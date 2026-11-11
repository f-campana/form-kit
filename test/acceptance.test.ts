import { describe, expect, it } from "vitest";
import { atelierContact as config } from "../src/example/atelier-contact";
import {
  deliverSubmission,
  issueFormToken,
  MailerError,
  processDue,
  purgeDelivered,
  submitContact,
} from "../src/kit";
import { DAY, MINUTE, REASONS, SECRET, setup, submission, VISITOR } from "./support";

// Written from pilot-spec.md §3, independently of the implementation.
const EXPECTED_RECIPIENTS = {
  devis: ["fondateur@example.test"],
  visite: ["fondateur@example.test"],
  suivi: ["atelier@example.test"],
  autre: ["atelier@example.test"],
};

describe("Contact form acceptance tests (pilot-spec.md §3)", () => {
  describe("each reason reaches only its recipients", () => {
    it.each(REASONS)("%s", async (reason) => {
      const { deps, clock, mail } = setup();

      const result = await submitContact(config, deps, await submission(reason, clock.now()));

      expect(result).toEqual({ status: "accepted", id: "sub-1" });
      expect(mail.sent.map((email) => email.to)).toEqual([EXPECTED_RECIPIENTS[reason], [VISITOR.email]]);
    });
  });

  it("rejects an unknown or edited reason key, and stores and sends nothing", async () => {
    const { deps, clock, mail, store } = setup();

    for (const reason of ["inconnu", "__proto__", "constructor", "DEVIS", "", undefined]) {
      const result = await submitContact(config, deps, await submission("autre", clock.now(), { reason }));
      expect(result).toEqual({
        status: "invalid",
        fieldErrors: { reason: "Choisissez le motif de votre message." },
      });
    }
    expect(store.records.size).toBe(0);
    expect(mail.attempts).toHaveLength(0);
  });

  it("ignores recipients and other reasons' fields smuggled into a submission", async () => {
    const { deps, clock, mail, store } = setup();

    await submitContact(
      config,
      deps,
      await submission("autre", clock.now(), {
        to: "intrus@example.com",
        recipients: ["intrus@example.com"],
        availability: "Champ d’un autre motif",
        budget: "Plus de 20 000 €",
      }),
    );

    expect(mail.sent.map((email) => email.to)).toEqual([["atelier@example.test"], [VISITOR.email]]);
    expect(Object.keys(store.records.get("sub-1")?.data ?? {}).sort()).toEqual([
      "email",
      "message",
      "name",
      "phone",
    ]);
    const everything = mail.sent.map((email) => `${email.subject}\n${email.text}`).join("\n");
    expect(everything).not.toContain("intrus@example.com");
    expect(everything).not.toContain("Champ d’un autre motif");
  });

  it("gives one plain-French error per missing or invalid field, and stores nothing", async () => {
    const { deps, clock, store } = setup();

    const result = await submitContact(
      config,
      deps,
      await submission("devis", clock.now(), {
        name: "   ",
        email: "camille@",
        phone: "appelez-moi",
        commune: "",
        description: "\n\n",
        dimensions: "x".repeat(201),
        budget: "Un million",
      }),
    );

    expect(result).toEqual({
      status: "invalid",
      fieldErrors: {
        name: "Indiquez votre nom.",
        email: "Cette adresse e-mail n’est pas valide.",
        phone: "Ce numéro de téléphone n’est pas valide.",
        commune: "Indiquez la commune du projet.",
        description: "Décrivez votre projet.",
        dimensions: "200 caractères maximum.",
        budget: "Choisissez un budget dans la liste.",
      },
    });
    expect(store.records.size).toBe(0);
  });

  describe("with the email provider down", () => {
    it("stores the submission, retries it, then alerts the developer once per message", async () => {
      const { deps, clock, mail, store, alerts } = setup({ failWhen: () => true });

      const result = await submitContact(config, deps, await submission("devis", clock.now()));
      expect(result).toEqual({ status: "accepted", id: "sub-1" });
      expect(store.records.get("sub-1")?.messages.notification).toMatchObject({ status: "pending", attempts: 1 });

      clock.advance(4 * MINUTE);
      await processDue(config, deps);
      expect(mail.attempts).toHaveLength(2); // the first retry isn't due yet

      clock.advance(MINUTE);
      await processDue(config, deps);
      expect(mail.attempts).toHaveLength(4); // second attempt, five minutes in

      clock.advance(30 * MINUTE);
      await processDue(config, deps);
      expect(mail.attempts).toHaveLength(6); // third and last attempt, 35 minutes in
      expect(alerts).toEqual([
        { submissionId: "sub-1", message: "notification", attempts: 3, lastError: "provider_unavailable" },
        { submissionId: "sub-1", message: "confirmation", attempts: 3, lastError: "provider_unavailable" },
      ]);

      clock.advance(DAY);
      await processDue(config, deps);
      expect(mail.attempts).toHaveLength(6);
      expect(alerts).toHaveLength(2);

      clock.advance(31 * DAY);
      await purgeDelivered(config, deps);
      expect(store.records.get("sub-1")?.messages.notification.status).toBe("failed"); // kept for follow-up
    });

    it("delivers on a later attempt once the provider is back, without alerting", async () => {
      const { deps, clock, mail, store, alerts } = setup({ failWhen: () => true });
      await submitContact(config, deps, await submission("visite", clock.now()));

      mail.failWhen(() => false);
      clock.advance(5 * MINUTE);
      await processDue(config, deps);

      expect(mail.sent.map((email) => email.to)).toEqual([["fondateur@example.test"], [VISITOR.email]]);
      expect(alerts).toEqual([]);
      expect(store.records.get("sub-1")?.deliveredAt).toBe(clock.now().toISOString());
    });

    it("alerts at once, without retrying, when the service rejects the email as invalid", async () => {
      const { deps, clock, mail, alerts } = setup({
        failWhen: (email) => !email.to.includes(VISITOR.email),
        failWith: () => new MailerError("rejected_400", { retryable: false }),
      });

      await submitContact(config, deps, await submission("devis", clock.now()));
      expect(alerts).toEqual([
        { submissionId: "sub-1", message: "notification", attempts: 1, lastError: "rejected_400" },
      ]);

      clock.advance(DAY);
      await processDue(config, deps);
      expect(mail.attempts).toHaveLength(2); // one notification attempt, one confirmation, no retries
    });

    it("never resends the notification when only the confirmation fails", async () => {
      const { deps, clock, mail, alerts } = setup({ failWhen: (email) => email.to.includes(VISITOR.email) });
      await submitContact(config, deps, await submission("suivi", clock.now()));

      for (const wait of [5, 30, 60]) {
        clock.advance(wait * MINUTE);
        await processDue(config, deps);
      }

      expect(mail.sent.map((email) => email.to)).toEqual([["atelier@example.test"]]);
      expect(mail.attempts).toHaveLength(4); // one notification, three confirmation attempts
      expect(alerts).toEqual([
        { submissionId: "sub-1", message: "confirmation", attempts: 3, lastError: "provider_unavailable" },
      ]);
    });
  });

  it("notifies no one about a honeypot submission, and stores nothing", async () => {
    const { deps, clock, mail, store } = setup();

    const result = await submitContact(
      config,
      deps,
      await submission("devis", clock.now(), { website: "https://promo.example" }),
    );

    expect(result).toEqual({ status: "accepted" });
    expect(store.records.size).toBe(0);
    expect(mail.attempts).toHaveLength(0);
  });

  it.each([
    ["missing", undefined],
    ["forged", "1794390000000.c2lnbmF0dXJlLWZvcmdlZQ"],
    ["malformed", "pas-un-jeton"],
  ])("silently discards a submission whose form token is %s", async (_case, formToken) => {
    const { deps, clock, mail, store } = setup();

    const result = await submitContact(config, deps, await submission("autre", clock.now(), { formToken }));

    expect(result).toEqual({ status: "accepted" });
    expect(store.records.size).toBe(0);
    expect(mail.attempts).toHaveLength(0);
  });

  it("silently discards a submission sent faster than a person could fill the form", async () => {
    const { deps, clock, mail, store } = setup();
    const formToken = await issueFormToken(SECRET, new Date(clock.now().getTime() - 1_000));

    const result = await submitContact(config, deps, await submission("autre", clock.now(), { formToken }));

    expect(result).toEqual({ status: "accepted" });
    expect(store.records.size).toBe(0);
    expect(mail.attempts).toHaveLength(0);
  });

  it("shows success only once the submission is stored", async () => {
    const { deps, clock, mail } = setup();
    const store = {
      ...deps.store,
      insert: async () => {
        throw new Error("database unreachable");
      },
    };

    const result = await submitContact(config, { ...deps, store }, await submission("devis", clock.now()));

    expect(result).toEqual({ status: "unavailable" });
    expect(mail.attempts).toHaveLength(0);
  });

  it("limits each visitor to five submissions an hour, keeping only a hash of their address", async () => {
    const { deps, clock, rateLimiter } = setup();
    const visitor = { address: "203.0.113.7" };

    const statuses: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await submitContact(config, deps, await submission("autre", clock.now()), visitor)).status);
    }
    expect(statuses).toEqual(["accepted", "accepted", "accepted", "accepted", "accepted", "rate_limited"]);

    const other = await submitContact(config, deps, await submission("autre", clock.now()), { address: "198.51.100.4" });
    expect(other.status).toBe("accepted");
    expect(rateLimiter.keys().join(" ")).not.toContain("203.0.113.7");

    clock.advance(61 * MINUTE);
    const later = await submitContact(config, deps, await submission("autre", clock.now()), visitor);
    expect(later.status).toBe("accepted");
  });

  it("lets the recipient reply straight to the visitor", async () => {
    const { deps, clock, mail } = setup();

    await submitContact(config, deps, await submission("devis", clock.now()));

    expect(mail.sent[0]).toMatchObject({
      from: "formulaire@example.test",
      replyTo: VISITOR.email,
      subject: "Demande de devis — Camille Durand",
    });
  });

  it("sends the visitor a copy of their request, with nothing internal", async () => {
    const { deps, clock, mail } = setup();

    await submitContact(config, deps, await submission("devis", clock.now()));

    const confirmation = mail.sent[1];
    expect(confirmation?.replyTo).toBe("atelier@example.test");
    expect(confirmation?.text).toContain("Demande de devis");
    expect(confirmation?.text).toContain("Une cuisine en chêne pour une pièce de 12 m².\nAvec un îlot central.");
    expect(confirmation?.text).toContain("Nous reviendrons vers vous pour échanger.");
    expect(confirmation?.text).not.toContain("fondateur@example.test");
    expect(confirmation?.text).not.toContain("sub-1");
  });

  it("leaves a blank line after a multi-line answer, and none at the end of the request", async () => {
    const { deps, clock, mail } = setup();

    await submitContact(config, deps, await submission("devis", clock.now()));
    await submitContact(config, deps, await submission("autre", clock.now(), { message: "Ligne 1\nLigne 2" }));

    expect(mail.sent[0]?.text).toContain("Avec un îlot central.\n\nDimensions approximatives : 4 m × 3 m");
    expect(mail.sent[2]?.text).toContain("Ligne 1\nLigne 2\n\nRépondez directement");
    expect(mail.sent[2]?.text).not.toContain("Ligne 2\n\n\n");
  });

  it("keeps line breaks in a name out of the email subject", async () => {
    const { deps, clock, mail } = setup();

    await submitContact(
      config,
      deps,
      await submission("autre", clock.now(), { name: "Camille\r\nBcc: intrus@example.com" }),
    );

    expect(mail.sent[0]?.subject).toBe("Autre question — Camille Bcc: intrus@example.com");
  });

  it("keeps visitors' details and messages out of the logs", async () => {
    const { deps, clock, logs } = setup({ failWhen: () => true });

    await submitContact(config, deps, await submission("devis", clock.now()), { address: "203.0.113.7" });
    await submitContact(config, deps, await submission("devis", clock.now(), { email: "pas-une-adresse" }));
    for (const wait of [5, 30]) {
      clock.advance(wait * MINUTE);
      await processDue(config, deps);
    }

    expect(logs.length).toBeGreaterThan(5);
    const written = logs.join("\n");
    for (const detail of [VISITOR.name, VISITOR.email, VISITOR.phone, "Créon", "cuisine en chêne", "203.0.113.7", "pas-une-adresse"]) {
      expect(written).not.toContain(detail);
    }
  });

  it("deletes a submission 30 days after it's delivered", async () => {
    const { deps, clock, store } = setup();
    await submitContact(config, deps, await submission("autre", clock.now()));

    clock.advance(30 * DAY - MINUTE);
    expect(await purgeDelivered(config, deps)).toBe(0);

    clock.advance(MINUTE);
    expect(await purgeDelivered(config, deps)).toBe(1);
    expect(store.records.size).toBe(0);
  });

  it("never sends a message twice when delivery runs overlap", async () => {
    const { deps, clock, mail } = setup({ failWhen: () => true });
    await submitContact(config, deps, await submission("autre", clock.now()));

    mail.failWhen(() => false);
    clock.advance(5 * MINUTE);
    await Promise.all([
      processDue(config, deps),
      processDue(config, deps),
      deliverSubmission(config, deps, "sub-1"),
    ]);

    expect(mail.sent).toHaveLength(2);
  });

  it("refuses to run with a short secret", async () => {
    const { deps, clock } = setup();

    await expect(
      submitContact(config, { ...deps, secret: "trop-court" }, await submission("autre", clock.now())),
    ).rejects.toThrow("at least 32 characters");
  });
});
