import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_TOKEN_BYTES = 32;
const TOKEN_PREFIX = "st1_", HASH_PREFIX = "sha256$1$";
const HASH_DOMAIN = "sample-workflow:session-token:v1\0";
export type SessionTokenFailure = "invalid_token" | "invalid_hash" | "crypto_unavailable";
export class SessionTokenError extends Error {
  readonly code: SessionTokenFailure;
  constructor(code: SessionTokenFailure) {
    super(code === "crypto_unavailable" ? "Session token crypto is unavailable" : "Session token material is malformed");
    this.name = "SessionTokenError"; this.code = code;
  }
}
function decode(value: unknown, prefix: string, code: "invalid_token" | "invalid_hash"): Buffer {
  if (typeof value !== "string" || value.length !== prefix.length + 43 || !value.startsWith(prefix)) throw new SessionTokenError(code);
  const encoded = value.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new SessionTokenError(code);
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length !== SESSION_TOKEN_BYTES || bytes.toString("base64url") !== encoded) throw new SessionTokenError(code);
  return bytes;
}
function digest(bytes: Buffer): Buffer {
  try { return createHash("sha256").update(HASH_DOMAIN, "utf8").update(bytes).digest(); }
  catch { throw new SessionTokenError("crypto_unavailable"); }
}
export function hashSessionToken(token: unknown): string {
  const bytes = decode(token, TOKEN_PREFIX, "invalid_token");
  try { return HASH_PREFIX + digest(bytes).toString("base64url"); }
  finally { bytes.fill(0); }
}
// The raw token is returned only for delivery to its owner; persistence stores
// tokenHash. This utility supplies neither identity nor expiry/revocation policy.
export function createSessionToken(): { token: string; tokenHash: string } {
  let bytes: Buffer;
  try { bytes = randomBytes(SESSION_TOKEN_BYTES); }
  catch { throw new SessionTokenError("crypto_unavailable"); }
  try {
    const token = TOKEN_PREFIX + bytes.toString("base64url");
    return { token, tokenHash: HASH_PREFIX + digest(bytes).toString("base64url") };
  } finally { bytes.fill(0); }
}
export function verifySessionToken(token: unknown, tokenHash: unknown): boolean {
  const expected = decode(tokenHash, HASH_PREFIX, "invalid_hash");
  const bytes = decode(token, TOKEN_PREFIX, "invalid_token");
  let actual: Buffer | undefined;
  try { actual = digest(bytes); return timingSafeEqual(actual, expected); }
  finally { bytes.fill(0); expected.fill(0); actual?.fill(0); }
}
