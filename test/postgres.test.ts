import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { migrateContactSchema, postgresRateLimiter, postgresStore, type SqlClient } from "../src/adapters/postgres";
import { provisionSite } from "../src/adapters/postgres-site";
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

const SENT = { status: "sent", attempts: 1, sentAt: START.toISOString() } as const;
/** A message that failed for good, whose alert hasn't gone out. */
const UNALERTED = { status: "failed", attempts: 1, lastError: "rejected_400" } as const;

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
  [
    "postgres, as a site's own role",
    async () => {
      const db = new PGlite();
      const site = await provisionSite(db, { site: "atelier", password: "password-for-site-a-0001" });
      await db.query(`set role ${site.role}`);
      return { store: postgresStore(db, site), limiter: postgresRateLimiter(db, site) };
    },
  ],
];

const at = (minutes: number) => new Date(START.getTime() + minutes * MINUTE);

function record(overrides: Partial<StoredSubmission> = {}): StoredSubmission {
  return {
    id: "sub-1",
    reference: "7K3F9QXM",
    tokenId: `token-of-${overrides.id ?? "sub-1"}`,
    fingerprint: "fingerprint-1",
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
    const delivered = { notification: SENT, confirmation: SENT };
    await store.insert(record({ messages: delivered, deliveredAt: at(0).toISOString() }));
    await store.insert(record({ id: "sub-2", messages: delivered, deliveredAt: at(10).toISOString() }));
    await store.insert(record({ id: "sub-3" }));

    expect(await store.deleteDeliveredBefore(at(5))).toBe(1);
    expect(await store.claim("sub-1", at(5), MINUTE)).toBeUndefined();
    expect(await store.claim("sub-2", at(5), MINUTE)).toBeDefined();
    expect(await store.claim("sub-3", at(5), MINUTE)).toBeDefined();
  });

  it("deletes only the visitor's data while an alert is waiting, then the rest once it has gone out", async () => {
    const { store } = await make();
    await store.insert(record({ messages: { notification: SENT, confirmation: UNALERTED }, deliveredAt: at(0).toISOString() }));

    expect(await store.deleteDeliveredBefore(at(5))).toBe(1);
    expect(await store.deleteDeliveredBefore(at(5))).toBe(0);
    expect(await store.listDue(at(5))).toEqual(["sub-1"]);
    const kept = (await store.claim("sub-1", at(5), MINUTE))!;
    expect(kept).toMatchObject({ id: "sub-1", reference: "7K3F9QXM", reason: "", data: {}, fingerprint: "" });

    await store.release({ ...kept, messages: { ...kept.messages, confirmation: { ...UNALERTED, alertedAt: at(5).toISOString() } } });
    expect(await store.listDue(at(5))).toEqual([]);
    expect(await store.deleteDeliveredBefore(at(5))).toBe(1);
    expect(await store.claim("sub-1", at(5), MINUTE)).toBeUndefined();
  });

  it("never undoes a purge that ran while a run held the lease", async () => {
    const { store } = await make();
    const waiting = { notification: SENT, confirmation: UNALERTED };
    await store.insert(record({ messages: waiting, deliveredAt: at(0).toISOString() }));
    await store.insert(record({ id: "sub-2", messages: { notification: SENT, confirmation: SENT }, deliveredAt: at(0).toISOString() }));

    const emptiedLater = (await store.claim("sub-1", at(5), MINUTE))!;
    const deletedLater = (await store.claim("sub-2", at(5), MINUTE))!;
    expect(await store.deleteDeliveredBefore(at(5))).toBe(2);
    await store.release({ ...emptiedLater, messages: { ...waiting, confirmation: { ...UNALERTED, alertedAt: at(5).toISOString() } } });
    await store.release(deletedLater);

    const kept = (await store.claim("sub-1", at(10), MINUTE))!;
    expect(kept).toMatchObject({ reason: "", data: {}, fingerprint: "" });
    expect(kept.messages.confirmation.alertedAt).toBe(at(5).toISOString());
    expect(JSON.stringify(kept)).not.toContain("camille");
    expect(await store.claim("sub-2", at(10), MINUTE)).toBeUndefined();
    expect(await store.findByToken("token-of-sub-2")).toBeUndefined();
  });

  it("rejects a duplicate ID", async () => {
    const { store } = await make();
    await store.insert(record());
    await expect(store.insert(record({ tokenId: "another-token" }))).rejects.toThrow();
  });

  it("stores one submission per form token, and says which one holds it", async () => {
    const { store } = await make();
    const holder = { id: "sub-1", reference: "7K3F9QXM", fingerprint: "fingerprint-1" };

    expect(await store.findByToken("token-of-sub-1")).toBeUndefined();
    expect(await store.insert(record())).toEqual({ stored: true });
    expect(await store.insert(record({ id: "sub-2", tokenId: "token-of-sub-1", fingerprint: "other" }))).toEqual({
      stored: false,
      existing: holder,
    });
    expect(await store.findByToken("token-of-sub-1")).toEqual(holder);
    expect(await store.claim("sub-2", at(0), MINUTE)).toBeUndefined();
  });

  it("lets only one of several inserts with the same token through", async () => {
    const { store } = await make();
    const ids = ["sub-1", "sub-2", "sub-3", "sub-4"];

    const outcomes = await Promise.all(ids.map((id) => store.insert(record({ id, tokenId: "shared-token" }))));

    expect(outcomes.filter((outcome) => outcome.stored)).toHaveLength(1);
    const holder = await store.findByToken("shared-token");
    for (const outcome of outcomes) {
      if (!outcome.stored) expect(outcome.existing).toEqual(holder);
    }
  });

  it("allows `max` hits per key in the window, then lets old hits expire", async () => {
    const { limiter } = await make();
    const results: boolean[] = [];
    for (let i = 0; i < 4; i += 1) results.push(await limiter.hit("visitor-a", at(i), 60 * MINUTE, 3, `form-${i}`));
    expect(results).toEqual([true, true, true, false]);
    expect(await limiter.hit("visitor-b", at(4), 60 * MINUTE, 3, "form-b")).toBe(true);
    expect(await limiter.hit("visitor-a", at(61), 60 * MINUTE, 3, "form-4")).toBe(true);
  });

  it("counts the same form once, however many times it arrives", async () => {
    const { limiter } = await make();

    expect(await limiter.hit("visitor-a", at(0), 60 * MINUTE, 1, "form-1")).toBe(true);
    expect(await limiter.hit("visitor-a", at(1), 60 * MINUTE, 1, "form-1")).toBe(true);
    expect(await limiter.hit("visitor-a", at(1), 60 * MINUTE, 1, "form-2")).toBe(false);

    const together = await Promise.all(
      [1, 2, 3].map(() => limiter.hit("visitor-b", at(0), 60 * MINUTE, 1, "form-3")),
    );
    expect(together).toEqual([true, true, true]);
    expect(await limiter.hit("visitor-b", at(1), 60 * MINUTE, 1, "form-4")).toBe(false);
  });
});

/** The tables as the first version of the kit created them, before references and single-use tokens. */
const FIRST_SCHEMA_SQL = `
create table contact_submissions (
  id text primary key,
  created_at timestamptz not null,
  reason text not null,
  data jsonb not null,
  messages jsonb not null,
  next_due_at timestamptz,
  delivered_at timestamptz,
  locked_until timestamptz
);
create index contact_submissions_next_due on contact_submissions (next_due_at) where next_due_at is not null;
create index contact_submissions_delivered on contact_submissions (delivered_at) where delivered_at is not null;
create table contact_rate_hits (
  key text not null,
  hit_at timestamptz not null
);
create index contact_rate_hits_key on contact_rate_hits (key, hit_at)
`;

describe("upgrading a database created by the first version", () => {
  it("keeps a submission that is still waiting, and delivers it", async () => {
    const db = new PGlite();
    for (const statement of FIRST_SCHEMA_SQL.split(";")) await db.query(statement);
    const waiting = record({ id: "old-1" });
    await db.query(
      `insert into contact_submissions (id, created_at, reason, data, messages, next_due_at)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $2)`,
      [waiting.id, waiting.createdAt, waiting.reason, JSON.stringify(waiting.data), JSON.stringify(waiting.messages)],
    );
    await db.query(`insert into contact_rate_hits (key, hit_at) values ('visitor-a', $1)`, [START.toISOString()]);

    // Failed before alerts were tracked, so whether their alert went out is unknown:
    // one with nothing else to do, one whose other message waits for a retry an hour later.
    const failedOnly = record({ id: "old-2", messages: { notification: UNALERTED, confirmation: SENT } });
    const failedAndWaiting = record({
      id: "old-3",
      messages: { notification: SENT, confirmation: { ...UNALERTED, lastError: "provider_503" } },
    });
    failedAndWaiting.messages.notification = { status: "pending", attempts: 1, nextAttemptAt: at(60).toISOString() };
    for (const [old, nextDue] of [[failedOnly, null], [failedAndWaiting, at(60).toISOString()]] as const) {
      await db.query(
        `insert into contact_submissions (id, created_at, reason, data, messages, next_due_at) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
        [old.id, old.createdAt, old.reason, JSON.stringify(old.data), JSON.stringify(old.messages), nextDue],
      );
    }

    await migrateContactSchema(db);
    await migrateContactSchema(db); // upgrading twice must be harmless

    const { deps, mail, alerts } = setup();
    const pgDeps = { ...deps, store: postgresStore(db), rateLimiter: postgresRateLimiter(db) };
    expect((await pgDeps.store.listDue(at(0))).sort()).toEqual(["old-1", "old-2", "old-3"]);
    await processDue(config, pgDeps);
    expect(mail.sent.map((email) => email.to)).toEqual([["atelier@example.test"], ["camille@example.org"]]);
    // The old alerts are sent again, once each, and the waiting retry keeps its time.
    expect(alerts.map((alert) => alert.kind === "delivery_failed" && [alert.submissionId, alert.message]).sort()).toEqual([
      ["old-2", "notification"],
      ["old-3", "confirmation"],
    ]);
    await migrateContactSchema(db);
    expect(await pgDeps.store.listDue(at(0))).toEqual([]);
    expect(await pgDeps.store.listDue(at(60))).toEqual(["old-3"]);
    await processDue(config, pgDeps);
    expect(alerts).toHaveLength(2);
    expect(mail.sent[0]?.text).toMatch(/Référence\u00a0: [2-9A-HJKMNP-TV-Z]{8}\n/);

    // New submissions and the rate limit work on the upgraded tables.
    const result = await submitContact(config, pgDeps, await submission("devis", at(0)), { address: "203.0.113.7" });
    expect(result).toMatchObject({ status: "accepted" });
    expect(await pgDeps.rateLimiter.hit("visitor-a", at(1), 60 * MINUTE, 1, "form-1")).toBe(false);
  });
});

describe("the whole flow on Postgres", () => {
  it("keeps sending other messages while more than 100 alerts keep failing", async () => {
    const db = await freshDatabase();
    const { deps, mail, failAlerts } = setup();
    const store = postgresStore(db);
    const pgDeps = { ...deps, store };
    failAlerts(true);
    for (let i = 1; i <= 150; i += 1) {
      await store.insert(record({ id: `failed-${i}`, messages: { notification: UNALERTED, confirmation: SENT } }));
    }
    await store.insert(record({ id: "waiting", messages: { notification: SENT, confirmation: record().messages.confirmation } }));

    // Each run takes 100; failed alerts move back, so the waiting message gets its turn by the second run.
    expect(await processDue(config, pgDeps)).toBe(100);
    expect(mail.sent).toEqual([]);
    expect(await processDue(config, pgDeps)).toBe(51);
    expect(mail.sent.map((email) => email.to)).toEqual([["camille@example.org"]]);
    expect(await store.listDue(deps.clock.now())).toEqual([]);
  });

  it("stores, retries through an outage, delivers once, and purges after 7 days", async () => {
    const db = await freshDatabase();
    const { deps, clock, mail, alerts } = setup({ failWhen: () => true });
    const pgDeps = { ...deps, store: postgresStore(db), rateLimiter: postgresRateLimiter(db) };

    const result = await submitContact(config, pgDeps, await submission("devis", clock.now()), { address: "203.0.113.7" });
    expect(result).toMatchObject({ status: "accepted", id: "sub-1" });

    mail.failWhen(() => false);
    clock.advance(5 * MINUTE);
    await Promise.all([processDue(config, pgDeps), processDue(config, pgDeps), deliverSubmission(config, pgDeps, "sub-1")]);
    expect(mail.sent.map((email) => email.to)).toEqual([["fondateur@example.test"], [VISITOR.email]]);
    expect(alerts).toEqual([]);

    const { rows } = await db.query<{ key: string }>("select key from contact_rate_hits");
    expect(rows.map((row) => row.key).join(" ")).not.toContain("203.0.113.7");

    clock.advance(7 * DAY);
    expect(await purgeDelivered(config, pgDeps)).toBe(1);
  });

  it("stores and sends once when the same form arrives twice at the same moment", async () => {
    const db = await freshDatabase();
    const { deps, clock, mail } = setup();
    const pgDeps = { ...deps, store: postgresStore(db), rateLimiter: postgresRateLimiter(db) };
    const form = await submission("devis", clock.now());

    const [first, second] = await Promise.all([submitContact(config, pgDeps, form), submitContact(config, pgDeps, form)]);

    expect(first).toMatchObject({ status: "accepted" });
    expect(second).toEqual(first);
    const { rows } = await db.query<{ id: string }>("select id from contact_submissions");
    expect(rows).toHaveLength(1);
    expect(mail.attempts).toHaveLength(2);
  });
});
