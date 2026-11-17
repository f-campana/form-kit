import type { ContactFormConfig } from "./define";
import { MailerError, type Alert, type Alerter, type Mailer, type MessageKind, type OutgoingEmail } from "./ports";
import type { ContactDeps } from "./submit";

/** Where alert emails go. Both addresses must be accepted by the alert provider: with SES in sandbox mode, verified. */
export interface AlertAddresses {
  readonly from: string;
  readonly to: readonly string[];
}

const MESSAGES: Record<MessageKind, string> = {
  notification: "the notification to the site's recipients",
  confirmation: "the confirmation to the visitor",
};

/**
 * The email for an alert. It is built from the alert alone, which holds the
 * site's name, IDs, counts and error codes, so no visitor data can reach it.
 */
export function alertEmail(alert: Alert, addresses: AlertAddresses): OutgoingEmail {
  if (alert.kind === "test") {
    return {
      from: addresses.from,
      to: addresses.to,
      subject: `Form alert test: ${alert.site}`,
      text: [
        `This is the monthly test of the contact form alerts for ${alert.site}, sent at ${alert.sentAt}.`,
        "",
        "If you are reading it, alerts reach you. Nothing else to do.",
      ].join("\n"),
    };
  }
  return {
    from: addresses.from,
    to: addresses.to,
    subject: `Form alert: ${alert.site}, ${alert.message} not sent (${alert.reference})`,
    text: [
      `A message from the contact form of ${alert.site} could not be sent, and won't be retried.`,
      "",
      `Site: ${alert.site}`,
      `Reference: ${alert.reference}`,
      `Submission: ${alert.submissionId}`,
      `Message: ${MESSAGES[alert.message]}`,
      `Attempts: ${alert.attempts}`,
      `Error: ${alert.lastError}`,
      "",
      "The submission stays in the site's database until someone handles it. It holds the visitor's message; this alert doesn't.",
    ].join("\n"),
  };
}

/** Sends alerts as emails through `mailer`, which must be a different provider from the one the form sends with. */
export function emailAlerter(mailer: Mailer, addresses: AlertAddresses): Alerter {
  return {
    alert: (alert) => mailer.send(alertEmail(alert, addresses)),
  };
}

/** A code for a failed alert that is safe to log. */
export const alertErrorCode = (error: unknown): string => (error instanceof MailerError ? error.code : "unexpected");

/**
 * Sends the monthly test alert. The host runs it on a schedule. If it can't go
 * out, it logs an error and throws, so the scheduled job shows the failure.
 */
export async function sendTestAlert(
  config: ContactFormConfig,
  deps: Pick<ContactDeps, "alerter" | "clock" | "logger">,
): Promise<void> {
  try {
    await deps.alerter.alert({ kind: "test", site: config.siteName, sentAt: deps.clock.now().toISOString() });
  } catch (error) {
    deps.logger.error("test_alert_failed", { error: alertErrorCode(error) });
    throw error;
  }
  deps.logger.info("test_alert_sent");
}
