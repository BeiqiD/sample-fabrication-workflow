import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSessionToken, hashSessionToken, SESSION_TOKEN_BYTES, SessionTokenError, verifySessionToken } from "./tokens";

describe("Opaque hashed Node session token foundation", () => {
  it("generates canonical 256-bit opaque tokens and an independently checked domain-separated hash", () => {
    const { token, tokenHash } = createSessionToken();
    expect(/^st1_[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
    expect(/^sha256\$1\$[A-Za-z0-9_-]{43}$/.test(tokenHash)).toBe(true);
    const bytes = Buffer.from(token.slice(4), "base64url");
    expect(bytes.length).toBe(SESSION_TOKEN_BYTES);
    const independentlyHashed = "sha256$1$" + createHash("sha256").update("sample-workflow:session-token:v1\0", "utf8").update(bytes).digest("base64url");
    expect(tokenHash === independentlyHashed).toBe(true);
    expect(hashSessionToken(token) === tokenHash).toBe(true);
    expect(verifySessionToken(token, tokenHash)).toBe(true);
    expect(tokenHash.includes(token)).toBe(false);
  });

  it("generates distinct actual random token/hash pairs without retaining raw material in a receipt", () => {
    const generated = Array.from({ length: 128 }, createSessionToken);
    expect(new Set(generated.map(value => value.token)).size).toBe(128);
    expect(new Set(generated.map(value => value.tokenHash)).size).toBe(128);
    expect(generated.every(value => verifySessionToken(value.token, value.tokenHash))).toBe(true);
  });

  it("rejects another valid token or a canonical tampered digest with fixed-length comparisons", () => {
    const first = createSessionToken(), other = createSessionToken();
    expect(verifySessionToken(other.token, first.tokenHash)).toBe(false);
    const changed = Buffer.from(first.tokenHash.slice("sha256$1$".length), "base64url"); changed[0] ^= 1;
    expect(verifySessionToken(first.token, "sha256$1$" + changed.toString("base64url"))).toBe(false);
  });

  it("fails closed on oversized, unsupported, malformed or base64-alias tokens and hashes", () => {
    const pair = createSessionToken();
    for (const invalid of [null, {}, [], "", pair.token + "=", pair.token + "$extra", " " + pair.token,
      pair.token.replace("st1_", "st2_"), "st1_" + "A".repeat(42) + "B", "st1_" + "é".repeat(43), "x".repeat(100_000)]) {
      expect(() => hashSessionToken(invalid)).toThrow(expect.objectContaining({ code: "invalid_token" }));
      expect(() => verifySessionToken(invalid, pair.tokenHash)).toThrow(expect.objectContaining({ code: "invalid_token" }));
    }
    for (const invalid of [null, {}, "", pair.tokenHash + "=", pair.tokenHash.replace("$1$", "$2$"),
      pair.tokenHash.replace("sha256", "sha512"), "sha256$1$" + "A".repeat(42) + "B", "x".repeat(100_000)]) {
      expect(() => verifySessionToken(pair.token, invalid)).toThrow(expect.objectContaining({ code: "invalid_hash" }));
    }
  });

  it("keeps errors free of provided token material", () => {
    const invalid = "synthetic malformed sensitive token";
    try { hashSessionToken(invalid); throw new Error("Expected rejection"); }
    catch (error) {
      expect(error).toBeInstanceOf(SessionTokenError);
      expect(String(error)).not.toContain(invalid);
      expect((error as Error).cause).toBeUndefined();
    }
  });
});
