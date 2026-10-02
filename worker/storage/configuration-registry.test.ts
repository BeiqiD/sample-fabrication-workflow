import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkedSaveStorageCandidateInput, checkedStorageConfigurationStatus, type SaveStorageCandidateInput } from "../../shared/contracts/storage-configuration";
import { SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { decryptStorageCredential, parseStorageCredentialKeyring } from "./credential-envelope";
import { readStorageConfiguration, saveStorageCandidate, StorageConfigurationError, storageCredentialEditingAvailable } from "./configuration-registry";

const migration = readFileSync(new URL("../../migrations/0014_fp2_storage_configuration.sql", import.meta.url), "utf8");
const rawKeyring = JSON.stringify({ version: 1, currentKeyId: "fixture", keys: { fixture: btoa(String.fromCharCode(...new Uint8Array(32).fill(13))) } });
const actor = "admin@example.test";
const input: SaveStorageCandidateInput = { expectedRevision: null, label: "Laboratory candidate",
  namespace: { kind: "s3", endpoint: "https://objects.example.test", bucket: "test-bucket", region: "eu-test-1", root: "research", forcePathStyle: true },
  credentials: { mode: "replace", value: { accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" } } };
const databases: DatabaseSync[] = [];
function fixture() {
  const sql = new DatabaseSync(":memory:"); databases.push(sql); sql.exec("PRAGMA foreign_keys=ON"); sql.exec(migration);
  const db = new SqliteD1Database(sql);
  const env = { DB: db as unknown as D1Database, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: actor, STORAGE_CREDENTIAL_KEYRING: rawKeyring } as Env;
  const io = vi.fn(() => { throw new Error("Provider I/O is forbidden"); }); vi.stubGlobal("fetch", io);
  return { sql, db, env, io };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach(db => db.close()); });
function count(sql: DatabaseSync, table: string): number { return Number(sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n); }
function snapshot(sql: DatabaseSync) {
  return ["system_storage_profiles", "system_storage_credential_descriptors", "system_storage_credential_payloads", "system_storage_configuration_revisions", "system_storage_configuration_audit"]
    .map(table => [table, count(sql, table)]);
}

describe("administrator storage candidate registry", () => {
  it("saves only encrypted credentials and safe audit metadata in one transaction, without provider I/O", async () => {
    const f = fixture(), saved = await saveStorageCandidate(f.env, input, actor);
    expect(saved).toMatchObject({ revision: 1, namespace: input.namespace, credentials: { status: "configured" } });
    const response = checkedStorageConfigurationStatus(await readStorageConfiguration(f.env, actor));
    expect(response).toEqual({ scope: "system", credentialEditingAvailable: true, candidates: { items: [saved], hasMore: false } });
    const rows = f.sql.prepare("SELECT * FROM system_storage_credential_payloads").all(), audit = f.sql.prepare("SELECT * FROM system_storage_configuration_audit").get();
    for (const secret of ["fixture-access", "fixture-secret"]) {
      expect(JSON.stringify(rows)).not.toContain(secret); expect(JSON.stringify(response)).not.toContain(secret); expect(JSON.stringify(audit)).not.toContain(secret);
    }
    expect(audit).toMatchObject({ actor, operation: "candidate_create", outcome: "saved", configuration_revision: 1 });
    expect(snapshot(f.sql).map(entry => entry[1])).toEqual([1, 1, 1, 1, 1]); expect(f.io).not.toHaveBeenCalled();
  });

  it("retains credentials by sealing them to a new immutable revision and allows S3 transport corrections", async () => {
    const f = fixture(), first = await saveStorageCandidate(f.env, input, actor);
    const revised = await saveStorageCandidate(f.env, { ...input, profileId: first.profileId, expectedRevision: 1, label: "Updated label",
      namespace: { ...input.namespace, region: "auto", forcePathStyle: false }, credentials: { mode: "retain" } }, actor);
    expect(revised.revision).toBe(2); expect(revised.credentials.ref).not.toBe(first.credentials.ref);
    const row = f.sql.prepare(`SELECT d.*,e.* FROM system_storage_credential_descriptors d JOIN system_storage_credential_payloads e USING(credential_ref) WHERE d.credential_ref=?`).get(revised.credentials.ref)!;
    const identity = { profileId: revised.profileId, configurationRevision: 2, credentialRef: revised.credentials.ref, namespaceSha256: row.namespace_sha256 as string };
    const envelope = { version: 1 as const, keyId: row.key_id as string, nonce: row.nonce as string, ciphertext: row.ciphertext as string };
    const ring = await parseStorageCredentialKeyring(rawKeyring);
    expect(await decryptStorageCredential(ring, identity, envelope)).toEqual({ outcome: "available", plaintext: JSON.stringify(input.credentials.mode === "replace" ? input.credentials.value : null) });
    expect(await decryptStorageCredential(ring, { ...identity, configurationRevision: 1 }, envelope)).toEqual({ outcome: "unavailable" });
    expect(f.sql.prepare("SELECT latest_revision n FROM system_storage_profiles").get()!.n).toBe(2);
    expect(f.sql.prepare("SELECT count(*) n FROM system_storage_configuration_revisions").get()!.n).toBe(2);
  });

  it("requires a new profile for namespace changes and detects stale revisions without partial writes", async () => {
    const f = fixture(), first = await saveStorageCandidate(f.env, input, actor), before = snapshot(f.sql);
    await expect(saveStorageCandidate(f.env, { ...input, profileId: first.profileId, expectedRevision: 1, namespace: { ...input.namespace, root: "different" } }, actor))
      .rejects.toMatchObject({ status: 409, message: "Changing the physical namespace requires a new storage profile." });
    await expect(saveStorageCandidate(f.env, { ...input, profileId: first.profileId, expectedRevision: 9 }, actor)).rejects.toMatchObject({ status: 409 });
    await expect(saveStorageCandidate(f.env, input, actor)).rejects.toMatchObject({ status: 409 });
    expect(snapshot(f.sql)).toEqual(before);
  });

  it("binds owner additions, corrections and removal to new immutable configuration revisions", async () => {
    const f = fixture(), awsInput = { ...input, namespace: { ...input.namespace, endpoint: "https://s3.eu-central-1.amazonaws.com", region: "eu-central-1" } };
    const first = await saveStorageCandidate(f.env, awsInput, actor);
    const originalProfile = f.sql.prepare("SELECT namespace_json,namespace_sha256 FROM system_storage_profiles WHERE id=?").get(first.profileId)!;
    const revisions = [first];
    for (const expectedBucketOwner of ["012345678901", "123456789012", undefined]) {
      revisions.push(await saveStorageCandidate(f.env, { ...awsInput, profileId: first.profileId, expectedRevision: revisions.length,
        namespace: { ...awsInput.namespace, ...(expectedBucketOwner === undefined ? {} : { expectedBucketOwner }) }, credentials: { mode: "retain" } }, actor));
    }
    const stored = f.sql.prepare("SELECT revision,namespace_json,credential_ref FROM system_storage_configuration_revisions ORDER BY revision").all();
    expect(stored.map(row => ({ revision: row.revision, namespace: JSON.parse(row.namespace_json as string), credentialRef: row.credential_ref })))
      .toEqual(revisions.map(revision => ({ revision: revision.revision, namespace: revision.namespace, credentialRef: revision.credentials.ref })));
    expect(revisions.map(revision => "expectedBucketOwner" in revision.namespace ? revision.namespace.expectedBucketOwner : null))
      .toEqual([null, "012345678901", "123456789012", null]);
    expect(new Set(revisions.map(revision => revision.credentials.ref)).size).toBe(4);
    expect(f.sql.prepare("SELECT namespace_json,namespace_sha256 FROM system_storage_profiles WHERE id=?").get(first.profileId)).toEqual(originalProfile);
    expect(JSON.stringify(originalProfile)).not.toContain("expectedBucketOwner");
    expect(f.sql.prepare("SELECT DISTINCT namespace_sha256 FROM system_storage_credential_descriptors").all()).toEqual([{ namespace_sha256: originalProfile.namespace_sha256 }]);
    expect((await readStorageConfiguration(f.env, actor)).candidates.items).toEqual([revisions[3]]);
    expect(() => f.sql.prepare("UPDATE system_storage_configuration_revisions SET namespace_json=? WHERE revision=2").run(stored[2].namespace_json))
      .toThrow();
    expect(f.io).not.toHaveBeenCalled();
  });

  it("rolls back a concurrent loser including its encrypted payload and audit", async () => {
    const f = fixture(), first = await saveStorageCandidate(f.env, input, actor);
    const update = { ...input, profileId: first.profileId, expectedRevision: 1, credentials: { mode: "retain" } };
    const results = await Promise.allSettled([saveStorageCandidate(f.env, update, actor), saveStorageCandidate(f.env, update, actor)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409 }); expect(snapshot(f.sql).map(entry => entry[1])).toEqual([1, 2, 2, 2, 2]);
  });

  it("rolls back every row when audit publication fails", async () => {
    const f = fixture(); f.sql.exec("CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON system_storage_configuration_audit BEGIN SELECT RAISE(ABORT,'private failure detail'); END;");
    await expect(saveStorageCandidate(f.env, input, actor)).rejects.toEqual(new StorageConfigurationError(503, "Storage configuration is temporarily unavailable."));
    expect(snapshot(f.sql).map(entry => entry[1])).toEqual([0, 0, 0, 0, 0]);
  });

  it("preserves metadata and ciphertext when the root key or protected payload is unavailable", async () => {
    const f = fixture(), saved = await saveStorageCandidate(f.env, input, actor), sealed = JSON.stringify(f.sql.prepare("SELECT * FROM system_storage_credential_payloads").get());
    const env = { ...f.env, STORAGE_CREDENTIAL_KEYRING: undefined };
    expect(await storageCredentialEditingAvailable(env)).toBe(false);
    expect((await readStorageConfiguration(env, actor)).candidates.items[0].credentials.status).toBe("unavailable");
    await expect(saveStorageCandidate(env, { ...input, profileId: saved.profileId, expectedRevision: 1, credentials: { mode: "retain" } }, actor)).rejects.toMatchObject({ status: 503 });
    expect(JSON.stringify(f.sql.prepare("SELECT * FROM system_storage_credential_payloads").get())).toBe(sealed);
    // A separately restored descriptor need not have a protected payload. This
    // is the deliberate reverse-FK boundary for metadata-only recovery.
    f.sql.exec("DROP TRIGGER system_storage_credential_payloads_delete_guard"); f.sql.exec("DELETE FROM system_storage_credential_payloads");
    expect((await readStorageConfiguration(f.env, actor)).candidates.items[0].credentials.status).toBe("unavailable");
    await expect(saveStorageCandidate(f.env, { ...input, profileId: saved.profileId, expectedRevision: 1, credentials: { mode: "retain" } }, actor)).rejects.toMatchObject({ status: 503 });
    expect((await saveStorageCandidate(f.env, { ...input, profileId: saved.profileId, expectedRevision: 1 }, actor)).revision).toBe(2);
  });

  it("enforces separate administrator permission before any database or credential access", async () => {
    const f = fixture();
    for (const env of [{ ...f.env, SYSTEM_ADMIN_EMAILS: "reader@example.test" }, { ...f.env, AUTH_MODE: "disabled" as const }]) {
      await expect(readStorageConfiguration(env, actor)).rejects.toMatchObject({ status: 403 });
      await expect(saveStorageCandidate(env, input, actor)).rejects.toMatchObject({ status: 403 });
    }
    expect(f.db.queryCount).toBe(0); expect(f.io).not.toHaveBeenCalled();
  });

  it("supports WebDAV/SWITCHdrive metadata with encrypted username/password and rejects unsafe or mismatched input", async () => {
    const f = fixture();
    for (const kind of ["webdav", "switchdrive"] as const) {
      const saved = await saveStorageCandidate(f.env, { expectedRevision: null, label: kind,
        namespace: { kind, endpoint: `https://${kind}.example.test/remote.php/dav/files/user`, root: "research" },
        credentials: { mode: "replace", value: { username: "fixture-user", password: "fixture-password" } } }, actor);
      expect(saved.namespace.kind).toBe(kind);
    }
    for (const changed of [{ ...input, unexpected: "secret" }, { ...input, credentials: { mode: "retain" } },
      { ...input, credentials: { mode: "replace", value: { username: "user", password: "password" } } },
      ...["http://objects.example.test", "https://127.0.0.1", "https://localhost", "https://192.168.1.1", "https://user:password@objects.example.test", "https://objects.example.test/?token=secret"].map(endpoint => ({ ...input, namespace: { ...input.namespace, endpoint } })),
      ...["../root", "/root", "root/..", "root//path"].map(root => ({ ...input, namespace: { ...input.namespace, root } }))]) expect(() => checkedSaveStorageCandidateInput(changed)).toThrow("Invalid storage configuration.");
    expect(f.io).not.toHaveBeenCalled();
  });

  it("database constraints retain immutable metadata, exact credential identity and safe audit", async () => {
    const f = fixture(), saved = await saveStorageCandidate(f.env, input, actor);
    for (const sql of ["UPDATE system_storage_profiles SET namespace_json='{}'", "UPDATE system_storage_profiles SET latest_revision=9",
      "UPDATE system_storage_configuration_revisions SET label='changed'", "UPDATE system_storage_credential_descriptors SET configuration_revision=9",
      "UPDATE system_storage_credential_payloads SET envelope_revision=9", "DELETE FROM system_storage_configuration_audit", "DELETE FROM system_storage_configuration_revisions"])
      expect(() => f.sql.exec(sql)).toThrow();
    expect(() => f.sql.prepare("UPDATE system_storage_credential_payloads SET credential_ref='different',envelope_revision=2 WHERE credential_ref=?").run(saved.credentials.ref)).toThrow();
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("uses the actual D1 transaction with native Worker crypto for candidate saves and stale CAS", async () => {
    const bundled = await build({ stdin: { contents: `
      import { readStorageConfiguration,saveStorageCandidate } from './configuration-registry';
      export default { async fetch(request,env) {
        try { const input=await request.json(); return Response.json(input.action==='read' ? await readStorageConfiguration(env,'admin@example.test') : await saveStorageCandidate(env,input.command,'admin@example.test')); }
        catch(error) { return Response.json({error:error.message},{status:error.status||503}); }
      } };`, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" }, bundle: true, format: "esm", platform: "browser", write: false });
    const native = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-07-14", d1Databases: ["DB"],
      bindings: { AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: actor, STORAGE_CREDENTIAL_KEYRING: rawKeyring } });
    try {
      const db = await native.getD1Database("DB");
      // D1 exec accepts SQL statements individually; trigger bodies are sent
      // intact through prepare rather than split on their internal semicolons.
      const statements = migration.match(/CREATE TABLE[\s\S]*?;|CREATE TRIGGER[\s\S]*?\nEND;/g)!;
      await db.batch(statements.map(statement => db.prepare(statement)));
      const invoke = (value: unknown) => native.dispatchFetch("https://fixture.test", { method: "POST", body: JSON.stringify(value) });
      const firstResponse = await invoke({ command: input }); expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json() as { profileId: string };
      const update = { ...input, profileId: first.profileId, expectedRevision: 1, credentials: { mode: "retain" } };
      expect((await invoke({ command: update })).status).toBe(200);
      expect((await invoke({ command: update })).status).toBe(409);
      const read = await (await invoke({ action: "read" })).json();
      expect(read).toMatchObject({ candidates: { items: [{ revision: 2, credentials: { status: "configured" } }] } });
      expect((await db.prepare("SELECT count(*) n FROM system_storage_credential_payloads").first<{ n: number }>())!.n).toBe(2);
    } finally { await native.dispose(); }
  }, 30_000);
});
