import type { ContactFormConfig } from "./define";
import { deliverSubmission } from "./delivery";
import { parseSubmission } from "./parse";
import type {
  Alerter,
  Clock,
  Logger,
  Mailer,
  MessageState,
  RateLimiter,
  StoredSubmission,
  SubmissionStore,
} from "./ports";
import { checkFormToken, visitorKey } from "./spam";

export interface ContactDeps {
  readonly store: SubmissionStore;
  readonly mailer: Mailer;
  readonly alerter: Alerter;
  readonly rateLimiter: RateLimiter;
  readonly clock: Clock;
  readonly logger: Logger;
  /** At least 32 characters, from the environment. Signs form tokens and hashes visitor addresses. */
  readonly secret: string;
  readonly newId: () => string;
  /**
   * Runs the first delivery attempt after the response is sent, for example
   * with the host's waitUntil. Without it, the submission waits for that attempt.
   */
  readonly defer?: (task: () => Promise<void>) => void;
}

export interface Visitor {
  /** The visitor's IP address as the host reports it. Used only, hashed, for the rate limit. */
  readonly address?: string;
}

export type SubmitResult =
  | { readonly status: "accepted"; readonly id?: string }
  | { readonly status: "invalid"; readonly fieldErrors: Readonly<Record<string, string>> }
  | { readonly status: "rate_limited" }
  | { readonly status: "unavailable" };

/**
 * Handles one submission, in the order pilot-spec.md §3 sets: spam checks,
 * server validation, rate limit, storage, then the first delivery attempt.
 * Suspected spam gets the same answer as a real submission, and nothing is
 * stored or sent for it.
 */
export async function submitContact(
  config: ContactFormConfig,
  deps: ContactDeps,
  input: Readonly<Record<string, unknown>>,
  visitor: Visitor = {},
): Promise<SubmitResult> {
  if (deps.secret.length < 32) throw new Error("The form secret must be at least 32 characters");
  const now = deps.clock.now();

  const honeypot = input[config.spam.honeypotField];
  if (typeof honeypot === "string" ? honeypot.trim() !== "" : honeypot !== undefined) {
    deps.logger.info("submission_discarded", { why: "honeypot" });
    return { status: "accepted" };
  }
  const token = await checkFormToken(deps.secret, input[config.spam.tokenField], now, config.spam.minFillMs);
  if (token !== "ok") {
    deps.logger.info("submission_discarded", { why: token });
    return { status: "accepted" };
  }

  const parsed = parseSubmission(config, input);
  if (!parsed.ok) {
    deps.logger.info("submission_invalid", { fields: Object.keys(parsed.fieldErrors).join(",") });
    return { status: "invalid", fieldErrors: parsed.fieldErrors };
  }

  if (visitor.address !== undefined) {
    const key = await visitorKey(deps.secret, visitor.address);
    const { rateLimitWindowMs, rateLimitMax } = config.spam;
    if (!(await deps.rateLimiter.hit(key, now, rateLimitWindowMs, rateLimitMax))) {
      deps.logger.info("submission_rate_limited");
      return { status: "rate_limited" };
    }
  }

  const pending: MessageState = { status: "pending", attempts: 0, nextAttemptAt: now.toISOString() };
  const record: StoredSubmission = {
    id: deps.newId(),
    createdAt: now.toISOString(),
    reason: parsed.reason,
    data: parsed.data,
    messages: { notification: pending, confirmation: pending },
  };
  try {
    await deps.store.insert(record);
  } catch {
    deps.logger.error("submission_store_failed", { reason: parsed.reason });
    return { status: "unavailable" };
  }
  deps.logger.info("submission_stored", { id: record.id, reason: record.reason });

  const deliver = async () => {
    try {
      await deliverSubmission(config, deps, record.id);
    } catch {
      deps.logger.error("delivery_crashed", { id: record.id });
    }
  };
  if (deps.defer === undefined) await deliver();
  else deps.defer(deliver);
  return { status: "accepted", id: record.id };
}
