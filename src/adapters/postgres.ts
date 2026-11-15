import {
  referenceFor,
  type MessageState,
  type RateLimiter,
  type StoredSubmission,
  type SubmissionStore,
  type TokenHolder,
} from "../kit";

/**
 * The one method this adapter needs from a Postgres client. A `pg` Pool, the
 * Pool from `@neondatabase/serverless` and PGlite all fit it.
 */
export interface SqlClient {
  query<Row>(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

/**
 * Tables for the delivery buffer and the rate limit, written so the same
 * statements set up a new database and upgrade one an earlier version of the
 * kit created. Each `add column` is for tables that predate the column.
 */
const TABLES_SQL = [
  `create table if not exists contact_submissions (
    id text primary key,
    reference text,
    token_id text,
    fingerprint text,
    created_at timestamptz not null,
    reason text not null,
    data jsonb not null,
    messages jsonb not null,
    next_due_at timestamptz,
    delivered_at timestamptz,
    locked_until timestamptz
  )`,
  `alter table contact_submissions add column if not exists reference text`,
  `alter table contact_submissions add column if not exists token_id text`,
  `alter table contact_submissions add column if not exists fingerprint text`,
  `create table if not exists contact_rate_hits (
    key text not null,
    hit_at timestamptz not null,
    form_id text
  )`,
  `alter table contact_rate_hits add column if not exists form_id text`,
];

/** Run once every submission has a reference, a token ID and a fingerprint. */
const CONSTRAINTS_SQL = [
  `alter table contact_submissions alter column reference set not null`,
  `alter table contact_submissions alter column token_id set not null`,
  `alter table contact_submissions alter column fingerprint set not null`,
  `create unique index if not exists contact_submissions_token on contact_submissions (token_id)`,
  `create index if not exists contact_submissions_next_due on contact_submissions (next_due_at) where next_due_at is not null`,
  `create index if not exists contact_submissions_delivered on contact_submissions (delivered_at) where delivered_at is not null`,
  `create index if not exists contact_rate_hits_key on contact_rate_hits (key, hit_at)`,
  `create unique index if not exists contact_rate_hits_form on contact_rate_hits (key, form_id)`,
];

/**
 * Creates or upgrades the kit's tables. Safe to run on every deploy.
 *
 * Submissions stored by an earlier version are kept: each gets its reference,
 * and a token ID no form token can match, so it is still delivered and purged
 * as before.
 */
export async function migrateContactSchema(client: SqlClient): Promise<void> {
  for (const statement of TABLES_SQL) await client.query(statement);

  const { rows } = await client.query<{ id: string }>(
    `select id from contact_submissions where reference is null or token_id is null or fingerprint is null`,
  );
  for (const { id } of rows) {
    await client.query(
      `update contact_submissions
       set reference = coalesce(reference, $2), token_id = coalesce(token_id, $3), fingerprint = coalesce(fingerprint, '')
       where id = $1`,
      [id, await referenceFor(id), `before-tokens:${id}`],
    );
  }

  for (const statement of CONSTRAINTS_SQL) await client.query(statement);
}

interface SubmissionRow {
  id: string;
  reference: string;
  token_id: string;
  fingerprint: string;
  created_at: Date | string;
  reason: string;
  data: Record<string, string>;
  messages: StoredSubmission["messages"];
  delivered_at: Date | string | null;
  locked_until: Date | string | null;
}

const iso = (value: Date | string) => new Date(value).toISOString();

/** The earliest time a pending message is due, or null when nothing is pending. Kept in a column so it can be indexed. */
function nextDueAt(messages: StoredSubmission["messages"]): string | null {
  const due = Object.values(messages)
    .filter((state: MessageState) => state.status === "pending")
    .map((state) => state.nextAttemptAt ?? new Date(0).toISOString())
    .sort();
  return due[0] ?? null;
}

function toRecord(row: SubmissionRow): StoredSubmission {
  return {
    id: row.id,
    reference: row.reference,
    tokenId: row.token_id,
    fingerprint: row.fingerprint,
    createdAt: iso(row.created_at),
    reason: row.reason,
    data: row.data,
    messages: row.messages,
    ...(row.delivered_at === null ? {} : { deliveredAt: iso(row.delivered_at) }),
    ...(row.locked_until === null ? {} : { lockedUntil: iso(row.locked_until) }),
  };
}

/**
 * Keeps submissions in Postgres. Each method is one statement, so overlapping
 * serverless runs can't both take the same delivery lease.
 */
export function postgresStore(client: SqlClient): SubmissionStore {
  async function findByToken(tokenId: string): Promise<TokenHolder | undefined> {
    const { rows } = await client.query<TokenHolder>(
      `select id, reference, fingerprint from contact_submissions where token_id = $1`,
      [tokenId],
    );
    const row = rows[0];
    return row === undefined ? undefined : { id: row.id, reference: row.reference, fingerprint: row.fingerprint };
  }

  return {
    findByToken,

    async insert(record) {
      // The unique index on token_id makes checking the token and saving one
      // step: of several inserts with the same token, the database keeps one.
      const { rows } = await client.query<{ id: string }>(
        `insert into contact_submissions
           (id, reference, token_id, fingerprint, created_at, reason, data, messages, next_due_at, delivered_at)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
         on conflict (token_id) do nothing
         returning id`,
        [
          record.id,
          record.reference,
          record.tokenId,
          record.fingerprint,
          record.createdAt,
          record.reason,
          JSON.stringify(record.data),
          JSON.stringify(record.messages),
          nextDueAt(record.messages),
          record.deliveredAt ?? null,
        ],
      );
      if (rows.length > 0) return { stored: true };
      const existing = await findByToken(record.tokenId);
      return existing === undefined ? { stored: false } : { stored: false, existing };
    },

    async claim(id, now, leaseMs) {
      const { rows } = await client.query<SubmissionRow>(
        `update contact_submissions set locked_until = $3
         where id = $1 and (locked_until is null or locked_until <= $2)
         returning id, reference, token_id, fingerprint, created_at, reason, data, messages, delivered_at, locked_until`,
        [id, now.toISOString(), new Date(now.getTime() + leaseMs).toISOString()],
      );
      return rows[0] === undefined ? undefined : toRecord(rows[0]);
    },

    async release(record) {
      await client.query(
        `update contact_submissions
         set messages = $2::jsonb, next_due_at = $3, delivered_at = $4, locked_until = null
         where id = $1`,
        [record.id, JSON.stringify(record.messages), nextDueAt(record.messages), record.deliveredAt ?? null],
      );
    },

    async listDue(now) {
      const { rows } = await client.query<{ id: string }>(
        `select id from contact_submissions where next_due_at <= $1 order by next_due_at limit 100`,
        [now.toISOString()],
      );
      return rows.map((row) => row.id);
    },

    async deleteDeliveredBefore(cutoff) {
      const { rows } = await client.query<{ id: string }>(
        `delete from contact_submissions where delivered_at <= $1 returning id`,
        [cutoff.toISOString()],
      );
      return rows.length;
    },
  };
}

/**
 * Counts hits per hashed visitor key in Postgres, and deletes hits once they
 * leave the window, so addresses are kept, hashed, only briefly. The unique
 * index on (key, form_id) makes one form count once, even when it arrives
 * several times at the same moment. Two different forms from one visitor at
 * the very same moment can both get through; for a contact form that slight
 * overshoot doesn't matter.
 */
export function postgresRateLimiter(client: SqlClient): RateLimiter {
  return {
    async hit(key, now, windowMs, max, formId) {
      const since = new Date(now.getTime() - windowMs).toISOString();
      await client.query(`delete from contact_rate_hits where hit_at <= $1`, [since]);
      const { rows } = await client.query<{ key: string }>(
        `insert into contact_rate_hits (key, hit_at, form_id)
         select $1, $2, $5
         where (select count(*) from contact_rate_hits where key = $1 and hit_at > $3) < $4
         on conflict (key, form_id) do nothing
         returning key`,
        [key, now.toISOString(), since, max, formId],
      );
      if (rows.length > 0) return true;
      // Not recorded: either the visitor is over the limit, or this form already counted.
      const counted = await client.query<{ key: string }>(
        `select key from contact_rate_hits where key = $1 and form_id = $2 limit 1`,
        [key, formId],
      );
      return counted.rows.length > 0;
    },
  };
}
