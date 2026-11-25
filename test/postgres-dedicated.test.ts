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
