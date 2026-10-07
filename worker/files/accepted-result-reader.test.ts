import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { acceptAndUploadR2Asset, type AcceptedR2UploadRow } from "../uploads/r2-upload-acceptance";
import { acceptAndUploadMetrologyReference, type AcceptedMetrologyReferenceUploadRow } from "../uploads/metrology-reference-acceptance";
import { FILE_READ_HOLD_MS } from "./authority-reader";

const namespace = JSON.stringify({ kind: "local-r2", installationId: "4e5c6dd7-325b-4eae-8499-518eaa0fcb40", bucketName: "accepted-files" });
const bytes = new TextEncoder().encode("accepted result bytes");
const opened: DatabaseSync[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); });

function immutableRows(sql: DatabaseSync) {
  const tables = sql.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'file_location_holds' ORDER BY name")
    .all() as Array<{ name: string }>;
  return Object.fromEntries(tables.map(({ name }) => [name, sql.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));
}

async function fixture(kind: "r2_upload" | "metrology_reference", candidate = false) {
  // Model the existing future-active substrate, as authority-reader tests do.
  // Current deployment migrations deliberately continue to prohibit activation.
  const sql = referenceTestDatabase({ throughMigration: "0007_fp1_file_authority_transition.sql" });
  opened.push(sql);
  const now = new Date().toISOString();
  sql.exec("DROP TRIGGER file_authority_control_update_guard");
  sql.prepare("UPDATE file_authority_control SET mode='overlap',updated_at=?,activated_at=?").run(now, now);
  sql.prepare("INSERT INTO recipe_families(id,name,template_type,created_at) VALUES('family','Family','module',?)").run(now);
  sql.prepare(`INSERT INTO template_versions(id,recipe_family_id,name,template_type,version,manifest_hash,content_json,created_at,template_kind)
    VALUES('template','family','Metrology','module',1,'manifest','{}',?,'metrology')`).run(now);
  const table = kind === "r2_upload" ? "r2_upload_requests" : "metrology_reference_upload_requests";
  const stored = new Map<string, Uint8Array>();
  const get = vi.fn(async (key: string) => {
    const value = stored.get(key);
    return value ? { body: new Blob([value]).stream(), size: value.length, httpEtag: '"accepted"', writeHttpMetadata() {} } : null;
  });
  const put = vi.fn(async (key: string, value: ArrayBuffer) => {
    stored.set(key, new Uint8Array(value));
    if (candidate) {
      const r = sql.prepare(`SELECT * FROM ${table}`).get()!;
      const expected = JSON.parse(String(r.request_input_json)).file;
      sql.prepare("INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at) VALUES('candidate-file',?,'system',?,?,'unresolved',?)")
        .run(r.purpose, expected.byteSize, expected.sha256, now);
      sql.prepare("INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at) VALUES('candidate-location','candidate-file',?,?,'unresolved',?)")
        .run(r.storage_profile_id, key, now);
      sql.prepare(`INSERT INTO file_acceptance_candidates(acceptance_kind,acceptance_id,item_id,purpose,access_scope,storage_profile_id,
        expected_byte_size,expected_sha256,candidate_file_id,candidate_location_id,candidate_object_key,state,created_at)
        VALUES(?,?,'',?,'system',?,?,?,'candidate-file','candidate-location',?,'candidate',?)`)
        .run(kind, r.id, r.purpose, r.storage_profile_id, expected.byteSize, expected.sha256, key, now);
    }
  });
  const env = { DB: new SqliteD1Database(sql) as unknown as D1Database, R2_BOOTSTRAP_NAMESPACE: namespace,
    ASSETS: { get, head: get, put } as unknown as R2Bucket } satisfies Env;
  const upload = { requestId: crypto.randomUUID(), actorEmail: "owner@example.test", originalName: "accepted.png", mimeType: "image/png", bytes: bytes.buffer };
  const replay = () => kind === "r2_upload"
    ? acceptAndUploadR2Asset(env, { ...upload, ingress: "ordinary_image" })
    : acceptAndUploadMetrologyReference(env, { ...upload, templateId: "template" });
  const first = await replay();
  expect(first.state.status).toBe("ready");
  const row = sql.prepare(`SELECT * FROM ${table}`).get() as unknown as AcceptedR2UploadRow | AcceptedMetrologyReferenceUploadRow;
  const expected = JSON.parse(row.request_input_json).file;
  const result = JSON.parse(row.accepted_result_json!);
  const legacyKey = kind === "r2_upload" ? result.key : result.reference.assetKey;
  function publishLocation(id: string, fileId: string, key: string) {
    sql.prepare(`INSERT INTO file_location_publications(location_id,file_id,storage_profile_id,object_key,verified_byte_size,verified_sha256,
      verification_method,verification_operation_id,verified_at,published_at) VALUES(?,?,?,?,?,?,'full_read_sha256',?,?,?)`)
      .run(id, fileId, row.storage_profile_id, key, expected.byteSize, expected.sha256, `verify-${id}`, now, now);
  }
  function bindPublishedResult() {
    sql.prepare("INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at) VALUES('result-file',?,'system',?,?,'unresolved',?)")
      .run(row.purpose, expected.byteSize, expected.sha256, now);
    sql.prepare("INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at) VALUES('result-location','result-file',?,'published/result','unresolved',?)")
      .run(row.storage_profile_id, now);
    publishLocation("result-location", "result-file", "published/result");
    sql.prepare(`INSERT INTO file_publications(file_id,purpose,access_scope,verified_byte_size,verified_sha256,active_location_id,state,published_at)
      VALUES('result-file',?,'system',?,?,'result-location','ready',?)`).run(row.purpose, expected.byteSize, expected.sha256, now);
    if (candidate) {
      publishLocation("candidate-location", "candidate-file", legacyKey);
      sql.prepare("UPDATE file_acceptance_candidates SET state='ready',result_file_id='result-file',result_location_id='result-location',completed_at=?").run(now);
    }
    if (kind === "metrology_reference") sql.prepare("UPDATE metrology_template_references SET file_id='result-file' WHERE id=?").run(result.reference.id);
    else if (!candidate) {
      sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('sample','S','Sample',?,?)").run(now, now);
      sql.prepare(`INSERT INTO events(id,sample_id,kind,asset_key,asset_file_id,metadata_json,created_at)
        VALUES('event','sample','image',?,'result-file','{"action":"sample_record"}',?)`).run(legacyKey, now);
    }
    stored.set("published/result", bytes);
  }
  return { sql, table, row, replay, first, stored, get, put, legacyKey, bindPublishedResult };
}

it.each([
  { kind: "r2_upload" as const, candidate: true },
  { kind: "r2_upload" as const, candidate: false },
  { kind: "metrology_reference" as const, candidate: false },
])("replays $kind (candidate=$candidate) from the bound File without changing its receipt or writing", async ({ kind, candidate }) => {
  const f = await fixture(kind, candidate);
  f.bindPublishedResult();
  f.sql.exec("UPDATE file_authority_control SET mode='active'");
  f.stored.delete(f.legacyKey); f.get.mockClear(); f.put.mockClear();
  const changes = f.sql.prepare("SELECT total_changes() n").get()!.n;
  const immutable = immutableRows(f.sql);
  const previousHolds = f.sql.prepare("SELECT * FROM file_location_holds ORDER BY id").all();
  const result = await f.replay();
  expect(result).toEqual({ state: f.first.state, fresh: false });
  expect(f.get).toHaveBeenCalledExactlyOnceWith("published/result");
  expect(f.put).not.toHaveBeenCalled();
  expect(f.sql.prepare(`SELECT * FROM ${f.table}`).get()).toEqual(f.row);
  expect(immutableRows(f.sql)).toEqual(immutable);
  const holds = f.sql.prepare("SELECT * FROM file_location_holds ORDER BY id").all();
  const previousIds = new Set(previousHolds.map(hold => hold.id));
  expect(holds.filter(hold => previousIds.has(hold.id))).toEqual(previousHolds);
  const added = holds.filter(hold => !previousIds.has(hold.id));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ location_id: "result-location", hold_kind: "read", operation_id: added[0].id,
    reason: "Published File read", released_at: expect.any(String) });
  expect(Date.parse(String(added[0].expires_at)) - Date.parse(String(added[0].acquired_at))).toBe(FILE_READ_HOLD_MS);
  expect(Date.parse(String(added[0].released_at))).toBeGreaterThanOrEqual(Date.parse(String(added[0].acquired_at)));
  // The only writes are this exact bounded hold's acquisition and EOF release.
  // Receipts, publications, candidates and every other table remain untouched.
  expect(Number(f.sql.prepare("SELECT total_changes() n").get()!.n) - Number(changes)).toBe(2);
});

it.each(["r2_upload", "metrology_reference"] as const)("preserves overlap %s replay and refuses absent active results without legacy fallback", async kind => {
  const f = await fixture(kind);
  f.get.mockClear(); f.put.mockClear();
  expect((await f.replay()).state).toEqual(f.first.state);
  expect(f.get).toHaveBeenCalledExactlyOnceWith(f.legacyKey);
  f.sql.exec("UPDATE file_authority_control SET mode='active'"); f.get.mockClear();
  expect((await f.replay()).state.status).toBe("unavailable");
  expect(f.get).not.toHaveBeenCalled(); expect(f.put).not.toHaveBeenCalled();
});
