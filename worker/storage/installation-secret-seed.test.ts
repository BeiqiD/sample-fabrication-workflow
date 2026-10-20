import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { createDecipheriv, hkdfSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INSTALLATION_SECRET_SEED_PREFIX } from "../../shared/contracts/installation-secret-seed";
import { decryptStorageCredential, encryptStorageCredential, reenvelopeStorageCredential, StorageCredentialUnavailableError,
  type StorageCredentialEnvelope, type StorageCredentialIdentity } from "./credential-envelope";
import { captureStorageCredentialRoot, INSTALLATION_SEED_HKDF_SALT, INSTALLATION_SEED_STORAGE_KEY_ID_INFO,
  INSTALLATION_SEED_STORAGE_KEY_INFO, resolveStorageCredentialRoot, storageCredentialRootUnchanged } from "./installation-secret-seed";

// Deterministic synthetic values, never production installation roots.
const seedBytes = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const seed = INSTALLATION_SECRET_SEED_PREFIX + Buffer.from(seedBytes).toString("base64url");
const otherSeed = INSTALLATION_SECRET_SEED_PREFIX + Buffer.alloc(32, 37).toString("base64url");
const legacy = JSON.stringify({ version: 1, currentKeyId: "old", keys: { old: Buffer.alloc(32, 83).toString("base64") } });
const identity: StorageCredentialIdentity = { profileId: "candidate-profile", configurationRevision: 3,
  credentialRef: "credential-retained-3", namespaceSha256: "a".repeat(64) };
const plaintext = JSON.stringify({ accessKeyId: "synthetic-aws-access-id", secretAccessKey: "synthetic-aws-secret 测试" });

describe("installation-seed credential root", () => {
  it("matches independent HKDF-SHA-256 derivation with fixed purpose/version domains", async () => {
    // Literal contexts intentionally do not reuse implementation constants in
    // this reference calculation: a silent context change must fail this gate.
    const salt = "sample-fabrication-workflow:installation-secret-seed:hkdf-sha256:v1";
    const info = "sample-fabrication-workflow:storage-credential-encryption:aes-256-gcm:v1";
    const idInfo = "sample-fabrication-workflow:storage-credential-key-id:v1";
    expect(INSTALLATION_SEED_HKDF_SALT).toBe(salt); expect(INSTALLATION_SEED_STORAGE_KEY_INFO).toBe(info);
    expect(INSTALLATION_SEED_STORAGE_KEY_ID_INFO).toBe(idInfo);
    const expectedKey = Buffer.from(hkdfSync("sha256", seedBytes, salt, info, 32));
    const expectedId = "seed-v1-" + Buffer.from(hkdfSync("sha256", seedBytes, salt, idInfo, 16)).toString("hex");
    const resolved = await resolveStorageCredentialRoot({ INSTALLATION_SECRET_SEED: seed });
    expect(resolved.source).toBe("installation_seed"); expect(resolved.keyring.currentKeyId).toBe(expectedId);
    expect(expectedId).toMatch(/^seed-v1-[a-f0-9]{32}$/);
    const key = resolved.keyring.keys.get(expectedId)!;
    expect(key).toMatchObject({ extractable: false, algorithm: { name: "AES-GCM", length: 256 } });
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
    const envelope = await encryptStorageCredential(resolved.keyring, identity, plaintext);
    const ciphertext = Buffer.from(envelope.ciphertext, "base64"), nonce = Buffer.from(envelope.nonce, "base64");
    const aad = Buffer.from(JSON.stringify({ kind: "storage-credential-envelope", version: 1, ...identity, keyId: expectedId }));
    const decipher = createDecipheriv("aes-256-gcm", expectedKey, nonce);
    decipher.setAAD(aad); decipher.setAuthTag(ciphertext.subarray(-16));
    expect(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString("utf8")).toBe(plaintext);
    for (const changedInfo of [idInfo, info.replace(/v1$/, "v2"), "sample-fabrication-workflow:application-signing:v1"])
      expect(Buffer.from(hkdfSync("sha256", seedBytes, salt, changedInfo, 32))).not.toEqual(expectedKey);
    expect(Buffer.from(hkdfSync("sha256", seedBytes, salt.replace(/v1$/, "v2"), info, 32))).not.toEqual(expectedKey);
  });

  it("decrypts unchanged envelopes after independent configuration reload and rejects replacement roots without mutating ciphertext", async () => {
    const first = await resolveStorageCredentialRoot({ INSTALLATION_SECRET_SEED: seed });
    const sealed = await encryptStorageCredential(first.keyring, identity, plaintext), before = JSON.stringify(sealed);
    const restarted = await resolveStorageCredentialRoot({ INSTALLATION_SECRET_SEED: seed });
    expect(restarted.keyring.currentKeyId).toBe(first.keyring.currentKeyId);
    expect(restarted.keyring.keys.get(restarted.keyring.currentKeyId)).not.toBe(first.keyring.keys.get(first.keyring.currentKeyId));
    expect(await decryptStorageCredential(restarted.keyring, identity, sealed)).toEqual({ outcome: "available", plaintext });
    const replaced = await resolveStorageCredentialRoot({ INSTALLATION_SECRET_SEED: otherSeed });
    expect(replaced.keyring.currentKeyId).not.toBe(first.keyring.currentKeyId);
    expect(await decryptStorageCredential(replaced.keyring, identity, sealed)).toEqual({ outcome: "unavailable" });
    expect(await reenvelopeStorageCredential(replaced.keyring, identity, sealed)).toEqual({ outcome: "unavailable" });
    expect(JSON.stringify(sealed)).toBe(before);
  });

  it("keeps legacy key IDs, old ciphertext and retained rotated-key snapshots readable without requiring a seed", async () => {
    const old = await resolveStorageCredentialRoot({ STORAGE_CREDENTIAL_KEYRING: legacy });
    const sealed = await encryptStorageCredential(old.keyring, identity, plaintext), before = JSON.stringify(sealed);
    const rotated = JSON.stringify({ version: 1, currentKeyId: "new", keys: { old: Buffer.alloc(32, 83).toString("base64"), new: Buffer.alloc(32, 91).toString("base64") } });
    const current = await resolveStorageCredentialRoot({ STORAGE_CREDENTIAL_KEYRING: rotated });
    expect(current.source).toBe("legacy_keyring"); expect([...current.keyring.keys.keys()]).toEqual(["old", "new"]);
    expect(await decryptStorageCredential(current.keyring, identity, sealed)).toEqual({ outcome: "available", plaintext });
    const result = await reenvelopeStorageCredential(current.keyring, identity, sealed);
    expect(result.outcome).toBe("available"); if (result.outcome !== "available") throw new Error("Synthetic rotation failed");
    expect(result.replacement.keyId).toBe("new");
    const reloaded = await resolveStorageCredentialRoot({ STORAGE_CREDENTIAL_KEYRING: rotated });
    expect(await decryptStorageCredential(reloaded.keyring, identity, result.replacement)).toEqual({ outcome: "available", plaintext });
    expect(await decryptStorageCredential(reloaded.keyring, identity, sealed)).toEqual({ outcome: "available", plaintext });
    expect(JSON.stringify(sealed)).toBe(before);
  });

  it("captures both roots immutably and fences changes, including the addition of a conflicting mechanism", () => {
    const env: { STORAGE_CREDENTIAL_KEYRING?: string; INSTALLATION_SECRET_SEED?: string } = { INSTALLATION_SECRET_SEED: seed };
    const captured = captureStorageCredentialRoot(env);
    expect(Object.isFrozen(captured)).toBe(true); expect(storageCredentialRootUnchanged(env, captured)).toBe(true);
    env.STORAGE_CREDENTIAL_KEYRING = legacy; expect(storageCredentialRootUnchanged(env, captured)).toBe(false);
    delete env.STORAGE_CREDENTIAL_KEYRING; env.INSTALLATION_SECRET_SEED = otherSeed;
    expect(storageCredentialRootUnchanged(env, captured)).toBe(false); expect(captured.INSTALLATION_SECRET_SEED).toBe(seed);
    delete env.INSTALLATION_SECRET_SEED; expect(storageCredentialRootUnchanged(env, captured)).toBe(false);
    const legacyEnv = { STORAGE_CREDENTIAL_KEYRING: legacy, INSTALLATION_SECRET_SEED: undefined as string | undefined };
    const legacyCapture = captureStorageCredentialRoot(legacyEnv); legacyEnv.INSTALLATION_SECRET_SEED = seed;
    expect(storageCredentialRootUnchanged(legacyEnv, legacyCapture)).toBe(false);
  });

  it("rejects missing, malformed and ambiguous configured roots with one error and no source fallback", async () => {
    for (const env of [{}, { INSTALLATION_SECRET_SEED: "password" }, { INSTALLATION_SECRET_SEED: "" },
      { STORAGE_CREDENTIAL_KEYRING: "private-malformed-keyring" }, { STORAGE_CREDENTIAL_KEYRING: "" },
      { STORAGE_CREDENTIAL_KEYRING: legacy, INSTALLATION_SECRET_SEED: seed },
      { STORAGE_CREDENTIAL_KEYRING: legacy, INSTALLATION_SECRET_SEED: "private-malformed-seed" },
      { STORAGE_CREDENTIAL_KEYRING: "private-malformed-keyring", INSTALLATION_SECRET_SEED: seed },
      { STORAGE_CREDENTIAL_KEYRING: "", INSTALLATION_SECRET_SEED: seed }]) {
      await expect(resolveStorageCredentialRoot(env)).rejects.toEqual(new StorageCredentialUnavailableError());
    }
    const captured = captureStorageCredentialRoot({ INSTALLATION_SECRET_SEED: seed });
    expect((await resolveStorageCredentialRoot(captured)).source).toBe("installation_seed");
  });

  it("exchanges seed-derived envelopes with native Worker Web Crypto across a Worker restart", async () => {
    const bundled = await build({ stdin: { contents: `
      import { resolveStorageCredentialRoot } from './installation-secret-seed';
      import { encryptStorageCredential, decryptStorageCredential } from './credential-envelope';
      export default { async fetch(request, env) {
        const input = await request.json(), root = await resolveStorageCredentialRoot(env);
        return Response.json(input.envelope ? await decryptStorageCredential(root.keyring, input.identity, input.envelope)
          : await encryptStorageCredential(root.keyring, input.identity, input.plaintext));
      } };`, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" }, bundle: true, format: "esm", platform: "browser", write: false });
    const options = { modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-07-14", bindings: { INSTALLATION_SECRET_SEED: seed } } as const;
    const host = await resolveStorageCredentialRoot({ INSTALLATION_SECRET_SEED: seed });
    const hostEnvelope = await encryptStorageCredential(host.keyring, identity, plaintext);
    const invoke = async (worker: Miniflare, input: Record<string, unknown>) => (await worker.dispatchFetch("https://fixture.test", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity, ...input }),
    })).json();
    let worker: Miniflare | undefined;
    try {
      worker = new Miniflare(options);
      expect(await invoke(worker, { envelope: hostEnvelope })).toEqual({ outcome: "available", plaintext });
      const workerEnvelope = await invoke(worker, { plaintext }) as StorageCredentialEnvelope;
      expect(await decryptStorageCredential(host.keyring, identity, workerEnvelope)).toEqual({ outcome: "available", plaintext });
      await worker.dispose(); worker = new Miniflare(options);
      expect(await invoke(worker, { envelope: workerEnvelope })).toEqual({ outcome: "available", plaintext });
    } finally { await worker?.dispose(); }
  }, 30_000);
});
