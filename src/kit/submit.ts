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
  TokenHolder,
} from "./ports";
import { referenceFor } from "./reference";
import { checkFormToken, contentFingerprint, formTokenId, visitorKey } from "./spam";

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
  /** A honeypot submission gets this too, without an ID or a reference. */
  | { readonly status: "accepted"; readonly id?: string; readonly reference?: string }
  /**
   * The form was sent too fast, or its token is missing, invalid, expired, or
   * already used for something else. The page asks the visitor to check their
   * message and send it again, with a fresh token and the fields still filled in.
   */
  | { readonly status: "retry" }
  | { readonly status: "invalid"; readonly fieldErrors: Readonly<Record<string, string>> }
  | { readonly status: "rate_limited" }
  | { readonly status: "unavailable" };

/**
 * Handles one submission, in the order pilot-spec.md §3 sets: spam checks,
 * server validation, rate limit, storage, then the first delivery attempt.
 * Only a honeypot submission gets the same answer as a real one; nothing is
 * stored or sent for it. The token checks can catch real people, so they ask
 * the visitor to try again.
 *
 * A form token stores one submission. The same form arriving again (a double
 * click, or a resend after a lost response) gets the first answer back and
 * sends nothing; a used token with different content is asked to try again.
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
  const { tokenField, minFillMs, tokenMaxAgeMs } = config.spam;
  const token = await checkFormToken(deps.secret, input[tokenField], now, minFillMs, tokenMaxAgeMs);
  if (token !== "ok") {
    deps.logger.info("submission_refused", { why: token });
    return { status: "retry" };
  }

  const parsed = parseSubmission(config, input);
  if (!parsed.ok) {
    deps.logger.info("submission_invalid", { fields: Object.keys(parsed.fieldErrors).join(",") });
    return { status: "invalid", fieldErrors: parsed.fieldErrors };
  }

  const tokenId = await formTokenId(String(input[tokenField]));
  const fingerprint = await contentFingerprint(parsed.reason, parsed.data);
  /** The answer for a token that already stored a submission. */
  const replay = (existing: TokenHolder | undefined): SubmitResult => {
    if (existing?.fingerprint !== fingerprint) {
      deps.logger.info("submission_refused", { why: "token_reused" });
      return { status: "retry" };
    }
    deps.logger.info("submission_repeated", { id: existing.id });
    return { status: "accepted", id: existing.id, reference: existing.reference };
  };

  // Looked up before the rate limit, so resending the same form doesn't use it up.
  let holder: TokenHolder | undefined;
  try {
    holder = await deps.store.findByToken(tokenId);
  } catch {
    deps.logger.error("submission_store_failed", { reason: parsed.reason });
    return { status: "unavailable" };
  }
  if (holder !== undefined) return replay(holder);

  if (visitor.address !== undefined) {
    const key = await visitorKey(deps.secret, visitor.address);
    const { rateLimitWindowMs, rateLimitMax } = config.spam;
    // The same form counts once, so two identical requests arriving together both get through to the store.
    if (!(await deps.rateLimiter.hit(key, now, rateLimitWindowMs, rateLimitMax, tokenId))) {
      deps.logger.info("submission_rate_limited");
      return { status: "rate_limited" };
    }
  }

  const pending: MessageState = { status: "pending", attempts: 0, nextAttemptAt: now.toISOString() };
  const id = deps.newId();
  const record: StoredSubmission = {
    id,
    reference: await referenceFor(id),
    tokenId,
    fingerprint,
    createdAt: now.toISOString(),
    reason: parsed.reason,
    data: parsed.data,
    messages: { notification: pending, confirmation: pending },
  };
  try {
    // Two requests can both get past the lookup above; the store lets one in.
    const outcome = await deps.store.insert(record);
    if (!outcome.stored) return replay(outcome.existing);
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
  return { status: "accepted", id: record.id, reference: record.reference };
}
