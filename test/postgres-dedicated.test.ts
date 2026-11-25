import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { checkSite, consoleConnectStep, PROVIDER_ADMIN_ROLE, provisionSite } from "../src/adapters/postgres-site";

/**
 * One database instance for one site, as on a managed Scaleway database, where
 * only the console can let a role connect. What the console adds is emulated
 * here in SQL: this is what it was seen to do for the "Read" permission, not
 * Scaleway itself. The real instance is checked with `provision-site --check`.
 */
const PASSWORD = "password-for-site-a-0001";

async function managedDatabase() {
  const db = new PGlite();
  const { rows } = await db.query<{ name: string }>("select current_database() as name");
  const database = rows[0]!.name;
  await db.exec(`create role ${PROVIDER_ADMIN_ROLE};
    revoke connect on database "${database}" from public;`);
  return { db, database };
}

/** The console's "Read" permission: connect, public usage, default privileges, and table rights replaced by select. */
async function consoleRead(db: PGlite, database: string, role = "site_atelier") {
  await db.exec(`
    grant connect, temporary on database "${database}" to ${role};
    grant usage on schema public to ${role};
    revoke insert, update, delete on all tables in schema ${role} from ${role};
    grant select on all tables in schema ${role} to ${role};
    alter default privileges for role ${PROVIDER_ADMIN_ROLE} in schema public grant select on tables to ${role};
    alter default privileges for role ${PROVIDER_ADMIN_ROLE} in schema public grant select on sequences to ${role};
    alter default privileges for role ${PROVIDER_ADMIN_ROLE} in schema public grant execute on functions to ${role};
    alter default privileges for role ${PROVIDER_ADMIN_ROLE} in schema ${role} grant select on tables to ${role};
  `);
}

const setUp = (db: PGlite, dedicatedInstance = true, site = "atelier") =>
  provisionSite(db, { site, password: PASSWORD, dedicatedInstance });

async function canInsert(db: PGlite) {
  const { rows } = await db.query<{ ok: boolean }>(
    "select has_table_privilege('site_atelier', 'site_atelier.contact_submissions', 'insert') as ok",
  );
  return rows[0]!.ok;
}

async function ready() {
  const managed = await managedDatabase();
  await setUp(managed.db);
  await consoleRead(managed.db, managed.database);
  await setUp(managed.db);
  return managed;
}

describe("a dedicated instance", () => {
  it("creates the role and says the console step is still needed", async () => {
    const { db, database } = await managedDatabase();
    const result = await setUp(db);
    expect(result).toMatchObject({ roleCreated: true, connectPending: true });
    expect(consoleConnectStep(result.role, database)).toContain(`on the database "${database}" to Read`);
  });

  it("is refused by the strict shared-database rule once the console has let the role connect", async () => {
    const { db, database } = await managedDatabase();
    await setUp(db);
    await consoleRead(db, database);
    await expect(setUp(db, false)).rejects.toThrow(/has rights on database|has rights on schema public|gets default/);
  });

  it("accepts what the console added, restores the table rights it replaced, and passes the check", async () => {
    const { db, database } = await managedDatabase();
    await setUp(db);
    await consoleRead(db, database);
    expect(await canInsert(db)).toBe(false);

    const again = await setUp(db);

    expect(again).toMatchObject({ roleCreated: false, connectPending: false });
    expect(await canInsert(db)).toBe(true);
    expect(await checkSite(db, "atelier", { dedicatedInstance: true })).toEqual([]);
  });

  it("reports rights a later console change took away, and changes nothing while doing it", async () => {
    const { db, database } = await ready();
    await consoleRead(db, database);

    const problems = await checkSite(db, "atelier", { dedicatedInstance: true });

    expect(problems).toContain("site_atelier can't insert site_atelier.contact_submissions");
    expect(problems).toContain("site_atelier can't delete site_atelier.contact_rate_hits");
    expect(await canInsert(db)).toBe(false);
  });

  it("reports a lost connect right", async () => {
    const { db, database } = await ready();
    await db.exec(`revoke connect on database "${database}" from site_atelier`);
    expect((await checkSite(db, "atelier", { dedicatedInstance: true })).join("\n")).toContain("can't connect");
  });

  it("says when the role doesn't exist", async () => {
    const { db } = await managedDatabase();
    expect(await checkSite(db, "atelier", { dedicatedInstance: true })).toEqual([
      "the role site_atelier doesn't exist: run setup",
    ]);
  });

  it("refuses a second site", async () => {
    const { db } = await ready();
    await expect(setUp(db, true, "boulangerie")).rejects.toThrow(/a dedicated instance holds one site/);
    await db.exec("create schema site_other");
    await expect(setUp(db)).rejects.toThrow(/second site is set up here/);
    expect((await checkSite(db, "atelier", { dedicatedInstance: true })).join("\n")).toContain("second site");
  });

  const beyondRead: [string, string, RegExp][] = [
    ["create on the database", 'grant create on database "$db" to site_atelier', /more than connect and temporary|can create schemas/],
    ["create on public", "grant create on schema public to site_atelier", /more than usage|can create objects/],
    [
      "a right on a table in public",
      "create table public.other (i int); grant select on public.other to site_atelier",
      /rights on table|can select public\.other/,
    ],
    [
      "default privileges beyond read from the provider",
      `alter default privileges for role ${PROVIDER_ADMIN_ROLE} in schema public grant insert on tables to site_atelier`,
      /gets default privileges/,
    ],
    [
      "default privileges from anyone else",
      "create role someone; alter default privileges for role someone in schema public grant select on tables to site_atelier",
      /gets default privileges/,
    ],
    [
      "default privileges from the provider in a third schema",
      `create schema extra; alter default privileges for role ${PROVIDER_ADMIN_ROLE} in schema extra grant select on tables to site_atelier`,
      /gets default privileges/,
    ],
    ["an extra role attribute", "alter role site_atelier createdb", /CREATEDB/],
    ["a membership", "create role boss; grant boss to site_atelier", /is a member of/],
  ];

  it.each(beyondRead)("still refuses %s, and changes nothing", async (_name, sql, expected) => {
    const { db, database } = await ready();
    await db.exec(sql.replace("$db", database));

    await expect(setUp(db)).rejects.toThrow(expected);
    expect((await checkSite(db, "atelier", { dedicatedInstance: true })).join("\n")).toMatch(expected);
  });
});

describe("--check after a partial restore", () => {
  const check = async (db: PGlite) => (await checkSite(db, "atelier", { dedicatedInstance: true })).join("\n");

  it("reports both tables when they are gone", async () => {
    const { db } = await ready();
    await db.exec("drop table site_atelier.contact_submissions, site_atelier.contact_rate_hits");

    const problems = await check(db);

    expect(problems).toContain("the table site_atelier.contact_submissions is missing");
    expect(problems).toContain("the table site_atelier.contact_rate_hits is missing");
  });

  const damage: [string, string, RegExp][] = [
    ["one missing table", "drop table site_atelier.contact_rate_hits", /contact_rate_hits is missing/],
    ["a missing column", "alter table site_atelier.contact_submissions drop column locked_until", /no column locked_until/],
    ["a changed type", "alter table site_atelier.contact_rate_hits alter column hit_at type text", /hit_at is text/],
    ["a lost not-null", "alter table site_atelier.contact_submissions alter column reason drop not null", /reason allows null/],
    ["an unknown required column", "alter table site_atelier.contact_rate_hits add column extra text not null", /unknown required column extra/],
    [
      "a lost primary key",
      "alter table site_atelier.contact_submissions drop constraint contact_submissions_pkey",
      /missing the primary key/,
    ],
    ["a lost unique index", "drop index site_atelier.contact_submissions_token", /missing the index contact_submissions_token/],
    [
      "a unique index restored as a plain one",
      "drop index site_atelier.contact_rate_hits_form; create index contact_rate_hits_form on site_atelier.contact_rate_hits (key, form_id)",
      /contact_rate_hits_form isn't the one the kit creates/,
    ],
    [
      "a unique index that covers only some rows",
      "drop index site_atelier.contact_submissions_token; create unique index contact_submissions_token on site_atelier.contact_submissions (token_id) where reason = 'devis'",
      /contact_submissions_token isn't the one the kit creates/,
    ],
    ["a unique token index with an expression added", "drop index site_atelier.contact_submissions_token; create unique index contact_submissions_token on site_atelier.contact_submissions (token_id, lower(fingerprint))", /contact_submissions_token isn't the one/],
    ["a unique token index on an expression only", "drop index site_atelier.contact_submissions_token; create unique index contact_submissions_token on site_atelier.contact_submissions (lower(token_id))", /contact_submissions_token isn't the one/],
    ["a unique token index with an extra column", "drop index site_atelier.contact_submissions_token; create unique index contact_submissions_token on site_atelier.contact_submissions (token_id, fingerprint)", /contact_submissions_token isn't the one/],
    ["a unique token index with INCLUDE", "drop index site_atelier.contact_submissions_token; create unique index contact_submissions_token on site_atelier.contact_submissions (token_id) include (fingerprint)", /contact_submissions_token isn't the one/],
    ["a rate-limit index with an expression added", "drop index site_atelier.contact_rate_hits_form; create unique index contact_rate_hits_form on site_atelier.contact_rate_hits (key, form_id, (hit_at is null))", /contact_rate_hits_form isn't the one/],
    ["a rate-limit index in another order", "drop index site_atelier.contact_rate_hits_form; create unique index contact_rate_hits_form on site_atelier.contact_rate_hits (form_id, key)", /contact_rate_hits_form isn't the one/],
    ["another operator class", "drop index site_atelier.contact_submissions_token; create unique index contact_submissions_token on site_atelier.contact_submissions (token_id text_pattern_ops)", /contact_submissions_token isn't the one/],
    ["another collation on the index", "drop index site_atelier.contact_submissions_token; create unique index contact_submissions_token on site_atelier.contact_submissions (token_id collate \"C\")", /contact_submissions_token isn't the one/],
    ["another collation on the column", "alter table site_atelier.contact_submissions alter column reason type text collate \"C\"", /reason has another collation/],
    ["a deferred primary key", "alter table site_atelier.contact_submissions drop constraint contact_submissions_pkey; alter table site_atelier.contact_submissions add primary key (id) deferrable initially deferred", /primary key isn't enforced/],
    ["an unlogged table", "alter table site_atelier.contact_rate_hits set unlogged", /not an ordinary, logged table/],
    ["an added unique index", "create unique index surprise on site_atelier.contact_submissions (reason)", /unknown unique or exclusion index surprise/],
    ["an added check constraint", "alter table site_atelier.contact_submissions add constraint odd check (reason <> 'devis')", /unknown constraint odd/],
    ["an added trigger", "create function site_atelier.skip() returns trigger language plpgsql as 'begin return null; end'; create trigger skip before insert on site_atelier.contact_submissions for each row execute function site_atelier.skip()", /unknown trigger skip/],
    ["an added rule", "create rule swallow as on insert to site_atelier.contact_rate_hits do instead nothing", /unknown rule swallow/],
    ["row-level security", "alter table site_atelier.contact_submissions enable row level security", /has row-level security/],
    ["a lost lookup index", "drop index site_atelier.contact_submissions_next_due", /missing the index contact_submissions_next_due/],
  ];

  it.each(damage)("reports %s", async (_name, sql, expected) => {
    const { db } = await ready();
    await db.exec(sql);
    expect(await check(db)).toMatch(expected);
  });
});

describe("rights held with grant option", () => {
  const delegable: [string, string][] = [
    ["connect on the database", 'grant connect on database "$db" to site_atelier with grant option'],
    ["usage on public", "grant usage on schema public to site_atelier with grant option"],
    [
      "the provider's default privileges",
      `alter default privileges for role ${PROVIDER_ADMIN_ROLE} in schema public grant select on tables to site_atelier with grant option`,
    ],
    ["usage on the site's own schema", "grant usage on schema site_atelier to site_atelier with grant option"],
    ["a table of its own", "grant select on site_atelier.contact_submissions to site_atelier with grant option"],
    ["a server setting", "grant set on parameter work_mem to site_atelier with grant option"],
    ["one column", "grant update (reason) on site_atelier.contact_submissions to site_atelier with grant option"],
  ];

  it.each(delegable)("are refused: %s", async (_name, sql) => {
    const { db, database } = await ready();
    await db.exec(sql.replace("$db", database));

    expect((await checkSite(db, "atelier", { dedicatedInstance: true })).join("\n")).toContain("with grant option");
    await expect(setUp(db)).rejects.toThrow(/with grant option/);
  });

  it("are refused by the strict shared-database rule too", async () => {
    const db = new PGlite();
    await setUp(db, false);
    await db.exec("grant select on site_atelier.contact_submissions to site_atelier with grant option");

    await expect(setUp(db, false)).rejects.toThrow(/with grant option/);
  });
});
