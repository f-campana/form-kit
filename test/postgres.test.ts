import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { migrateContactSchema, postgresRateLimiter, postgresStore, type SqlClient } from "../src/adapters/postgres";
import { atelierContact as config } from "../src/example/atelier-contact";
import {
  deliverSubmission,
  memoryRateLimiter,
  memoryStore,
  processDue,
  purgeDelivered,
  submitContact,
  type RateLimiter,
  type StoredSubmission,
  type SubmissionStore,
} from "../src/kit";
import { DAY, MINUTE, setup, START, submission, VISITOR } from "./support";

/** A fresh in-process Postgres with the kit's tables. */
async function freshDatabase(): Promise<SqlClient> {
  const db = new PGlite();
  await migrateContactSchema(db);
  await migrateContactSchema(db); // running the schema twice must be harmless
  return db;
}

const stores: [string, () => Promise<{ store: SubmissionStore; limiter: RateLimiter }>][] = [
  ["memory", async () => ({ store: memoryStore(), limiter: memoryRateLimiter() })],
  [
    "postgres",
    async () => {
      const db = await freshDatabase();
      return { store: postgresStore(db), limiter: postgresRateLimiter(db) };
    },
  ],
];

const at = (minutes: number) => new Date(START.getTime() + minutes * MINUTE);

function record(overrides: Partial<StoredSubmission> = {}): StoredSubmission {
  return {
    id: "sub-1",
    createdAt: START.toISOString(),
    reason: "autre",
    data: { name: "Camille", email: "camille@example.org", message: "Bonjour\nà vous" },
    messages: {
      notification: { status: "pending", attempts: 0, nextAttemptAt: START.toISOString() },
      confirmation: { status: "pending", attempts: 0, nextAttemptAt: START.toISOString() },
    },
    ...overrides,
  };
}

describe.each(stores)("%s store: the contract the kit relies on", (_name, make) => {
  it("gives the lease to one run at a time, until it's released or expires", async () => {
    const { store } = await make();
    await store.insert(record());

    const first = await store.claim("sub-1", at(0), 2 * MINUTE);
    expect(first?.data["message"]).toBe("Bonjour\nà vous");
    expect(await store.claim("sub-1", at(1), 2 * MINUTE)).toBeUndefined();
    expect(await store.claim("sub-1", at(2), 2 * MINUTE)).toBeDefined(); // the first lease expired

    await store.release({ ...first!, messages: { ...first!.messages } });
    expect(await store.claim("sub-1", at(2), 2 * MINUTE)).toBeDefined();
    expect(await store.claim("missing", at(2), 2 * MINUTE)).toBeUndefined();
  });

  it("lists only submissions with a message due, and keeps saved state", async () => {
    const { store } = await make();
    await store.insert(record());
    await store.insert(record({ id: "sub-2", createdAt: at(1).toISOString() }));

    const claimed = (await store.claim("sub-1", at(0), MINUTE))!;
    claimed.messages = {
      notification: { status: "sent", attempts: 1, sentAt: at(0).toISOString() },
      confirmation: { status: "pending", attempts: 1, nextAttemptAt: at(5).toISOString(), lastError: "busy_429" },
    };
    await store.release(claimed);

    expect(await store.listDue(at(4))).toEqual(["sub-2"]);
    expect((await store.listDue(at(5))).sort()).toEqual(["sub-1", "sub-2"]);
    expect((await store.claim("sub-1", at(5), MINUTE))?.messages.confirmation).toEqual({
      status: "pending",
      attempts: 1,
      nextAttemptAt: at(5).toISOString(),
      lastError: "busy_429",
    });
  });

  it("deletes only submissions delivered before the cutoff", async () => {
    const { store } = await make();
    await store.insert(record({ deliveredAt: at(0).toISOString() }));
    await store.insert(record({ id: "sub-2", deliveredAt: at(10).toISOString() }));
    await store.insert(record({ id: "sub-3" }));

    expect(await store.deleteDeliveredBefore(at(5))).toBe(1);
    expect(await store.claim("sub-1", at(5), MINUTE)).toBeUndefined();
    expect(await store.claim("sub-3", at(5), MINUTE)).toBeDefined();
  });

  it("rejects a duplicate ID", async () => {
    const { store } = await make();
    await store.insert(record());
    await expect(store.insert(record())).rejects.toThrow();
  });

  it("allows `max` hits per key in the window, then lets old hits expire", async () => {
    const { limiter } = await make();
    const results: boolean[] = [];
    for (let i = 0; i < 4; i += 1) results.push(await limiter.hit("visitor-a", at(i), 60 * MINUTE, 3));
    expect(results).toEqual([true, true, true, false]);
    expect(await limiter.hit("visitor-b", at(4), 60 * MINUTE, 3)).toBe(true);
    expect(await limiter.hit("visitor-a", at(61), 60 * MINUTE, 3)).toBe(true);
  });
});

describe("the whole flow on Postgres", () => {
  it("stores, retries through an outage, delivers once, and purges after 30 days", async () => {
    const db = await freshDatabase();
    const { deps, clock, mail, alerts } = setup({ failWhen: () => true });
    const pgDeps = { ...deps, store: postgresStore(db), rateLimiter: postgresRateLimiter(db) };

    const result = await submitContact(config, pgDeps, await submission("devis", clock.now()), { address: "203.0.113.7" });
    expect(result).toEqual({ status: "accepted", id: "sub-1" });

    mail.failWhen(() => false);
    clock.advance(5 * MINUTE);
    await Promise.all([processDue(config, pgDeps), processDue(config, pgDeps), deliverSubmission(config, pgDeps, "sub-1")]);
    expect(mail.sent.map((email) => email.to)).toEqual([["fondateur@example.test"], [VISITOR.email]]);
    expect(alerts).toEqual([]);

    const { rows } = await db.query<{ key: string }>("select key from contact_rate_hits");
    expect(rows.map((row) => row.key).join(" ")).not.toContain("203.0.113.7");

    clock.advance(30 * DAY);
    expect(await purgeDelivered(config, pgDeps)).toBe(1);
  });
});
