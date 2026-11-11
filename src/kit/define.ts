import { z } from "zod";
import type { FieldSpec } from "./fields";

/** The form field that carries the chosen reason's key. */
export const REASON_FIELD = "reason";

export interface ReasonSpec {
  readonly label: string;
  /** A key of `recipients`. The form only ever sends the reason's key. */
  readonly to: string;
  readonly fields: Readonly<Record<string, FieldSpec>>;
}

export interface SpamSettings {
  /** A hidden field that real visitors leave empty. */
  readonly honeypotField: string;
  /** The field carrying the server-signed time the form was shown. */
  readonly tokenField: string;
  /** Faster than this, a submission is treated as spam. */
  readonly minFillMs: number;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
}

export interface DeliverySettings {
  /**
   * Waits between attempts. Two delays mean three attempts; after the last one
   * fails, the developer is alerted and the submission is kept.
   */
  readonly retryDelaysMs: readonly number[];
  /** How long one delivery run may hold a submission before another run can take it. */
  readonly leaseMs: number;
}

export interface ContactFormInput {
  readonly siteName: string;
  /** Sender address, on the site's own domain. */
  readonly from: string;
  /** Where replies to the confirmation go. Leave it out to use `from`. */
  readonly confirmationReplyTo?: string;
  /** One or two sentences for the confirmation email about what happens next. */
  readonly nextSteps: string;
  /** The approved recipient lists, by role. */
  readonly recipients: Readonly<Record<string, readonly string[]>>;
  /** Fields every reason asks for. Must include `name` and `email`. */
  readonly commonFields: Readonly<Record<string, FieldSpec>>;
  readonly reasons: Readonly<Record<string, ReasonSpec>>;
  /** Error shown when no valid reason is chosen. */
  readonly reasonError?: string;
  readonly spam?: Partial<SpamSettings>;
  readonly delivery?: Partial<DeliverySettings>;
  /** Days a delivered submission stays in the store. */
  readonly retentionDays?: number;
}

export interface ContactFormConfig
  extends Omit<ContactFormInput, "spam" | "delivery" | "retentionDays" | "reasonError"> {
  readonly reasonError: string;
  readonly spam: SpamSettings;
  readonly delivery: DeliverySettings;
  readonly retentionDays: number;
}

export const DEFAULT_SPAM: SpamSettings = {
  honeypotField: "website",
  tokenField: "formToken",
  minFillMs: 3_000,
  rateLimitMax: 5,
  rateLimitWindowMs: 60 * 60_000,
};

export const DEFAULT_DELIVERY: DeliverySettings = {
  retryDelaysMs: [5 * 60_000, 30 * 60_000],
  leaseMs: 2 * 60_000,
};

export class ContactConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid contact form configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ContactConfigError";
    this.problems = problems;
  }
}

/**
 * Checks the configuration and fills in defaults. It throws on any problem, so
 * a site whose build imports its configuration fails to deploy: for example
 * when a reason has no recipient or an address is invalid.
 */
export function defineContactForm(input: ContactFormInput): ContactFormConfig {
  const config: ContactFormConfig = {
    ...input,
    reasonError: input.reasonError ?? "Choisissez le motif de votre message.",
    spam: { ...DEFAULT_SPAM, ...input.spam },
    delivery: { ...DEFAULT_DELIVERY, ...input.delivery },
    retentionDays: input.retentionDays ?? 30,
  };
  const problems = findProblems(config);
  if (problems.length > 0) throw new ContactConfigError(problems);
  return Object.freeze(config);
}

const isEmail = (value: string) => z.email().safeParse(value).success;

function findProblems(config: ContactFormConfig): string[] {
  const problems: string[] = [];

  if (!isEmail(config.from)) problems.push(`from: "${config.from}" isn't a valid address`);
  if (config.confirmationReplyTo !== undefined && !isEmail(config.confirmationReplyTo)) {
    problems.push(`confirmationReplyTo: "${config.confirmationReplyTo}" isn't a valid address`);
  }

  for (const [role, addresses] of Object.entries(config.recipients)) {
    if (addresses.length === 0) problems.push(`recipients.${role} has no address`);
    for (const address of addresses) {
      if (!isEmail(address)) problems.push(`recipients.${role}: "${address}" isn't a valid address`);
    }
  }

  const reasons = Object.entries(config.reasons);
  if (reasons.length === 0) problems.push("reasons: at least one reason is needed");
  for (const [key, reason] of reasons) {
    if (!/^[a-z][a-z0-9-]*$/.test(key)) {
      problems.push(`reasons.${key}: keys use lowercase letters, digits and dashes`);
    }
    if (!Object.hasOwn(config.recipients, reason.to)) {
      problems.push(`reasons.${key} goes to "${reason.to}", which isn't in recipients`);
    }
  }

  for (const required of ["name", "email"]) {
    if (!Object.hasOwn(config.commonFields, required)) {
      problems.push(`commonFields needs a "${required}" field`);
    }
  }

  // Field names must be unique across all reasons: without JavaScript the
  // browser submits every reason's fields, and duplicates would collide.
  const reserved = new Set([REASON_FIELD, config.spam.honeypotField, config.spam.tokenField]);
  const seen = new Map<string, string>();
  const fieldGroups: [string, Readonly<Record<string, FieldSpec>>][] = [
    ["commonFields", config.commonFields],
    ...reasons.map(([key, reason]): [string, Readonly<Record<string, FieldSpec>>] => [
      `reasons.${key}`,
      reason.fields,
    ]),
  ];
  for (const [group, fields] of fieldGroups) {
    for (const name of Object.keys(fields)) {
      if (reserved.has(name)) problems.push(`${group}.${name}: "${name}" is reserved`);
      const first = seen.get(name);
      if (first !== undefined) {
        problems.push(`${group}.${name}: field names must be unique, "${name}" is also in ${first}`);
      } else {
        seen.set(name, group);
      }
    }
  }

  const { retryDelaysMs, leaseMs } = config.delivery;
  if (!retryDelaysMs.every((ms) => Number.isFinite(ms) && ms >= 0)) {
    problems.push("delivery.retryDelaysMs: delays must be zero or more");
  }
  if (!(leaseMs > 0)) problems.push("delivery.leaseMs must be more than zero");
  if (!(config.retentionDays > 0)) problems.push("retentionDays must be more than zero");
  if (!(config.spam.minFillMs >= 0)) problems.push("spam.minFillMs must be zero or more");
  if (!(config.spam.rateLimitMax >= 1)) problems.push("spam.rateLimitMax must be at least 1");
  if (!(config.spam.rateLimitWindowMs > 0)) problems.push("spam.rateLimitWindowMs must be more than zero");

  return problems;
}
