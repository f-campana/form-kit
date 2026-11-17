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

export interface PostgresOptions {
  /**
   * The schema holding this site's tables, when several sites share one
   * database (see `provisionSite`). Leave it out to use the connection's
   * default schema.
   */
  readonly schema?: string;
}

interface TableNames {
  readonly submissions: string;
  readonly hits: string;
}

/** Lowercase letters, digits and underscores only, so a name can go into SQL safely. */
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function tableNames(schema: string | undefined): TableNames {
  if (schema === undefined) return { submissions: "contact_submissions", hits: "contact_rate_hits" };
  if (!IDENTIFIER.test(schema)) throw new Error(`Invalid schema name: ${JSON.stringify(schema)}`);
  return { submissions: `"${schema}".contact_submissions`, hits: `"${schema}".contact_rate_hits` };
}

/**
 * Tables for the delivery buffer and the rate limit, written so the same
 * statements set up a new database and upgrade one an earlier version of the
 * kit created. Each `add column` is for tables that predate the column.
 */
const tablesSql = (names: TableNames) => [
  `create table if not exists ${names.submissions} (
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
  `alter table ${names.submissions} add column if not exists reference text`,
  `alter table ${names.submissions} add column if not exists token_id text`,
  `alter table ${names.submissions} add column if not exists fingerprint text`,
  `create table if not exists ${names.hits} (
    key text not null,
    hit_at timestamptz not null,
    form_id text
  )`,
  `alter table ${names.hits} add column if not exists form_id text`,
];

/** Run once every submission has a reference, a token ID and a fingerprint. */
const constraintsSql = (names: TableNames) => [
  `alter table ${names.submissions} alter column reference set not null`,
  `alter table ${names.submissions} alter column token_id set not null`,
  `alter table ${names.submissions} alter column fingerprint set not null`,
  `create unique index if not exists contact_submissions_token on ${names.submissions} (token_id)`,
  `create index if not exists contact_submissions_next_due on ${names.submissions} (next_due_at) where next_due_at is not null`,
  `create index if not exists contact_submissions_delivered on ${names.submissions} (delivered_at) where delivered_at is not null`,
  `create index if not exists contact_rate_hits_key on ${names.hits} (key, hit_at)`,
  `create unique index if not exists contact_rate_hits_form on ${names.hits} (key, form_id)`,
];

/**
 * Creates or upgrades the kit's tables. Safe to run again at any time.
 *
 * Where several sites share one database, an administrator runs it for each
 * site through `provisionSite`: a site's own role can't change its tables.
 *
 * Submissions stored by an earlier version are kept: each gets its reference,
 * and a token ID no form token can match, so it is still delivered and purged
 * as before.
 */
export async function migrateContactSchema(client: SqlClient, options: PostgresOptions = {}): Promise<void> {
  const names = tableNames(options.schema);
  for (const statement of tablesSql(names)) await client.query(statement);

  const { rows } = await client.query<{ id: string }>(
    `select id from ${names.submissions} where reference is null or token_id is null or fingerprint is null`,
  );
  for (const { id } of rows) {
    await client.query(
      `update ${names.submissions}
       set reference = coalesce(reference, $2), token_id = coalesce(token_id, $3), fingerprint = coalesce(fingerprint, '')
       where id = $1`,
      [id, await referenceFor(id), `before-tokens:${id}`],
    );
  }

  for (const statement of constraintsSql(names)) await client.query(statement);
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
export function postgresStore(client: SqlClient, options: PostgresOptions = {}): SubmissionStore {
  const names = tableNames(options.schema);

  async function findByToken(tokenId: string): Promise<TokenHolder | undefined> {
    const { rows } = await client.query<TokenHolder>(
      `select id, reference, fingerprint from ${names.submissions} where token_id = $1`,
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
        `insert into ${names.submissions}
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
        `update ${names.submissions} set locked_until = $3
         where id = $1 and (locked_until is null or locked_until <= $2)
         returning id, reference, token_id, fingerprint, created_at, reason, data, messages, delivered_at, locked_until`,
        [id, now.toISOString(), new Date(now.getTime() + leaseMs).toISOString()],
      );
      return rows[0] === undefined ? undefined : toRecord(rows[0]);
    },

    async release(record) {
      await client.query(
        `update ${names.submissions}
         set messages = $2::jsonb, next_due_at = $3, delivered_at = $4, locked_until = null
         where id = $1`,
        [record.id, JSON.stringify(record.messages), nextDueAt(record.messages), record.deliveredAt ?? null],
      );
    },

    async listDue(now) {
      const { rows } = await client.query<{ id: string }>(
        `select id from ${names.submissions} where next_due_at <= $1 order by next_due_at limit 100`,
        [now.toISOString()],
      );
      return rows.map((row) => row.id);
    },

    async deleteDeliveredBefore(cutoff) {
      const { rows } = await client.query<{ id: string }>(
        `delete from ${names.submissions} where delivered_at <= $1 returning id`,
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
export function postgresRateLimiter(client: SqlClient, options: PostgresOptions = {}): RateLimiter {
  const names = tableNames(options.schema);
  return {
    async hit(key, now, windowMs, max, formId) {
      const since = new Date(now.getTime() - windowMs).toISOString();
      await client.query(`delete from ${names.hits} where hit_at <= $1`, [since]);
      const { rows } = await client.query<{ key: string }>(
        `insert into ${names.hits} (key, hit_at, form_id)
         select $1, $2, $5
         where (select count(*) from ${names.hits} where key = $1 and hit_at > $3) < $4
         on conflict (key, form_id) do nothing
         returning key`,
        [key, now.toISOString(), since, max, formId],
      );
      if (rows.length > 0) return true;
      // Not recorded: either the visitor is over the limit, or this form already counted.
      const counted = await client.query<{ key: string }>(
        `select key from ${names.hits} where key = $1 and form_id = $2 limit 1`,
        [key, formId],
      );
      return counted.rows.length > 0;
    },
  };
}
