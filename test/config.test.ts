import { describe, expect, it } from "vitest";
import { atelierContact } from "../src/example/atelier-contact";
import { defineContactForm, emailField, textField, type ContactFormInput } from "../src/kit";

const message = textField("Message", { max: 2000, required: "Écrivez votre message." });

function input(overrides: Partial<ContactFormInput> = {}): ContactFormInput {
  return {
    siteName: "Test",
    from: "site@example.test",
    nextSteps: "Nous vous répondrons.",
    recipients: { equipe: ["equipe@example.test"] },
    commonFields: {
      name: textField("Nom", { max: 100, required: "Indiquez votre nom." }),
      email: emailField("E-mail", { required: "Indiquez votre e-mail.", invalid: "E-mail invalide." }),
    },
    reasons: { autre: { label: "Autre question", to: "equipe", fields: { message } } },
    ...overrides,
  };
}

describe("defineContactForm: the deploy fails on a bad routing table", () => {
  it("accepts the cabinetmaker's configuration", () => {
    expect(atelierContact.reasons["devis"]?.to).toBe("fondateur");
    expect(atelierContact.retentionDays).toBe(7);
    expect(atelierContact.spam.tokenMaxAgeMs).toBe(24 * 60 * 60_000);
  });

  it("fails when a reason goes to a role with no recipient list", () => {
    expect(() =>
      defineContactForm(input({ reasons: { autre: { label: "Autre", to: "personne", fields: { message } } } })),
    ).toThrow('reasons.autre goes to "personne", which isn\'t in recipients');
  });

  it("fails when a recipient list is empty or holds an invalid address", () => {
    expect(() => defineContactForm(input({ recipients: { equipe: [] } }))).toThrow("recipients.equipe has no address");
    expect(() => defineContactForm(input({ recipients: { equipe: ["equipe@"] } }))).toThrow(
      'recipients.equipe: "equipe@" isn\'t a valid address',
    );
  });

  it("fails when the sender address is invalid", () => {
    expect(() => defineContactForm(input({ from: "site" }))).toThrow('from: "site" isn\'t a valid address');
  });

  it("fails when two reasons share a field name, or a field uses a reserved name", () => {
    expect(() =>
      defineContactForm(
        input({
          reasons: {
            autre: { label: "Autre", to: "equipe", fields: { message } },
            suivi: { label: "Suivi", to: "equipe", fields: { message, website: message } },
          },
        }),
      ),
    ).toThrow(/reasons\.suivi\.message: field names must be unique[\s\S]*reasons\.suivi\.website: "website" is reserved/);
  });

  it("fails without the name and email fields the emails need", () => {
    expect(() => defineContactForm(input({ commonFields: {} }))).toThrow('commonFields needs a "name" field');
  });
});
