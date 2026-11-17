import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { MailerError, type AlertAddresses, type Mailer } from "../kit";

/**
 * Sends email through Amazon SES's v2 API (SendEmail), in Stockholm
 * (eu-north-1) by default, where the alerts account lives. The kit uses it
 * for alerts (decision D19), so they don't depend on the provider they report
 * on. AWS notes:
 * - In sandbox mode, the account sends only to verified addresses, from a
 *   verified address or domain, at most 200 a day. That is enough for alerts
 *   to one developer.
 * - A successful call means SES accepted the email. A later bounce isn't
 *   reported back to the kit.
 *
 * The request is signed with AWS Signature Version 4, done here in a few
 * lines rather than with the AWS SDK, so the kit keeps one runtime
 * dependency. A test checks the signature against the SDK's own signer.
 */
export interface SesMailerOptions {
  /** An access key allowed only to send email (the IAM action ses:SendEmail). */
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Only for temporary credentials. */
  readonly sessionToken?: string;
  readonly region?: string;
  readonly timeoutMs?: number;
  /** Replaces the global fetch, for tests. */
  readonly fetch?: typeof fetch;
  /** Replaces the system clock used to sign, for tests. */
  readonly now?: () => Date;
}

const sha256 = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data, "utf8").digest();

/**
 * Signs a request with no query string, as AWS Signature Version 4 describes,
 * and returns the headers to send. `host` is signed but left to fetch to send.
 */
function signedHeaders(
  options: SesMailerOptions & { readonly region: string },
  url: URL,
  body: string,
  now: Date,
): Record<string, string> {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: url.host,
    "x-amz-date": amzDate,
    ...(options.sessionToken === undefined ? {} : { "x-amz-security-token": options.sessionToken }),
  };
  const names = Object.keys(headers).sort();
  const canonicalRequest = [
    "POST",
    url.pathname,
    "",
    ...names.map((name) => `${name}:${headers[name]!.trim()}`),
    "",
    names.join(";"),
    sha256(body),
  ].join("\n");
  const scope = `${day}/${options.region}/ses/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${options.secretAccessKey}`, day), options.region), "ses"), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");

  const { host: _sentByFetch, ...sent } = headers;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

/**
 * Turns an HTTP status and SES's error type into a code that is safe to log,
 * and says whether retrying can help. The error type is a name such as
 * "MessageRejected"; anything else in the header is dropped.
 */
function failureFor(status: number, errorType: string | null): { code: string; retryable: boolean } {
  const type = (errorType ?? "").split(":")[0]!.replace(/[^A-Za-z]/g, "");
  const suffix = type === "" ? "" : `_${type}`;
  // A wrong or revoked key can be fixed while the alert waits, so those are retried.
  if (status === 401 || status === 403) return { code: `auth_${status}${suffix}`, retryable: true };
  if (status === 408 || status === 429) return { code: `busy_${status}${suffix}`, retryable: true };
  if (status >= 500) return { code: `provider_${status}${suffix}`, retryable: true };
  return { code: `rejected_${status}${suffix}`, retryable: false };
}

export function sesMailer(options: SesMailerOptions): Mailer {
  const region = options.region ?? "eu-north-1";
  const url = new URL(`https://email.${region}.amazonaws.com/v2/email/outbound-emails`);
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? (() => new Date());

  return {
    async send(email) {
      const body = JSON.stringify({
        FromEmailAddress: email.from,
        Destination: { ToAddresses: email.to },
        ...(email.replyTo === undefined ? {} : { ReplyToAddresses: [email.replyTo] }),
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: "UTF-8" },
            Body: { Text: { Data: email.text, Charset: "UTF-8" } },
          },
        },
      });

      let response: Response;
      try {
        response = await fetchFn(url, {
          method: "POST",
          headers: signedHeaders({ ...options, region }, url, body, now()),
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        throw new MailerError(timedOut ? "timeout" : "network_error", { cause: error });
      }

      // The response body can echo addresses, so it's read and dropped, never kept.
      await response.text().catch(() => "");
      if (!response.ok) {
        const { code, retryable } = failureFor(response.status, response.headers.get("x-amzn-ErrorType"));
        throw new MailerError(code, { retryable });
      }
    },
  };
}

/**
 * The variables are named SES_*, not AWS_*, so they can't clash with the AWS
 * variables a host's own runtime may set.
 */
const SesEnv = z.object({
  SES_ACCESS_KEY_ID: z.string().regex(/^[A-Z0-9]{16,128}$/),
  SES_SECRET_ACCESS_KEY: z.string().min(16),
  SES_REGION: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/).default("eu-north-1"),
  ALERT_FROM: z.email(),
  ALERT_TO: z
    .string()
    .transform((value) => value.split(",").map((address) => address.trim()))
    .pipe(z.array(z.email()).min(1)),
});

/**
 * Reads the SES settings and the alert addresses from the environment, and
 * checks them. On a problem it names the variables, never their values.
 */
export function sesOptionsFromEnv(env: Readonly<Record<string, string | undefined>>): {
  ses: Pick<SesMailerOptions, "accessKeyId" | "secretAccessKey" | "region">;
  alerts: AlertAddresses;
} {
  const result = SesEnv.safeParse(env);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`Missing or invalid environment variables: ${names.join(", ")}`);
  }
  return {
    ses: {
      accessKeyId: result.data.SES_ACCESS_KEY_ID,
      secretAccessKey: result.data.SES_SECRET_ACCESS_KEY,
      region: result.data.SES_REGION,
    },
    alerts: { from: result.data.ALERT_FROM, to: result.data.ALERT_TO },
  };
}
