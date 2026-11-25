import { alertErrorCode } from "./alerts";
import type { ContactFormConfig } from "./define";
import { alertDue, alertFailed } from "./due";
import { confirmationEmail, notificationEmail, UnknownReasonError } from "./messages";
import { MailerError, type MessageKind, type MessageState, type StoredSubmission } from "./ports";
import type { ContactDeps } from "./submit";

type DeliveryDeps = Pick<ContactDeps, "store" | "mailer" | "alerter" | "clock" | "logger">;

const KINDS: readonly MessageKind[] = ["notification", "confirmation"];

const isDue = (state: MessageState, now: Date) =>
  state.status === "pending" &&
  (state.nextAttemptAt === undefined || Date.parse(state.nextAttemptAt) <= now.getTime());

/**
 * Tells the developer that a message failed for good, and records when the
 * alert went out. If it can't go out, it logs an error and leaves the alert
 * pending, to be tried again later (see `ALERT_RETRY_DELAYS_MS`).
 */
async function alertIfPending(
  config: ContactFormConfig,
  deps: DeliveryDeps,
  record: StoredSubmission,
  kind: MessageKind,
  now: Date,
): Promise<void> {
  const state = record.messages[kind];
  if (!alertDue(state, now)) return;
  try {
    await deps.alerter.alert({
      kind: "delivery_failed",
      site: config.siteName,
      submissionId: record.id,
      reference: record.reference,
      message: kind,
      attempts: state.attempts,
      lastError: state.lastError ?? "unknown",
    });
    record.messages[kind] = { ...state, alertedAt: now.toISOString() };
  } catch (error) {
    record.messages[kind] = alertFailed(state, now);
    deps.logger.error("alert_failed", { id: record.id, message: kind, error: alertErrorCode(error) });
  }
}

/**
 * What went wrong, as a code that is safe to store and log (never addresses or
 * message contents), and whether another attempt could succeed.
 */
function describeFailure(error: unknown): { readonly code: string; readonly retryable: boolean } {
  if (error instanceof MailerError) return { code: error.code, retryable: error.retryable };
  if (error instanceof UnknownReasonError) return { code: "unknown_reason", retryable: false };
  return { code: "unexpected", retryable: true };
}

function emailFor(kind: MessageKind, config: ContactFormConfig, record: StoredSubmission) {
  return kind === "notification" ? notificationEmail(config, record) : confirmationEmail(config, record);
}

/**
 * Sends whatever is due for one submission, then saves its state. The
 * notification and the confirmation are tracked separately, so a retry never
 * resends a message that already went out. Safe to call from overlapping runs:
 * only the run holding the lease sends anything.
 */
export async function deliverSubmission(
  config: ContactFormConfig,
  deps: DeliveryDeps,
  id: string,
): Promise<void> {
  const now = deps.clock.now();
  const record = await deps.store.claim(id, now, config.delivery.leaseMs);
  if (record === undefined) return;

  try {
    for (const kind of KINDS) {
      const state = record.messages[kind];
      if (!isDue(state, now)) {
        await alertIfPending(config, deps, record, kind, now);
        continue;
      }
      const attempts = state.attempts + 1;
      try {
        await deps.mailer.send(emailFor(kind, config, record));
        record.messages[kind] = { status: "sent", attempts, sentAt: now.toISOString() };
        deps.logger.info("email_sent", { id, message: kind, attempts });
      } catch (error) {
        const { code: lastError, retryable } = describeFailure(error);
        // A failure retrying can't fix is final at once, so the developer hears about it straight away.
        const delay = retryable ? config.delivery.retryDelaysMs[attempts - 1] : undefined;
        if (delay === undefined) {
          record.messages[kind] = { status: "failed", attempts, lastError };
          deps.logger.error("email_failed", { id, message: kind, attempts, error: lastError });
          await alertIfPending(config, deps, record, kind, now);
        } else {
          const nextAttemptAt = new Date(now.getTime() + delay).toISOString();
          record.messages[kind] = { status: "pending", attempts, lastError, nextAttemptAt };
          deps.logger.error("email_retry_scheduled", { id, message: kind, attempts, error: lastError });
        }
      }
    }

    // Delivered starts the retention period (D8). It doesn't wait for an alert:
    // the alert carries no visitor data, and outlives it if it must (see `purgeDelivered`).
    const { notification, confirmation } = record.messages;
    if (record.deliveredAt === undefined && notification.status === "sent" && confirmation.status !== "pending") {
      record.deliveredAt = now.toISOString();
    }
  } finally {
    await deps.store.release(record);
  }
}

/**
 * Retries every message that is due. The host runs it on a schedule, more
 * often than the shortest retry delay, and returns how many submissions it saw.
 */
export async function processDue(config: ContactFormConfig, deps: DeliveryDeps): Promise<number> {
  const ids = await deps.store.listDue(deps.clock.now());
  for (const id of ids) {
    try {
      await deliverSubmission(config, deps, id);
    } catch {
      deps.logger.error("delivery_crashed", { id });
    }
  }
  return ids.length;
}
