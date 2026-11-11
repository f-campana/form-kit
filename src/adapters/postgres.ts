import type { MessageState, RateLimiter, StoredSubmission, SubmissionStore } from "../kit";

/**
 * The one method this adapter needs from a Postgres client. A `pg` Pool, the
 * Pool from `@neondatabase/serverless` and PGlite all fit it.
 */
export interface SqlClient {
  query<Row>(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

/** Tables for the delivery buffer and the rate limit. Safe to run on every deploy. */
export const CONTACT_SCHEMA_SQL = `
create table if not exists contact_submissions (
  id text primary key,
  created_at timestamptz not null,
  reason text not null,
  data jsonb not null,
  messages jsonb not null,
  next_due_at timestamptz,
  delivered_at timestamptz,
  locked_until timestamptz
);
create index if not exists contact_submissions_next_due on contact_submissions (next_due_at) where next_due_at is not null;
create index if not exists contact_submissions_delivered on contact_submissions (delivered_at) where delivered_at is not null;
create table if not exists contact_rate_hits (
  key text not null,
  hit_at timestamptz not null
);
create index if not exists contact_rate_hits_key on contact_rate_hits (key, hit_at);
`;

export async function migrateContactSchema(client: SqlClient): Promise<void> {
  for (const statement of CONTACT_SCHEMA_SQL.split(";").map((part) => part.trim())) {
    if (statement !== "") await client.query(statement);
  }
}

interface SubmissionRow {
  id: string;
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
  return {
    async insert(record) {
      await client.query(
        `insert into contact_submissions (id, created_at, reason, data, messages, next_due_at, delivered_at)
         values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
        [
          record.id,
          record.createdAt,
          record.reason,
          JSON.stringify(record.data),
          JSON.stringify(record.messages),
          nextDueAt(record.messages),
          record.deliveredAt ?? null,
        ],
      );
    },

    async claim(id, now, leaseMs) {
      const { rows } = await client.query<SubmissionRow>(
        `update contact_submissions set locked_until = $3
         where id = $1 and (locked_until is null or locked_until <= $2)
         returning id, created_at, reason, data, messages, delivered_at, locked_until`,
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
 * leave the window, so addresses are kept, hashed, only briefly. Two requests
 * from one visitor at the very same moment can both get through; for a contact
 * form that slight overshoot doesn't matter.
 */
export function postgresRateLimiter(client: SqlClient): RateLimiter {
  return {
    async hit(key, now, windowMs, max) {
      const since = new Date(now.getTime() - windowMs).toISOString();
      await client.query(`delete from contact_rate_hits where hit_at <= $1`, [since]);
      const { rows } = await client.query<{ key: string }>(
        `insert into contact_rate_hits (key, hit_at)
         select $1, $2
         where (select count(*) from contact_rate_hits where key = $1 and hit_at > $3) < $4
         returning key`,
        [key, now.toISOString(), since, max],
      );
      return rows.length > 0;
    },
  };
}
