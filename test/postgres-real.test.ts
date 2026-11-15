import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateContactSchema, postgresRateLimiter, postgresStore } from "../src/adapters/postgres";
import { atelierContact as config } from "../src/example/atelier-contact";
import { submitContact, type StoredSubmission } from "../src/kit";
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
