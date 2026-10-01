import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decryptStorageCredential, encryptStorageCredential, MAX_STORAGE_CREDENTIAL_BYTES,
  parseStorageCredentialKeyring, reenvelopeStorageCredential, StorageCredentialUnavailableError,
  type StorageCredentialEnvelope, type StorageCredentialIdentity } from "./credential-envelope";

// Deterministic test material, never an installation key.
const oldKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(11)));
const newKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(22)));
const secret = JSON.stringify({ username: "fixture-user@example.test", password: "fixture-password 测试 🔑" });
const identity: StorageCredentialIdentity = { profileId: "candidate-profile", configurationRevision: 3,
  credentialRef: "credential-ref-3", namespaceSha256: "a".repeat(64) };
const rawKeyring = (currentKeyId = "old", keys: Record<string, string> = { old: oldKey }) => JSON.stringify({ version: 1, currentKeyId, keys });

describe("installation-local credential encryption", () => {
  it("imports only non-extractable AES-256 keys and seals UTF-8 with a fresh 96-bit nonce", async () => {
    const ring = await parseStorageCredentialKeyring(rawKeyring());
    expect(ring.keys.get("old")).toMatchObject({ extractable: false, algorithm: { name: "AES-GCM", length: 256 } });
    const first = await encryptStorageCredential(ring, identity, secret), second = await encryptStorageCredential(ring, identity, secret);
    expect(atob(first.nonce).length).toBe(12);
    expect(first.nonce).not.toBe(second.nonce); expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(await decryptStorageCredential(ring, identity, first)).toEqual({ outcome: "available", plaintext: secret });
    expect(JSON.stringify(first)).not.toContain(secret); expect(JSON.stringify(first)).not.toContain(oldKey);
    await expect(crypto.subtle.exportKey("raw", ring.keys.get("old")!)).rejects.toThrow();
  });

  it.each([
    { ...identity, profileId: "different-profile" },
    { ...identity, configurationRevision: 4 },
    { ...identity, credentialRef: "different-reference" },
    { ...identity, namespaceSha256: "b".repeat(64) },
  ])("rejects authenticated identity substitution: %j", async substituted => {
    const ring = await parseStorageCredentialKeyring(rawKeyring()), sealed = await encryptStorageCredential(ring, identity, secret);
    expect(await decryptStorageCredential(ring, substituted, sealed)).toEqual({ outcome: "unavailable" });
    expect(await decryptStorageCredential(ring, identity, sealed)).toEqual({ outcome: "available", plaintext: secret });
  });

  it("authenticates key ID as well as envelope version, nonce and ciphertext", async () => {
    const ring = await parseStorageCredentialKeyring(rawKeyring("old", { old: oldKey, alias: oldKey }));
    const sealed = await encryptStorageCredential(ring, identity, secret);
    const damaged = Uint8Array.from(atob(sealed.ciphertext), character => character.charCodeAt(0)); damaged[0] ^= 1;
    for (const changed of [
      { ...sealed, keyId: "alias" }, { ...sealed, version: 2 },
      { ...sealed, nonce: btoa(String.fromCharCode(...new Uint8Array(12))) },
      { ...sealed, ciphertext: btoa(String.fromCharCode(...damaged)) },
    ]) expect(await decryptStorageCredential(ring, identity, changed)).toEqual({ outcome: "unavailable" });
  });

  it("rotates using the retained old key without modifying the identity or source envelope", async () => {
    const oldRing = await parseStorageCredentialKeyring(rawKeyring()), sealed = await encryptStorageCredential(oldRing, identity, secret);
    const before = JSON.stringify(sealed), ring = await parseStorageCredentialKeyring(rawKeyring("new", { old: oldKey, new: newKey }));
    const rotation = await reenvelopeStorageCredential(ring, identity, sealed);
    expect(rotation.outcome).toBe("available"); if (rotation.outcome !== "available") throw new Error("Fixture rotation failed");
    expect(rotation.expected).toEqual(sealed); expect(rotation.expected).not.toBe(sealed);
    expect(rotation.replacement.keyId).toBe("new"); expect(rotation.replacement.nonce).not.toBe(sealed.nonce);
    expect(JSON.stringify(sealed)).toBe(before);
    const newRing = await parseStorageCredentialKeyring(rawKeyring("new", { new: newKey }));
    expect(await decryptStorageCredential(newRing, identity, rotation.replacement)).toEqual({ outcome: "available", plaintext: secret });
    expect(await decryptStorageCredential(oldRing, identity, rotation.replacement)).toEqual({ outcome: "unavailable" });
  });

  it("leaves ciphertext untouched when the old key is missing or the key material is wrong", async () => {
    const sealed = await encryptStorageCredential(await parseStorageCredentialKeyring(rawKeyring()), identity, secret);
    const before = JSON.stringify(sealed);
    for (const ring of [await parseStorageCredentialKeyring(rawKeyring("new", { new: newKey })),
      await parseStorageCredentialKeyring(rawKeyring("old", { old: newKey }))]) {
      expect(await decryptStorageCredential(ring, identity, sealed)).toEqual({ outcome: "unavailable" });
      expect(await reenvelopeStorageCredential(ring, identity, sealed)).toEqual({ outcome: "unavailable" });
      expect(JSON.stringify(sealed)).toBe(before);
    }
  });

  it.each([
    undefined, "fixture-private-not-json", rawKeyring("absent"),
    JSON.stringify({ version: 2, currentKeyId: "old", keys: { old: oldKey } }),
    rawKeyring("old", { old: "fixture-private-invalid-base64" }),
    rawKeyring("old", { old: btoa("short") }),
    rawKeyring("invalid/id", { "invalid/id": oldKey }),
  ])("rejects unusable bootstrap keyrings with one safe error", async raw => {
    await expect(parseStorageCredentialKeyring(raw)).rejects.toEqual(new StorageCredentialUnavailableError());
  });

  it("rejects unsupported payloads and malformed envelopes without returning private inputs", async () => {
    const ring = await parseStorageCredentialKeyring(rawKeyring());
    for (const plaintext of ["", "x".repeat(MAX_STORAGE_CREDENTIAL_BYTES + 1), "\ud800"])
      await expect(encryptStorageCredential(ring, identity, plaintext)).rejects.toEqual(new StorageCredentialUnavailableError());
    for (const sealed of [null, { version: 1, keyId: "old", nonce: "fixture-private", ciphertext: "fixture-private" }])
      expect(await decryptStorageCredential(ring, identity, sealed)).toEqual({ outcome: "unavailable" });
  });

  it("exchanges envelopes and rotation results between Node and native Worker WebCrypto", async () => {
    const bundled = await build({ stdin: { contents: `
      import { parseStorageCredentialKeyring, encryptStorageCredential, decryptStorageCredential, reenvelopeStorageCredential } from './credential-envelope';
      export default { async fetch(request) {
        const input = await request.json(), ring = await parseStorageCredentialKeyring(input.keyring);
        const result = input.action === 'encrypt' ? await encryptStorageCredential(ring, input.identity, input.plaintext)
          : input.action === 'rotate' ? await reenvelopeStorageCredential(ring, input.identity, input.envelope)
          : await decryptStorageCredential(ring, input.identity, input.envelope);
        return Response.json(result);
      } };`, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" }, bundle: true, format: "esm", platform: "browser", write: false });
    const worker = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-07-14" });
    try {
      const ring = await parseStorageCredentialKeyring(rawKeyring()), hostEnvelope = await encryptStorageCredential(ring, identity, secret);
      const invoke = async (input: Record<string, unknown>) => (await worker.dispatchFetch("https://fixture.test", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity, ...input }),
      })).json();
      expect(await invoke({ action: "decrypt", keyring: rawKeyring(), envelope: hostEnvelope })).toEqual({ outcome: "available", plaintext: secret });
      const workerEnvelope = await invoke({ action: "encrypt", keyring: rawKeyring(), plaintext: secret }) as StorageCredentialEnvelope;
      expect(await decryptStorageCredential(ring, identity, workerEnvelope)).toEqual({ outcome: "available", plaintext: secret });
      const rotated = await invoke({ action: "rotate", keyring: rawKeyring("new", { old: oldKey, new: newKey }), envelope: hostEnvelope }) as {
        outcome: string; expected: StorageCredentialEnvelope; replacement: StorageCredentialEnvelope };
      expect(rotated.outcome).toBe("available"); expect(rotated.expected).toEqual(hostEnvelope);
      expect(await decryptStorageCredential(await parseStorageCredentialKeyring(rawKeyring("new", { new: newKey })), identity, rotated.replacement))
        .toEqual({ outcome: "available", plaintext: secret });
    } finally { await worker.dispose(); }
  }, 30_000);
});
