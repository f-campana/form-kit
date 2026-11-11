import { z } from "zod";
import { MailerError, type Mailer } from "../kit";

/**
 * Sends the kit's emails through Scaleway Transactional Email's HTTP API, as
 * documented in Scaleway's guide "Send emails with the API" and its JS SDK
 * (`createEmail`). Scaleway notes:
 * - Transactional Email runs only in the fr-par region.
 * - The sender must be on a domain the Project has checked.
 * - Subjects need at least 10 characters.
 * - Each recipient is billed as one email, with at most 10 recipients by default.
 * - A successful call means Scaleway accepted the email and will send it
 *   shortly. A later bounce isn't reported back to the kit.
 */
export interface ScalewayMailerOptions {
  /** The secret key of an API key allowed to send email (TransactionalEmailEmailApiCreate). */
  readonly secretKey: string;
  readonly projectId: string;
  readonly region?: string;
  /** The sender's display name, for example the business name. */
  readonly fromName?: string;
  readonly timeoutMs?: number;
  /** Replaces the global fetch, for tests. */
  readonly fetch?: typeof fetch;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The plain-text body as simple HTML: one paragraph per block, line breaks kept, everything escaped. */
export function textToHtml(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`);
  return `<html><body>${paragraphs.join("")}</body></html>`;
}

/** Turns an HTTP status into a code that is safe to log, and says whether retrying can help. */
function failureFor(status: number): { code: string; retryable: boolean } {
  // A wrong or revoked key can be fixed within the retry window, so those are retried.
  if (status === 401 || status === 403) return { code: `auth_${status}`, retryable: true };
  if (status === 408 || status === 429) return { code: `busy_${status}`, retryable: true };
  if (status >= 500) return { code: `provider_${status}`, retryable: true };
  return { code: `rejected_${status}`, retryable: false };
}

export function scalewayMailer(options: ScalewayMailerOptions): Mailer {
  const region = options.region ?? "fr-par";
  const url = `https://api.scaleway.com/transactional-email/v1alpha1/regions/${encodeURIComponent(region)}/emails`;
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async send(email) {
      const body = {
        from: {
          email: email.from,
          ...(options.fromName === undefined ? {} : { name: options.fromName }),
        },
        to: email.to.map((address) => ({ email: address })),
        subject: email.subject,
        text: email.text,
        html: textToHtml(email.text),
        project_id: options.projectId,
        ...(email.replyTo === undefined
          ? {}
          : { additional_headers: [{ key: "Reply-To", value: email.replyTo }] }),
      };

      let response: Response;
      try {
        response = await fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Auth-Token": options.secretKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        throw new MailerError(timedOut ? "timeout" : "network_error", { cause: error });
      }

      // The response body can echo addresses, so it's read and dropped, never kept.
      await response.text().catch(() => "");
      if (!response.ok) {
        const { code, retryable } = failureFor(response.status);
        throw new MailerError(code, { retryable });
      }
    },
  };
}

const ScalewayEnv = z.object({
  SCW_SECRET_KEY: z.uuid(),
  SCW_DEFAULT_PROJECT_ID: z.uuid(),
  SCW_TEM_REGION: z.string().default("fr-par"),
});

/**
 * Reads the Scaleway settings from the environment and checks them. On a
 * problem it names the variables, never their values.
 */
export function scalewayOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): Pick<ScalewayMailerOptions, "secretKey" | "projectId" | "region"> {
  const result = ScalewayEnv.safeParse(env);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`Missing or invalid environment variables: ${names.join(", ")}`);
  }
  return {
    secretKey: result.data.SCW_SECRET_KEY,
    projectId: result.data.SCW_DEFAULT_PROJECT_ID,
    region: result.data.SCW_TEM_REGION,
  };
}
