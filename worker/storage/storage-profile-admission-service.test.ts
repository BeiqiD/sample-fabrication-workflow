import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { S3StorageNamespace, StorageCandidate } from "../../shared/contracts/storage-configuration";
import { awsS3NativeNamespace } from "../../shared/contracts/storage-profile-admission";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import type { Sha256Factory } from "../files/byte-verification";
import type { Env } from "../types";
import { startStorageCandidateCheck } from "./candidate-check-service";
import { saveStorageCandidate } from "./configuration-registry";
import { reenvelopeStoredStorageCredential } from "./credential-reenvelope-service";
import { findStorageProfileAdmission, readStorageProfileAdmission, registerStorageProfile } from "./storage-profile-admission-service";

const actor = "admin@example.test", material = (value: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(value)));
const oldRing = JSON.stringify({ version: 1, currentKeyId: "old", keys: { old: material(13) } });
const rotatedRing = JSON.stringify({ version: 1, currentKeyId: "new", keys: { old: material(13), new: material(29) } });
const namespace: S3StorageNamespace = { kind: "s3", endpoint: "https://s3.us-east-1.amazonaws.com", bucket: "registration-fixture",
  region: "us-east-1", root: "research", forcePathStyle: true, expectedBucketOwner: "111122223333" };
const candidate = { expectedRevision: null, label: "Native registration", namespace,
  credentials: { mode: "replace" as const, value: { accessKeyId: "private-access", secretAccessKey: "private-secret" } } };
const hash: Sha256Factory = () => { const value = createHash("sha256"); return { async write(bytes) { value.update(bytes); },
  async finish() { return value.digest("hex"); }, async abort() {} }; };
const databases: ReturnType<typeof referenceTestDatabase>[] = [];
async function fixture(overrides: Partial<S3StorageNamespace> = {}) {
  const sql = referenceTestDatabase(); databases.push(sql); sql.exec("PRAGMA foreign_keys=ON");
  const db = new SqliteD1Database(sql), env = { DB: db as unknown as D1Database, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: actor,
    STORAGE_CREDENTIAL_KEYRING: oldRing } as Env;
  const configured = { ...namespace, ...overrides };
  if (configured.expectedBucketOwner === undefined) delete configured.expectedBucketOwner;
  const input = { ...candidate, namespace: configured }, saved = await saveStorageCandidate(env, input, actor);
  const objects = new Map<string, ArrayBuffer>();
  const provider = vi.fn(async (request: Request) => {
    if (request.method === "PUT") { objects.set(request.url, await request.arrayBuffer()); return new Response(null); }
    if (request.method === "DELETE") { objects.delete(request.url); return new Response(null, { status: 204 }); }
    const bytes = objects.get(request.url); return bytes ? new Response(request.method === "GET" ? bytes.slice(0) : null,
      { headers: { "content-length": String(bytes.byteLength), "content-type": "application/octet-stream" } }) : new Response(null, { status: 404 });
  });
  const check = async (current: StorageCandidate = saved, fetch = provider) => {
    const result = await startStorageCandidateCheck(env, { checkId: crypto.randomUUID(), profileId: current.profileId, expectedRevision: current.revision }, actor,
      { fetch, createHash: hash });
    return result;
  };
  const successful = await check(); expect(successful.status).toBe("succeeded");
  const command = { operationId: crypto.randomUUID(), profileId: saved.profileId, expectedRevision: 1, expectedEnvelopeRevision: 1, checkId: successful.id };
  const query = { profileId: saved.profileId, expectedRevision: 1 };
  const revise = (next: Partial<S3StorageNamespace> = {}) => saveStorageCandidate(env, { ...input, profileId: saved.profileId, expectedRevision: 1,
    namespace: { ...input.namespace, ...next }, credentials: { mode: "retain" } }, actor);
  const rotate = () => reenvelopeStoredStorageCredential(env, { operationId: crypto.randomUUID(), profileId: saved.profileId, revision: 1,
    credentialRef: saved.credentials.ref, expectedEnvelopeRevision: 1 }, actor);
  const count = (table: string) => Number(sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
  const state = () => ["storage_profiles", "storage_profile_runtime", "storage_profile_admissions", "storage_role_defaults", "file_locations"]
    .map(table => [table, count(table)]);
  const globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No provider access during registration"));
  provider.mockClear();
  return { sql, db, env, input, saved, check, successful, command, query, revise, rotate, state, count, provider, globalFetch };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); databases.splice(0).forEach(db => db.close()); });

describe("native AWS profile registration", () => {
  it("atomically registers qualified identity and portable evidence only, without credentials, locations, defaults or provider I/O", async () => {
    const f = await fixture();
    await expect(findStorageProfileAdmission(f.env, f.query, actor)).rejects.toMatchObject({ status: 404 });
    const result = await registerStorageProfile(f.env, f.command, actor), identity = awsS3NativeNamespace(namespace);
    const digest = createHash("sha256").update(identity).digest("hex");
    expect(result).toMatchObject({ operationId: f.command.operationId, profileId: f.saved.profileId, revision: 1, envelopeRevision: 1,
      checkId: f.successful.id, nativeProfileId: `storage-profile:aws-s3:${digest}`, configurationRevision: 1, runtimeAccess: "read_only", createdBy: actor });
    expect(f.sql.prepare("SELECT * FROM storage_profiles WHERE id=?").get(result.nativeProfileId)).toEqual({ id: result.nativeProfileId,
      adapter_type: "s3", namespace_identity: identity, configuration_source: "system", credential_reference: null,
      configuration_revision: 1, state: "historical", created_at: result.createdAt });
    expect(f.sql.prepare("SELECT * FROM storage_profile_runtime WHERE storage_profile_id=?").get(result.nativeProfileId))
      .toEqual({ storage_profile_id: result.nativeProfileId, state: "read_only", registered_at: result.createdAt, activated_at: null, retired_at: null });
    const receipt = f.sql.prepare("SELECT * FROM storage_profile_admissions").get()!;
    expect(receipt.namespace_sha256).toBe(digest);
    expect(receipt.configuration_sha256).toBe(createHash("sha256").update(JSON.stringify(namespace)).digest("hex"));
    expect(receipt.namespace_sha256).not.toBe(f.sql.prepare("SELECT namespace_sha256 FROM system_storage_profiles").get()!.namespace_sha256);
    for (const secret of ["private-access", "private-secret", "ciphertext", "nonce", "credential_ref", namespace.endpoint]) expect(JSON.stringify(receipt)).not.toContain(secret);
    expect(f.state().map(value => value[1])).toEqual([1, 1, 1, 0, 0]);
    expect(await findStorageProfileAdmission(f.env, f.query, actor)).toEqual(result);
    expect(f.provider).not.toHaveBeenCalled(); expect(f.globalFetch).not.toHaveBeenCalled();
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("replays after candidate edits and unavailable keys, and finds an old admission for the same current namespace", async () => {
    const f = await fixture(), first = await registerStorageProfile(f.env, f.command, actor), revised = await f.revise({ forcePathStyle: false });
    f.env.STORAGE_CREDENTIAL_KEYRING = undefined;
    expect(await registerStorageProfile(f.env, f.command, actor)).toEqual(first);
    expect(await readStorageProfileAdmission(f.env, f.command.operationId, actor)).toEqual(first);
    expect(await findStorageProfileAdmission(f.env, { ...f.query, expectedRevision: revised.revision }, actor)).toEqual(first);
    await expect(findStorageProfileAdmission(f.env, f.query, actor)).rejects.toMatchObject({ status: 409 });
    await expect(registerStorageProfile(f.env, { ...f.command, checkId: crypto.randomUUID() }, actor)).rejects.toMatchObject({ status: 409 });
    expect(f.count("storage_profile_admissions")).toBe(1);
  });

  it("reads durable receipts using portable tables only", async () => {
    const f = await fixture(), first = await registerStorageProfile(f.env, f.command, actor);
    const prepare = vi.fn((sql: string) => { if (sql.includes("system_storage_")) throw new Error("Installation tables are absent after recovery"); return f.db.prepare(sql); });
    const env = { ...f.env, STORAGE_CREDENTIAL_KEYRING: undefined, DB: { prepare } as unknown as D1Database };
    expect(await readStorageProfileAdmission(env, f.command.operationId, actor)).toEqual(first);
    expect(await registerStorageProfile(env, f.command, actor)).toEqual(first);
  });

  it("finds the same physical registration through a separate global-endpoint candidate", async () => {
    const f = await fixture(), first = await registerStorageProfile(f.env, f.command, actor);
    const alias = await saveStorageCandidate(f.env, { ...candidate, namespace: { ...namespace, endpoint: "https://s3.amazonaws.com" } }, actor);
    expect(alias.profileId).not.toBe(first.profileId);
    expect(await findStorageProfileAdmission(f.env, { profileId: alias.profileId, expectedRevision: 1 }, actor)).toEqual(first);
  });

  it("rejects a changed source in the final primary lookup snapshot", async () => {
    const f = await fixture(); await registerStorageProfile(f.env, f.command, actor);
    const withSession = vi.fn(() => ({ prepare: (sql: string) => ({ bind: (...values: unknown[]) => {
      const statement = f.db.prepare(sql).bind(...values);
      return { first: async () => { if (sql.startsWith("WITH source")) await f.revise({ forcePathStyle: false }); return statement.first(); } };
    } }) }));
    await expect(findStorageProfileAdmission({ ...f.env, DB: { withSession } as unknown as D1Database }, f.query, actor)).rejects.toMatchObject({ status: 409 });
    expect(withSession.mock.calls).toEqual([["first-primary"], ["first-primary"]]);
  });

  it("deduplicates concurrent same-operation registration and reconciles a lost batch acknowledgement", async () => {
    const f = await fixture();
    const [first, second] = await Promise.all([registerStorageProfile(f.env, f.command, actor), registerStorageProfile(f.env, f.command, actor)]);
    expect(second).toEqual(first); expect(f.count("storage_profiles")).toBe(1); expect(f.count("storage_profile_admissions")).toBe(1);
    await expect(registerStorageProfile(f.env, { ...f.command, operationId: crypto.randomUUID() }, actor)).rejects.toMatchObject({ status: 409 });
    const other = await fixture({ root: "other" });
    const env = { ...other.env, DB: { prepare: other.db.prepare.bind(other.db), batch: async (statements: D1PreparedStatement[]) => {
      await other.db.batch(statements); throw new Error("private acknowledgement lost");
    } } as unknown as D1Database };
    const reconciled = await registerStorageProfile(env, other.command, actor);
    expect(await readStorageProfileAdmission(other.env, other.command.operationId, actor)).toEqual(reconciled);
  });

  it("returns conflict for another operation even when the native profile timestamp is identical", async () => {
    const f = await fixture(), now = new Date(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    const first = await registerStorageProfile(f.env, f.command, actor);
    await expect(registerStorageProfile(f.env, { ...f.command, operationId: crypto.randomUUID() }, actor)).rejects.toMatchObject({ status: 409 });
    expect(await readStorageProfileAdmission(f.env, f.command.operationId, actor)).toEqual(first);
    expect(f.count("storage_profiles")).toBe(1); expect(f.count("storage_profile_admissions")).toBe(1);
  });

  it("rolls back profile, runtime and registry side effects if receipt publication fails", async () => {
    const f = await fixture(), before = f.state(), claims = f.count("file_registry_rowid_claims");
    f.sql.exec("CREATE TRIGGER fixture_receipt_failure BEFORE INSERT ON storage_profile_admissions BEGIN SELECT RAISE(ABORT,'private receipt failure'); END;");
    await expect(registerStorageProfile(f.env, f.command, actor)).rejects.toMatchObject({ status: 503, message: "Storage profile registration is temporarily unavailable." });
    expect(f.state()).toEqual(before); expect(f.count("file_registry_rowid_claims")).toBe(claims);
  });

  it("requires the current authenticated wrapping key and a new exact check after re-enveloping", async () => {
    const f = await fixture(); f.env.STORAGE_CREDENTIAL_KEYRING = rotatedRing;
    await expect(registerStorageProfile(f.env, f.command, actor)).rejects.toMatchObject({ status: 409 });
    await f.rotate();
    await expect(registerStorageProfile(f.env, f.command, actor)).rejects.toMatchObject({ status: 409 });
    await expect(registerStorageProfile(f.env, { ...f.command, expectedEnvelopeRevision: 2 }, actor)).rejects.toMatchObject({ status: 409 });
    const current = await f.check();
    expect(await registerStorageProfile(f.env, { ...f.command, expectedEnvelopeRevision: 2, checkId: current.id }, actor)).toMatchObject({ envelopeRevision: 2, checkId: current.id });
  });

  it.each(["revision", "envelope", "cleanup"])("rejects a %s change between validation and atomic publication", async change => {
    const f = await fixture(), before = f.state();
    const env = { ...f.env, DB: { prepare: f.db.prepare.bind(f.db), batch: async (statements: D1PreparedStatement[]) => {
      if (change === "revision") await f.revise();
      else if (change === "envelope") { f.env.STORAGE_CREDENTIAL_KEYRING = rotatedRing; await f.rotate(); }
      else await f.check(f.saved, vi.fn(async () => new Response(null, { status: 403 })));
      return f.db.batch(statements);
    } } as unknown as D1Database };
    await expect(registerStorageProfile(env, f.command, actor)).rejects.toMatchObject({ status: 409 });
    expect(f.state()).toEqual(before);
  });

  it("blocks unresolved cleanup even when an earlier exact check succeeded", async () => {
    const f = await fixture();
    const failed = await f.check(f.saved, vi.fn(async () => new Response(null, { status: 403 })));
    expect(failed.cleanup).toBe("required");
    await expect(registerStorageProfile(f.env, f.command, actor)).rejects.toMatchObject({ status: 409 });
    expect(f.count("storage_profiles")).toBe(0);
  });

  it("blocks an in-progress check without reconciling or cancelling that provider operation", async () => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; }), accepted = new Promise<void>(resolve => { entered = resolve; });
    const pending = f.check(f.saved, vi.fn(async (request: Request) => {
      if (request.method === "PUT") { entered(); await paused; } return f.provider(request);
    }));
    await accepted;
    try {
      await expect(registerStorageProfile(f.env, f.command, actor)).rejects.toMatchObject({ status: 409 });
      expect(f.count("storage_profiles")).toBe(0);
      expect(f.sql.prepare("SELECT count(*) n FROM system_storage_candidate_checks WHERE status='running'").get()!.n).toBe(1);
    } finally { release(); await pending; }
  });

  it.each([
    { expectedBucketOwner: undefined },
    { endpoint: "https://s3.us-gov-west-1.amazonaws.com", region: "us-gov-west-1" },
  ])("rejects unqualified candidate namespaces without changing native content", async override => {
    const f = await fixture(override);
    await expect(registerStorageProfile(f.env, f.command, actor)).rejects.toMatchObject({ status: 400 });
    expect(f.count("storage_profiles")).toBe(0);
  });

  it("denies non-administrators before any database access and sanitizes missing or corrupt protected state", async () => {
    const f = await fixture(); f.db.resetQueryCount();
    for (const operation of [() => registerStorageProfile(f.env, f.command, "reader@example.test"),
      () => readStorageProfileAdmission(f.env, f.command.operationId, "reader@example.test"),
      () => findStorageProfileAdmission(f.env, f.query, "reader@example.test")]) await expect(operation()).rejects.toMatchObject({ status: 403 });
    expect(f.db.queryCount).toBe(0);
    for (const keyring of [undefined, "invalid"]) await expect(registerStorageProfile({ ...f.env, STORAGE_CREDENTIAL_KEYRING: keyring }, f.command, actor))
      .rejects.toMatchObject({ status: 503, message: "Storage profile registration is temporarily unavailable." });
    expect(f.count("storage_profiles")).toBe(0);
  });
});
