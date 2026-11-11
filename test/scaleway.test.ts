import { describe, expect, it } from "vitest";
import { scalewayMailer, scalewayOptionsFromEnv, textToHtml } from "../src/adapters/scaleway";
import { atelierContact as config } from "../src/example/atelier-contact";
import { MailerError, submitContact } from "../src/kit";
import { setup, submission, VISITOR } from "./support";

const SECRET_KEY = "11111111-2222-4333-8444-555555555555";
const PROJECT_ID = "66666666-7777-4888-9999-000000000000";
const ENDPOINT = "https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails";

/** A stand-in for fetch that records requests and answers with `status`. */
function fakeFetch(status = 200) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ emails: [{ id: "e-1", status: "new" }] }), { status });
  }) as typeof fetch;
  const bodies = () => requests.map((request) => JSON.parse(String(request.init.body)) as Record<string, unknown>);
  return { fetchFn, requests, bodies };
}

const email = {
  from: "formulaire@atelier.example",
  to: ["fondateur@atelier.example"],
  replyTo: "camille@example.org",
  subject: "Demande de devis — Camille Durand",
  text: "Bonjour,\n\nUne cuisine <en chêne> & un îlot.\nMerci.",
};

describe("Scaleway mailer", () => {
  it("sends the request Scaleway documents, with Reply-To as an extra header", async () => {
    const { fetchFn, requests, bodies } = fakeFetch();
    const mailer = scalewayMailer({ secretKey: SECRET_KEY, projectId: PROJECT_ID, fromName: "L’atelier", fetch: fetchFn });

    await mailer.send(email);

    expect(requests[0]?.url).toBe(ENDPOINT);
    expect(requests[0]?.init.method).toBe("POST");
    expect(requests[0]?.init.headers).toEqual({ "Content-Type": "application/json", "X-Auth-Token": SECRET_KEY });
    expect(bodies()[0]).toEqual({
      from: { email: "formulaire@atelier.example", name: "L’atelier" },
      to: [{ email: "fondateur@atelier.example" }],
      subject: "Demande de devis — Camille Durand",
      text: email.text,
      html: "<html><body><p>Bonjour,</p><p>Une cuisine &lt;en chêne&gt; &amp; un îlot.<br>Merci.</p></body></html>",
      project_id: PROJECT_ID,
      additional_headers: [{ key: "Reply-To", value: "camille@example.org" }],
    });
  });

  it("leaves out the Reply-To header and the display name when there are none", async () => {
    const { fetchFn, bodies } = fakeFetch();
    const { replyTo: _none, ...withoutReplyTo } = email;

    await scalewayMailer({ secretKey: SECRET_KEY, projectId: PROJECT_ID, fetch: fetchFn }).send(withoutReplyTo);

    expect(bodies()[0]).not.toHaveProperty("additional_headers");
    expect(bodies()[0]?.["from"]).toEqual({ email: "formulaire@atelier.example" });
  });

  it.each([
    [500, "provider_500", true],
    [503, "provider_503", true],
    [429, "busy_429", true],
    [401, "auth_401", true],
    [403, "auth_403", true],
    [400, "rejected_400", false],
    [404, "rejected_404", false],
  ])("turns HTTP %i into %s (retryable: %s), without addresses in the error", async (status, code, retryable) => {
    const { fetchFn } = fakeFetch(status);
    const mailer = scalewayMailer({ secretKey: SECRET_KEY, projectId: PROJECT_ID, fetch: fetchFn });

    const error = await mailer.send(email).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MailerError);
    expect(error).toMatchObject({ code, retryable });
    expect((error as Error).message).not.toContain("@");
  });

  it("reports a network failure and a timeout as retryable", async () => {
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const hanging = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;

    const network = await scalewayMailer({ secretKey: SECRET_KEY, projectId: PROJECT_ID, fetch: offline })
      .send(email)
      .catch((caught: unknown) => caught);
    const timeout = await scalewayMailer({ secretKey: SECRET_KEY, projectId: PROJECT_ID, fetch: hanging, timeoutMs: 20 })
      .send(email)
      .catch((caught: unknown) => caught);

    expect(network).toMatchObject({ code: "network_error", retryable: true });
    expect(timeout).toMatchObject({ code: "timeout", retryable: true });
  });

  it("carries a whole submission: the notification to the reason's recipients, the copy to the visitor", async () => {
    const { deps, clock } = setup();
    const { fetchFn, bodies } = fakeFetch();
    const mailer = scalewayMailer({ secretKey: SECRET_KEY, projectId: PROJECT_ID, fetch: fetchFn });

    const result = await submitContact(config, { ...deps, mailer }, await submission("visite", clock.now()));

    expect(result.status).toBe("accepted");
    expect(bodies().map((body) => [body["to"], body["additional_headers"]])).toEqual([
      [[{ email: "fondateur@example.test" }], [{ key: "Reply-To", value: VISITOR.email }]],
      [[{ email: VISITOR.email }], [{ key: "Reply-To", value: "atelier@example.test" }]],
    ]);
  });
});

describe("textToHtml", () => {
  it("escapes markup and keeps paragraphs and line breaks", () => {
    expect(textToHtml('a <b>\n"c"\n\nd & e')).toBe(
      "<html><body><p>a &lt;b&gt;<br>&quot;c&quot;</p><p>d &amp; e</p></body></html>",
    );
  });
});

describe("scalewayOptionsFromEnv", () => {
  it("reads the key, Project and region", () => {
    expect(scalewayOptionsFromEnv({ SCW_SECRET_KEY: SECRET_KEY, SCW_DEFAULT_PROJECT_ID: PROJECT_ID })).toEqual({
      secretKey: SECRET_KEY,
      projectId: PROJECT_ID,
      region: "fr-par",
    });
  });

  it("names missing or malformed variables without printing their values", () => {
    expect(() => scalewayOptionsFromEnv({ SCW_SECRET_KEY: "pas-une-cle" })).toThrow(
      "Missing or invalid environment variables: SCW_SECRET_KEY, SCW_DEFAULT_PROJECT_ID",
    );
    expect(() => scalewayOptionsFromEnv({ SCW_SECRET_KEY: "pas-une-cle" })).not.toThrow(/pas-une-cle/);
  });
});
