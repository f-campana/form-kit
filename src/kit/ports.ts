/**
 * What the kit needs from the site that hosts it. Each site wires real adapters
 * (a database, an email service, an alert channel); tests and local runs use
 * the in-memory adapters in `memory.ts`.
 */

export interface Clock {
  now(): Date;
}

export interface OutgoingEmail {
  readonly from: string;
  readonly to: readonly string[];
  readonly replyTo?: string;
  readonly subject: string;
  readonly text: string;
}

/** Sends one email, and throws if it can't. */
export interface Mailer {
  send(email: OutgoingEmail): Promise<void>;
}

/**
 * The error a mailer adapter throws. Its code is stored and logged, so it must
 * never contain addresses or message contents.
 */
export class MailerError extends Error {
  readonly code: string;
  /** False when trying again can't help, such as a request the service rejects as invalid. */
  readonly retryable: boolean;

  constructor(code: string, options?: ErrorOptions & { readonly retryable?: boolean }) {
    super(`Email sending failed: ${code}`, options);
    this.name = "MailerError";
    this.code = code;
    this.retryable = options?.retryable ?? true;
  }
}

export type MessageKind = "notification" | "confirmation";

/** A message that failed for good. It carries no visitor data. */
export interface DeliveryAlert {
  readonly submissionId: string;
  readonly message: MessageKind;
  readonly attempts: number;
  readonly lastError: string;
}

/**
 * Tells the developer about a message that failed for good. It must not go
 * through the email service that just failed: use a webhook, a second provider
 * or the host's monitoring.
 */
export interface Alerter {
  alert(alert: DeliveryAlert): Promise<void>;
}

/** Receives event names, IDs and codes only, never visitor data. */
export interface Logger {
  info(event: string, fields?: Readonly<Record<string, string | number>>): void;
  error(event: string, fields?: Readonly<Record<string, string | number>>): void;
}

export interface MessageState {
  readonly status: "pending" | "sent" | "failed";
  readonly attempts: number;
  readonly nextAttemptAt?: string;
  readonly sentAt?: string;
  readonly lastError?: string;
}

export interface StoredSubmission {
  readonly id: string;
  /** What the visitor and the recipients quote. See `referenceFor`. */
  readonly reference: string;
  readonly createdAt: string;
  readonly reason: string;
  /** Validated values only: the common fields and the chosen reason's fields. */
  readonly data: Readonly<Record<string, string>>;
  messages: Record<MessageKind, MessageState>;
  /** Set once the notification is sent and nothing is pending. Starts the retention period. */
  deliveredAt?: string;
  /** Delivery lease, so two runs never send the same message at once. */
  lockedUntil?: string;
}

export interface SubmissionStore {
  /** Saves a new submission. Throws if it can't, and then nothing is sent. */
  insert(record: StoredSubmission): Promise<void>;
  /**
   * Takes the delivery lease if it's free or expired, and returns a copy of the
   * record. Returns undefined if another run holds it, or the record is gone.
   */
  claim(id: string, now: Date, leaseMs: number): Promise<StoredSubmission | undefined>;
  /** Saves the record and releases its lease. */
  release(record: StoredSubmission): Promise<void>;
  /** IDs of submissions with a pending message due at or before `now`. */
  listDue(now: Date): Promise<string[]>;
  /** Deletes submissions delivered at or before `cutoff`, and returns how many. */
  deleteDeliveredBefore(cutoff: Date): Promise<number>;
}

/** Counts submissions per hashed visitor key over a sliding window. */
export interface RateLimiter {
  /** Records a hit and returns true, or returns false if the visitor is over the limit. */
  hit(key: string, now: Date, windowMs: number, max: number): Promise<boolean>;
}
