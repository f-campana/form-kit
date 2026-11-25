import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { migrateContactSchema, type SqlClient } from "./postgres";

/**
 * Several sites share one database (decision D16). Each gets a schema holding
 * its tables and a login role that can read and write those tables and reach
 * nothing else: not another site's tables, not the structure of its own.
 */
export interface SiteDatabase {
  readonly schema: string;
  readonly role: string;
  /** False when the role already existed; its password was then left alone unless asked otherwise. */
  readonly roleCreated: boolean;
  /**
   * True when the role has no right to connect to the database yet. On a
   * managed Scaleway database only the console can give it (see
   * `consoleConnectStep`); set that, then run setup again.
   */
  readonly connectPending: boolean;
}

export interface SiteModeOptions {
  /**
   * One database instance for one site, on a managed service whose console is
   * the only way to let a role connect (Scaleway). It accepts exactly the
   * rights the console adds with the "Read" permission, and refuses a second
   * site on the same database. Without it, the strict rule for a shared
   * database applies.
   */
  readonly dedicatedInstance?: boolean;
}

/** Scaleway's internal administrator, which owns the default privileges its console creates. */
export const PROVIDER_ADMIN_ROLE = "_rdb_superadmin";

/** What to do in the console when a role has no right to connect. */
export function consoleConnectStep(role: string, database: string): string {
  return `In the Scaleway console: the Database Instance > Users > ${role} > set its permission on the database "${database}" to Read. Then run setup again: Read also replaces the table rights, which setup restores.`;
}

export interface ProvisionSiteInput extends SiteModeOptions {
  /** Lowercase letters, digits and underscores, starting with a letter. */
  readonly site: string;
  /** The role's password, used when the role is created or `rotatePassword` is set. */
  readonly password: string;
  /** Set a new password on a role that already exists. */
  readonly rotatePassword?: boolean;
  /**
   * How many connections the site's role may hold at once, 10 by default, so
   * one site can't use up the database's connections. Applied on every run.
   * Past it, a submission can't be stored and the visitor is asked to retry.
   */
  readonly connectionLimit?: number;
}

const SITE_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const MIN_PASSWORD_LENGTH = 20;
/** Printable ASCII with no space, which SCRAM's SASLprep step leaves unchanged. */
const PASSWORD_CHARACTERS = /^[\x21-\x7e]+$/;
const DEFAULT_CONNECTION_LIMIT = 10;
const SCRAM_ITERATIONS = 4096;

/**
 * The SCRAM-SHA-256 verifier PostgreSQL stores for a password (RFC 5802 and
 * RFC 7677), in the form `pg_authid` keeps it. Sending this instead of the
 * password keeps the password itself off the server: a statement log shows
 * only what the database stores anyway.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  const b64 = (bytes: Buffer) => bytes.toString("base64");
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}

export function siteNames(site: string): { schema: string; role: string } {
  if (!SITE_NAME.test(site)) {
    throw new Error(
      `Invalid site name ${JSON.stringify(site)}: use up to 40 lowercase letters, digits and underscores, starting with a letter.`,
    );
  }
  return { schema: `site_${site}`, role: `site_${site}` };
}

/**
 * Creates or upgrades one site's schema, tables and role. Safe to run again:
 * existing submissions are kept and an existing role keeps its password.
 *
 * It runs as the database administrator, and refuses a database where the
 * site wouldn't be isolated: a role that already exists with more rights than
 * a site needs, or a schema someone else owns or can reach. It reports what it
 * found rather than removing rights it didn't grant, since those may be there
 * on purpose. It checks before and after setting the site up.
 *
 * Everything happens in one transaction: if a step or the last check fails,
 * nothing is changed. So `admin` must be a single connection (a `pg.Client`,
 * or a pool of one), not a pool that may send each statement elsewhere.
 */
export async function provisionSite(admin: SqlClient, input: ProvisionSiteInput): Promise<SiteDatabase> {
  const { schema, role } = siteNames(input.site);
  if (input.password.length < MIN_PASSWORD_LENGTH || !PASSWORD_CHARACTERS.test(input.password)) {
    throw new Error(
      `The site password must be at least ${MIN_PASSWORD_LENGTH} characters long, in printable ASCII with no spaces.`,
    );
  }
  const connectionLimit = input.connectionLimit ?? DEFAULT_CONNECTION_LIMIT;
  if (!Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 1000) {
    throw new Error("The connection limit must be a whole number from 1 to 1000.");
  }

  const dedicated = input.dedicatedInstance === true;

  await admin.query("begin");
  try {
    const existing = await admin.query(`select rolname from pg_roles where rolname = $1`, [role]);
    const roleCreated = existing.rows.length === 0;

    const before = await isolationProblems(admin, schema, role, roleCreated, dedicated);
    if (before.length > 0) {
      throw new Error(`Site ${input.site} can't be set up safely, and nothing was changed:\n${list(before)}`);
    }

    await admin.query(`create schema if not exists "${schema}"`);
    await migrateContactSchema(admin, { schema });

    if (roleCreated) {
      await admin.query(`create role "${role}" login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`);
    }
    if (roleCreated || input.rotatePassword === true) {
      // Only the hash is sent. format() quotes it, though it holds only base64 and punctuation.
      const { rows } = await admin.query<{ statement: string }>(
        `select format('alter role %I password %L', $1::text, $2::text) as statement`,
        [role, scramVerifier(input.password)],
      );
      await admin.query(rows[0]!.statement);
    }
    await admin.query(`alter role "${role}" connection limit ${connectionLimit}`);

    await admin.query(`grant usage on schema "${schema}" to "${role}"`);
    await admin.query(`grant select, insert, update, delete on all tables in schema "${schema}" to "${role}"`);
    await admin.query(`alter role "${role}" set search_path = "${schema}"`);

    const after = [...(await isolationProblems(admin, schema, role, false, dedicated)), ...(await shapeProblems(admin, schema))];
    if (after.length > 0) {
      throw new Error(
        `Site ${input.site} can't be set up safely, and nothing was changed. Once set up, it wouldn't be right:\n${list(after)}`,
      );
    }
    const connectPending = !(await canConnect(admin, role));
    await admin.query("commit");
    return { schema, role, roleCreated, connectPending };
  } catch (error) {
    await admin.query("rollback").catch(() => {});
    throw error;
  }
}

async function canConnect(admin: SqlClient, role: string): Promise<boolean> {
  const { rows } = await admin.query<{ ok: boolean }>(
    `select has_database_privilege($1, current_database(), 'connect') as ok`,
    [role],
  );
  return rows[0]?.ok === true;
}

/**
 * A read-only audit of a site that is already set up: everything setup would
 * refuse, plus the rights the site needs but may have lost. A restore or a
 * permission change in a provider's console can alter them silently, so run
 * it after either. It changes nothing.
 *
 * It reads the catalog: it doesn't log in as the site, run its queries, or
 * restore anything, so a pass isn't proof that the site works after a
 * restore. Nor does it prove that an extension can't be installed later.
 */
export async function checkSite(admin: SqlClient, site: string, options: SiteModeOptions = {}): Promise<string[]> {
  const { schema, role } = siteNames(site);
  const dedicated = options.dedicatedInstance === true;
  await admin.query("begin transaction read only");
  try {
    const existing = await admin.query(`select rolname from pg_roles where rolname = $1`, [role]);
    if (existing.rows.length === 0) return [`the role ${role} doesn't exist: run setup`];
    const problems = await isolationProblems(admin, schema, role, false, dedicated);
    problems.push(...(await shapeProblems(admin, schema)), ...(await missingRights(admin, schema, role)));
    if (!(await canConnect(admin, role))) {
      problems.push(`${role} can't connect to this database${dedicated ? " (set it in the console)" : ""}`);
    }
    return problems;
  } finally {
    await admin.query("rollback").catch(() => {});
  }
}

/** What the kit's tables must look like for the site to store, deduplicate, deliver and purge. */
const EXPECTED_COLUMNS: Record<string, [name: string, type: string, notNull: boolean][]> = {
  contact_submissions: [
    ["id", "text", true],
    ["reference", "text", true],
    ["token_id", "text", true],
    ["fingerprint", "text", true],
    ["created_at", "timestamp with time zone", true],
    ["reason", "text", true],
    ["data", "jsonb", true],
    ["messages", "jsonb", true],
    ["next_due_at", "timestamp with time zone", false],
    ["delivered_at", "timestamp with time zone", false],
    ["locked_until", "timestamp with time zone", false],
  ],
  contact_rate_hits: [
    ["key", "text", true],
    ["hit_at", "timestamp with time zone", true],
    ["form_id", "text", false],
  ],
};

/**
 * Each index the kit creates, as PostgreSQL describes it, without the table's
 * schema. The whole definition is compared, so an expression, an extra or
 * reordered column, INCLUDE, a different order, operator class or collation, a
 * WHERE clause or a missing UNIQUE all count as a different index. The primary
 * key may have any name, written here as <primary>.
 */
const EXPECTED_INDEXES: [name: string | null, table: string, definition: string][] = [
  [null, "contact_submissions", "CREATE UNIQUE INDEX <primary> ON contact_submissions USING btree (id)"],
  ["contact_submissions_token", "contact_submissions", "CREATE UNIQUE INDEX contact_submissions_token ON contact_submissions USING btree (token_id)"],
  [
    "contact_submissions_next_due",
    "contact_submissions",
    "CREATE INDEX contact_submissions_next_due ON contact_submissions USING btree (next_due_at) WHERE (next_due_at IS NOT NULL)",
  ],
  [
    "contact_submissions_delivered",
    "contact_submissions",
    "CREATE INDEX contact_submissions_delivered ON contact_submissions USING btree (delivered_at) WHERE (delivered_at IS NOT NULL)",
  ],
  ["contact_rate_hits_key", "contact_rate_hits", "CREATE INDEX contact_rate_hits_key ON contact_rate_hits USING btree (key, hit_at)"],
  ["contact_rate_hits_form", "contact_rate_hits", "CREATE UNIQUE INDEX contact_rate_hits_form ON contact_rate_hits USING btree (key, form_id)"],
];

/**
 * Whether the tables, their columns and their indexes are what the kit creates,
 * with nothing added that could change what an insert does. A partial or
 * altered restore can lose or change any of these while every right still looks
 * fine: without the tables nothing is stored, and without the unique indexes a
 * resend is stored twice and the rate limit can be passed.
 */
async function shapeProblems(admin: SqlClient, schema: string): Promise<string[]> {
  const columns = await admin.query<{
    table_name: string;
    name: string;
    type: string;
    not_null: boolean;
    has_default: boolean;
    plain: boolean;
  }>(
    `select c.relname as table_name, a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
       a.attnotnull as not_null, a.atthasdef as has_default,
       a.attcollation = t.typcollation and a.attgenerated = '' and a.attidentity = '' as plain
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     join pg_type t on t.oid = a.atttypid
     where n.nspname = $1 and c.relkind in ('r', 'p') and c.relname in ('contact_submissions', 'contact_rate_hits')`,
    [schema],
  );
  const indexes = await admin.query<{
    index_name: string;
    table_name: string;
    is_unique: boolean;
    is_primary: boolean;
    excludes: boolean;
    usable: boolean;
    immediate: boolean;
    definition: string;
  }>(
    `select i.relname as index_name, t.relname as table_name, x.indisunique as is_unique, x.indisprimary as is_primary,
       x.indisexclusion as excludes, x.indisvalid and x.indisready and x.indislive as usable,
       x.indimmediate as immediate, pg_get_indexdef(x.indexrelid) as definition
     from pg_index x
     join pg_class i on i.oid = x.indexrelid
     join pg_class t on t.oid = x.indrelid
     join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = $1 and t.relname in ('contact_submissions', 'contact_rate_hits')`,
    [schema],
  );
  // Anything else on the tables that can refuse, change or hide a row.
  const additions = await admin.query<{ problem: string }>(
    `with kit as (
       select c.oid, c.relname, c.relkind, c.relpersistence, c.relrowsecurity
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relname in ('contact_submissions', 'contact_rate_hits')
     )
     select format('%s is not an ordinary, logged table', relname) as problem from kit
       where relkind <> 'r' or relpersistence <> 'p'
     union all select format('%s has row-level security', relname) from kit where relrowsecurity
     union all select format('%s has an unknown constraint %I', k.relname, c.conname)
       from kit k join pg_constraint c on c.conrelid = k.oid where c.contype in ('c', 'f', 'u', 'x')
     union all select format('%s has an unknown trigger %I', k.relname, g.tgname)
       from kit k join pg_trigger g on g.tgrelid = k.oid where not g.tgisinternal
     union all select format('%s has an unknown rule %I', k.relname, r.rulename)
       from kit k join pg_rewrite r on r.ev_class = k.oid`,
    [schema],
  );

  const problems: string[] = additions.rows.map((row) => `${schema}.${row.problem}`);
  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    const found = columns.rows.filter((row) => row.table_name === table);
    if (found.length === 0) {
      problems.push(`the table ${schema}.${table} is missing`);
      continue;
    }
    for (const [name, type, notNull] of expected) {
      const column = found.find((row) => row.name === name);
      if (!column) problems.push(`${schema}.${table} has no column ${name}`);
      else if (column.type !== type) problems.push(`${schema}.${table}.${name} is ${column.type}, not ${type}`);
      else if (column.not_null !== notNull) problems.push(`${schema}.${table}.${name} ${notNull ? "allows" : "forbids"} null`);
      else if (!column.plain) problems.push(`${schema}.${table}.${name} has another collation, or is generated or an identity`);
    }
    for (const extra of found) {
      if (!expected.some(([name]) => name === extra.name) && extra.not_null && !extra.has_default) {
        problems.push(`${schema}.${table} has an unknown required column ${extra.name}: the kit's inserts would fail`);
      }
    }

    const onTable = indexes.rows.filter((row) => row.table_name === table);
    const matched = new Set<string>();
    for (const [name, indexTable, definition] of EXPECTED_INDEXES) {
      if (indexTable !== table) continue;
      const index = onTable.find((row) => (name === null ? row.is_primary : row.index_name === name));
      const label = name === null ? "the primary key" : `the index ${name}`;
      if (!index) {
        problems.push(`${schema}.${table} is missing ${label}`);
        continue;
      }
      matched.add(index.index_name);
      let actual = index.definition.replace(/ ON (?:ONLY )?(?:"?[a-z_][a-z0-9_]*"?\.)?/, " ON ");
      if (name === null) actual = actual.replace(` INDEX ${index.index_name} ON `, " INDEX <primary> ON ");
      if (actual !== definition) problems.push(`${schema}.${table}: ${label} isn't the one the kit creates: ${actual}`);
      else if (!index.usable || (index.is_unique && !index.immediate)) {
        problems.push(`${schema}.${table}: ${label} isn't enforced (invalid, or checked only at commit)`);
      }
    }
    for (const other of onTable) {
      if (!matched.has(other.index_name) && (other.is_unique || other.excludes)) {
        problems.push(`${schema}.${table} has an unknown unique or exclusion index ${other.index_name}`);
      }
    }
  }
  return problems;
}

/** The rights the site needs on its own schema and tables, and the ones it must not have there. */
async function missingRights(admin: SqlClient, schema: string, role: string): Promise<string[]> {
  const { rows } = await admin.query<{ problem: string }>(
    `select format('%s can''t use schema %I', $1::text, nspname) as problem
     from pg_namespace where nspname = $2 and not has_schema_privilege($1, oid, 'usage')
     union all
     select format('%I has no schema %I: run setup', current_database(), $2::text)
     where not exists (select 1 from pg_namespace where nspname = $2)
     union all
     select format('%s can''t %s %I.%I', $1::text, p.privilege, n.nspname, c.relname)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     cross join unnest(array['select', 'insert', 'update', 'delete']) as p(privilege)
     where n.nspname = $2 and c.relkind in ('r', 'p') and not has_table_privilege($1, c.oid, p.privilege)
     union all
     select format('%s can %s %I.%I, which it doesn''t need', $1::text, p.privilege, n.nspname, c.relname)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     cross join unnest(array['truncate', 'references', 'trigger']) as p(privilege)
     where n.nspname = $2 and c.relkind in ('r', 'p') and has_table_privilege($1, c.oid, p.privilege)`,
    [role, schema],
  );
  return rows.map((row) => row.problem);
}

const list = (problems: string[]) => problems.map((problem) => `- ${problem}`).join("\n");

/**
 * Everything that would let the site's role reach more than its own rows, or
 * let anyone else reach them. When the role doesn't exist yet, the checks on
 * what it could reach use PUBLIC, whose rights every new role gets.
 *
 * On a dedicated instance (`dedicatedInstance`) it accepts what the provider's
 * console adds to let a role connect, and nothing more: connect and temporary
 * on this database, usage on public, and the provider's own read-level default
 * privileges in public and in the site's schema. It then also requires that no
 * other site exists, because those rights would reach it.
 *
 * What it assumes: the database holds only the sites set up this way, and
 * only the administrator changes rights in it. The checks describe the
 * database at the moment setup runs; a right granted later isn't caught
 * until setup runs again. Functions that run with the caller's rights, the
 * default, are allowed: they reach only what the caller already can. Every
 * role can still see the names of other sites' tables in the catalog.
 */
async function isolationProblems(
  admin: SqlClient,
  schema: string,
  role: string,
  roleAbsent: boolean,
  dedicated: boolean,
): Promise<string[]> {
  const who = roleAbsent ? "public" : role;
  const checks: [string, unknown[]][] = [
    // The role's own attributes.
    [
      `select format('the role %I already exists with %s', rolname, concat_ws(', ',
         case when rolsuper then 'SUPERUSER' end, case when rolcreatedb then 'CREATEDB' end,
         case when rolcreaterole then 'CREATEROLE' end, case when rolreplication then 'REPLICATION' end,
         case when rolbypassrls then 'BYPASSRLS' end, case when not rolcanlogin then 'NOLOGIN' end)) as problem
       from pg_roles
       where rolname = $1 and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or not rolcanlogin)`,
      [role],
    ],
    // Memberships, both ways. The administrator may hold the role: PostgreSQL 16 and later grant that to whoever creates it.
    [
      `select format('%s is a member of %s', m.member::regrole, m.roleid::regrole) as problem
       from pg_auth_members m
       where m.member = (select oid from pg_roles where rolname = $1)
          or (m.roleid = (select oid from pg_roles where rolname = $1)
              and m.member <> (select oid from pg_roles where rolname = current_user))`,
      [role],
    ],
    // Anything the role owns or holds rights on, in any database, other than the rights setup gives it.
    [
      `select case
         when d.dbid not in (0, (select oid from pg_database where datname = current_database()))
           then format('the role %I owns something or holds rights in another database', $1::text)
         when d.deptype = 'o' then format('the role %I owns %s', $1::text, pg_describe_object(d.classid, d.objid, d.objsubid))
         when d.classid = 'pg_default_acl'::regclass
           then format('the role %I gets %s', $1::text, pg_describe_object(d.classid, d.objid, d.objsubid))
         else format('the role %I has rights on %s', $1::text, pg_describe_object(d.classid, d.objid, d.objsubid))
       end as problem
       from pg_shdepend d
       where d.refclassid = 'pg_authid'::regclass
         and d.refobjid = (select oid from pg_roles where rolname = $1)
         and not (d.deptype = 'a'
           and d.dbid = (select oid from pg_database where datname = current_database())
           and ((d.classid = 'pg_namespace'::regclass and d.objid = (select oid from pg_namespace where nspname = $2))
             or (d.classid = 'pg_class'::regclass and d.objid in (
               select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $2))))
         -- Dedicated instance only: what the console's "Read" permission adds. The privileges are checked below.
         and not ($3::boolean and d.deptype = 'a'
           and d.dbid in (0, (select oid from pg_database where datname = current_database()))
           and ((d.classid = 'pg_database'::regclass and d.objid = (select oid from pg_database where datname = current_database()))
             or (d.classid = 'pg_namespace'::regclass and d.objid = (select oid from pg_namespace where nspname = 'public'))
             or (d.classid = 'pg_default_acl'::regclass and d.objid in (
               select a.oid from pg_default_acl a
               where a.defaclrole = (select oid from pg_roles where rolname = $4)
                 and a.defaclnamespace in (select oid from pg_namespace where nspname in ('public', $2))
                 and not exists (
                   select 1 from aclexplode(a.defaclacl) x
                   where x.grantee = (select oid from pg_roles where rolname = $1)
                     and x.privilege_type not in ('SELECT', 'USAGE', 'EXECUTE'))))))`,
      [role, schema, dedicated, PROVIDER_ADMIN_ROLE],
    ],
    // What the role can actually do to tables outside its schema, however it got the right (directly or through
    // PUBLIC), on the whole table or on a single column.
    [
      `select format('%s can %s %I.%I', $1::text, string_agg(p.privilege, ', '), n.nspname, c.relname) as problem
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) as p(privilege)
       where c.relkind in ('r', 'p', 'v', 'm', 'f')
         and n.nspname <> $2 and n.nspname <> 'information_schema' and n.nspname not like 'pg\\_%'
         and (has_table_privilege($1, c.oid, p.privilege)
           or (p.privilege in ('select', 'insert', 'update', 'references')
             and has_any_column_privilege($1, c.oid, p.privilege)))
       group by n.nspname, c.relname`,
      [who, schema],
    ],
    // Functions that run with their owner's rights, which the role could call to reach what the owner reaches.
    [
      `select format('%s can run %I.%I(%s), which runs as %s', $1::text, n.nspname, p.proname,
         pg_get_function_identity_arguments(p.oid), p.proowner::regrole) as problem
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.prosecdef and n.nspname <> 'information_schema' and n.nspname not like 'pg\\_%'
         and has_function_privilege($1, p.oid, 'execute')`,
      [who],
    ],
    // Large objects everyone may read or change. Rights given to the role itself show up in pg_shdepend above.
    [
      `select format('public can %s large object %s', case a.privilege_type when 'SELECT' then 'read' else 'change' end, l.oid) as problem
       from pg_largeobject_metadata l, aclexplode(l.lomacl) a
       where a.grantee = 0
       union all
       select 'lo_compat_privileges is on, so every role can read and change every large object'
       where current_setting('lo_compat_privileges') = 'on'`,
      [],
    ],
    [
      `select format('%s can create objects in schema %I', $1::text, nspname) as problem
       from pg_namespace
       where nspname <> 'information_schema' and nspname not like 'pg\\_%' and has_schema_privilege($1, oid, 'create')`,
      [who],
    ],
    [
      `select format('%s can create schemas in this database', $1::text) as problem
       where has_database_privilege($1, current_database(), 'create')`,
      [who],
    ],
    // The site's own schema and tables: owned by the administrator, reachable by the site's role only.
    [
      `select format('schema %I belongs to %s, not to %s', nspname, nspowner::regrole, current_user) as problem
       from pg_namespace
       where nspname = $1 and nspowner <> (select oid from pg_roles where rolname = current_user)
       union all
       select format('%I.%I belongs to %s, not to %s', n.nspname, c.relname, c.relowner::regrole, current_user)
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relowner <> (select oid from pg_roles where rolname = current_user)`,
      [schema],
    ],
    [
      `select format('%s has privileges on schema %I', case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end, n.nspname) as problem
       from pg_namespace n, aclexplode(n.nspacl) a
       where n.nspname = $1 and a.grantee <> n.nspowner
         and a.grantee is distinct from (select oid from pg_roles where rolname = $2)
       union all
       select format('%s has privileges on %I.%I', case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end, n.nspname, c.relname)
       from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
       where n.nspname = $1 and a.grantee <> c.relowner
         and a.grantee is distinct from (select oid from pg_roles where rolname = $2)
       union all
       select format('%s has privileges on column %I of %I.%I', case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end,
         t.attname, n.nspname, c.relname)
       from pg_attribute t join pg_class c on c.oid = t.attrelid join pg_namespace n on n.oid = c.relnamespace,
         aclexplode(t.attacl) a
       where n.nspname = $1 and a.grantee <> c.relowner
         and a.grantee is distinct from (select oid from pg_roles where rolname = $2)`,
      [schema, role],
    ],
  ];

  // A right held WITH GRANT OPTION lets the role pass it on, which no accepted right may allow. Memberships are
  // refused above, so only direct entries can carry it (PUBLIC can't hold a grant option).
  checks.push([
    `with acls(what, acl) as (
       select format('database %I', datname), datacl from pg_database
       union all select format('schema %I', nspname), nspacl from pg_namespace
       union all select format('relation %s', oid::regclass), relacl from pg_class
       union all select format('column %I of %s', attname, attrelid::regclass), attacl from pg_attribute
       union all select format('function %s', oid::regprocedure), proacl from pg_proc
       union all select format('type %s', oid::regtype), typacl from pg_type
       union all select format('language %I', lanname), lanacl from pg_language
       union all select format('foreign server %I', srvname), srvacl from pg_foreign_server
       union all select format('foreign-data wrapper %I', fdwname), fdwacl from pg_foreign_data_wrapper
       union all select format('large object %s', oid), lomacl from pg_largeobject_metadata
       union all select format('tablespace %I', spcname), spcacl from pg_tablespace
       union all select format('server setting %I', parname), paracl from pg_parameter_acl
       union all select format('default privileges of %s', defaclrole::regrole), defaclacl from pg_default_acl
     )
     select format('%s can pass on %s on %s (granted with grant option)', $1::text, string_agg(distinct x.privilege_type, ', '), what) as problem
     from acls, aclexplode(acls.acl) x
     where x.is_grantable and x.grantee = (select oid from pg_roles where rolname = $1)
     group by what`,
    [role],
  ]);

  // Extensions that open connections from the database server, which a site never needs.
  checks.push([
    `select format('the extension %I is installed in this database: it can open connections elsewhere', extname) as problem
     from pg_extension where extname in ('dblink', 'postgres_fdw', 'file_fdw')`,
    [],
  ]);
  if (dedicated) {
    checks.push(
      // The allow-list above accepts the database and public-schema entries, so their privileges are limited here.
      [
        `select format('%s has %s on database %I, more than connect and temporary', $1::text, string_agg(x.privilege_type, ', '), d.datname) as problem
         from pg_database d, aclexplode(d.datacl) x
         where d.datname = current_database() and x.grantee = (select oid from pg_roles where rolname = $1)
           and x.privilege_type not in ('CONNECT', 'TEMPORARY')
         group by d.datname`,
        [role],
      ],
      [
        `select format('%s has %s on schema public, more than usage', $1::text, string_agg(x.privilege_type, ', ')) as problem
         from pg_namespace n, aclexplode(n.nspacl) x
         where n.nspname = 'public' and x.grantee = (select oid from pg_roles where rolname = $1)
           and x.privilege_type <> 'USAGE'
         group by n.nspname`,
        [role],
      ],
      // One instance, one site: the console's rights cover the whole database.
      [
        `select format('a second site is set up here (schema %I): a dedicated instance holds one site', nspname) as problem
         from pg_namespace where nspname like 'site\\_%' and nspname <> $1
         union all
         select format('a second site role exists on this instance (%I): a dedicated instance holds one site', rolname)
         from pg_roles where rolname like 'site\\_%' and rolname <> $2`,
        [schema, role],
      ],
    );
  }

  const problems: string[] = [];
  for (const [sql, params] of checks) {
    const { rows } = await admin.query<{ problem: string }>(sql, params);
    for (const row of rows) if (!problems.includes(row.problem)) problems.push(row.problem);
  }
  return problems;
}
