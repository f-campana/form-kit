import { describe, expect, it } from "vitest";
import { atelierContact as config } from "../src/example/atelier-contact";
import { checkFormToken, issueFormToken, parseSubmission, visitorKey } from "../src/kit";
import { SECRET, START } from "./support";

describe("form token", () => {
  const at = (ms: number) => new Date(START.getTime() + ms);

  it("passes once the minimum fill time has gone by, and not before", async () => {
    const token = await issueFormToken(SECRET, START);
    expect(await checkFormToken(SECRET, token, at(3_000), 3_000)).toBe("ok");
    expect(await checkFormToken(SECRET, token, at(2_999), 3_000)).toBe("too_fast");
  });

  it("rejects a token signed with another secret, or with an edited time", async () => {
    const token = await issueFormToken(SECRET, START);
    const signature = token.split(".")[1];
    expect(await checkFormToken("another-secret-of-at-least-32-characters", token, at(60_000), 3_000)).toBe("invalid");
    expect(await checkFormToken(SECRET, `${START.getTime() - 3_600_000}.${signature}`, at(60_000), 3_000)).toBe("invalid");
  });

  it.each([undefined, 42, "", "123", "123.", ".abc", "123.abc.def", "abc.def", "123.a+b/c="])(
    "rejects %s",
    async (token) => {
      expect(await checkFormToken(SECRET, token, at(60_000), 3_000)).toBe("invalid");
    },
  );
});

describe("visitor key", () => {
  it("is stable for one address and secret, and changes with either", async () => {
    const key = await visitorKey(SECRET, "203.0.113.7");
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await visitorKey(SECRET, "203.0.113.7")).toBe(key);
    expect(await visitorKey(SECRET, "203.0.113.8")).not.toBe(key);
    expect(await visitorKey("another-secret-of-at-least-32-characters", "203.0.113.7")).not.toBe(key);
  });
});

describe("parseSubmission", () => {
  it("trims values, keeps line breaks only in long answers, and drops blank optional fields", () => {
    const result = parseSubmission(config, {
      reason: "devis",
      name: "  Camille \n  Durand ",
      email: " camille@example.org ",
      phone: "",
      projectType: "Autre",
      commune: "Créon",
      description: "Ligne 1\r\nLigne 2  ",
      dimensions: "   ",
      timeline: "Je ne sais pas encore",
      budget: "",
    });

    expect(result).toEqual({
      ok: true,
      reason: "devis",
      data: {
        name: "Camille Durand",
        email: "camille@example.org",
        projectType: "Autre",
        commune: "Créon",
        description: "Ligne 1\nLigne 2",
        timeline: "Je ne sais pas encore",
      },
    });
  });

  it("reports the missing reason together with the common fields' errors", () => {
    expect(parseSubmission(config, { name: "", email: "camille@example.org" })).toEqual({
      ok: false,
      fieldErrors: { reason: "Choisissez le motif de votre message.", name: "Indiquez votre nom." },
    });
  });

  it("treats a file or a number where text is expected as invalid", () => {
    const result = parseSubmission(config, {
      reason: "autre",
      name: 42,
      email: "camille@example.org",
      message: new Blob(["texte"]),
    });
    expect(result).toEqual({
      ok: false,
      fieldErrors: { name: "Indiquez votre nom.", message: "Écrivez votre message." },
    });
  });
});
