import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { S3StorageNamespace } from "../../shared/contracts/storage-configuration";
import { canonicalR2UploadInput } from "../../shared/contracts/r2-upload";
import { stageAuthorityCandidate } from "../files/authority-candidates";
import { futureActiveRuntimeDatabase } from "../files/authority-runtime-test-support";
import { openShadowProfile } from "../files/shadow-profile";
import { writeVerifiedBytes } from "../files/byte-writer";
import type { Sha256Factory } from "../files/byte-verification";
import { SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { saveStorageCandidate } from "./configuration-registry";
import { startStorageCandidateCheck } from "./candidate-check-service";
import { activateNativeStorageProfile } from "./native-profile-activation";
import { nativeS3ByteStorage } from "./native-s3-byte-storage";
import type { S3RequestOperation } from "./s3-byte-adapter";
import { readStorageProfileAdmission, registerStorageProfile } from "./storage-profile-admission-service";
import { reenvelopeStoredStorageCredential } from "./credential-reenvelope-service";
import { setStorageRoleDefaults } from "./storage-role-policy";

const actor = "admin@example.test";
const material = (number: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(number)));
const ring = JSON.stringify({ version: 1, currentKeyId: "old", keys: { old: material(31) } });
const rotated = JSON.stringify({ version: 1, currentKeyId: "new", keys: { old: material(31), new: material(47) } });
const namespace: S3StorageNamespace = { kind: "s3", endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1",
  bucket: "native-file-fixture", root: "recorded-root", forcePathStyle: true, expectedBucketOwner: "111122223333" };
const hash: Sha256Factory = () => { const value = createHash("sha256"); return {
  async write(bytes) { value.update(bytes); }, async finish() { return value.digest("hex"); }, async abort() {},
}; };
const databases: ReturnType<typeof futureActiveRuntimeDatabase>[] = [];
async function fixture() {
  const sql = futureActiveRuntimeDatabase(undefined, { throughMigration: "0018_fp2_native_file_runtime.sql" });
  databases.push(sql);
  const env = { DB: new SqliteD1Database(sql) as unknown as D1Database, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: actor,
    STORAGE_CREDENTIAL_KEYRING: ring } as Env;
  const candidate = { expectedRevision: null, label: "Native File", namespace,
    credentials: { mode: "replace" as const, value: { accessKeyId: "fixture-retained-access", secretAccessKey: "fixture-retained-secret" } } };
  const saved = await saveStorageCandidate(env, candidate, actor);
  const objects = new Map<string, ArrayBuffer>();
  const fetch = vi.fn(async (request: Request) => {
    if (request.method === "PUT") { objects.set(request.url, await request.arrayBuffer()); return new Response(null); }
    if (request.method === "DELETE") { objects.delete(request.url); return new Response(null, { status: 204 }); }
    const bytes = objects.get(request.url);
    return bytes ? new Response(request.method === "HEAD" ? null : bytes.slice(0), { headers: { "content-length": String(bytes.byteLength) } })
      : new Response(null, { status: 404 });
  });
  const check = await startStorageCandidateCheck(env, { checkId: crypto.randomUUID(), profileId: saved.profileId, expectedRevision: 1 }, actor, { fetch, createHash: hash });
  expect(check.status).toBe("succeeded");
  const command = { operationId: crypto.randomUUID(), profileId: saved.profileId, expectedRevision: 1, expectedEnvelopeRevision: 1, checkId: check.id };
  const admission = await registerStorageProfile(env, command, actor);
  const profile = { profileId: admission.nativeProfileId, configurationRevision: 1 };
  await activateNativeStorageProfile(env, { operationId: crypto.randomUUID(), nativeProfileId: profile.profileId,
    candidateProfileId: saved.profileId, expectedCandidateRevision: 1, expectedEnvelopeRevision: 1, checkId: check.id, expectedBindingRevision: null }, actor);
  fetch.mockClear();
  const body = new TextEncoder().encode("verified native bytes").buffer;
  const input = { key: "opaque/%2F and space", body, byteSize: body.byteLength, sha256: createHash("sha256").update(new Uint8Array(body)).digest("hex"),
    contentType: "application/octet-stream", filename: "fixture.bin" };
  return { sql, env, saved, candidate, fetch, objects, input, profile, admission, command };
}
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(database => database.close()); });

describe("activated exact-profile native File transport", () => {
  it("opens authenticated capabilities without provider I/O and verifies complete write/readback/stat/delete against the recorded namespace", async () => {
    const f = await fixture();
    const globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(f.fetch);
    const profile = await openShadowProfile(f.env, f.profile, "write");
    expect(globalFetch).not.toHaveBeenCalled();
    expect(profile.storage.adapterType).toBe("s3");
    expect(profile.writer).toBeDefined(); expect(profile.deleter).toBeDefined();
    await writeVerifiedBytes({ ...profile, writer: profile.writer!, createHash: hash }, f.input);
    expect(await profile.reader.stat(f.input.key)).toMatchObject({ outcome: "available", byteSize: f.input.byteSize });
    expect(await profile.deleter!.delete(f.input.key)).toEqual({ outcome: "acknowledged" });
    expect(f.fetch.mock.calls.map(([request]) => request.method)).toEqual(["PUT", "GET", "HEAD", "DELETE"]);
    for (const [request] of f.fetch.mock.calls) {
      expect(request.url).toContain("/native-file-fixture/recorded-root/opaque/%252F%20and%20space");
      expect(request.headers.get("x-amz-expected-bucket-owner")).toBe(namespace.expectedBucketOwner);
      expect(request.headers.get("authorization")).toContain("fixture-retained-access");
    }
    expect(f.sql.prepare("SELECT count(*) n FROM file_locations").get()).toEqual({ n: 0 });
  });

  it("preserves the exact retained target and credentials after candidate edits", async () => {
    const f = await fixture();
    await saveStorageCandidate(f.env, { ...f.candidate, profileId: f.saved.profileId, expectedRevision: 1,
      namespace: { ...namespace, forcePathStyle: false, expectedBucketOwner: "999988887777" },
      credentials: { mode: "replace", value: { accessKeyId: "fixture-latest-access", secretAccessKey: "fixture-latest-secret" } } }, actor);
    const storage = nativeS3ByteStorage(f.env, f.profile, "write", { fetch: f.fetch });
    await storage.writer.write(f.input);
    expect(await storage.reader.stat(f.input.key)).toMatchObject({ outcome: "available" });
    for (const [request] of f.fetch.mock.calls) {
      expect(request.headers.get("x-amz-expected-bucket-owner")).toBe("111122223333");
      expect(request.headers.get("authorization")).toContain("fixture-retained-access");
      expect(request.headers.get("authorization")).not.toContain("fixture-latest-access");
    }
  });

  it.each(["GET", "HEAD", "PUT", "DELETE"] as const)("fences %s after caller suspension and credential re-enveloping without retrying", async method => {
    const f = await fixture(); f.env.STORAGE_CREDENTIAL_KEYRING = rotated;
    const beforeRequest = vi.fn(async (operation: S3RequestOperation) => {
      expect(operation).toEqual({ method, key: f.input.key }); expect(Object.isFrozen(operation)).toBe(true);
      await reenvelopeStoredStorageCredential(f.env, { operationId: crypto.randomUUID(), profileId: f.saved.profileId,
        revision: 1, credentialRef: f.saved.credentials.ref, expectedEnvelopeRevision: 1 }, actor);
      return true;
    });
    const storage = nativeS3ByteStorage(f.env, f.profile, "write", { fetch: f.fetch, beforeRequest });
    if (method === "GET") expect(await storage.reader.read(f.input.key)).toEqual({ outcome: "unavailable" });
    if (method === "HEAD") expect(await storage.reader.stat(f.input.key)).toEqual({ outcome: "unavailable" });
    if (method === "DELETE") expect(await storage.deleter.delete(f.input.key)).toEqual({ outcome: "unavailable" });
    if (method === "PUT") await expect(storage.writer.write(f.input)).rejects.toMatchObject({ phase: "destination", reason: "unavailable" });
    expect(beforeRequest).toHaveBeenCalledTimes(1); expect(f.fetch).not.toHaveBeenCalled();
    expect(await nativeS3ByteStorage(f.env, f.profile, "write", { fetch: f.fetch }).reader.stat(f.input.key)).toEqual({ outcome: "missing" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails opening unavailable credentials while historical registration replay survives activation and missing credentials", async () => {
    const f = await fixture();
    f.env.STORAGE_CREDENTIAL_KEYRING = undefined;
    await expect(openShadowProfile(f.env, f.profile, "write")).rejects.toThrow("recorded File storage profile is unavailable");
    expect(await readStorageProfileAdmission(f.env, f.command.operationId, actor)).toEqual(f.admission);
    expect(await registerStorageProfile(f.env, f.command, actor)).toEqual(f.admission);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("fences an unpaired newer portable activation after signing and rejects the stale installation binding", async () => {
    const f = await fixture();
    const append = f.sql.prepare(`INSERT INTO storage_profile_activations(operation_id,storage_profile_id,configuration_revision,action,
      candidate_profile_id,candidate_revision,envelope_revision,check_id,configuration_sha256,namespace_sha256,binding_revision,actor,created_at)
      SELECT ?,a.storage_profile_id,a.configuration_revision,a.action,a.candidate_profile_id,a.candidate_revision,a.envelope_revision,
      a.check_id,a.configuration_sha256,a.namespace_sha256,a.binding_revision+1,a.actor,a.created_at
      FROM storage_profile_activations a JOIN system_storage_native_bindings b ON b.activation_operation_id=a.operation_id
      WHERE b.storage_profile_id=?`);
    const beforeRequest = vi.fn(async () => { append.run(crypto.randomUUID(), f.profile.profileId); return true; });
    const storage = nativeS3ByteStorage(f.env, f.profile, "write", { fetch: f.fetch, beforeRequest });
    expect(await storage.reader.stat(f.input.key)).toEqual({ outcome: "unavailable" });
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(f.fetch).not.toHaveBeenCalled();
    await expect(openShadowProfile(f.env, f.profile, "write")).rejects.toThrow("recorded File storage profile is unavailable");
    expect(() => append.run(crypto.randomUUID(), f.profile.profileId)).toThrow("Native activation binding revision is stale");
    expect(f.sql.prepare("SELECT binding_revision FROM system_storage_native_bindings").get()).toEqual({ binding_revision: 1 });
  });

  it("retains a native candidate hold through its typed address without manufacturing a legacy R2 or WebDAV address", async () => {
    const f = await fixture();
    await setStorageRoleDefaults(f.env, { operationId: crypto.randomUUID(), expectedPolicyRevision: null,
      internalProfileId: f.profile.profileId, originalsProfileId: f.profile.profileId }, actor);
    const now = new Date().toISOString(), id = crypto.randomUUID(), operationId = crypto.randomUUID();
    const canonical = await canonicalR2UploadInput("project_attachment", { originalName: "fixture.bin", mimeType: f.input.contentType,
      byteSize: f.input.byteSize, sha256: f.input.sha256 });
    f.sql.prepare(`INSERT INTO r2_upload_requests(id,actor_email,client_request_id,operation_id,ingress,purpose,request_sha256,
      request_input_json,request_scope,storage_profile_id,storage_profile_revision,storage_policy_revision,candidate_asset_id,
      candidate_object_key,status,created_at,expires_at,role_policy_revision)
      VALUES(?,?,?,?,'project_attachment','research_source',?,?,'system',?,1,1,?,?,'pending',?,?,3)`)
      .run(id, actor, crypto.randomUUID(), operationId, canonical.sha256, canonical.json, f.profile.profileId, crypto.randomUUID(),
        f.input.key, now, new Date(Date.parse(now) + 86400000).toISOString());
    const candidate = await stageAuthorityCandidate(f.env.DB, { kind: "r2_upload", acceptanceId: id, actorEmail: actor, operationId }, now);
    const holdId = crypto.randomUUID();
    f.sql.prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at)
      VALUES(?,?,'operator',?,'Native retention bridge qualification',?)`).run(holdId, candidate.locationId, operationId, now);
    expect(f.sql.prepare("SELECT 1 FROM file_location_retention_edges WHERE location_id=? AND occurrence_id=?")
      .get(candidate.locationId, holdId)).toBeDefined();
    expect(f.sql.prepare("SELECT * FROM file_shadow_namespace_evidence WHERE storage_profile_id=?").all(f.profile.profileId)).toEqual([]);
    expect(f.sql.prepare("SELECT * FROM file_shadow_retention_namespaces WHERE storage_profile_id=?").all(f.profile.profileId)).toEqual([]);
    expect(f.sql.prepare("SELECT * FROM blob_retention_edges WHERE occurrence_type='file_location_hold' AND occurrence_id=?").all(holdId)).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("passes the invocation abort signal to in-flight requests and blocks later requests", async () => {
    const f = await fixture(), abort = new AbortController();
    let sent!: () => void;
    const started = new Promise<void>(resolve => { sent = resolve; });
    const fetch = vi.fn((request: Request) => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("fixture interrupted")), { once: true }); sent();
    }));
    const storage = nativeS3ByteStorage(f.env, f.profile, "write", { fetch, signal: abort.signal });
    const pending = storage.reader.read(f.input.key); await started; abort.abort();
    expect(await pending).toEqual({ outcome: "unavailable" });
    expect(await storage.reader.stat(f.input.key)).toEqual({ outcome: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
