/**
 * Spam checks that don't track visitors: a signed, single-use form token for
 * the minimum fill time and the form's expiry, and a keyed hash of the
 * visitor's address for the rate limit.
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
  // The random part makes every token unique, so each one can be used once.
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  return `${issuedAt}.${nonce}.${await sign(secret, `form-token:${issuedAt}.${nonce}`)}`;
}

async function sha256(text: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/**
 * What the store keeps to know a token was used. A hash, so the token itself
 * is never stored. Call it only on a token `checkFormToken` accepted.
 *
 * It covers the signed part only, never the signature: a signature can be
 * spelled several ways that all verify, and each spelling would otherwise
 * count as a new token.
 */
export function formTokenId(token: string): Promise<string> {
  const [issuedAt, nonce] = token.split(".");
  return sha256(`form-token-id:${issuedAt}.${nonce}`);
}

/**
 * Identifies what a visitor sent, so the same form arriving twice (a double
 * click, or a resend after a lost response) can be told from a used token
 * coming back with something else.
 */
export function contentFingerprint(reason: string, data: Readonly<Record<string, string>>): Promise<string> {
  const fields = Object.keys(data)
    .sort()
    .map((name) => [name, data[name]]);
  return sha256(`content:${JSON.stringify([reason, fields])}`);
}

export type TokenCheck = "ok" | "too_fast" | "expired" | "invalid";

export async function checkFormToken(
  secret: string,
  token: unknown,
  now: Date,
  minFillMs: number,
  maxAgeMs: number,
): Promise<TokenCheck> {
  if (typeof token !== "string") return "invalid";
  const [issuedAt, nonce, signature, ...rest] = token.split(".");
  if (issuedAt === undefined || nonce === undefined || signature === undefined || rest.length > 0) return "invalid";
  if (!/^\d{1,15}$/.test(issuedAt) || !/^[A-Za-z0-9_-]{1,64}$/.test(nonce)) return "invalid";
  const signatureBytes = fromBase64Url(signature);
  if (signatureBytes === undefined) return "invalid";

  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    signatureBytes,
    encoder.encode(`form-token:${issuedAt}.${nonce}`),
  );
  if (!valid) return "invalid";
  const age = now.getTime() - Number(issuedAt);
  if (age < minFillMs) return "too_fast";
  return age >= maxAgeMs ? "expired" : "ok";
}

/**
 * The rate limit's key for a visitor's address. A keyed hash: without the
 * secret, the address can't be recovered or matched from the stored key.
 */
export function visitorKey(secret: string, address: string): Promise<string> {
  return sign(secret, `visitor:${address}`);
}
