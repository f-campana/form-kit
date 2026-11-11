/**
 * Spam checks that don't track visitors: a signed form token for the minimum
 * fill time, and a keyed hash of the visitor's address for the rate limit.
 * Uses Web Crypto only, so it runs on Node, Bun and edge runtimes alike.
 */

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function hmacKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

async function sign(secret: string, message: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    encoder.encode(message),
  );
  return toBase64Url(new Uint8Array(signature));
}

/**
 * The token a page puts in the form's hidden field when it renders the form.
 * It must be issued when the page is served: a page built ahead of time would
 * carry its build time, and every submission would pass the minimum fill time.
 */
export async function issueFormToken(secret: string, now: Date): Promise<string> {
  const issuedAt = String(now.getTime());
  return `${issuedAt}.${await sign(secret, `form-token:${issuedAt}`)}`;
}

export type TokenCheck = "ok" | "too_fast" | "invalid";

export async function checkFormToken(
  secret: string,
  token: unknown,
  now: Date,
  minFillMs: number,
): Promise<TokenCheck> {
  if (typeof token !== "string") return "invalid";
  const [issuedAt, signature, ...rest] = token.split(".");
  if (issuedAt === undefined || signature === undefined || rest.length > 0) return "invalid";
  if (!/^\d{1,15}$/.test(issuedAt)) return "invalid";
  const signatureBytes = fromBase64Url(signature);
  if (signatureBytes === undefined) return "invalid";

  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    signatureBytes,
    encoder.encode(`form-token:${issuedAt}`),
  );
  if (!valid) return "invalid";
  return now.getTime() - Number(issuedAt) < minFillMs ? "too_fast" : "ok";
}

/**
 * The rate limit's key for a visitor's address. A keyed hash: without the
 * secret, the address can't be recovered or matched from the stored key.
 */
export function visitorKey(secret: string, address: string): Promise<string> {
  return sign(secret, `visitor:${address}`);
}
