import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../shared/content-addressing";
import type { CommentAcceptanceState } from "../../shared/contracts/comment-acceptance";
import { acceptCommentUpload, uploadAcceptedCommentItem } from "../comment-acceptance-test-support";
import worker from "../index";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { getCommentAcceptanceState } from "../uploads/comment-acceptance";

const databases: ReturnType<typeof referenceTestDatabase>[] = [];
const bytes = new TextEncoder().encode("original Comment image bytes");
const fileKey = "published/comment-image";
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
afterEach(() => databases.splice(0).forEach((db) => db.close()));

async function fixture() {
  // Model future activation on the typed substrate; current production shadow
  // migrations deliberately prohibit this transition and typed bindings.
  const sql = referenceTestDatabase({ throughMigration: "0007_fp1_file_authority_transition.sql" });
  databases.push(sql);
  const objects = new Map<string, Uint8Array>();
  function object(key: string) {
    const value = objects.get(key);
    return value ? {
      body: new Response(value.slice()).body!, size: value.byteLength, httpEtag: '"comment-image"',
      writeHttpMetadata(headers: Headers) { headers.set("content-type", "image/png"); },
    } : null;
  }
  const put = vi.fn(async (key: string, body: BodyInit) => {
    objects.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
  });
  const get = vi.fn(async (key: string) => object(key));
  const env = {
    AUTH_MODE: "disabled", DB: new SqliteD1Database(sql) as unknown as D1Database,
    ASSETS: { get, put, head: vi.fn(async (key: string) => object(key)), delete: vi.fn(async (key: string) => objects.delete(key)) } as unknown as R2Bucket,
  } as Env;
  const now = new Date().toISOString();
  sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('sample-upload','IMAGE','Comment image',?,?)").run(now, now);
  await acceptCommentUpload(sql, env, { kind: "comment_image", bytes });
  await uploadAcceptedCommentItem(env, "submission-upload", "item-upload", "comment_image", bytes);
  const finalized = await worker.fetch(new Request("https://app.test/api/comment-submissions/submission-upload/finalize", { method: "POST" }), env, context);
  const body = await finalized.json() as { request: CommentAcceptanceState };
  expect(finalized.status).toBe(200); expect(body.request.status).toBe("ready");
  expect(put).toHaveBeenCalledTimes(1);
  const accepted = sql.prepare("SELECT actor_email,storage_profile_id,accepted_result_json FROM comment_item_acceptances WHERE item_id='item-upload'")
    .get() as { actor_email: string; storage_profile_id: string; accepted_result_json: string };
  const legacy = JSON.parse(accepted.accepted_result_json) as { objectKey: string; blobRecordId: string };
  const sha = await sha256Hex(bytes.slice().buffer);
  sql.exec("DROP TRIGGER file_authority_control_update_guard");
  sql.prepare("UPDATE file_authority_control SET mode='active',updated_at=?,activated_at=?").run(now, now);
  sql.prepare("INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at) VALUES('image-file','embedded_content','system',?,?,'unresolved',?)")
    .run(bytes.length, sha, now);
  sql.prepare("INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at) VALUES('image-location','image-file',?,?,'unresolved',?)")
    .run(accepted.storage_profile_id, fileKey, now);
  sql.prepare(`INSERT INTO file_location_publications(location_id,file_id,storage_profile_id,object_key,verified_byte_size,verified_sha256,verification_method,verification_operation_id,verified_at,published_at)
    VALUES('image-location','image-file',?,?,?,?,'full_read_sha256','image-verification',?,?)`)
    .run(accepted.storage_profile_id, fileKey, bytes.length, sha, now, now);
  sql.prepare("INSERT INTO file_publications(file_id,purpose,access_scope,verified_byte_size,verified_sha256,active_location_id,state,published_at) VALUES('image-file','embedded_content','system',?,?,'image-location','ready',?)")
    .run(bytes.length, sha, now);
  sql.exec("UPDATE comment_submission_items SET file_id='image-file' WHERE id='item-upload'");
  objects.set(fileKey, bytes.slice());
  objects.delete(legacy.objectKey);
  get.mockClear(); put.mockClear();
  const replay = () => getCommentAcceptanceState(env, accepted.actor_email, "submission-upload");
  return { sql, get, put, replay, legacy, accepted, now, sha, result: body.request.result };
}

describe("active Comment receipt replay", () => {
  it("verifies the published File bytes without another PUT or dependence on the old object", async () => {
    const f = await fixture();
    expect(await f.replay()).toMatchObject({ status: "ready", items: [{ id: "item-upload", status: "ready" }], result: f.result });
    expect(f.get).toHaveBeenCalledExactlyOnceWith(fileKey); expect(f.put).not.toHaveBeenCalled();

    // The final availability snapshot must also use the File, rather than
    // invalidating a successful replay because its preserved old receipt key
    // has since entered the legacy lifecycle quarantine.
    f.sql.prepare(`INSERT INTO blob_integrity_quarantine(store_kind,provider,object_key,blob_record_id,reason,expected_byte_size,observed_byte_size,operation_id,detected_at,last_checked_at)
      VALUES('r2','r2',?,?,'size_mismatch',?,?,'old-object-quarantine',?,?)`)
      .run(f.legacy.objectKey, f.legacy.blobRecordId, bytes.length, bytes.length + 1, f.now, f.now);
    expect(await f.replay()).toMatchObject({ status: "ready", items: [{ status: "ready" }], result: f.result });
    expect(f.get.mock.calls).toEqual([[fileKey], [fileKey]]); expect(f.put).not.toHaveBeenCalled();
    expect(f.sql.prepare("SELECT accepted_result_json FROM comment_item_acceptances WHERE item_id='item-upload'").get())
      .toEqual({ accepted_result_json: f.accepted.accepted_result_json });
  });

  it("reports an unavailable typed publication without reading or reuploading the legacy object", async () => {
    const f = await fixture();
    f.sql.prepare(`INSERT INTO file_location_integrity_quarantine(location_id,reason,expected_byte_size,expected_sha256,operation_id,detected_at,last_checked_at)
      VALUES('image-location','missing',?,?,'file-quarantine',?,?)`).run(bytes.length, f.sha, f.now, f.now);
    const state = await f.replay();
    expect(state).toMatchObject({ status: "unavailable", items: [{ id: "item-upload", status: "unavailable" }] });
    expect(state.result).toBeUndefined();
    expect(f.get).not.toHaveBeenCalled(); expect(f.put).not.toHaveBeenCalled();
  });
});
