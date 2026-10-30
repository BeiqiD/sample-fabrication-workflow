import { scrypt } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createPasswordHasher, MAX_PASSWORD_BYTES, MAX_PASSWORD_VERIFIER_BYTES, PasswordHashError, SCRYPT_V1, SCRYPT_V1_MAXMEM_BYTES, type PasswordHashLimits } from "./passwords";

// Synthetic material stays in test memory; tests never snapshot/log verifiers.
const password = "A synthetic development-only password";
let verifier: string;
beforeAll(async () => { verifier = await createPasswordHasher().hash(password); });
function replaceField(value: string, index: number, replacement: string): string {
  const parts = value.split("$"); parts[index] = replacement; return parts.join("$");
}
function tamperBytes(encoded: string): string {
  const bytes = Buffer.from(encoded, "base64url"); bytes[0] ^= 1; return bytes.toString("base64url");
}
function referenceKey(secret: string, salt: Buffer, maxmem = SCRYPT_V1_MAXMEM_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(secret, salt, 32, { N: 131072, r: 8, p: 1, maxmem }, (error, key) => error ? reject(error) : resolve(key)));
}

describe("Node scrypt password verifier foundation", () => {
  it("persists exact versioned candidate parameters and distinguishes correct and wrong passwords with actual crypto", async () => {
    const fields = verifier.split("$");
    expect(fields.slice(0, 6)).toEqual(["scrypt", "1", "131072", "8", "1", "32"]);
    expect(Buffer.from(fields[6], "base64url").length).toBe(32);
    expect(Buffer.from(fields[7], "base64url").length).toBe(32);
    const hasher = createPasswordHasher();
    await expect(hasher.verify(password, verifier)).resolves.toBe(true);
    await expect(hasher.verify("A different synthetic password", verifier)).resolves.toBe(false);
  });

  it("uses independently generated salts and interoperates with direct native scrypt", async () => {
    const hasher = createPasswordHasher(), other = await hasher.hash(password);
    expect(other === verifier).toBe(false);
    expect(other.split("$")[6] === verifier.split("$")[6]).toBe(false);
    const expected = await referenceKey(password, Buffer.from(other.split("$")[6], "base64url"));
    try { expect(Buffer.from(other.split("$")[7], "base64url").equals(expected)).toBe(true); }
    finally { expected.fill(0); }
  });

  it("rejects valid-length salt or digest tampering through actual verification", async () => {
    const fields = verifier.split("$"), hasher = createPasswordHasher();
    await expect(hasher.verify(password, replaceField(verifier, 6, tamperBytes(fields[6])))).resolves.toBe(false);
    await expect(hasher.verify(password, replaceField(verifier, 7, tamperBytes(fields[7])))).resolves.toBe(false);
  });

  it("fails closed on noncanonical, malformed, oversized or non-string persisted input", async () => {
    const hasher = createPasswordHasher();
    const malformed: unknown[] = [null, {}, [], "", verifier + "$extra", verifier.slice(0, -1), " " + verifier,
      verifier.replace("$131072$", "$0131072$"), verifier.replace("$8$", "$8.0$"), verifier.replace("$1$", "$+1$"),
      replaceField(verifier, 6, "A".repeat(42) + "B"), replaceField(verifier, 7, "A".repeat(42) + "B"),
      replaceField(verifier, 6, verifier.split("$")[6] + "="), "x".repeat(MAX_PASSWORD_VERIFIER_BYTES + 1),
      replaceField(verifier, 6, "é".repeat(43))];
    for (const value of malformed) await expect(hasher.verify(password, value)).rejects.toMatchObject({ code: "invalid_verifier" });
    // Rejected parser input never consumes native capacity.
    await expect(hasher.verify(password, verifier)).resolves.toBe(true);
  });

  it("refuses unknown versions and altered work factors rather than weakening or trusting persisted parameters", async () => {
    const hasher = createPasswordHasher();
    for (const [field, value] of [[0, "argon2"], [1, "0"], [1, "2"], [2, "65536"], [2, "262144"], [3, "4"], [3, "16"], [4, "0"], [4, "2"], [5, "16"], [5, "64"]] as const) {
      await expect(hasher.verify(password, replaceField(verifier, field, value))).rejects.toMatchObject({ code: "unsupported_verifier" });
    }
    await expect(hasher.verify(password, verifier)).resolves.toBe(true);
  });

  it("preserves whitespace and Unicode code points without trimming or normalization", async () => {
    const hasher = createPasswordHasher(), exact = "  e\u0301\0 ";
    const saved = await hasher.hash(exact);
    await expect(hasher.verify(exact, saved)).resolves.toBe(true);
    await expect(hasher.verify(exact.trim(), saved)).resolves.toBe(false);
    await expect(hasher.verify("  é\0 ", saved)).resolves.toBe(false);
  });

  it("enforces the UTF-8 byte boundary and rejects oversized input or lone-surrogate aliases", async () => {
    const hasher = createPasswordHasher(), boundary = "💡".repeat(MAX_PASSWORD_BYTES / 4);
    const saved = await hasher.hash(boundary);
    await expect(hasher.verify(boundary, saved)).resolves.toBe(true);
    for (const invalid of ["", "x".repeat(MAX_PASSWORD_BYTES + 1), boundary + "x", "\ud800", "\udfff", null]) {
      await expect(hasher.hash(invalid as string)).rejects.toMatchObject({ code: "invalid_password" });
      await expect(hasher.verify(invalid as string, verifier)).rejects.toMatchObject({ code: "invalid_password" });
    }
  });

  it("requires an explicit sufficient memory budget and never admits parameter overrides", () => {
    expect(createPasswordHasher().limits).toEqual({ maxConcurrent: 1, memoryBudgetBytes: SCRYPT_V1_MAXMEM_BYTES, maxmemPerOperationBytes: SCRYPT_V1_MAXMEM_BYTES });
    expect(() => createPasswordHasher({ memoryBudgetBytes: 128 * 1024 * 1024 })).toThrow(expect.objectContaining({ code: "resource_budget" }));
    expect(() => createPasswordHasher({ maxConcurrent: 2 })).toThrow(expect.objectContaining({ code: "resource_budget" }));
    for (const options of [{ maxConcurrent: 0 }, { maxConcurrent: 3 }, { maxConcurrent: 1.5 }, { maxConcurrent: null }, { memoryBudgetBytes: null }, { memoryBudgetBytes: Infinity }, { memoryBudgetBytes: 3 * SCRYPT_V1_MAXMEM_BYTES }, { N: 65536 }, null]) {
      expect(() => createPasswordHasher(options as PasswordHashLimits)).toThrow(expect.objectContaining({ code: "invalid_configuration" }));
    }
    expect(SCRYPT_V1.N).toBe(131072);
  });

  it("demonstrates that the native candidate fails under its insufficient default memory limit", async () => {
    await expect(referenceKey(password, Buffer.alloc(32), 32 * 1024 * 1024)).rejects.toThrow();
    await expect(createPasswordHasher().verify(password, verifier)).resolves.toBe(true);
  });

  it("admits only one native operation by default with no queue, retaining capacity until completion", async () => {
    const hasher = createPasswordHasher(), outstanding = hasher.hash(password);
    await expect(hasher.verify(password, verifier)).rejects.toMatchObject({ code: "capacity" });
    await Promise.resolve();
    await expect(hasher.hash(password)).rejects.toMatchObject({ code: "capacity" });
    const accepted = await outstanding;
    await expect(hasher.verify(password, accepted)).resolves.toBe(true);
  });

  it("bounds two concurrent real operations under their reserved memory and releases capacity after both settle", async () => {
    const hasher = createPasswordHasher({ maxConcurrent: 2, memoryBudgetBytes: 2 * SCRYPT_V1_MAXMEM_BYTES });
    const first = hasher.hash(password), second = hasher.verify(password, verifier);
    await expect(hasher.hash(password)).rejects.toMatchObject({ code: "capacity" });
    const [saved, matched] = await Promise.all([first, second]);
    expect(matched).toBe(true);
    await expect(hasher.verify(password, saved)).resolves.toBe(true);
  });

  it("keeps error material generic and exposes only fixed typed failure codes", async () => {
    const hasher = createPasswordHasher();
    try { await hasher.verify(password, "malformed synthetic verifier"); throw new Error("Expected rejection"); }
    catch (error) {
      expect(error).toBeInstanceOf(PasswordHashError);
      expect((error as PasswordHashError).code).toBe("invalid_verifier");
      expect(String(error)).not.toContain(password);
      expect(String(error)).not.toContain("malformed synthetic verifier");
      expect((error as Error).cause).toBeUndefined();
    }
  });
});
