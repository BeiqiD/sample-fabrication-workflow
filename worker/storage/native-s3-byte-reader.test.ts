import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { sqliteFixtureImage } from "../../test/sqlite-fixture-image";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { S3StorageNamespace } from "../../shared/contracts/storage-configuration";
import type { Sha256Factory } from "../files/byte-verification";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { startStorageCandidateCheck } from "./candidate-check-service";
import { saveStorageCandidate } from "./configuration-registry";
import { reenvelopeStoredStorageCredential } from "./credential-reenvelope-service";
import { nativeS3ByteReader } from "./native-s3-byte-reader";
import { registerStorageProfile } from "./storage-profile-admission-service";

const actor = "admin@example.test", material = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
const oldRing = JSON.stringify({ version: 1, currentKeyId: "old", keys: { old: material(11) } });
const newRing = JSON.stringify({ version: 1, currentKeyId: "new", keys: { old: material(11), new: material(22) } });
const newOnly = JSON.stringify({ version: 1, currentKeyId: "new", keys: { new: material(22) } });
const namespace: S3StorageNamespace = { kind: "s3", endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1",
  bucket: "native-reader-fixture", root: "research", forcePathStyle: true, expectedBucketOwner: "111122223333" };
const credentials = { accessKeyId: "fixture-old-access", secretAccessKey: "fixture-old-secret", sessionToken: "fixture-old-token" };
const hash: Sha256Factory = () => { const value = createHash("sha256"); return { async write(bytes) { value.update(bytes); },
  async finish() { return value.digest("hex"); }, async abort() {} }; };
const databases: ReturnType<typeof referenceTestDatabase>[] = [];
let fixtureDirectory = "", pristinePath = "", nextFixture = 0;
beforeAll(async () => {
  // Replay all current migrations, then preserve their complete native SQLite
  // image. Cases share no candidate, credential, binding, object or env writes.
  fixtureDirectory = mkdtempSync(join(tmpdir(), "native-s3-reader-pristine-"));
  pristinePath = join(fixtureDirectory, "pristine.sqlite");
  const database = referenceTestDatabase();
  try {
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const expected = sqliteFixtureImage(database);
    await backup(database, pristinePath);
    const cloned = new DatabaseSync(pristinePath, { readOnly: true });
    try {
      expect(sqliteFixtureImage(cloned)).toEqual(expected);
      expect(cloned.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { cloned.close(); }
  } finally { database.close(); }
});
afterAll(() => { if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true }); });
function pristineDatabase() {
  if (!fixtureDirectory || !pristinePath) throw new Error("The canonical native reader fixture is unavailable");
  const path = join(fixtureDirectory, `scenario-${nextFixture++}.sqlite`);
  copyFileSync(pristinePath, path);
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON");
  return database;
}
async function fixture() {
  const sql = pristineDatabase(); databases.push(sql);
  const db = new SqliteD1Database(sql), env = { DB: db as unknown as D1Database, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: actor,
    STORAGE_CREDENTIAL_KEYRING: oldRing } as Env;
  const candidate = { expectedRevision: null, label: "Reader fixture", namespace, credentials: { mode: "replace", value: credentials } };
  const saved = await saveStorageCandidate(env, candidate, actor), objects = new Map<string, ArrayBuffer>();
  const fetch = vi.fn(async (request: Request) => {
    if (request.method === "PUT") { objects.set(request.url, await request.arrayBuffer()); return new Response(null); }
    if (request.method === "DELETE") { objects.delete(request.url); return new Response(null, { status: 204 }); }
    const bytes = objects.get(request.url);
    return bytes ? new Response(request.method === "HEAD" ? null : bytes.slice(0),
      { headers: { "content-length": String(bytes.byteLength), "content-type": "application/x-fixture", etag: '"provider-etag"' } }) : new Response(null, { status: 404 });
  });
  const check = await startStorageCandidateCheck(env, { checkId: crypto.randomUUID(), profileId: saved.profileId, expectedRevision: 1 }, actor,
    { fetch, createHash: hash });
  expect(check.status).toBe("succeeded");
  const receipt = await registerStorageProfile(env, { operationId: crypto.randomUUID(), profileId: saved.profileId,
    expectedRevision: 1, expectedEnvelopeRevision: 1, checkId: check.id }, actor);
  const profile = { profileId: receipt.nativeProfileId, configurationRevision: 1 };
  const url = "https://s3.us-east-1.amazonaws.com/native-reader-fixture/research/files/known";
  objects.set(url, new TextEncoder().encode("known bytes").buffer); fetch.mockClear();
  const reader = nativeS3ByteReader(env, profile, { fetch });
  const rotate = () => reenvelopeStoredStorageCredential(env, { operationId: crypto.randomUUID(), profileId: saved.profileId,
    revision: 1, credentialRef: saved.credentials.ref, expectedEnvelopeRevision: 1 }, actor);
  const revise = () => saveStorageCandidate(env, { ...candidate, profileId: saved.profileId, expectedRevision: 1,
    namespace: { ...namespace, forcePathStyle: false, expectedBucketOwner: "999988887777" },
    credentials: { mode: "replace", value: { accessKeyId: "fixture-new-access", secretAccessKey: "fixture-new-secret" } } }, actor);
  return { sql, db, env, saved, receipt, profile, fetch, reader, rotate, revise, objects, url };
}
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(db => db.close()); });

describe("registered native S3 read transport", () => {
  it("isolates candidate revisions, credential policy and provider objects across fresh copies", async () => {
    const f = await fixture(); await f.revise();
    f.env.STORAGE_CREDENTIAL_KEYRING = undefined;
    f.objects.clear();
    const g = await fixture();
    expect(g.env).not.toBe(f.env); expect(g.sql).not.toBe(f.sql);
    expect(g.sql.prepare("SELECT latest_revision FROM system_storage_profiles WHERE id=?").get(g.saved.profileId)).toEqual({ latest_revision: 1 });
    expect(f.sql.prepare("SELECT latest_revision FROM system_storage_profiles WHERE id=?").get(f.saved.profileId)).toEqual({ latest_revision: 2 });
    expect(g.env.STORAGE_CREDENTIAL_KEYRING).toBe(oldRing);
    expect(await g.reader.stat("files/known")).toMatchObject({ outcome: "available", byteSize: 11 });
    expect(g.sql.prepare("SELECT state FROM storage_profile_runtime WHERE storage_profile_id=?").get(g.profile.profileId)).toEqual({ state: "read_only" });
    expect(g.sql.prepare("SELECT count(*) n FROM file_locations").get()).toEqual({ n: 0 });
    expect(g.sql.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(g.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("constructs without I/O, exposes only read/stat and sends owner-qualified signed requests without changing metadata", async () => {
    const f = await fixture(); f.db.resetQueryCount();
    const before = f.sql.prepare("SELECT total_changes() n").get();
    const reader = nativeS3ByteReader(f.env, f.profile, { fetch: f.fetch });
    expect(Object.keys(reader).sort()).toEqual(["read", "stat"]); expect(f.db.queryCount).toBe(0); expect(f.fetch).not.toHaveBeenCalled();
    const read = await reader.read("files/known"); expect(read).toMatchObject({ outcome: "available", contentType: "application/x-fixture", etag: '"provider-etag"' });
    if (read.outcome !== "available") throw new Error("Expected stream");
    expect(await new Response(read.body).text()).toBe("known bytes");
    expect(await reader.stat("files/known")).toMatchObject({ outcome: "available", byteSize: 11 });
    expect(f.fetch.mock.calls.map(([request]) => request.method)).toEqual(["GET", "HEAD"]);
    for (const [request] of f.fetch.mock.calls) {
      expect(request.url).toBe(f.url); expect(request.headers.get("x-amz-expected-bucket-owner")).toBe(namespace.expectedBucketOwner);
      expect(request.headers.get("authorization")).toContain(`Credential=${credentials.accessKeyId}/`);
      expect(request.headers.get("authorization")).toContain("x-amz-expected-bucket-owner");
      expect(request.headers.get("x-amz-security-token")).toBe(credentials.sessionToken);
    }
    expect(f.sql.prepare("SELECT total_changes() n").get()).toEqual(before);
    expect(f.sql.prepare("SELECT count(*) n FROM file_locations").get()).toEqual({ n: 0 });
  });

  it("retains the admitted revision, owner and credentials after a candidate edit, including edits during request preparation", async () => {
    const f = await fixture(); await f.revise();
    expect(await f.reader.stat("files/known")).toMatchObject({ outcome: "available" });
    const request = f.fetch.mock.calls[0][0];
    expect(request.url).toBe(f.url); expect(request.headers.get("x-amz-expected-bucket-owner")).toBe("111122223333");
    expect(request.headers.get("authorization")).toContain("fixture-old-access");
    expect(request.headers.get("authorization")).not.toContain("fixture-new-access");
    const g = await fixture();
    const withSession = vi.fn(() => ({ prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: async () => {
      if (sql.startsWith("SELECT 1 AS bound")) await g.revise();
      return g.db.prepare(sql).bind(...values).first();
    } }) }) }));
    expect(await nativeS3ByteReader({ ...g.env, DB: { withSession } as unknown as D1Database }, g.profile, { fetch: g.fetch }).stat("files/known"))
      .toMatchObject({ outcome: "available" });
    expect(withSession.mock.calls).toEqual([["first-primary"], ["first-primary"]]);
    expect(g.fetch.mock.calls[0][0].headers.get("x-amz-expected-bucket-owner")).toBe("111122223333");
  });

  it("authenticates historical re-enveloping per call and fails closed when retained key material is unavailable", async () => {
    const f = await fixture(); await f.revise();
    f.env.STORAGE_CREDENTIAL_KEYRING = newOnly;
    expect(await f.reader.stat("files/known")).toEqual({ outcome: "unavailable" }); expect(f.fetch).not.toHaveBeenCalled();
    f.env.STORAGE_CREDENTIAL_KEYRING = newRing; await f.rotate(); f.env.STORAGE_CREDENTIAL_KEYRING = newOnly;
    expect(await f.reader.stat("files/known")).toMatchObject({ outcome: "available" });
    expect(f.fetch.mock.calls[0][0].headers.get("authorization")).toContain("fixture-old-access");
  });

  it("rejects a wrapping race immediately before send without retrying; the next call uses the authenticated replacement", async () => {
    const f = await fixture(); f.env.STORAGE_CREDENTIAL_KEYRING = newRing;
    let rotated = false;
    const withSession = vi.fn((_constraint: string) => ({ prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: async () => {
      if (sql.startsWith("SELECT 1 AS bound") && !rotated) { rotated = true; await f.rotate(); }
      return f.db.prepare(sql).bind(...values).first();
    } }) }) }));
    const reader = nativeS3ByteReader({ ...f.env, DB: { withSession } as unknown as D1Database }, f.profile, { fetch: f.fetch });
    expect(await reader.read("files/known")).toEqual({ outcome: "unavailable" }); expect(f.fetch).not.toHaveBeenCalled();
    expect(await reader.stat("files/known")).toMatchObject({ outcome: "available" }); expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(withSession.mock.calls.every(([constraint]) => constraint === "first-primary")).toBe(true);
  });

  it("rejects deployment keyring changes during signing without sending or retaining the old credential", async () => {
    const f = await fixture();
    const reader = nativeS3ByteReader(f.env, f.profile, { fetch: f.fetch, now: () => {
      f.env.STORAGE_CREDENTIAL_KEYRING = undefined; return new Date();
    } });
    expect(await reader.stat("files/known")).toEqual({ outcome: "unavailable" }); expect(f.fetch).not.toHaveBeenCalled();
    expect(await reader.stat("files/known")).toEqual({ outcome: "unavailable" });
  });

  it("applies caller lifecycle checks without granting native write access or changing recorded targets", async () => {
    const f = await fixture();
    let permitted = false;
    const beforeRequest = vi.fn(async () => permitted);
    const before = f.sql.prepare("SELECT total_changes() n").get();
    const reader = nativeS3ByteReader(f.env, f.profile, { fetch: f.fetch, beforeRequest });
    expect(Object.keys(reader).sort()).toEqual(["read", "stat"]);
    expect(await reader.read("files/known")).toEqual({ outcome: "unavailable" });
    expect(f.fetch).not.toHaveBeenCalled();
    permitted = true;
    expect(await reader.stat("files/known")).toMatchObject({ outcome: "available", byteSize: 11 });
    expect(beforeRequest.mock.calls).toEqual([[{ method: "GET", key: "files/known" }], [{ method: "HEAD", key: "files/known" }]]);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0][0].url).toBe(f.url);
    expect(f.sql.prepare("SELECT total_changes() n").get()).toEqual(before);
    expect(f.sql.prepare("SELECT state FROM storage_profile_runtime WHERE storage_profile_id=?").get(f.profile.profileId))
      .toEqual({ state: "read_only" });
    expect(f.sql.prepare("SELECT count(*) n FROM file_locations").get()).toEqual({ n: 0 });
    expect(f.sql.prepare("SELECT count(*) n FROM storage_role_defaults").get()).toEqual({ n: 0 });
  });

  it("rechecks the admitted binding after an asynchronous caller lifecycle check rotates its envelope", async () => {
    const f = await fixture(); f.env.STORAGE_CREDENTIAL_KEYRING = newRing;
    let rotated = false;
    const beforeRequest = vi.fn(async () => {
      if (!rotated) { rotated = true; await f.rotate(); }
      return true;
    });
    const reader = nativeS3ByteReader(f.env, f.profile, { fetch: f.fetch, beforeRequest });
    expect(await reader.stat("files/known")).toEqual({ outcome: "unavailable" });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    // A later explicit call authenticates the replacement; the rejected call
    // does not retry or bypass the final primary-D1 binding check.
    expect(await reader.stat("files/known")).toMatchObject({ outcome: "available", byteSize: 11 });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(beforeRequest).toHaveBeenCalledTimes(2);
  });

  it("does not substitute another candidate after recovery or a missing admitted payload", async () => {
    const f = await fixture();
    await saveStorageCandidate(f.env, { expectedRevision: null, label: "Same native namespace, separate installation candidate",
      namespace: { ...namespace, endpoint: "https://s3.amazonaws.com" }, credentials: { mode: "replace", value: credentials } }, actor);
    // Simulate an incomplete installation restore in this disposable database;
    // ordinary configuration APIs cannot remove protected payloads.
    f.sql.exec("DROP TRIGGER system_storage_credential_payloads_delete_guard");
    f.sql.prepare("DELETE FROM system_storage_credential_payloads WHERE credential_ref=?").run(f.saved.credentials.ref);
    expect(await f.reader.stat("files/known")).toEqual({ outcome: "unavailable" }); expect(f.fetch).not.toHaveBeenCalled();
    const prepared = vi.fn(() => { throw new Error("Private restored installation state absent"); });
    const restored = nativeS3ByteReader({ ...f.env, DB: { prepare: prepared } as unknown as D1Database }, f.profile, { fetch: f.fetch });
    expect(await restored.read("files/known")).toEqual({ outcome: "unavailable" }); expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { namespace_identity: '{"kind":"aws-s3","partition":"aws","accountId":"999988887777","bucketName":"native-reader-fixture","root":"research"}' },
    { configuration_sha256: "0".repeat(64) }, { candidate_namespace_sha256: "0".repeat(64) },
    { descriptor_namespace_sha256: "0".repeat(64) }, { credential_ref: "credential:swapped" },
    { ciphertext: "tampered" }, { runtime_state: "read_write" }, { activated_at: "2026-01-01T00:00:00.000Z" },
    { envelope_revision: 0 }, { admission_envelope_revision: 2 }, { configuration_source: "bootstrap" },
  ])("rejects inconsistent protected/native source %j before provider I/O", async change => {
    const f = await fixture();
    const env = { ...f.env, DB: { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: async () => {
      const row = await f.db.prepare(sql).bind(...values).first(); return row ? { ...row, ...change } : row;
    } }) }) } as unknown as D1Database };
    expect(await nativeS3ByteReader(env, f.profile, { fetch: f.fetch }).stat("files/known")).toEqual({ outcome: "unavailable" });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("returns safe provider outcomes, makes one request per call and transfers stream cancellation to the caller", async () => {
    const f = await fixture();
    for (const status of [403, 404, 500, 301]) {
      const fetch = vi.fn(async () => new Response(null, { status }));
      const reader = nativeS3ByteReader(f.env, f.profile, { fetch });
      expect(await reader.stat("files/known")).toEqual(status === 403 ? { outcome: "denied", status: 403 } : status === 404 ? { outcome: "missing" } : { outcome: "unavailable" });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const fetch = vi.fn(async () => { throw new Error("private provider credential endpoint message"); });
    expect(await nativeS3ByteReader(f.env, f.profile, { fetch }).read("files/known")).toEqual({ outcome: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const cancel = vi.fn(), read = await nativeS3ByteReader(f.env, f.profile, { fetch: async () => new Response(new ReadableStream({ cancel })) }).read("files/known");
    if (read.outcome !== "available") throw new Error("Expected stream");
    await read.body.cancel(); expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid profiles at construction and unsupported object keys without provider access", async () => {
    const f = await fixture();
    for (const profile of [{ ...f.profile, configurationRevision: 2 }, { ...f.profile, profileId: f.saved.profileId }])
      expect(() => nativeS3ByteReader(f.env, profile, { fetch: f.fetch })).toThrow("S3 storage is unavailable.");
    for (const key of ["", "files/../other", "files/\0", "files/\ud800"]) expect(await f.reader.read(key)).toEqual({ outcome: "unavailable" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
