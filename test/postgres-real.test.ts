import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateContactSchema, postgresRateLimiter, postgresStore } from "../src/adapters/postgres";
import { checkSite, provisionSite } from "../src/adapters/postgres-site";
import { atelierContact as config } from "../src/example/atelier-contact";
import { processDue, submitContact, type StoredSubmission } from "../src/kit";
import { MINUTE, setup, START, submission } from "./support";

/**
 * The guarantees that need several real database connections at once. PGlite,
 * which the other Postgres tests use, runs one query at a time, so it can't
 * show them.
 *
 * Runs only when TEST_DATABASE_URL points at a real PostgreSQL server:
 *
 *   TEST_DATABASE_URL=postgres://user:password@host:5432/database pnpm test
 *
 * Everything happens in a schema of its own, dropped at the end.
 */
const url = process.env["TEST_DATABASE_URL"];
const CONNECTIONS = 10;
const REQUESTS = 30;

const at = (minutes: number) => new Date(START.getTime() + minutes * MINUTE);
const times = <T>(count: number, make: (index: number) => Promise<T>) =>
  Promise.all(Array.from({ length: count }, (_unused, index) => make(index)));

function record(id: string, tokenId: string): StoredSubmission {
  const pending = { status: "pending" as const, attempts: 0, nextAttemptAt: START.toISOString() };
  return {
    id,
    reference: "7K3F9QXM",
    tokenId,
    fingerprint: "fingerprint-1",
    createdAt: START.toISOString(),
    reason: "autre",
    data: { name: "Camille", email: "camille@example.org", message: "Bonjour" },
    messages: { notification: pending, confirmation: pending },
  };
}

describe.skipIf(url === undefined)("on a real PostgreSQL server, with several connections at once", () => {
  const schema = `form_kit_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`create schema ${schema}`);
    pool = new pg.Pool({ connectionString: url, max: CONNECTIONS, options: `-c search_path=${schema}` });
    await migrateContactSchema(pool);
    // Open every connection first, so the requests below really run side by side.
    const clients = await times(CONNECTIONS, () => pool.connect());
    for (const client of clients) client.release();
    expect(pool.totalCount).toBe(CONNECTIONS);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop schema if exists ${schema} cascade`);
    await admin?.end();
  });

  it("stores one submission when many inserts carry the same form token", async () => {
    const store = postgresStore(pool);

    const outcomes = await times(REQUESTS, (index) => store.insert(record(`insert-${index}`, "token-shared")));

    expect(outcomes.filter((outcome) => outcome.stored)).toHaveLength(1);
    const holder = await store.findByToken("token-shared");
    expect(holder).toBeDefined();
    for (const outcome of outcomes) {
      if (!outcome.stored) expect(outcome.existing).toEqual(holder);
    }
    const { rows } = await pool.query(`select id from contact_submissions where token_id = 'token-shared'`);
    expect(rows).toHaveLength(1);
  });

  it("gives the delivery lease to one of many runs", async () => {
    const store = postgresStore(pool);
    await store.insert(record("lease-1", "token-lease"));

    const claims = await times(REQUESTS, () => store.claim("lease-1", at(0), 2 * MINUTE));

    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
  });

  it("counts one form once at the rate limit, and still refuses another form", async () => {
    const limiter = postgresRateLimiter(pool);

    const sameForm = await times(REQUESTS, () => limiter.hit("visitor-real", at(0), 60 * MINUTE, 1, "form-1"));

    expect(sameForm.every((allowed) => allowed)).toBe(true);
    expect(await limiter.hit("visitor-real", at(1), 60 * MINUTE, 1, "form-2")).toBe(false);
    const { rows } = await pool.query(`select key from contact_rate_hits where key = 'visitor-real'`);
    expect(rows).toHaveLength(1);
  });

  it("stores and sends once when the same form arrives many times together, at the visitor's rate limit", async () => {
    const { deps, clock, mail } = setup();
    let next = 0;
    const pgDeps = {
      ...deps,
      store: postgresStore(pool),
      rateLimiter: postgresRateLimiter(pool),
      newId: () => `submit-${++next}`,
    };
    const oneAnHour = { ...config, spam: { ...config.spam, rateLimitMax: 1 } };
    const visitor = { address: "203.0.113.7" };
    const form = await submission("devis", clock.now());

    const results = await times(REQUESTS, () => submitContact(oneAnHour, pgDeps, form, visitor));

    expect(results[0]).toMatchObject({ status: "accepted" });
    for (const result of results) expect(result).toEqual(results[0]);
    const { rows } = await pool.query(`select id from contact_submissions where id like 'submit-%'`);
    expect(rows).toHaveLength(1);
    expect(mail.attempts).toHaveLength(2);
  });
});

/**
 * Each site logs in with its own role. `set role` in PGlite shows the
 * permissions; only a real login shows that a site can't become another site.
 */
describe.skipIf(url === undefined)("on a real PostgreSQL server, logged in as a site's own role", () => {
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const sites = { a: `test_a_${suffix}`, b: `test_b_${suffix}` };
  const passwords = { a: `pw-a-${suffix}-${Math.random()}`, b: `pw-b-${suffix}-${Math.random()}` };
  let admin: pg.Pool;
  let asA: pg.Pool;
  let a: Awaited<ReturnType<typeof provisionSite>>;
  let b: Awaited<ReturnType<typeof provisionSite>>;

  const loginUrl = (role: string, password: string) => {
    const login = new URL(url!);
    login.username = role;
    login.password = password;
    return login.toString();
  };
  const loginAs = (role: string, password: string) => new pg.Pool({ connectionString: loginUrl(role, password), max: 2 });

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url, max: 1 });
    a = await provisionSite(admin, { site: sites.a, password: passwords.a });
    b = await provisionSite(admin, { site: sites.b, password: passwords.b });
    asA = loginAs(a.role, passwords.a);
  });

  afterAll(async () => {
    await asA?.end();
    for (const site of [a, b]) {
      if (site === undefined) continue;
      await admin.query(`drop schema if exists ${site.schema} cascade`);
      await admin.query(`drop role if exists ${site.role}`);
    }
    await admin?.end();
  });

  it("stores and delivers through the kit", async () => {
    const { deps, clock, mail } = setup();
    const siteDeps = { ...deps, store: postgresStore(asA, a), rateLimiter: postgresRateLimiter(asA, a) };

    const result = await submitContact(config, siteDeps, await submission("devis", clock.now()), {
      address: "203.0.113.7",
    });
    await processDue(config, siteDeps);

    expect(result).toMatchObject({ status: "accepted" });
    expect(mail.sent).toHaveLength(2);
    const { rows } = await asA.query<{ current_user: string }>(`select current_user`);
    expect(rows[0]?.current_user).toBe(a.role);
  });

  it("finds its own tables without being told the schema", async () => {
    const { rows } = await asA.query(`select id from contact_submissions`);
    expect(rows).toHaveLength(1);
  });

  it("can't reach the other site's tables, through the kit or directly", async () => {
    const denied = /permission denied/;
    await expect(postgresStore(asA, b).findByToken("any")).rejects.toThrow(denied);
    await expect(postgresStore(asA, b).listDue(START)).rejects.toThrow(denied);
    await expect(postgresRateLimiter(asA, b).hit("visitor", START, MINUTE, 5, "form-1")).rejects.toThrow(denied);
    await expect(asA.query(`select * from ${b.schema}.contact_submissions`)).rejects.toThrow(denied);
    await expect(asA.query(`delete from ${b.schema}.contact_submissions`)).rejects.toThrow(denied);
  });

  it("can't become the other site or the administrator", async () => {
    await expect(asA.query(`set role ${b.role}`)).rejects.toThrow(/permission denied/);
    const { rows } = await admin.query<{ current_user: string }>(`select current_user`);
    await expect(asA.query(`set role ${rows[0]!.current_user}`)).rejects.toThrow(/permission denied/);
  });

  it("can't change the structure of its own tables, or create anything", async () => {
    const refused = /permission denied|must be owner/;
    await expect(asA.query(`drop table ${a.schema}.contact_submissions`)).rejects.toThrow(refused);
    await expect(asA.query(`create table ${a.schema}.extra (x int)`)).rejects.toThrow(refused);
    await expect(asA.query(`create table public.extra_${suffix} (x int)`)).rejects.toThrow(refused);
    await expect(asA.query(`create schema extra_${suffix}`)).rejects.toThrow(refused);
  });

  it.each([
    ["can already read the other site's messages", (role: string) => [
      `create role ${role} login`,
      `grant usage on schema ${b.schema} to ${role}`,
      `grant select on ${b.schema}.contact_submissions to ${role}`,
    ]],
    // Not SUPERUSER: managed services such as Scaleway don't let the administrator grant it. PGlite covers it.
    ["can create databases", (role: string) => [`create role ${role} login createdb`]],
  ])("refuses to set up a site whose existing role %s, and changes nothing", async (_case, before) => {
    const site = `test_c_${suffix}`;
    const role = `site_${site}`;
    try {
      for (const statement of before(role)) await admin.query(statement);

      await expect(provisionSite(admin, { site, password: `pw-c-${suffix}-${Math.random()}` })).rejects.toThrow(
        /can't be set up safely, and nothing was changed/,
      );

      const { rows } = await admin.query(`select 1 from pg_namespace where nspname = $1`, [role]);
      expect(rows).toEqual([]);
    } finally {
      // Without superuser (managed services), dropping what a role owns needs its privileges: the admin, which created it,
      // grants them to itself first. GRANT doesn't accept current_user here, so the admin is named, and INHERIT and SET
      // are explicit: the grant PostgreSQL 16+ gave the creator has them off, and a plain GRANT keeps them that way.
      const { rows: me } = await admin.query<{ name: string }>(`select current_user as name`);
      await admin.query(`grant ${role} to "${me[0]!.name}" with inherit true, set true`).catch(() => undefined);
      await admin.query(`drop owned by ${role}`).catch(() => undefined);
      await admin.query(`drop role if exists ${role}`);
    }
  });

  it("refuses to set up a site when everyone can read one column of a table elsewhere", async () => {
    const other = `other_${suffix}`;
    const site = `test_d_${suffix}`;
    try {
      await admin.query(`create schema ${other}`);
      await admin.query(`create table ${other}.secret (value text)`);
      await admin.query(`grant usage on schema ${other} to public`);
      await admin.query(`grant select (value) on ${other}.secret to public`);

      await expect(provisionSite(admin, { site, password: `pw-d-${suffix}-${Math.random()}` })).rejects.toThrow(
        new RegExp(`public can select ${other}\\.secret`),
      );

      const { rows } = await admin.query(`select 1 from pg_roles where rolname = $1`, [`site_${site}`]);
      expect(rows).toEqual([]);
    } finally {
      await admin.query(`drop schema if exists ${other} cascade`);
    }
  });

  it("refuses connections over the site's limit", async () => {
    const site = `test_e_${suffix}`;
    const password = `pw-e-${suffix}`;
    const c = await provisionSite(admin, { site, password, connectionLimit: 1 });
    const first = new pg.Client({ connectionString: loginUrl(c.role, password) });
    const second = new pg.Client({ connectionString: loginUrl(c.role, password) });
    try {
      await first.connect();
      await expect(second.connect()).rejects.toThrow(/too many connections for role/);
    } finally {
      await first.end().catch(() => {});
      await second.end().catch(() => {});
      await admin.query(`drop schema if exists ${c.schema} cascade`);
      await admin.query(`drop role if exists ${c.role}`);
    }
  });

  it("can't log in with the wrong password, or as the other site with its own", async () => {
    const wrong = loginAs(a.role, "not-the-password");
    await expect(wrong.query(`select 1`)).rejects.toThrow(/password authentication failed/);
    await wrong.end();
    const crossed = loginAs(b.role, passwords.a);
    await expect(crossed.query(`select 1`)).rejects.toThrow(/password authentication failed/);
    await crossed.end();
  });
});

/**
 * What the audit stands for, shown by behaviour: with a changed unique index a
 * duplicate really is stored, and the audit says so; with the kit's own index
 * the server refuses it. Also server settings, which only a real server grants
 * the way production does. It uses a database of its own, dropped at the end.
 */
describe.skipIf(url === undefined)("the audit, against what a real server enforces", () => {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1e4)}`.slice(-10);
  const database = `form_kit_audit_${suffix}`;
  const site = `audit${suffix}`;
  const role = `site_${site}`;
  const submissions = `"${role}".contact_submissions`;
  const hits = `"${role}".contact_rate_hits`;
  let server: pg.Client;
  let db: pg.Client;

  beforeAll(async () => {
    server = new pg.Client({ connectionString: url });
    await server.connect();
    await server.query(`create database ${database}`);
    const own = new URL(url!);
    own.pathname = `/${database}`;
    db = new pg.Client({ connectionString: own.toString() });
    await db.connect();
    await provisionSite(db, { site, password: "password-for-the-audit-0001" });
  });

  afterAll(async () => {
    await db?.query(`revoke all on parameter work_mem from ${role}`).catch(() => {});
    await db?.end();
    await server?.query(`drop database if exists ${database} with (force)`);
    await server?.query(`drop role if exists ${role}`);
    await server?.end();
  });

  const insertToken = (id: string, fingerprint: string) =>
    db.query(
      `insert into ${submissions} (id, reference, token_id, fingerprint, created_at, reason, data, messages)
       values ($1, 'r', 'one-token', $2, now(), 'autre', '{}', '{}')`,
      [id, fingerprint],
    );
  const insertHit = (at: string) => db.query(`insert into ${hits} (key, hit_at, form_id) values ('visitor', $1, 'one-form')`, [at]);

  it("passes as set up, and the server refuses a second submission or hit for one form", async () => {
    expect(await checkSite(db, site)).toEqual([]);
    await insertToken("a", "first");
    await expect(insertToken("b", "second")).rejects.toThrow(/contact_submissions_token/);
    await insertHit("2026-01-01T00:00:00Z");
    await expect(insertHit("2026-01-01T00:01:00Z")).rejects.toThrow(/contact_rate_hits_form/);
  });

  it.each([
    [
      "token",
      "contact_submissions_token",
      () => `create unique index contact_submissions_token on ${submissions} (token_id, lower(fingerprint))`,
      () => insertToken("c", "third"),
      () => `delete from ${submissions} where id = 'c'`,
      () => `create unique index contact_submissions_token on ${submissions} (token_id)`,
    ],
    [
      "rate-limit",
      "contact_rate_hits_form",
      () => `create unique index contact_rate_hits_form on ${hits} (key, form_id, hit_at)`,
      () => insertHit("2026-01-01T00:02:00Z"),
      () => `delete from ${hits} where hit_at = '2026-01-01T00:02:00Z'`,
      () => `create unique index contact_rate_hits_form on ${hits} (key, form_id)`,
    ],
  ])("catches a %s index that lets a duplicate in", async (_name, index, broken, duplicate, undo, restore) => {
    await db.query(`drop index "${role}".${index}`);
    await db.query(broken());

    await expect(duplicate()).resolves.toBeDefined();
    expect((await checkSite(db, site)).join("\n")).toContain(`${index} isn't the one the kit creates`);

    await db.query(undo());
    await db.query(`drop index "${role}".${index}`);
    await db.query(restore());
    expect(await checkSite(db, site)).toEqual([]);
  });

  it.each([
    ["without grant option", ""],
    ["with grant option", " with grant option"],
  ])("refuses a server setting granted %s", async (_name, option) => {
    await db.query(`grant set, alter system on parameter work_mem to ${role}${option}`);

    const problems = (await checkSite(db, site)).join("\n");

    expect(problems).toContain("work_mem");
    if (option) expect(problems).toContain("with grant option");
    await db.query(`revoke all on parameter work_mem from ${role} cascade`);
    expect(await checkSite(db, site)).toEqual([]);
  });
});
