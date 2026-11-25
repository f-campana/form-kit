import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { postgresRateLimiter, postgresStore } from "../src/adapters/postgres";
import { provisionSite, siteNames } from "../src/adapters/postgres-site";
import { atelierContact as config } from "../src/example/atelier-contact";
import { processDue, purgeDelivered, submitContact } from "../src/kit";
import { DAY, MINUTE, setup, START, submission, VISITOR } from "./support";

/**
 * Several sites share one database. Each gets its own schema and a role that
 * reaches nothing else (decision D16).
 *
 * PGlite has one connection, logged in as the administrator, so these tests
 * become a site with `set role`: that applies the site role's permissions.
 * What needs a real login is checked in postgres-real.test.ts: a site can't
 * become another site, and it finds its own tables without naming the schema.
 */
async function twoSites() {
  const db = new PGlite();
  const a = await provisionSite(db, { site: "atelier", password: "password-for-site-a-0001" });
  const b = await provisionSite(db, { site: "boulangerie", password: "password-for-site-b-0002" });
  const actAs = (role: string | undefined) => db.query(role === undefined ? "reset role" : `set role ${role}`);
  return { db, a, b, actAs };
}

const DENIED = /permission denied/;

describe("one schema and one role per site", () => {
  it("names a site's schema and role after the site", () => {
    expect(siteNames("atelier")).toEqual({ schema: "site_atelier", role: "site_atelier" });
  });

  it.each(["", "Atelier", "a b", "a-b", 'a"; drop schema public cascade; --', "1abc", "a".repeat(60)])(
    "refuses the site name %j before touching the database",
    async (site) => {
      const queries: string[] = [];
      const spy = { query: async (text: string) => (queries.push(text), { rows: [] }) };
      await expect(provisionSite(spy, { site, password: "password-for-site-a-0001" })).rejects.toThrow(/site name/);
      expect(queries).toEqual([]);
    },
  );

  it("refuses a weak password before touching the database", async () => {
    const queries: string[] = [];
    const spy = { query: async (text: string) => (queries.push(text), { rows: [] }) };
    await expect(provisionSite(spy, { site: "atelier", password: "short" })).rejects.toThrow(/password/);
    expect(queries).toEqual([]);
  });

  it("refuses a password with characters other than printable ASCII, before touching the database", async () => {
    const queries: string[] = [];
    const spy = { query: async (text: string) => (queries.push(text), { rows: [] }) };
    for (const password of ["password with spaces 0001", "mot-de-passe-évident-0001"]) {
      await expect(provisionSite(spy, { site: "atelier", password })).rejects.toThrow(/password/);
    }
    expect(queries).toEqual([]);
  });

  it("sends the password to the server only as a SCRAM hash, so it can't appear in its logs", async () => {
    const db = new PGlite();
    const password = "password-for-site-a-0001";
    const sent: string[] = [];
    const recording = {
      query: async <Row>(text: string, params?: unknown[]) => {
        sent.push(text, ...(params ?? []).map(String));
        return db.query<Row>(text, params);
      },
    };

    await provisionSite(recording, { site: "atelier", password });
    await provisionSite(recording, { site: "atelier", password: "password-for-site-a-0002", rotatePassword: true });

    expect(sent.join("\n")).not.toContain("password-for-site-a-000");
    const { rows } = await db.query<{ rolpassword: string }>(`select rolpassword from pg_authid where rolname = 'site_atelier'`);
    // Stored exactly as sent: the server accepted it as a hash rather than hashing it again.
    expect(rows[0]?.rolpassword).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(sent).toContain(rows[0]?.rolpassword);
  });

  it("limits how many connections a site's role can open, on new and existing roles", async () => {
    const db = new PGlite();
    const limitOf = async () =>
      (await db.query<{ rolconnlimit: number }>(`select rolconnlimit from pg_roles where rolname = 'site_atelier'`)).rows[0]
        ?.rolconnlimit;

    await provisionSite(db, { site: "atelier", password: "password-for-site-a-0001" });
    expect(await limitOf()).toBe(10);
    await provisionSite(db, { site: "atelier", password: "password-for-site-a-0001", connectionLimit: 3 });
    expect(await limitOf()).toBe(3);
    await expect(
      provisionSite(db, { site: "atelier", password: "password-for-site-a-0001", connectionLimit: 0 }),
    ).rejects.toThrow(/connection limit/);
  });

  describe("is all or nothing", () => {
    const leftovers = async (db: PGlite) => ({
      schemas: (await db.query(`select 1 from pg_namespace where nspname = 'site_atelier'`)).rows.length,
      roles: (await db.query(`select 1 from pg_roles where rolname = 'site_atelier'`)).rows.length,
    });

    it("changes nothing when a step fails partway", async () => {
      const db = new PGlite();
      const failing = {
        query: async <Row>(text: string, params?: unknown[]) => {
          if (text.startsWith("grant usage")) throw new Error("connection lost");
          return db.query<Row>(text, params);
        },
      };

      await expect(provisionSite(failing, { site: "atelier", password: "password-for-site-a-0001" })).rejects.toThrow(
        /connection lost/,
      );
      expect(await leftovers(db)).toEqual({ schemas: 0, roles: 0 });
    });

    it("changes nothing when the site isn't isolated once set up", async () => {
      const db = new PGlite();
      // Tables the administrator creates from now on are readable by everyone: only visible once the tables exist.
      await db.query(`alter default privileges grant select on tables to public`);

      await expect(provisionSite(db, { site: "atelier", password: "password-for-site-a-0001" })).rejects.toThrow(
        /nothing was changed[\s\S]*PUBLIC has privileges on site_atelier\.contact_submissions/,
      );
      expect(await leftovers(db)).toEqual({ schemas: 0, roles: 0 });
    });
  });

  it("sets up a site, and can be run again without losing anything", async () => {
    const { db, a, actAs } = await twoSites();
    expect(a).toEqual({ schema: "site_atelier", role: "site_atelier", roleCreated: true, connectPending: false });

    await actAs(a.role);
    const { deps, clock } = setup();
    const siteDeps = { ...deps, store: postgresStore(db, a), rateLimiter: postgresRateLimiter(db, a) };
    await submitContact(config, siteDeps, await submission("devis", clock.now()));
    await actAs(undefined);

    const again = await provisionSite(db, { site: "atelier", password: "password-for-site-a-0001" });

    expect(again).toEqual({ schema: "site_atelier", role: "site_atelier", roleCreated: false, connectPending: false });
    const { rows } = await db.query<{ id: string }>(`select id from site_atelier.contact_submissions`);
    expect(rows).toEqual([{ id: "sub-1" }]);
  });

  it("lets a site store, retry, deliver and purge with its own role", async () => {
    const { db, a, actAs } = await twoSites();
    const { deps, clock, mail, alerts } = setup({ failWhen: () => true });
    const siteDeps = { ...deps, store: postgresStore(db, a), rateLimiter: postgresRateLimiter(db, a) };
    await actAs(a.role);

    const result = await submitContact(config, siteDeps, await submission("devis", clock.now()), {
      address: "203.0.113.7",
    });
    expect(result).toMatchObject({ status: "accepted", id: "sub-1" });
    mail.failWhen(() => false);
    clock.advance(5 * MINUTE);
    await processDue(config, siteDeps);
    expect(mail.sent.map((email) => email.to)).toEqual([["fondateur@example.test"], [VISITOR.email]]);
    expect(alerts).toEqual([]);
    clock.advance(7 * DAY);
    expect(await purgeDelivered(config, siteDeps)).toBe(1);
  });

  describe("a site can't reach another site's messages", () => {
    it("can't read, add, change or delete them through the kit", async () => {
      const { db, a, b, actAs } = await twoSites();
      const { deps, clock } = setup();
      // Site B has one message waiting.
      await actAs(b.role);
      const bDeps = { ...deps, store: postgresStore(db, b), rateLimiter: postgresRateLimiter(db, b) };
      await submitContact(config, bDeps, await submission("devis", clock.now()));

      // Site A's role, pointed at site B's schema.
      await actAs(a.role);
      const stolen = postgresStore(db, b);
      const record = sampleRecord();
      await expect(stolen.findByToken("any")).rejects.toThrow(DENIED);
      await expect(stolen.insert(record)).rejects.toThrow(DENIED);
      await expect(stolen.claim("sub-1", START, MINUTE)).rejects.toThrow(DENIED);
      await expect(stolen.listDue(START)).rejects.toThrow(DENIED);
      await expect(stolen.deleteDeliveredBefore(START)).rejects.toThrow(DENIED);
      await expect(postgresRateLimiter(db, b).hit("visitor", START, MINUTE, 5, "form-1")).rejects.toThrow(DENIED);

      await actAs(undefined);
      const { rows } = await db.query<{ id: string }>(`select id from site_boulangerie.contact_submissions`);
      expect(rows).toEqual([{ id: "sub-1" }]);
    });

    it.each([
      `select * from site_boulangerie.contact_submissions`,
      `select * from site_boulangerie.contact_rate_hits`,
      `insert into site_boulangerie.contact_rate_hits (key, hit_at) values ('k', now())`,
      `update site_boulangerie.contact_submissions set reason = 'x'`,
      `delete from site_boulangerie.contact_submissions`,
      `truncate site_boulangerie.contact_submissions`,
      `drop table site_boulangerie.contact_submissions`,
      `create table site_boulangerie.extra (x int)`,
    ])("is refused: %s", async (sql) => {
      const { db, a, actAs } = await twoSites();
      await actAs(a.role);
      await expect(db.query(sql)).rejects.toThrow(DENIED);
    });
  });

  describe("refuses a database where the site wouldn't be isolated, and changes nothing", () => {
    type Db = PGlite;
    const provision = (db: Db, site: string) => provisionSite(db, { site, password: `password-for-${site}-000000` });
    const snapshot = async (db: Db) => {
      const { rows } = await db.query(
        `select
           (select count(*)::int from pg_namespace where nspname = 'site_alpha') as schemas,
           (select count(*)::int from pg_roles where rolname = 'site_alpha') as roles,
           (select count(*)::int from pg_shdepend where refobjid = (select oid from pg_roles where rolname = 'site_alpha')) as grants`,
      );
      return rows[0];
    };

    it.each<{ case: string; before: (db: Db) => Promise<unknown>; error: RegExp }>([
      {
        case: "the role can already read another site's messages",
        before: async (db) => {
          await provision(db, "beta");
          await db.exec(`create role site_alpha login;
            grant usage on schema site_beta to site_alpha;
            grant select on site_beta.contact_submissions to site_alpha;`);
        },
        error: /site_beta/,
      },
      ...["superuser", "createdb", "createrole", "replication", "bypassrls", "nologin"].map((attribute) => ({
        case: `the role already exists with ${attribute.toUpperCase()}`,
        before: (db: Db) => db.exec(`create role site_alpha ${attribute === "nologin" ? "" : "login "}${attribute}`),
        error: new RegExp(attribute, "i"),
      })),
      {
        case: "the role is a member of another site's role",
        before: async (db) => {
          await provision(db, "beta");
          await db.exec(`create role site_alpha login; grant site_beta to site_alpha;`);
        },
        error: /member/,
      },
      {
        case: "another site's role is a member of the site's role",
        before: async (db) => {
          await provision(db, "alpha");
          await provision(db, "beta");
          await db.exec(`grant site_alpha to site_beta`);
        },
        error: /member/,
      },
      {
        case: "the role owns something",
        before: (db) =>
          db.exec(`create role site_alpha login; create table public.owned (x int); alter table public.owned owner to site_alpha;`),
        error: /owns/,
      },
      {
        case: "the role gets privileges on tables created later",
        before: (db) =>
          db.exec(`create role site_alpha login; alter default privileges in schema public grant select on tables to site_alpha;`),
        error: /default privileges/,
      },
      {
        case: "the site's schema belongs to someone else",
        before: (db) => db.exec(`create role intruder; create schema site_alpha authorization intruder;`),
        error: /belongs to intruder/,
      },
      {
        case: "another site's role can read the site's messages",
        before: async (db) => {
          await provision(db, "alpha");
          await provision(db, "beta");
          await db.exec(`grant usage on schema site_alpha to site_beta;
            grant select on site_alpha.contact_submissions to site_beta;`);
        },
        error: /site_beta has privileges/,
      },
      {
        case: "everyone can read another site's messages",
        before: async (db) => {
          await provision(db, "beta");
          await db.exec(`grant usage on schema site_beta to public;
            grant select on site_beta.contact_submissions to public;`);
        },
        error: /site_beta\.contact_submissions/,
      },
      {
        case: "everyone can read one column of a table elsewhere",
        before: (db) =>
          db.exec(`create schema other; create table other.secret (value text);
            grant usage on schema other to public; grant select (value) on other.secret to public;`),
        error: /public can select other\.secret/,
      },
      {
        case: "everyone can change one column of another site's messages",
        before: async (db) => {
          await provision(db, "beta");
          await db.exec(`grant usage on schema site_beta to public;
            grant update (reason) on site_beta.contact_submissions to public;`);
        },
        error: /public can update site_beta\.contact_submissions/,
      },
      {
        case: "another site's role can read one column of the site's messages",
        before: async (db) => {
          await provision(db, "alpha");
          await provision(db, "beta");
          await db.exec(`grant usage on schema site_alpha to site_beta;
            grant select (data) on site_alpha.contact_submissions to site_beta;`);
        },
        error: /site_beta has privileges on column data of site_alpha\.contact_submissions/,
      },
      {
        case: "everyone can run a function that runs with its owner's rights",
        before: (db) =>
          db.exec(`create function public.peek() returns bigint language sql security definer
            as 'select count(*) from pg_class';`),
        error: /public can run public\.peek\(\), which runs as postgres/,
      },
      {
        case: "everyone can read a large object",
        before: (db) =>
          db.exec(`select lo_create(4242); grant select on large object 4242 to public;`),
        error: /public can read large object 4242/,
      },
      {
        case: "everyone can create tables in the public schema, as before PostgreSQL 15",
        before: (db) => db.exec(`grant create on schema public to public`),
        error: /create objects in schema public/,
      },
      {
        case: "everyone can create schemas in the database",
        before: (db) => db.exec(`do $$ begin execute format('grant create on database %I to public', current_database()); end $$`),
        error: /create schemas/,
      },
    ])("$case", async ({ before, error }) => {
      const db = new PGlite();
      await before(db);
      const was = await snapshot(db);

      await expect(provision(db, "alpha")).rejects.toThrow(error);

      expect(await snapshot(db)).toEqual(was);
    });
  });

  describe("a site can't change the structure of its own tables", () => {
    it.each([
      `drop table site_atelier.contact_submissions`,
      `truncate site_atelier.contact_submissions`,
      `alter table site_atelier.contact_submissions add column extra text`,
      `create table site_atelier.extra (x int)`,
      `drop schema site_atelier cascade`,
    ])("is refused: %s", async (sql) => {
      const { db, a, actAs } = await twoSites();
      await actAs(a.role);
      await expect(db.query(sql)).rejects.toThrow(/permission denied|must be owner/);
    });
  });
});

function sampleRecord() {
  const pending = { status: "pending" as const, attempts: 0, nextAttemptAt: START.toISOString() };
  return {
    id: "intruder-1",
    reference: "7K3F9QXM",
    tokenId: "token-intruder",
    fingerprint: "fingerprint-1",
    createdAt: START.toISOString(),
    reason: "autre",
    data: { name: "Camille", email: "camille@example.org", message: "Bonjour" },
    messages: { notification: pending, confirmation: pending },
  };
}
