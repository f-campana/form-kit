/** No 0, O, 1, I, L or U: nothing a person could misread or mishear on the phone. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const LENGTH = 8;

/**
 * The short reference a visitor and the recipients can quote for a submission.
 * It is derived from the submission's ID, so it never reveals the ID itself.
 */
export async function referenceFor(id: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`reference:${id}`));
  return Array.from(new Uint8Array(digest).slice(0, LENGTH), (byte) => ALPHABET[byte % ALPHABET.length]).join("");
}
