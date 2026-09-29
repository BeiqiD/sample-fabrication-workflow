import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../shared/content-addressing";
import { acceptCommentSubmission, acceptCommentUpload, commentManagedFetch, COMMENT_TEST_R2_NAMESPACE } from "../comment-acceptance-test-support";
import { futureActiveRuntimeDatabase } from "../files/authority-runtime-test-support";
import { managedBootstrapNamespace } from "../files/managed-bootstrap-profile";
import { snapshotFullExportV18 } from "../export-v18-snapshot";
import worker from "../index";
import { SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";

const databases: ReturnType<typeof futureActiveRuntimeDatabase>[] = [];
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach(db => db.close()); });

function fixture() {
  const config = { AUTH_MODE: "disabled", R2_BOOTSTRAP_NAMESPACE: COMMENT_TEST_R2_NAMESPACE,
    MANAGED_STORAGE_PROVIDER: "switchdrive", SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/user%40example.ch",
    SWITCHDRIVE_USERNAME: "user@example.ch", SWITCHDRIVE_APP_PASSWORD: "test-password" };
  const now = new Date().toISOString();
  const sql = futureActiveRuntimeDatabase(db => {
    db.prepare("INSERT INTO storage_profiles VALUES('r2-profile','r2',?,'bootstrap',NULL,1,'historical',?)").run(COMMENT_TEST_R2_NAMESPACE, now);
    db.prepare("INSERT INTO storage_profiles VALUES('managed-profile','switchdrive',?,'environment','environment:SWITCHDRIVE',1,'historical',?)")
      .run(managedBootstrapNamespace(config), now);
    for (const id of ["r2-profile", "managed-profile"]) db.prepare("INSERT INTO file_shadow_profile_enablements VALUES(?,1,'test',?)").run(id, now);
  });
  databases.push(sql);
  sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('sample-upload','COMMENT','Comment uploads',?,?)").run(now, now);
  const objects = new Map<string, Uint8Array>();
  const put = vi.fn(async (key: string, body: BodyInit) => { objects.set(key, new Uint8Array(await new Response(body).arrayBuffer())); });
  const get = vi.fn(async (key: string) => {
    const bytes = objects.get(key);
    return bytes ? { body: new Response(bytes.slice()).body!, size: bytes.length, httpEtag: '"image"',
      writeHttpMetadata(headers: Headers) { headers.set("content-type", "image/webp"); } } : null;
  });
  const managed = vi.fn(commentManagedFetch()); vi.stubGlobal("fetch", managed);
  const adapter = new SqliteD1Database(sql);
  const env = { ...config, DB: adapter as unknown as D1Database, ASSETS: { put, get, head: get } as unknown as R2Bucket } as Env;
  const request = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://app.test/api${path}`, init), env, context);
  const upload = async (id: string, bytes: Uint8Array, mime = "image/png", submission = "submission-upload") => request(
    `/comment-submissions/${submission}/items/${id}/content`, { method: "PUT", body: bytes.slice().buffer,
      headers: { "content-type": mime, "x-upload-size": String(bytes.length), "x-content-sha256": await sha256Hex(bytes.slice().buffer) } });
  const finalize = (submission = "submission-upload") => request(`/comment-submissions/${submission}/finalize`, { method: "POST" });
  return { sql, env, adapter, put, get, managed, objects, now, upload, finalize, request };
}

describe("active accepted Comment upload publication", () => {
  it("commits an image File, alias, binding and receipt together and replays a lost commit acknowledgement without another PUT", async () => {
    const f = fixture(), bytes = new TextEncoder().encode("accepted image");
    await acceptCommentSubmission(f.env, { id: "submission-upload", body: "", context: { kind: "sample", sampleId: "sample-upload", expectedUpdatedAt: f.now },
      items: [
        { id: "item-upload", kind: "comment_image", filename: "image.png", mimeType: "image/png", byteSize: bytes.length,
          sha256: await sha256Hex(bytes.slice().buffer), originalFilename: "image.png", originalMimeType: "image/png", originalByteSize: bytes.length },
        { id: "link-item", kind: "link", url: "https://example.com/reference", title: "Reference" },
      ] });
    const batch = f.adapter.batch.bind(f.adapter); let loseAck = true; const batchErrors: string[] = [];
    vi.spyOn(f.adapter, "batch").mockImplementation(async statements => {
      let result;
      try { result = await batch(statements); } catch (error) { batchErrors.push(String(error)); throw error; }
      if (loseAck && statements.some(s => (s as unknown as { sql: string }).sql.includes("INSERT INTO file_location_publications"))) {
        loseAck = false; throw new Error("Lost publication acknowledgement");
      }
      return result;
    });
    const response = await f.upload("item-upload", bytes);
    expect(batchErrors).toEqual([]);
    expect(response.status, await response.clone().text()).toBe(200);
    const bound = f.sql.prepare(`SELECT c.state,c.result_file_id,i.file_id,i.asset_id,a.r2_key,r.status
      FROM file_acceptance_candidates c JOIN comment_submission_items i ON i.id=c.acceptance_id
      JOIN comment_item_acceptances r ON r.item_id=i.id JOIN assets a ON a.id=i.asset_id`).get()!;
    expect(bound).toMatchObject({ state: "ready", status: "ready", file_id: bound.result_file_id });
    expect(f.sql.prepare("SELECT file_id FROM file_usable_publications").get()!.file_id).toBe(bound.file_id);
    expect(f.objects.get(String(bound.r2_key))).toEqual(bytes);
    const receipt = f.sql.prepare("SELECT * FROM comment_item_acceptances").get();
    expect((await f.upload("item-upload", bytes)).status).toBe(200);
    expect(f.sql.prepare("SELECT * FROM comment_item_acceptances").get()).toEqual(receipt);
    expect((await f.finalize()).status).toBe(200); expect(f.put).toHaveBeenCalledTimes(1);
    expect((await f.request("/comment-submissions/submission-upload/items/item-upload", { method: "DELETE" })).status).toBe(200);
    const restoredItem = await f.request("/comment-submissions/submission-upload/items/item-upload/restore", { method: "POST" });
    expect(restoredItem.status, await restoredItem.clone().text()).toBe(200);
    expect((await f.request("/comment-submissions/submission-upload", { method: "DELETE" })).status).toBe(200);
    const restoredComment = await f.request("/comment-submissions/submission-upload/restore", { method: "POST" });
    expect(restoredComment.status, await restoredComment.clone().text()).toBe(200);
    expect(f.sql.prepare("SELECT file_id,asset_id FROM comment_submission_items WHERE id='item-upload'").get())
      .toEqual({ file_id: bound.file_id, asset_id: bound.asset_id });
    expect(f.put).toHaveBeenCalledTimes(1);

    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each(["uploaded", "cancelled"] as const)("preserves client preview with %s JPEG original without asserting verified derivation", async originalState => {
    const f = fixture(), original = new TextEncoder().encode("original jpeg bytes"), preview = new TextEncoder().encode("webp preview bytes");
    const originalSha = await sha256Hex(original.slice().buffer), previewSha = await sha256Hex(preview.slice().buffer);
    // A historical compatibility record must not prevent a new exact File alias.
    f.sql.prepare(`INSERT INTO managed_storage_objects(id,provider,object_key,original_name,mime_type,byte_size,sha256,status,created_at)
      VALUES('old-original','switchdrive','old/original','original.jpg','image/jpeg',?,?,'ready',?)`).run(original.length, originalSha, f.now);
    await acceptCommentSubmission(f.env, { id: "submission-upload", body: "", context: { kind: "sample", sampleId: "sample-upload", expectedUpdatedAt: f.now },
      items: [
        { id: "original-item", kind: "attachment", filename: "original.jpg", mimeType: "image/jpeg", byteSize: original.length, sha256: originalSha, relatedCommentImageId: "preview-item" },
        { id: "preview-item", kind: "comment_image", filename: "preview.webp", mimeType: "image/webp", byteSize: preview.length, sha256: previewSha,
          originalFilename: "original.jpg", originalMimeType: "image/jpeg", originalByteSize: original.length, relatedAttachmentId: "original-item" },
      ] });
    const image = await f.upload("preview-item", preview, "image/webp");
    expect(image.status, await image.clone().text()).toBe(200);
    expect((await f.finalize()).status).toBe(409);
    const originalResponse = originalState === "uploaded" ? await f.upload("original-item", original, "image/jpeg")
      : await f.request("/comment-submissions/submission-upload/items/original-item", { method: "DELETE" });
    expect(originalResponse.status, await originalResponse.clone().text()).toBe(200);
    const finalized = await f.finalize(); expect(finalized.status, await finalized.clone().text()).toBe(200);
    expect(f.sql.prepare(`SELECT i.id,i.related_item_id,f.purpose FROM comment_submission_items i JOIN file_usable_publications f ON f.file_id=i.file_id ORDER BY i.id`).all())
      .toEqual([...(originalState === "uploaded" ? [{ id: "original-item", related_item_id: "preview-item", purpose: "research_source" }] : []),
        { id: "preview-item", related_item_id: "original-item", purpose: "derived_preview" }]);
    expect(f.sql.prepare("SELECT count(*) n FROM file_derivations").get()!.n).toBe(0);
    expect(f.sql.prepare("SELECT count(*) n FROM attachment_derivatives").get()!.n).toBe(0);
    expect(f.put).toHaveBeenCalledTimes(1);
    expect(f.managed.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(originalState === "uploaded" ? 1 : 0);
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const manifest = await snapshotFullExportV18(f.env.DB);
    expect(manifest.tables.comment_submission_items.filter(item => item.status === "ready").every(item => typeof item.file_id === "string")).toBe(true);
    expect(manifest.tables.file_derivations).toEqual([]);
  }, 15_000);

  it("rolls back File publication with a rejected item receipt and retains the original execution token on retry", async () => {
    const f = fixture(), bytes = new TextEncoder().encode("receipt rollback image");
    await acceptCommentUpload(f.sql, f.env, { kind: "comment_image", bytes });
    f.sql.exec(`CREATE TRIGGER reject_comment_ready BEFORE UPDATE ON comment_item_acceptances WHEN NEW.status='ready'
      BEGIN SELECT RAISE(ABORT,'test receipt rejection'); END`);
    expect((await f.upload("item-upload", bytes)).status).toBe(202);
    const receipt = f.sql.prepare("SELECT execution_token,status FROM comment_item_acceptances").get()!;
    expect(receipt.execution_token).toEqual(expect.any(String)); expect(receipt.status).toBe("pending");
    expect(f.sql.prepare("SELECT state FROM file_acceptance_candidates").get()!.state).toBe("candidate");
    expect(f.sql.prepare("SELECT file_id,asset_id FROM comment_submission_items").get()).toEqual({ file_id: null, asset_id: null });
    for (const table of ["file_publications", "file_location_publications", "assets"]) expect(f.sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(0);
    f.sql.exec("DROP TRIGGER reject_comment_ready");
    expect((await f.upload("item-upload", bytes)).status).toBe(202);
    expect(f.sql.prepare("SELECT execution_token,status FROM comment_item_acceptances").get()).toEqual(receipt);
    expect(f.put).toHaveBeenCalledTimes(1);
  });
});
