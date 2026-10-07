import { vi } from "vitest";
import { COMMENT_TEST_R2_NAMESPACE } from "../comment-acceptance-test-support";
import { enableFutureFileAuthority } from "../files/authority-runtime-test-support";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import { startStorageCandidateCheck } from "../storage/candidate-check-service";
import { saveStorageCandidate } from "../storage/configuration-registry";
import { activateNativeStorageProfile } from "../storage/native-profile-activation";
import { registerStorageProfile } from "../storage/storage-profile-admission-service";
import { setStorageRoleDefaults } from "../storage/storage-role-policy";
import type { Env } from "../types";

export const nativeAcceptanceActor = "comment-owner@example.test";
const actor = nativeAcceptanceActor;

/** Real FP2 migration, admission, binding and role policy services with isolated
 * provider bytes. Only the existing test File-authority cutover is simulated;
 * all native activation, receipt, publication and consumer guards stay intact. */
export async function nativeAcceptanceFixture(internalNative = true,
  options: { throughMigration?: string; databaseFactory?: typeof referenceTestDatabase } = {}) {
  const now = new Date().toISOString();
  const sql = (options.databaseFactory ?? referenceTestDatabase)({ throughMigration: options.throughMigration ?? "0018_fp2_native_file_runtime.sql" });
  try {
    sql.exec("PRAGMA foreign_keys=ON");
    sql.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'native-acceptance-test',? FROM file_shadow_control").run(now);
    {
      const db = sql;
      db.prepare("INSERT INTO storage_profiles VALUES('r2-profile','r2',?,'bootstrap',NULL,1,'historical',?)").run(COMMENT_TEST_R2_NAMESPACE, now);
      db.prepare("INSERT INTO file_shadow_profile_enablements VALUES('r2-profile',1,'native-comment-test',?)").run(now);
    }
    enableFutureFileAuthority(sql);
    sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('sample-native','NATIVE-COMMENT','Native Comment',?,?)").run(now, now);
    // Host equivalent used by existing accepted writer tests. Byte accounting
    // remains production code; separate workerd tests qualify FixedLengthStream.
    vi.stubGlobal("FixedLengthStream", class extends TransformStream<Uint8Array, Uint8Array> { constructor(_length: number) { super(); } });
    // Cloudflare's Request accepts stream bodies directly. Node's fetch host
    // requires duplex for those same bodies; adapt only the test constructor.
    const HostRequest = Request;
    vi.stubGlobal("Request", class extends HostRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, { ...init, ...(init?.body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);
      }
    });
    const objects = new Map<string, ArrayBuffer>(), r2Objects = new Map<string, ArrayBuffer>();
    const s3Fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request && !init ? input : new Request(input, init);
      if (request.method === "PUT") { objects.set(request.url, await request.arrayBuffer()); return new Response(null); }
      if (request.method === "DELETE") { objects.delete(request.url); return new Response(null, { status: 204 }); }
      const bytes = objects.get(request.url);
      return bytes ? new Response(request.method === "HEAD" ? null : bytes.slice(0), {
        headers: { "content-length": String(bytes.byteLength), "content-type": "application/octet-stream", etag: '"native-comment"' },
      }) : new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", s3Fetch);
    const r2Put = vi.fn(async (key: string, body: BodyInit) => { r2Objects.set(key, await new Response(body).arrayBuffer()); });
    const r2Get = vi.fn(async (key: string) => {
      const bytes = r2Objects.get(key);
      return bytes ? { body: new Response(bytes.slice(0)).body!, size: bytes.byteLength, httpEtag: '"r2-comment"',
        writeHttpMetadata(headers: Headers) { headers.set("content-type", "image/png"); } } : null;
    });
    const r2Delete = vi.fn(async (key: string) => { r2Objects.delete(key); });
    const db = new SqliteD1Database(sql);
    const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(47)));
    const env = { DB: db as unknown as D1Database, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: actor,
      R2_BOOTSTRAP_NAMESPACE: COMMENT_TEST_R2_NAMESPACE,
      STORAGE_CREDENTIAL_KEYRING: JSON.stringify({ version: 1, currentKeyId: "fixture", keys: { fixture: key } }),
      ASSETS: { put: r2Put, get: r2Get, head: r2Get, delete: r2Delete } as unknown as R2Bucket } as Env;
    const saved = await saveStorageCandidate(env, { expectedRevision: null, label: "Native Comment storage",
      namespace: { kind: "s3", endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", bucket: "native-comment-fixture",
        root: "research", forcePathStyle: true, expectedBucketOwner: "111122223333" },
      credentials: { mode: "replace", value: { accessKeyId: "fixture-comment-access", secretAccessKey: "fixture-comment-secret" } } }, actor);
    const check = await startStorageCandidateCheck(env, { checkId: crypto.randomUUID(), profileId: saved.profileId, expectedRevision: 1 }, actor, { fetch: s3Fetch });
    if (check.status !== "succeeded") throw new Error("Native acceptance fixture check did not succeed");
    const admission = await registerStorageProfile(env, { operationId: crypto.randomUUID(), profileId: saved.profileId, expectedRevision: 1,
      expectedEnvelopeRevision: 1, checkId: check.id }, actor);
    await activateNativeStorageProfile(env, { operationId: crypto.randomUUID(), nativeProfileId: admission.nativeProfileId,
      candidateProfileId: saved.profileId, expectedCandidateRevision: 1, expectedEnvelopeRevision: 1,
      checkId: check.id, expectedBindingRevision: null }, actor);
    await setStorageRoleDefaults(env, { operationId: crypto.randomUUID(), expectedPolicyRevision: null,
      internalProfileId: internalNative ? admission.nativeProfileId : "r2-profile", originalsProfileId: admission.nativeProfileId }, actor);
    s3Fetch.mockClear(); r2Put.mockClear(); r2Get.mockClear(); r2Delete.mockClear();
    return { sql, db, env, now, objects, r2Objects, s3Fetch, r2Put, r2Get, r2Delete, admission, saved, check, actor };
  } catch (error) { sql.close(); throw error; }
}
