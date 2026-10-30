import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateInstallationSecretSeed } from "../../shared/contracts/installation-secret-seed";
import { checkedStorageCredentialSetupStatus } from "../../shared/contracts/storage-credential-setup";
import type { SaveStorageCandidateInput } from "../../shared/contracts/storage-configuration";
import { SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { readStorageCredentialSetup } from "./credential-setup";
import { readStorageConfiguration, saveStorageCandidate } from "./configuration-registry";
import { startStorageCandidateCheck } from "./candidate-check-service";
import { reenvelopeStoredStorageCredential } from "./credential-reenvelope-service";

const actor = "admin@example.test";
const ring = (byte: number, id = "original") => JSON.stringify({ version: 1, currentKeyId: id,
  keys: { [id]: btoa(String.fromCharCode(...new Uint8Array(32).fill(byte))) } });
const input = (bucket = "onboarding-bucket"): SaveStorageCandidateInput => ({ expectedRevision: null, label: "Onboarding fixture",
  namespace: { kind: "s3", endpoint: "https://s3.eu-central-1.amazonaws.com", bucket, region: "eu-central-1", root: "research", forcePathStyle: true },
  credentials: { mode: "replace", value: { accessKeyId: "synthetic-access", secretAccessKey: "synthetic-provider-secret" } } });
const databases: DatabaseSync[] = [];
function fixture(through = 16) {
  const sql = new DatabaseSync(":memory:"); databases.push(sql); sql.exec("PRAGMA foreign_keys=ON");
  for (const [n, name] of [[14, "0014_fp2_storage_configuration.sql"], [15, "0015_fp2_storage_candidate_checks.sql"], [16, "0016_fp2_credential_reenvelopes.sql"]] as const) {
    if (n <= through) sql.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  }
  const db = new SqliteD1Database(sql), env = { DB: db as unknown as D1Database, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: actor } as Env;
  return { sql, db, env };
}
const count = (sql: DatabaseSync, table: string) => Number(sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
const protectedRows = (sql: DatabaseSync) => JSON.stringify(sql.prepare("SELECT * FROM system_storage_credential_payloads ORDER BY credential_ref").all());
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(sql => sql.close()); });

describe("conditional external credential setup and existing-root recovery", () => {
  it("keeps fresh R2/read-only administration usable and reports first setup without writing any row", async () => {
    const f = fixture(), before = f.sql.prepare("SELECT total_changes() n").get()!.n;
    const status = await readStorageCredentialSetup(f.env, actor);
    expect(checkedStorageCredentialSetupStatus(status)).toEqual({ version: 1, runtime: "cloudflare_worker", state: "setup_required" });
    expect(await readStorageConfiguration(f.env, actor)).toEqual({ scope: "system", credentialEditingAvailable: false, candidates: { items: [], hasMore: false } });
    expect(f.sql.prepare("SELECT total_changes() n").get()!.n).toBe(before);
    expect(JSON.stringify(status)).not.toMatch(/keyId|ciphertext|credentialRef|seed-v1/);
  });

  it("authorizes independently before reading configuration or root state", async () => {
    const f = fixture();
    for (const [env, email] of [[f.env, "reader@example.test"], [{ ...f.env, AUTH_MODE: "disabled" }, actor],
      [{ ...f.env, SYSTEM_ADMIN_EMAILS: undefined }, actor]] as const) {
      await expect(readStorageCredentialSetup(env as Env, email)).rejects.toMatchObject({ status: 403 });
    }
    expect(f.db.queryCount).toBe(0);
  });

  it("uses one seed across independent configuration reloads and later S3 additions", async () => {
    const f = fixture(), seed = generateInstallationSecretSeed(); f.env.INSTALLATION_SECRET_SEED = seed;
    expect((await readStorageCredentialSetup(f.env, actor)).state).toBe("seed_ready");
    const first = await saveStorageCandidate(f.env, input(), actor);
    const reloaded = { ...f.env };
    expect((await readStorageCredentialSetup(reloaded, actor)).state).toBe("seed_ready");
    const second = await saveStorageCandidate(reloaded, input("onboarding-second"), actor);
    expect((await readStorageConfiguration(reloaded, actor)).candidates.items.map(item => item.credentials.status)).toEqual(["configured", "configured"]);
    expect(new Set(f.sql.prepare("SELECT key_id FROM system_storage_credential_payloads").all().map(row => row.key_id)).size).toBe(1);
    expect(first.profileId).not.toBe(second.profileId);
    for (const secret of [seed, "synthetic-access", "synthetic-provider-secret"]) expect(protectedRows(f.sql)).not.toContain(secret);
  });

  it("requires the original root for missing and well-formed wrong seeds, preserving every protected row", async () => {
    const f = fixture(), original = generateInstallationSecretSeed(); f.env.INSTALLATION_SECRET_SEED = original;
    await saveStorageCandidate(f.env, input(), actor); const before = protectedRows(f.sql);
    for (const value of [undefined, generateInstallationSecretSeed(), "malformed", ""]) {
      f.env.INSTALLATION_SECRET_SEED = value;
      expect((await readStorageCredentialSetup(f.env, actor)).state).toBe("restore_required");
      await expect(saveStorageCandidate(f.env, input("onboarding-third"), actor)).rejects.toMatchObject({ status: 503 });
      expect(protectedRows(f.sql)).toBe(before); expect(count(f.sql, "system_storage_profiles")).toBe(1);
      expect((await readStorageConfiguration(f.env, actor)).candidates.items[0].credentials.status).toBe("unavailable");
    }
    f.env.INSTALLATION_SECRET_SEED = original;
    expect((await readStorageCredentialSetup(f.env, actor)).state).toBe("seed_ready");
    expect((await readStorageConfiguration(f.env, actor)).candidates.items[0].credentials.status).toBe("configured");
    expect(protectedRows(f.sql)).toBe(before);
  });

  it("does not offer bootstrap for malformed configured roots or for conflicting mechanisms", async () => {
    const f = fixture();
    for (const bad of ["", "memorable-password", "sfi-seed-v1.invalid"]) {
      f.env.INSTALLATION_SECRET_SEED = bad;
      expect((await readStorageCredentialSetup(f.env, actor)).state).toBe("restore_required");
    }
    f.env.STORAGE_CREDENTIAL_KEYRING = ring(13);
    for (const value of [generateInstallationSecretSeed(), ""]) {
      f.env.INSTALLATION_SECRET_SEED = value;
      expect((await readStorageCredentialSetup(f.env, actor)).state).toBe("configuration_conflict");
      await expect(saveStorageCandidate(f.env, input(), actor)).rejects.toMatchObject({ status: 503 });
    }
    expect(count(f.sql, "system_storage_profiles")).toBe(0);
  });

  it("retains legacy keyring and schema14 admission and detects wrong material even with matching key IDs", async () => {
    const f = fixture(14); f.env.STORAGE_CREDENTIAL_KEYRING = ring(13);
    await saveStorageCandidate(f.env, input(), actor); const before = protectedRows(f.sql);
    expect((await readStorageCredentialSetup(f.env, actor)).state).toBe("legacy_ready");
    f.env.STORAGE_CREDENTIAL_KEYRING = ring(29);
    expect((await readStorageCredentialSetup(f.env, actor)).state).toBe("restore_required");
    await expect(saveStorageCandidate(f.env, input("onboarding-wrong"), actor)).rejects.toMatchObject({ status: 503 });
    f.env.STORAGE_CREDENTIAL_KEYRING = ring(13);
    expect((await readStorageConfiguration(f.env, actor)).candidates.items[0].credentials.status).toBe("configured");
    expect(protectedRows(f.sql)).toBe(before);
  });

  it("retains immutable check keys after live payloads have been correctly re-enveloped", async () => {
    const f = fixture(); f.env.STORAGE_CREDENTIAL_KEYRING = ring(13, "old");
    const saved = await saveStorageCandidate(f.env, input(), actor);
    const check = await startStorageCandidateCheck(f.env, { checkId: crypto.randomUUID(), profileId: saved.profileId, expectedRevision: 1 }, actor, {
      fetch: async () => { throw new Error("Synthetic provider unavailable"); },
      createHash: () => { const hash = createHash("sha256"); return { async write(bytes) { hash.update(bytes); }, async finish() { return hash.digest("hex"); }, async abort() {} }; },
    });
    const snapshot = f.sql.prepare("SELECT * FROM system_storage_candidate_checks WHERE id=?").get(check.id);
    f.env.STORAGE_CREDENTIAL_KEYRING = JSON.stringify({ version: 1, currentKeyId: "current", keys: {
      old: btoa(String.fromCharCode(...new Uint8Array(32).fill(13))), current: btoa(String.fromCharCode(...new Uint8Array(32).fill(29))) } });
    await reenvelopeStoredStorageCredential(f.env, { operationId: crypto.randomUUID(), profileId: saved.profileId, revision: 1,
      credentialRef: saved.credentials.ref, expectedEnvelopeRevision: 1 }, actor);
    expect((await readStorageCredentialSetup(f.env, actor)).state).toBe("legacy_ready");
    f.env.STORAGE_CREDENTIAL_KEYRING = ring(29, "current");
    expect((await readStorageCredentialSetup(f.env, actor)).state).toBe("restore_required");
    await expect(saveStorageCandidate(f.env, input("onboarding-without-history-key"), actor)).rejects.toMatchObject({ status: 503 });
    expect(f.sql.prepare("SELECT * FROM system_storage_candidate_checks WHERE id=?").get(check.id)).toEqual(snapshot);
    expect(count(f.sql, "system_storage_profiles")).toBe(1);
  });

  it("preserves explicit legacy metadata-only recovery without admitting a replacement seed", async () => {
    const f = fixture(14); f.env.STORAGE_CREDENTIAL_KEYRING = ring(13);
    const saved = await saveStorageCandidate(f.env, input(), actor);
    f.sql.exec("DROP TRIGGER system_storage_credential_payloads_delete_guard; DELETE FROM system_storage_credential_payloads");
    expect((await readStorageCredentialSetup(f.env, actor)).state).toBe("legacy_ready");
    const newRoot = { ...f.env, STORAGE_CREDENTIAL_KEYRING: undefined, INSTALLATION_SECRET_SEED: generateInstallationSecretSeed() };
    expect((await readStorageCredentialSetup(newRoot, actor)).state).toBe("restore_required");
    await expect(saveStorageCandidate(newRoot, input("onboarding-replacement-root"), actor)).rejects.toMatchObject({ status: 503 });
    await expect(saveStorageCandidate(f.env, { ...input(), profileId: saved.profileId, expectedRevision: 1,
      credentials: { mode: "retain" } }, actor)).rejects.toMatchObject({ status: 503 });
    expect((await saveStorageCandidate(f.env, { ...input(), profileId: saved.profileId, expectedRevision: 1 }, actor)).revision).toBe(2);
    expect(count(f.sql, "system_storage_profiles")).toBe(1);
  });

  it("reports unavailable rather than new setup or root loss after an unexpected database failure", async () => {
    const f = fixture(); f.env.INSTALLATION_SECRET_SEED = generateInstallationSecretSeed();
    const prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, "prepare").mockImplementation(sql => {
      if (sql.includes("WITH retained")) throw new Error("Synthetic D1 failure");
      return prepare(sql);
    });
    await saveStorageCandidate(f.env, input(), actor);
    expect((await readStorageCredentialSetup(f.env, actor)).state).toBe("unavailable");
    expect(count(f.sql, "system_storage_profiles")).toBe(1);
  });

  it.each(["seed", "legacy"] as const)("serializes first-root %s writers, including reused legacy key IDs", async source => {
    const f = fixture(), rootA = source === "seed" ? { INSTALLATION_SECRET_SEED: generateInstallationSecretSeed() } : { STORAGE_CREDENTIAL_KEYRING: ring(13) };
    const rootB = source === "seed" ? { INSTALLATION_SECRET_SEED: generateInstallationSecretSeed() } : { STORAGE_CREDENTIAL_KEYRING: ring(29) };
    const first = { ...f.env, ...rootA }, second = { ...f.env, ...rootB };
    let unblock!: () => void, arrivals = 0;
    const barrier = new Promise<void>(resolve => { unblock = resolve; }), batch = f.db.batch.bind(f.db);
    vi.spyOn(f.db, "batch").mockImplementation(async statements => { if (++arrivals === 2) unblock(); await barrier; return batch(statements); });
    const results = await Promise.allSettled([saveStorageCandidate(first, input("onboarding-race-a"), actor), saveStorageCandidate(second, input("onboarding-race-b"), actor)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(count(f.sql, "system_storage_profiles")).toBe(1); expect(count(f.sql, "system_storage_credential_payloads")).toBe(1);
    expect(count(f.sql, "system_storage_configuration_audit")).toBe(1);
    const states = await Promise.all([readStorageCredentialSetup(first, actor), readStorageCredentialSetup(second, actor)]);
    expect(states.map(value => value.state).sort()).toEqual([source === "seed" ? "seed_ready" : "legacy_ready", "restore_required"].sort());
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects an in-flight root replacement before committing any candidate", async () => {
    const f = fixture(); f.env.INSTALLATION_SECRET_SEED = generateInstallationSecretSeed();
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
      const result = await encrypt(...args); f.env.INSTALLATION_SECRET_SEED = generateInstallationSecretSeed(); return result;
    });
    await expect(saveStorageCandidate(f.env, input(), actor)).rejects.toMatchObject({ status: 503 });
    expect(count(f.sql, "system_storage_profiles")).toBe(0); expect(count(f.sql, "system_storage_credential_payloads")).toBe(0);
  });

  it("serializes the first protected write during concurrent legacy metadata-only recovery", async () => {
    const f = fixture(14); f.env.STORAGE_CREDENTIAL_KEYRING = ring(13);
    const a = await saveStorageCandidate(f.env, input("recovery-race-a"), actor);
    const b = await saveStorageCandidate(f.env, input("recovery-race-b"), actor);
    f.sql.exec("DROP TRIGGER system_storage_credential_payloads_delete_guard; DELETE FROM system_storage_credential_payloads");
    const rootA = { ...f.env }, rootB = { ...f.env, STORAGE_CREDENTIAL_KEYRING: ring(29) };
    let unblock!: () => void, arrivals = 0;
    const barrier = new Promise<void>(resolve => { unblock = resolve; }), batch = f.db.batch.bind(f.db);
    vi.spyOn(f.db, "batch").mockImplementation(async statements => { if (++arrivals === 2) unblock(); await barrier; return batch(statements); });
    const results = await Promise.allSettled([
      saveStorageCandidate(rootA, { ...input("recovery-race-a"), profileId: a.profileId, expectedRevision: 1 }, actor),
      saveStorageCandidate(rootB, { ...input("recovery-race-b"), profileId: b.profileId, expectedRevision: 1 }, actor),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(count(f.sql, "system_storage_profiles")).toBe(2); expect(count(f.sql, "system_storage_credential_payloads")).toBe(1);
    expect(count(f.sql, "system_storage_configuration_revisions")).toBe(3);
    expect(count(f.sql, "system_storage_configuration_audit")).toBe(3);
    expect((await Promise.all([readStorageCredentialSetup(rootA, actor), readStorageCredentialSetup(rootB, actor)]))
      .map(value => value.state).sort()).toEqual(["legacy_ready", "restore_required"].sort());
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
