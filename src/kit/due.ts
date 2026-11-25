import type { MessageState, StoredSubmission } from "./ports";

/**
 * How long to wait before trying an alert again, after each failure in turn;
 * the last delay repeats. Each failure pushes the alert back, so alerts that
 * keep failing never hold up the other work waiting behind them.
 */
export const ALERT_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

/** A message that failed for good, whose alert hasn't gone out yet. */
export const alertPending = (state: MessageState): boolean =>
  state.status === "failed" && state.alertedAt === undefined;

/** When the alert of a message whose alert is pending should go out: at once, unless an attempt failed. */
const alertDueAt = (state: MessageState): string => state.nextAlertAt ?? new Date(0).toISOString();

/** The time the worker next has something to do for this message, or undefined when nothing is left. */
function dueAt(state: MessageState): string | undefined {
  if (alertPending(state)) return alertDueAt(state);
  if (state.status === "pending") return state.nextAttemptAt ?? new Date(0).toISOString();
  return undefined;
}

/** True when this message's alert is pending and due at `now`. */
export const alertDue = (state: MessageState, now: Date): boolean =>
  alertPending(state) && Date.parse(alertDueAt(state)) <= now.getTime();

/** True when the worker has something to do for this message at `now`: a retry, or an alert to resend. */
export function needsWork(state: MessageState, now: Date): boolean {
  const due = dueAt(state);
  return due !== undefined && Date.parse(due) <= now.getTime();
}

/** The state after an alert failed to go out: one more failure, and when to try again. */
export function alertFailed(state: MessageState, now: Date): MessageState {
  const alertAttempts = (state.alertAttempts ?? 0) + 1;
  const delay = ALERT_RETRY_DELAYS_MS[Math.min(alertAttempts, ALERT_RETRY_DELAYS_MS.length) - 1]!;
  return { ...state, alertAttempts, nextAlertAt: new Date(now.getTime() + delay).toISOString() };
}

/**
 * The earliest time the worker has something to do for a submission, or null
 * when nothing is left. Stores keep it in a column so due submissions can be
 * found with an index.
 */
export function nextDueAt(messages: StoredSubmission["messages"]): string | null {
  const due = Object.values(messages)
    .map(dueAt)
    .filter((at): at is string => at !== undefined)
    .sort();
  return due[0] ?? null;
}
