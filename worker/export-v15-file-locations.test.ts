import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const bytes = new TextEncoder().encode("qualified export 文件");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const namespace = JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "qualified-export" });
const otherNamespace = JSON.stringify({ kind: "cloudflare-r2", accountId: "b".repeat(32), bucketName: "qualified-export" });
const databases: DatabaseSync[] = [];
const executionContext = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

function fixture() {
  const sql = referenceTestDatabase(); databases.push(sql);
  const now = new Date().toISOString();
  for (const [id, physical] of [["profile-one", namespace], ["profile-two", otherNamespace]]) {
    sql.prepare("INSERT INTO storage_profiles VALUES(?,'r2',?,'bootstrap',NULL,1,'historical',?)").run(id, physical, now);
  }
  sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('sample','EXPORT','Export source',?,?)").run(now, now);
  sql.prepare(`INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at)
    VALUES('source-asset','legacy/source-key','source.bin','application/octet-stream',?,'ready',?,?)`).run(bytes.length, sha256, now);
  for (const id of ["one", "two"]) sql.prepare(`INSERT INTO events(id,sample_id,kind,asset_key,metadata_json,created_at)
    VALUES(?,'sample','image','legacy/source-key','{"action":"sample_record"}',?)`).run(`event-${id}`, now);
  sql.prepare(`INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at)
    VALUES('source-file','embedded_content','system',?,?,'unresolved',?)`).run(bytes.length, sha256, now);
  sql.prepare(`INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at)
    VALUES('source-location','source-file','profile-one','legacy/source-key','unresolved',?)`).run(now);
  sql.prepare(`INSERT INTO legacy_file_mappings(store_kind,provider,object_key,file_id,location_id,classification,evidence_json,observed_at)
    VALUES('r2','r2','legacy/source-key','source-file','source-location','classified','{}',?)`).run(now);
  sql.prepare(`INSERT INTO file_shadow_enablements(singleton,expected_epoch,enabled_by,enabled_at)
    SELECT 1,epoch,'fixture',? FROM file_shadow_control`).run(now);
  for (const profile of ["profile-one", "profile-two"]) sql.prepare(`INSERT INTO file_shadow_profile_enablements
    (storage_profile_id,configuration_revision,enabled_by,enabled_at) VALUES(?,1,'fixture',?)`).run(profile, now);
  const incarnation = crypto.randomUUID(), lease = new Date(Date.parse(now) + 15 * 60 * 1000).toISOString();
  sql.prepare("UPDATE file_shadow_runtime_guard SET enabled=1,incarnation=?,enabled_by='fixture',updated_at=?").run(incarnation, now);
  for (const [id, profile, published] of [["one", "profile-one", true], ["two", "profile-two", true], ["unverified", "profile-one", false]] as const) {
    const objectKey = id === "unverified" ? "candidate/no-proof" : "same/opaque/%2F/key";
    sql.prepare(`INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at)
      VALUES(?,'embedded_content','system',?,?,'unresolved',?)`).run(`file-${id}`, bytes.length, sha256, now);
    sql.prepare(`INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at)
      VALUES(?,?,?,?,'unresolved',?)`).run(`location-${id}`, `file-${id}`, profile, objectKey, now);
    if (published) {
      // Establish the actual immutable claim, source hold and verified attempt;
      // export fixtures must pass the same publication guards as the runtime.
      const operation = crypto.randomUUID(), attempt = crypto.randomUUID();
      sql.prepare(`INSERT INTO file_shadow_operations(id,occurrence_id,captured_epoch,baseline_sha256,purpose,access_scope,
        source_store_kind,source_provider,source_object_key,source_profile_id,source_profile_revision,
        source_expected_byte_size,source_expected_sha256,destination_profile_id,destination_profile_revision,status,created_by,created_at)
        SELECT ?,h.occurrence_id,c.epoch,?,'embedded_content','system','r2','r2','legacy/source-key','profile-one',1,?,?,?,1,'pending','fixture',?
        FROM file_shadow_heads h CROSS JOIN file_shadow_control c WHERE h.consumer_kind='event' AND h.consumer_id=? AND h.file_slot='primary'`)
        .run(operation, sha256, bytes.length, sha256, profile, now, `event-${id}`);
      sql.prepare(`INSERT INTO file_shadow_attempts(id,operation_id,attempt_number,owner_token,runtime_incarnation,state,lease_expires_at,created_at)
        VALUES(?,?,1,?,?,'staged',?,?)`).run(attempt, operation, crypto.randomUUID(), incarnation, lease, now);
      sql.prepare(`INSERT INTO file_shadow_legacy_holds(id,operation_id,store_kind,provider,object_key,storage_profile_id,profile_revision,acquired_at)
        VALUES(?,?,'r2','r2','legacy/source-key','profile-one',1,?)`).run(crypto.randomUUID(), operation, now);
      sql.prepare(`UPDATE file_shadow_attempts SET candidate_file_id=?,candidate_location_id=?,candidate_object_key=?,verified_byte_size=?,
        verified_sha256=?,source_verified_at=? WHERE id=?`).run(`file-${id}`, `location-${id}`, objectKey, bytes.length, sha256, now, attempt);
      sql.prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at)
        VALUES(?,?,'transition_destination',?,'Export qualification',?)`).run(crypto.randomUUID(), `location-${id}`, operation, now);
      sql.prepare("UPDATE file_shadow_attempts SET state='write_started',write_started_at=? WHERE id=?").run(now, attempt);
      sql.prepare("UPDATE file_shadow_attempts SET state='verified',verified_at=? WHERE id=?").run(now, attempt);
      sql.prepare(`INSERT INTO file_location_publications(location_id,file_id,storage_profile_id,object_key,verified_byte_size,verified_sha256,
        verification_method,verification_operation_id,verified_at,published_at) VALUES(?,?,?,?,?,?,'full_read_sha256',?,?,?)`)
        .run(`location-${id}`, `file-${id}`, profile, objectKey, bytes.length, sha256, operation, now, now);
      sql.prepare(`INSERT INTO file_publications(file_id,purpose,access_scope,verified_byte_size,verified_sha256,active_location_id,state,published_at)
        VALUES(?,'embedded_content','system',?,?,?,'ready',?)`).run(`file-${id}`, bytes.length, sha256, `location-${id}`, now);
      sql.prepare(`INSERT INTO file_shadow_decisions(occurrence_id,operation_id,decision,file_id,location_id,baseline_sha256,reason,decided_by,decided_at)
        SELECT occurrence_id,id,'resolved',?,?,baseline_sha256,NULL,'fixture',? FROM file_shadow_operations WHERE id=?`)
        .run(`file-${id}`, `location-${id}`, now, operation);
      sql.prepare("UPDATE file_shadow_attempts SET state='published',completed_at=? WHERE id=?").run(now, attempt);
      sql.prepare("UPDATE file_shadow_operations SET status='resolved',completed_at=? WHERE id=?").run(now, operation);
      sql.prepare("UPDATE file_shadow_legacy_holds SET released_at=? WHERE operation_id=?").run(now, operation);
      sql.prepare("UPDATE file_location_holds SET released_at=? WHERE operation_id=?").run(now, operation);
    }
  }
  const get = vi.fn(async (_key: string): Promise<unknown> => ({ body: new Response(bytes).body!, size: bytes.length,
    httpEtag: '"private-etag"', writeHttpMetadata(headers: Headers) {
      headers.set("content-type", "application/octet-stream");
      headers.set("cache-control", "public, max-age=86400");
      headers.set("set-cookie", "provider-private-cookie");
    } }));
  const head = vi.fn(), put = vi.fn(), remove = vi.fn();
  const providerFetch = vi.fn(async () => { throw new Error("Unexpected provider fallback"); });
  vi.stubGlobal("fetch", providerFetch);
  const local = new SqliteD1Database(sql);
  const env = { AUTH_MODE: "disabled", DB: local as unknown as D1Database,
    ASSETS: { get, head, put, delete: remove } as unknown as R2Bucket, R2_BOOTSTRAP_NAMESPACE: namespace } satisfies Env;
  function noProvider() { for (const fn of [get, head, put, remove, providerFetch]) expect(fn).not.toHaveBeenCalled(); }
  return { sql, local, env, get, head, put, remove, providerFetch, noProvider, now };
}
function request(env: Env, suffix = "location-one?profile=profile-one&revision=1") {
  return worker.fetch(new Request(`https://app.test/api/exports/file-locations/${suffix}`), env, executionContext);
}
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const sql of databases.splice(0)) sql.close();
});

describe("V15 profile-qualified export delivery through the root application", () => {
  it("streams the exact registered namespace/key and applies private response headers", async () => {
    const f = fixture();
    const response = await request(f.env);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(f.get).toHaveBeenCalledExactlyOnceWith("same/opaque/%2F/key");
    expect(f.head).not.toHaveBeenCalled(); expect(f.put).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });

  it("rejects a different profile or revision despite a published location at the same object key", async () => {
    const f = fixture();
    for (const suffix of ["location-one?profile=profile-two&revision=1", "location-one?profile=profile-one&revision=2",
      "location-two?profile=profile-one&revision=1", "location-missing?profile=profile-one&revision=1"]) {
      const response = await request(f.env, suffix);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Export File location is unavailable" });
    }
    f.noProvider();
  });

  it("rejects candidate bytes without a full-read location publication", async () => {
    const f = fixture();
    expect((await request(f.env, "location-unverified?profile=profile-one&revision=1")).status).toBe(404);
    f.noProvider();
  });

  it("requires the complete qualified identity and a canonical positive revision before SQL", async () => {
    const f = fixture(); f.local.resetQueryCount();
    for (const suffix of ["location-one", "location-one?profile=profile-one", "location-one?revision=1",
      "location-one?profile=profile-one&revision=0", "location-one?profile=profile-one&revision=01",
      "location-one?profile=profile-one&revision=1.0", "location-one?profile=profile-one&revision=9007199254740992"]) {
      expect((await request(f.env, suffix)).status).toBe(400);
    }
    expect(f.local.queryCount).toBe(0); f.noProvider();
  });

  it("cannot serve the recorded profile using the deployment binding of another physical namespace", async () => {
    const f = fixture();
    const response = await request({ ...f.env, R2_BOOTSTRAP_NAMESPACE: otherNamespace });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "The recorded File storage profile is unavailable" });
    expect((await request(f.env, "location-two?profile=profile-two&revision=1")).status).toBe(503);
    f.noProvider();
  });

  it("rejects quarantined location metadata before any provider read", async () => {
    const f = fixture();
    f.sql.prepare(`INSERT INTO file_location_integrity_quarantine(location_id,reason,expected_byte_size,expected_sha256,
      operation_id,detected_at,last_checked_at) VALUES('location-one','missing',?,?,'integrity-check',?,?)`)
      .run(bytes.length, sha256, f.now, f.now);
    expect((await request(f.env)).status).toBe(404); f.noProvider();
  });

  it("authenticates the qualified export before revealing registry metadata", async () => {
    const f = fixture(); f.local.resetQueryCount();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await request({ ...f.env, AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: "https://access.example", ACCESS_AUD: "audience" });
    expect(response.status).toBe(403); expect(f.local.queryCount).toBe(0); f.noProvider();
  });

  it("hides provider exceptions and reports missing bytes without fallback or writes", async () => {
    const f = fixture();
    f.get.mockRejectedValueOnce(new Error("private provider endpoint and token"));
    const unavailable = await request(f.env);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "The recorded File storage profile is unavailable" });
    f.get.mockResolvedValueOnce(null);
    const missing = await request(f.env);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Export File bytes are missing" });
    expect(f.get).toHaveBeenCalledTimes(2);
    expect(f.head).not.toHaveBeenCalled(); expect(f.put).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
    expect(f.providerFetch).not.toHaveBeenCalled();
  });
});
