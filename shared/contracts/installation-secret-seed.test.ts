import { afterEach, describe, expect, it, vi } from "vitest";
import { checkedInstallationSecretSeed, generateInstallationSecretSeed, InstallationSecretSeedError,
  INSTALLATION_SECRET_SEED_BYTES, INSTALLATION_SECRET_SEED_NAME, INSTALLATION_SECRET_SEED_PREFIX } from "./installation-secret-seed";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("versioned installation seed transport", () => {
  it("generates exactly 256 random bits per explicit call, without retaining mutable bytes", () => {
    const original = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    let temporary: Uint8Array | undefined;
    const random = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(value => {
      expect(value).toBeInstanceOf(Uint8Array); expect(value?.byteLength).toBe(32);
      temporary = value as Uint8Array;
      return original(value);
    });
    expect(INSTALLATION_SECRET_SEED_NAME).toBe("INSTALLATION_SECRET_SEED");
    expect(INSTALLATION_SECRET_SEED_BYTES).toBe(32);
    const first = generateInstallationSecretSeed(), second = generateInstallationSecretSeed();
    expect(random).toHaveBeenCalledTimes(2);
    expect(first).toMatch(/^sfi-seed-v1\.[A-Za-z0-9_-]{43}$/); expect(second).not.toBe(first);
    expect(checkedInstallationSecretSeed(first)).toHaveLength(32);
    expect(temporary).toEqual(new Uint8Array(32));
  });

  it("returns independent byte arrays and preserves all byte values in canonical URL-safe form", () => {
    const input = INSTALLATION_SECRET_SEED_PREFIX + Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => 224 + i)).toString("base64url");
    const first = checkedInstallationSecretSeed(input), second = checkedInstallationSecretSeed(input);
    expect(first).toEqual(Uint8Array.from({ length: 32 }, (_, i) => 224 + i));
    expect(second).not.toBe(first); first.fill(0);
    expect(second[0]).toBe(224); expect(checkedInstallationSecretSeed(input)[31]).toBe(255);
  });

  it("rejects weak text, wrong versions, padding, whitespace and noncanonical trailing bits with one safe error", () => {
    const canonical = INSTALLATION_SECRET_SEED_PREFIX + Buffer.alloc(32, 255).toString("base64url");
    const noncanonical = canonical.slice(0, -1) + "9"; // Same decoded bytes as final canonical '8'.
    for (const value of [undefined, null, 7, {}, "correct horse battery staple", "123456", "password".repeat(4),
      canonical.replace("v1", "v2"), canonical + "=", " " + canonical, canonical + "\n", canonical.slice(0, -1),
      canonical + "A", canonical.replace(/_/g, "/"), noncanonical]) {
      let failure: unknown;
      try { checkedInstallationSecretSeed(value); } catch (error) { failure = error; }
      expect(failure).toEqual(new InstallationSecretSeedError());
      expect(String(failure)).toBe("InstallationSecretSeedError: Invalid installation secret seed.");
    }
  });

  it("never falls back to weak randomness when secure context or Web Crypto is absent", () => {
    vi.stubGlobal("isSecureContext", false);
    const random = vi.spyOn(globalThis.crypto, "getRandomValues");
    expect(() => generateInstallationSecretSeed()).toThrow(new InstallationSecretSeedError());
    expect(random).not.toHaveBeenCalled();
    vi.stubGlobal("isSecureContext", true); vi.stubGlobal("crypto", undefined);
    expect(() => generateInstallationSecretSeed()).toThrow(new InstallationSecretSeedError());
  });
});
