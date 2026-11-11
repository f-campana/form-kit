import type { ContactFormConfig, ReasonSpec } from "./define";
import type { FieldSpec } from "./fields";
import type { OutgoingEmail, StoredSubmission } from "./ports";

// French typography puts a no-break space before a colon.
const COLON = " :";

/** Strips control characters, including line breaks, so a value can't add email headers. */
const oneLine = (text: string, max = 150) =>
  text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export class UnknownReasonError extends Error {
  constructor(reason: string) {
    super(`No reason "${reason}" in the configuration`);
    this.name = "UnknownReasonError";
  }
}

function reasonOf(config: ContactFormConfig, record: StoredSubmission): ReasonSpec {
  const reason = Object.hasOwn(config.reasons, record.reason) ? config.reasons[record.reason] : undefined;
  if (reason === undefined) throw new UnknownReasonError(record.reason);
  return reason;
}

function fieldLines(fields: Readonly<Record<string, FieldSpec>>, data: StoredSubmission["data"]) {
  const lines: string[] = [];
  for (const [name, spec] of Object.entries(fields)) {
    const value = data[name];
    if (value === undefined) continue;
    // A multi-line answer gets a blank line after it, so it doesn't run into the next field.
    lines.push(value.includes("\n") ? `${spec.label}${COLON}\n${value}\n` : `${spec.label}${COLON} ${value}`);
  }
  return lines;
}

/** The request as the visitor sent it: the reason, then each field they filled in. */
function summary(config: ContactFormConfig, reason: ReasonSpec, record: StoredSubmission) {
  return [
    `Motif${COLON} ${reason.label}`,
    ...fieldLines(config.commonFields, record.data),
    ...fieldLines(reason.fields, record.data),
  ]
    .join("\n")
    .replace(/\n+$/, "");
}

/** The email to the reason's recipients. Replying to it writes to the visitor. */
export function notificationEmail(config: ContactFormConfig, record: StoredSubmission): OutgoingEmail {
  const reason = reasonOf(config, record);
  const name = record.data["name"] ?? "";
  return {
    from: config.from,
    to: config.recipients[reason.to] ?? [],
    replyTo: record.data["email"] ?? config.from,
    subject: oneLine(`${reason.label} — ${name}`),
    text: [
      `Nouveau message envoyé depuis le site ${config.siteName}.`,
      "",
      summary(config, reason, record),
      "",
      `Répondez directement à ce message pour écrire à ${name}.`,
    ].join("\n"),
  };
}

/** The copy sent to the visitor. It contains only what they sent, nothing internal. */
export function confirmationEmail(config: ContactFormConfig, record: StoredSubmission): OutgoingEmail {
  const reason = reasonOf(config, record);
  const name = record.data["name"] ?? "";
  return {
    from: config.from,
    to: [record.data["email"] ?? ""],
    ...(config.confirmationReplyTo === undefined ? {} : { replyTo: config.confirmationReplyTo }),
    subject: oneLine(`Votre message à ${config.siteName}`),
    text: [
      `Bonjour ${name},`,
      "",
      `Merci pour votre message. ${config.nextSteps}`,
      "",
      `Voici une copie de ce que vous nous avez envoyé${COLON}`,
      "",
      summary(config, reason, record),
      "",
      config.siteName,
    ].join("\n"),
  };
}
