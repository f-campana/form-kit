import type { Clock, Logger, MessageState, RateLimiter, StoredSubmission, SubmissionStore } from "./ports";

const isDue = (state: MessageState, now: Date) =>
  state.status === "pending" &&
  (state.nextAttemptAt === undefined || Date.parse(state.nextAttemptAt) <= now.getTime());

/**
 * Keeps submissions in memory. For tests and local runs only: everything is
 * lost on restart, and serverless instances don't share it.
 */
export function memoryStore(): SubmissionStore & {
  readonly records: ReadonlyMap<string, StoredSubmission>;
} {
  const records = new Map<string, StoredSubmission>();
  return {
    records,
    async insert(record) {
      if (records.has(record.id)) throw new Error("Duplicate submission ID");
      records.set(record.id, structuredClone(record));
    },
    async claim(id, now, leaseMs) {
      const record = records.get(id);
      if (record === undefined) return undefined;
      if (record.lockedUntil !== undefined && Date.parse(record.lockedUntil) > now.getTime()) return undefined;
      record.lockedUntil = new Date(now.getTime() + leaseMs).toISOString();
      return structuredClone(record);
    },
    async release(record) {
      const { lockedUntil: _released, ...rest } = record;
      records.set(record.id, structuredClone(rest));
    },
    async listDue(now) {
      return [...records.values()]
        .filter((record) => Object.values(record.messages).some((state) => isDue(state, now)))
        .map((record) => record.id);
    },
    async deleteDeliveredBefore(cutoff) {
      let count = 0;
      for (const [id, record] of records) {
        if (record.deliveredAt !== undefined && Date.parse(record.deliveredAt) <= cutoff.getTime()) {
          records.delete(id);
          count += 1;
        }
      }
      return count;
    },
  };
}

/** Counts hits in memory, dropping them once they leave the window. Per instance only. */
export function memoryRateLimiter(): RateLimiter & { readonly keys: () => string[] } {
  const hits = new Map<string, number[]>();
  return {
    keys: () => [...hits.keys()],
    async hit(key, now, windowMs, max) {
      const since = now.getTime() - windowMs;
      for (const [visitor, times] of hits) {
        const recent = times.filter((time) => time > since);
        if (recent.length === 0) hits.delete(visitor);
        else hits.set(visitor, recent);
      }
      const recent = hits.get(key) ?? [];
      if (recent.length >= max) return false;
      hits.set(key, [...recent, now.getTime()]);
      return true;
    },
  };
}

export const systemClock: Clock = { now: () => new Date() };

/** Writes events as JSON lines. The kit's events never carry visitor data. */
export const consoleLogger: Logger = {
  info: (event, fields) => console.info(JSON.stringify({ level: "info", event, ...fields })),
  error: (event, fields) => console.error(JSON.stringify({ level: "error", event, ...fields })),
};
