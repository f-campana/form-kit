import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { describe, expect, it } from "vitest";
import { sesMailer, sesOptionsFromEnv } from "../src/adapters/ses";
import { atelierContact as config } from "../src/example/atelier-contact";
import { emailAlerter, MailerError, processDue, sendTestAlert, submitContact } from "../src/kit";
import { ALERTS, MINUTE, REASON_VALUES, setup, START, submission, VISITOR } from "./support";

// AWS's documented example credentials, not real ones.
const CREDENTIALS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const ENDPOINT = "https://email.eu-north-1.amazonaws.com/v2/email/outbound-emails";

/** A fake SES endpoint: records requests and answers with the next status in `statuses` (the last one repeats). */
function fakeSes(statuses: number[] = [200], errorType?: string) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    const status = statuses[Math.min(requests.length - 1, statuses.length - 1)]!;
    const headers = errorType === undefined || status < 300 ? {} : { "x-amzn-ErrorType": errorType };
    return new Response(status < 300 ? JSON.stringify({ MessageId: "m-1" }) : "{}", { status, headers });
  }) as typeof fetch;
  const bodies = () => requests.map((request) => JSON.parse(String(request.init.body)) as Record<string, unknown>);
  const headers = (index = 0) => requests[index]!.init.headers as Record<string, string>;
  return { fetchFn, requests, bodies, headers };
}

const ses = (fetchFn: typeof fetch, extra: Partial<Parameters<typeof sesMailer>[0]> = {}) =>
  sesMailer({ ...CREDENTIALS, fetch: fetchFn, now: () => START, ...extra });

const email = {
  from: "alertes@example.test",
  to: ["fabien@example.test"],
  subject: "Form alert: Atelier, notification not sent (7K3F9QXM)",
  text: "Site: Atelier\nRéférence : 7K3F9QXM",
};

describe("SES mailer", () => {
  it("sends the SendEmail request SES v2 documents, in Stockholm by default", async () => {
    const { fetchFn, requests, bodies, headers } = fakeSes();

    await ses(fetchFn).send({ ...email, replyTo: "reply@example.test" });

    expect(requests[0]?.url).toBe(ENDPOINT);
    expect(requests[0]?.init.method).toBe("POST");
    expect(headers()).toMatchObject({ "content-type": "application/json", "x-amz-date": "20261111T090000Z" });
    expect(headers()["authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261111\/eu-north-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(bodies()[0]).toEqual({
      FromEmailAddress: "alertes@example.test",
      Destination: { ToAddresses: ["fabien@example.test"] },
      ReplyToAddresses: ["reply@example.test"],
      Content: {
        Simple: {
          Subject: { Data: email.subject, Charset: "UTF-8" },
          Body: { Text: { Data: email.text, Charset: "UTF-8" } },
        },
      },
    });
  });

  it.each([
    ["without a session token", {}],
    ["with a session token", { sessionToken: "session-token-example" }],
  ])("signs exactly as the AWS SDK's own signer does, %s", async (_case, extra: { sessionToken?: string }) => {
    const { fetchFn, requests, headers } = fakeSes();

    await ses(fetchFn, extra).send(email);

    const url = new URL(requests[0]!.url);
    const reference = new SignatureV4({
      credentials: { ...CREDENTIALS, ...extra },
      region: "eu-north-1",
      service: "ses",
      sha256: Hash.bind(null, "sha256"),
      applyChecksum: false,
    });
    const signed = await reference.sign(
      new HttpRequest({
        method: "POST",
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname,
        headers: { "content-type": "application/json", host: url.hostname },
        body: String(requests[0]!.init.body),
      }),
      { signingDate: START },
    );
    expect(headers()["authorization"]).toBe(signed.headers["authorization"]);
    expect(headers()["x-amz-security-token"]).toBe(extra.sessionToken);
  });

  it("uses another region when told", async () => {
    const { fetchFn, requests, headers } = fakeSes();

    await ses(fetchFn, { region: "eu-central-1" }).send(email);

    expect(requests[0]?.url).toBe("https://email.eu-central-1.amazonaws.com/v2/email/outbound-emails");
    expect(headers()["authorization"]).toContain("/eu-central-1/ses/aws4_request");
  });

  it.each([
    [500, undefined, "provider_500", true],
    [503, undefined, "provider_503", true],
    [429, "TooManyRequestsException", "busy_429_TooManyRequestsException", true],
    [403, "UnrecognizedClientException:http://internal.amazon.com/coral/", "auth_403_UnrecognizedClientException", true],
    [400, "MessageRejected", "rejected_400_MessageRejected", false],
    [400, "<script>", "rejected_400_script", false],
  ])("turns HTTP %i (%s) into %s (retryable: %s), without secrets or addresses", async (status, type, code, retryable) => {
    const { fetchFn } = fakeSes([status], type);

    const error = await ses(fetchFn).send(email).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MailerError);
    expect(error).toMatchObject({ code, retryable });
    expect((error as Error).message).not.toContain("@");
    expect((error as Error).message).not.toContain(CREDENTIALS.secretAccessKey);
  });

  it("reports a network failure as retryable", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    await expect(ses(failing).send(email)).rejects.toMatchObject({ code: "network_error", retryable: true });
  });

  describe("settings from the environment", () => {
    const env = {
      SES_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      SES_SECRET_ACCESS_KEY: CREDENTIALS.secretAccessKey,
      ALERT_FROM: "alertes@example.test",
      ALERT_TO: "fabien@example.test, second@example.test",
    };

    it("reads the key, the region (Stockholm by default) and where alerts go", () => {
      expect(sesOptionsFromEnv(env)).toEqual({
        ses: { ...CREDENTIALS, accessKeyId: "AKIAIOSFODNN7EXAMPLE", region: "eu-north-1" },
        alerts: { from: "alertes@example.test", to: ["fabien@example.test", "second@example.test"] },
      });
      expect(sesOptionsFromEnv({ ...env, SES_REGION: "eu-central-1" }).ses.region).toBe("eu-central-1");
    });

    it("names missing or invalid variables, never their values", () => {
      const { SES_ACCESS_KEY_ID: _missing, ...partial } = env;

      const read = () => sesOptionsFromEnv({ ...partial, ALERT_TO: "not-an-address" });

      expect(read).toThrow(/SES_ACCESS_KEY_ID, ALERT_TO|ALERT_TO, SES_ACCESS_KEY_ID/);
      expect(read).not.toThrow(CREDENTIALS.secretAccessKey);
    });
  });
});

describe("alerts through SES, against a fake SES endpoint", () => {
  const rejected = () => new MailerError("rejected_400", { retryable: false });
  const alertSubjects = (ses: ReturnType<typeof fakeSes>) =>
    ses.bodies().map((body) => (body["Content"] as { Simple: { Subject: { Data: string } } }).Simple.Subject.Data);

  it("sends an alert after the last failed attempt", async () => {
    const endpoint = fakeSes();
    const { deps, clock } = setup({ failWhen: () => true });
    const sesDeps = { ...deps, alerter: emailAlerter(ses(endpoint.fetchFn), ALERTS) };

    await submitContact(config, sesDeps, await submission("devis", clock.now()));
    for (const wait of [5, 30]) {
      expect(endpoint.requests).toHaveLength(0);
      clock.advance(wait * MINUTE);
      await processDue(config, sesDeps);
    }

    expect(alertSubjects(endpoint)).toEqual([
      expect.stringMatching(/^Form alert: .+, notification not sent \([2-9A-Z]{8}\)$/),
      expect.stringMatching(/^Form alert: .+, confirmation not sent \([2-9A-Z]{8}\)$/),
    ]);
    expect(endpoint.bodies()[0]?.["Destination"]).toEqual({ ToAddresses: ALERTS.to });
  });

  it("records a failed alert, logs it as an error, and sends it on a later run", async () => {
    const endpoint = fakeSes([503, 200]);
    const { deps, clock, store, logs } = setup({ failWhen: (sent) => !sent.to.includes(VISITOR.email), failWith: rejected });
    const sesDeps = { ...deps, alerter: emailAlerter(ses(endpoint.fetchFn), ALERTS) };

    await submitContact(config, sesDeps, await submission("visite", clock.now()));
    expect(store.records.get("sub-1")?.messages.notification.alertedAt).toBeUndefined();
    expect(logs).toContainEqual(expect.stringMatching(/"level":"error","event":"alert_failed".*"error":"provider_503"/));

    clock.advance(MINUTE);
    await processDue(config, sesDeps);

    expect(endpoint.requests).toHaveLength(2);
    expect(store.records.get("sub-1")?.messages.notification.alertedAt).toBe(clock.now().toISOString());
  });

  it("sends the monthly test alert", async () => {
    const endpoint = fakeSes();
    const { deps } = setup();

    await sendTestAlert(config, { ...deps, alerter: emailAlerter(ses(endpoint.fetchFn), ALERTS) });

    expect(alertSubjects(endpoint)).toEqual([`Form alert test: ${config.siteName}`]);
  });

  it("sends SES nothing the visitor submitted", async () => {
    const endpoint = fakeSes();
    const { deps, clock } = setup({ failWhen: () => true, failWith: rejected });

    await submitContact(
      config,
      { ...deps, alerter: emailAlerter(ses(endpoint.fetchFn), ALERTS) },
      await submission("devis", clock.now()),
    );

    expect(endpoint.requests).toHaveLength(2);
    const sent = endpoint.requests.map((request) => String(request.init.body)).join("\n");
    for (const value of [...Object.values(VISITOR), ...Object.values(REASON_VALUES.devis)]) {
      expect(sent).not.toContain(JSON.stringify(value).slice(1, -1));
    }
  });
});
