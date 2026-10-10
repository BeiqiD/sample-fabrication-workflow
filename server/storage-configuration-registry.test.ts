import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkedStorageConfigurationStatus, type SaveStorageCandidateInput } from "../shared/contracts/storage-configuration";
import { principalHasCapability, type AuthenticatedPrincipal } from "../worker/runtime/authorization";
import type { ConfigurationSqlDatabase, ConfigurationSqlStatement } from "../worker/runtime/configuration-sql";
import { decryptStorageCredential, parseStorageCredentialKeyring } from "../worker/storage/credential-envelope";
import { createStorageConfigurationRegistry, StorageConfigurationError } from "../worker/storage/configuration-registry-core";
import { createSqliteCapability, type SqliteCapability } from "./sqlite";
import { asStorageConfigurationSqlDatabase } from "./storage-configuration-sql";

const migration = readFileSync(new URL("../migrations/0014_fp2_storage_configuration.sql", import.meta.url), "utf8");
const rawKeyring = JSON.stringify({ version: 1, currentKeyId: "fixture", keys: { fixture: Buffer.alloc(32, 13).toString("base64") } });
const accountId = `local_${crypto.randomUUID()}`, actor = `local-account:${accountId}`;
const input: SaveStorageCandidateInput = { expectedRevision: null, label: "Local laboratory candidate",
  namespace: { kind: "s3", endpoint: "https://objects.example.test", bucket: "test-bucket", region: "eu-test-1", root: "research", forcePathStyle: true },
  credentials: { mode: "replace", value: { accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" } } };
const tables = ["system_storage_profiles", "system_storage_credential_descriptors", "system_storage_credential_payloads", "system_storage_configuration_revisions", "system_storage_configuration_audit"];
const fixtures: { directory: string; cores: SqliteCapability[] }[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rt1-storage-registry-")), filename = join(directory, "fixture.sqlite");
  const database = new DatabaseSync(filename, { allowExtension: false }); database.exec(migration);
  const core = createSqliteCapability(database), cores: SqliteCapability[] = [core];
  const sql = asStorageConfigurationSqlDatabase(core);
  let principal: AuthenticatedPrincipal = { id: accountId, actor, capabilities: { systemAdministrator: true, fileEvidenceOperator: false } };
  const authorizeAdministrator = vi.fn((verifiedActor: string) => principalHasCapability(principal, verifiedActor, "systemAdministrator"));
  const selectDatabase = vi.fn(() => sql), keyring = vi.fn(() => parseStorageCredentialKeyring(rawKeyring));
  const service = createStorageConfigurationRegistry({ database: selectDatabase, authorizeAdministrator, keyring });
  const connect = () => {
    const connection = new DatabaseSync(filename, { allowExtension: false });
    const capability = createSqliteCapability(connection); cores.push(capability);
    return { connection, capability, sql: asStorageConfigurationSqlDatabase(capability) };
  };
  const f = { directory, filename, database, core, sql, cores, service, authorizeAdministrator, selectDatabase, keyring, connect,
    revoke() { principal = { ...principal, capabilities: { systemAdministrator: false, fileEvidenceOperator: true } }; } };
  fixtures.push(f); return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    for (const core of f.cores) core.close();
    rmSync(f.directory, { recursive: true });
  }
  vi.restoreAllMocks();
});
function counts(database: DatabaseSync) { return tables.map(table => Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)); }
function lostAcknowledgement(f: ReturnType<typeof fixture>, options: { commit: boolean; closePrimary?: boolean }) {
  const reader = f.connect();
  if (options.closePrimary) reader.capability.close();
  let primarySelections = 0;
  const batch = vi.fn(async (items: readonly ConfigurationSqlStatement[]) => {
    if (options.commit) await f.sql.batch(items);
    throw new Error("Private ACK failure details");
  });
  const faulty: ConfigurationSqlDatabase = {
    prepare: f.sql.prepare, batch,
    primary() { primarySelections++; return primarySelections === 1 ? faulty : reader.sql.primary(); },
  };
  const service = createStorageConfigurationRegistry({ database: () => faulty, authorizeAdministrator: f.authorizeAdministrator, keyring: f.keyring });
  return { service, batch, reader, selections: () => primarySelections };
}

describe("actual Node SQLite storage configuration capabilities", () => {
  it("keeps exact BigInt cells, rejects inexact Number bindings and reports direct changes separately from trigger work", async () => {
    const f = fixture();
    const row = await f.sql.prepare("SELECT 9223372036854775807 AS exact_integer, 1.5 AS fraction").first();
    expect(row).toEqual({ exact_integer: 9223372036854775807n, fraction: 1.5 });
    expect(() => f.sql.prepare("SELECT ? AS value").bind(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    f.database.exec("CREATE TABLE fixture_direct(v INTEGER); CREATE TABLE fixture_trigger(v INTEGER); CREATE TRIGGER fixture_side_effect AFTER INSERT ON fixture_direct BEGIN INSERT INTO fixture_trigger VALUES(NEW.v); END;");
    const result = await f.sql.batch([f.sql.prepare("INSERT INTO fixture_direct VALUES(?)").bind(1)]);
    expect(result).toEqual([{ directChanges: 1 }]);
    await expect(f.sql.batch([f.sql.prepare("SELECT 1 AS value")])).rejects.toThrow("Storage configuration batch only accepts top-level mutations");
    expect(f.database.prepare("SELECT changes() AS direct, total_changes() AS total").get()).toEqual({ direct: 1, total: 2 });
  });
  it("persists encrypted candidates and safe audit metadata to an actual WAL file using an explicit local grant", async () => {
    const f = fixture(), saved = await f.service.saveStorageCandidate(input, actor);
    expect(checkedStorageConfigurationStatus(await f.service.readStorageConfiguration(actor))).toEqual({
      scope: "system", credentialEditingAvailable: true, candidates: { items: [saved], hasMore: false },
    });
    expect(saved.createdBy).toBe(actor); expect(saved.revision).toBe(1);
    expect(counts(f.database)).toEqual([1, 1, 1, 1, 1]);
    const observer = f.connect();
    expect(observer.connection.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("wal");
    expect(observer.connection.prepare("SELECT actor,operation,outcome FROM system_storage_configuration_audit").get())
      .toEqual({ actor, operation: "candidate_create", outcome: "saved" });
    for (const secret of ["fixture-access", "fixture-secret"]) {
      expect(JSON.stringify(observer.connection.prepare("SELECT * FROM system_storage_credential_payloads").all())).not.toContain(secret);
      expect(JSON.stringify(saved)).not.toContain(secret);
    }
    expect(observer.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("reseals retained credentials to the exact new revision and preserves physical identity during transport corrections", async () => {
    const f = fixture(), first = await f.service.saveStorageCandidate(input, actor);
    const update = { ...input, profileId: first.profileId, expectedRevision: 1,
      namespace: { ...input.namespace, region: "auto", forcePathStyle: false }, credentials: { mode: "retain" } };
    const saved = await f.service.saveStorageCandidate(update, actor);
    expect(saved.revision).toBe(2); expect(saved.credentials.ref).not.toBe(first.credentials.ref);
    const row = f.database.prepare("SELECT d.namespace_sha256,e.* FROM system_storage_credential_descriptors d JOIN system_storage_credential_payloads e USING(credential_ref) WHERE d.credential_ref=?").get(saved.credentials.ref)!;
    const identity = { profileId: saved.profileId, configurationRevision: 2, credentialRef: saved.credentials.ref, namespaceSha256: String(row.namespace_sha256) };
    const envelope = { version: 1 as const, keyId: String(row.key_id), nonce: String(row.nonce), ciphertext: String(row.ciphertext) };
    const ring = await parseStorageCredentialKeyring(rawKeyring);
    expect(await decryptStorageCredential(ring, identity, envelope)).toEqual({ outcome: "available", plaintext: JSON.stringify(input.credentials.mode === "replace" ? input.credentials.value : null) });
    expect(await decryptStorageCredential(ring, { ...identity, configurationRevision: 1 }, envelope)).toEqual({ outcome: "unavailable" });
    expect(counts(f.database)).toEqual([1, 2, 2, 2, 2]);
  });
  it("rolls back the concurrent CAS loser across two actual connections, including its payload and audit", async () => {
    const f = fixture(), first = await f.service.saveStorageCandidate(input, actor), peer = f.connect();
    const peerService = createStorageConfigurationRegistry({ database: () => peer.sql, authorizeAdministrator: f.authorizeAdministrator, keyring: f.keyring });
    const update = { ...input, profileId: first.profileId, expectedRevision: 1, credentials: { mode: "retain" } };
    const result = await Promise.allSettled([f.service.saveStorageCandidate(update, actor), peerService.saveStorageCandidate(update, actor)]);
    expect(result.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(result.find(item => item.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(counts(f.database)).toEqual([1, 2, 2, 2, 2]);
  });
  it("rolls back every row when the real audit trigger rejects publication", async () => {
    const f = fixture();
    f.database.exec("CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON system_storage_configuration_audit BEGIN SELECT RAISE(ABORT,'private SQL details'); END;");
    await expect(f.service.saveStorageCandidate(input, actor)).rejects.toEqual(new StorageConfigurationError(503, "Storage configuration is temporarily unavailable."));
    expect(counts(f.database)).toEqual([0, 0, 0, 0, 0]);
  });
  it.each(["create", "revise"] as const)("settles a lost %s acknowledgement by its own complete receipt at a fresh actual primary connection", async mode => {
    const f = fixture();
    const first = mode === "revise" ? await f.service.saveStorageCandidate(input, actor) : undefined;
    const fault = lostAcknowledgement(f, { commit: true });
    const command = first ? { ...input, profileId: first.profileId, expectedRevision: 1, credentials: { mode: "retain" } } : input;
    const saved = await fault.service.saveStorageCandidate(command, actor);
    expect(saved.revision).toBe(first ? 2 : 1); expect(fault.batch).toHaveBeenCalledOnce(); expect(fault.selections()).toBe(2);
    expect(fault.reader.connection.prepare("SELECT count(*) AS n FROM system_storage_configuration_audit").get()!.n).toBe(first ? 2 : 1);
    expect(counts(f.database)).toEqual(first ? [1, 2, 2, 2, 2] : [1, 1, 1, 1, 1]);
    expect((await f.service.readStorageConfiguration(actor)).candidates.items).toEqual([saved]);
  });
  it("does not treat an uncommitted failure or unreadable primary as a successful acknowledgement", async () => {
    const absent = fixture(), first = lostAcknowledgement(absent, { commit: false });
    await expect(first.service.saveStorageCandidate(input, actor)).rejects.toEqual(new StorageConfigurationError(503, "Storage configuration is temporarily unavailable."));
    expect(first.selections()).toBe(2); expect(counts(absent.database)).toEqual([0, 0, 0, 0, 0]);
    const committed = fixture(), second = lostAcknowledgement(committed, { commit: true, closePrimary: true });
    await expect(second.service.saveStorageCandidate(input, actor)).rejects.toEqual(new StorageConfigurationError(503, "Storage configuration is temporarily unavailable."));
    expect(second.selections()).toBe(2); expect(counts(committed.database)).toEqual([1, 1, 1, 1, 1]);
  });
  it("preserves ciphertext and metadata when the current keyring is unavailable", async () => {
    const f = fixture(), saved = await f.service.saveStorageCandidate(input, actor);
    const before = f.database.prepare("SELECT * FROM system_storage_credential_payloads").all();
    f.keyring.mockRejectedValue(new Error("Private keyring details"));
    expect(await f.service.storageCredentialEditingAvailable()).toBe(false);
    expect((await f.service.readStorageConfiguration(actor)).candidates.items[0].credentials.status).toBe("unavailable");
    await expect(f.service.saveStorageCandidate({ ...input, profileId: saved.profileId, expectedRevision: 1, credentials: { mode: "retain" } }, actor))
      .rejects.toEqual(new StorageConfigurationError(503, "Storage credential encryption is unavailable."));
    expect(f.database.prepare("SELECT * FROM system_storage_credential_payloads").all()).toEqual(before);
  });
  it("rejects missing or revoked current administrator grants before selecting SQL/keyring and again before the write", async () => {
    const f = fixture(); f.revoke();
    await expect(f.service.readStorageConfiguration(actor)).rejects.toMatchObject({ status: 403 });
    await expect(f.service.saveStorageCandidate(input, actor)).rejects.toMatchObject({ status: 403 });
    expect(f.selectDatabase).not.toHaveBeenCalled(); expect(f.keyring).not.toHaveBeenCalled();
    f.authorizeAdministrator.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await expect(f.service.saveStorageCandidate(input, actor)).rejects.toMatchObject({ status: 403 });
    expect(counts(f.database)).toEqual([0, 0, 0, 0, 0]);
  });
  it("rejects a genuinely unsafe integer revision from a deliberately corrupt private SQLite fixture without rounding it", async () => {
    const f = fixture(); await f.service.saveStorageCandidate(input, actor);
    // Privileged fixture damage deliberately bypasses immutability/FKs; this
    // is not an allowed service operation and touches only this private file.
    f.database.exec("PRAGMA foreign_keys=OFF; DROP TRIGGER system_storage_profiles_update_guard; DROP TRIGGER system_storage_configuration_revisions_immutable; UPDATE system_storage_profiles SET latest_revision=9007199254740992; UPDATE system_storage_configuration_revisions SET revision=9007199254740992; PRAGMA foreign_keys=ON;");
    await expect(f.service.readStorageConfiguration(actor)).rejects.toEqual(new StorageConfigurationError(503, "Storage configuration is temporarily unavailable."));
    const row = await f.sql.prepare("SELECT revision FROM system_storage_configuration_revisions").first();
    expect(row!.revision).toBe(9007199254740992n);
  });
  it("rejects foreign adapter statements before any mutation", async () => {
    const a = fixture(), b = fixture();
    a.database.exec("CREATE TABLE fixture_write(v INTEGER)"); b.database.exec("CREATE TABLE fixture_write(v INTEGER)");
    await expect(a.sql.batch([b.sql.prepare("INSERT INTO fixture_write VALUES(1)")])).rejects.toThrow("Foreign storage configuration statement");
    expect(a.database.prepare("SELECT count(*) AS n FROM fixture_write").get()!.n).toBe(0);
    expect(b.database.prepare("SELECT count(*) AS n FROM fixture_write").get()!.n).toBe(0);
  });
});
