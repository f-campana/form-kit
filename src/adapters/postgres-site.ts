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
}

export interface ProvisionSiteInput {
  /** Lowercase letters, digits and underscores, starting with a letter. */
  readonly site: string;
  /** The role's password, used when the role is created or `rotatePassword` is set. */
  readonly password: string;
  /** Set a new password on a role that already exists. */
  readonly rotatePassword?: boolean;
}

const SITE_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const MIN_PASSWORD_LENGTH = 20;

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
 * It runs as the database administrator, and refuses, before changing
 * anything, a database where the site wouldn't be isolated: a role that
 * already exists with more rights than a site needs, or a schema someone
 * else owns or can reach. It reports what it found rather than removing
 * rights it didn't grant, since those may be there on purpose. It checks
 * again once the site is set up.
 */
export async function provisionSite(admin: SqlClient, input: ProvisionSiteInput): Promise<SiteDatabase> {
  const { schema, role } = siteNames(input.site);
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The site password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }

  const existing = await admin.query(`select rolname from pg_roles where rolname = $1`, [role]);
  const roleCreated = existing.rows.length === 0;

  const before = await isolationProblems(admin, schema, role, roleCreated);
  if (before.length > 0) {
    throw new Error(`Site ${input.site} can't be set up safely, and nothing was changed:\n${list(before)}`);
  }

  await admin.query(`create schema if not exists "${schema}"`);
  await migrateContactSchema(admin, { schema });

  if (roleCreated || input.rotatePassword === true) {
    // format() quotes the role and the password, so neither can break out of the statement.
    const template = roleCreated
      ? "create role %I login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password %L"
      : "alter role %I password %L";
    const { rows } = await admin.query<{ statement: string }>(`select format($1::text, $2::text, $3::text) as statement`, [
      template,
      role,
      input.password,
    ]);
    await admin.query(rows[0]!.statement);
  }

  await admin.query(`grant usage on schema "${schema}" to "${role}"`);
  await admin.query(`grant select, insert, update, delete on all tables in schema "${schema}" to "${role}"`);
  await admin.query(`alter role "${role}" set search_path = "${schema}"`);

  const after = await isolationProblems(admin, schema, role, false);
  if (after.length > 0) {
    throw new Error(
      `Site ${input.site} was set up, but isn't isolated:\n${list(after)}\nFix these and run it again` +
        (roleCreated ? ", with --rotate-password to get the role's connection URL." : "."),
    );
  }
  return { schema, role, roleCreated };
}

const list = (problems: string[]) => problems.map((problem) => `- ${problem}`).join("\n");

/**
 * Everything that would let the site's role reach more than its own rows, or
 * let anyone else reach them. When the role doesn't exist yet, the checks on
 * what it could reach use PUBLIC, whose rights every new role gets.
 *
 * What it assumes: the database holds only the sites set up this way, and
 * only the administrator changes rights in it. The checks describe the
 * database at the moment setup runs; a right granted later isn't caught
 * until setup runs again. Functions that run with the caller's rights, the
 * default, are allowed: they reach only what the caller already can. Every
 * role can still see the names of other sites' tables in the catalog.
 */
async function isolationProblems(admin: SqlClient, schema: string, role: string, roleAbsent: boolean): Promise<string[]> {
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
               select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $2))))`,
      [role, schema],
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

  const problems: string[] = [];
  for (const [sql, params] of checks) {
    const { rows } = await admin.query<{ problem: string }>(sql, params);
    for (const row of rows) if (!problems.includes(row.problem)) problems.push(row.problem);
  }
  return problems;
}
