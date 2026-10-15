import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../shared/content-addressing";
import type { SampleDetail } from "../../shared/types";
import { acceptCommentSubmission, acceptCommentUpload, commentManagedFetch, COMMENT_TEST_R2_NAMESPACE } from "../comment-acceptance-test-support";
import { enableFutureFileAuthority, futureActiveRuntimeDatabase } from "../files/authority-runtime-test-support";
import { managedBootstrapNamespace } from "../files/managed-bootstrap-profile";
import { snapshotFullExportV20 } from "../export-v20-snapshot";
import worker from "../index";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";

const databases: ReturnType<typeof futureActiveRuntimeDatabase>[] = [];
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach(db => db.close()); });

function fixture(active = true, throughMigration = "0017_fp2_native_storage_profiles.sql") {
  const config = { AUTH_MODE: "disabled", R2_BOOTSTRAP_NAMESPACE: COMMENT_TEST_R2_NAMESPACE,
    MANAGED_STORAGE_PROVIDER: "switchdrive", SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/user%40example.ch",
    SWITCHDRIVE_USERNAME: "user@example.ch", SWITCHDRIVE_APP_PASSWORD: "test-password" };
  const now = new Date().toISOString();
  const seed = (db: ReturnType<typeof referenceTestDatabase>) => {
    db.prepare("INSERT INTO storage_profiles VALUES('r2-profile','r2',?,'bootstrap',NULL,1,'historical',?)").run(COMMENT_TEST_R2_NAMESPACE, now);
    db.prepare("INSERT INTO storage_profiles VALUES('managed-profile','switchdrive',?,'environment','environment:SWITCHDRIVE',1,'historical',?)")
      .run(managedBootstrapNamespace(config), now);
    for (const id of ["r2-profile", "managed-profile"]) db.prepare("INSERT INTO file_shadow_profile_enablements VALUES(?,1,'test',?)").run(id, now);
  };
  const schema = { throughMigration };
  const sql = active ? futureActiveRuntimeDatabase(seed, schema) : referenceTestDatabase(schema);
  if (!active) {
    sql.exec("PRAGMA foreign_keys=ON");
    sql.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'test',? FROM file_shadow_control").run(now);
    seed(sql);
  }
  databases.push(sql);
  // Host stream equivalent. Native D1 qualification separately uses workerd's
  // FixedLengthStream; the production writer still checks every emitted byte.
  vi.stubGlobal("FixedLengthStream", class extends TransformStream<Uint8Array, Uint8Array> {
    constructor(_byteSize: number) { super(); }
  });
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
  it("preserves a pre-role-policy managed original through authentic0012 acceptance and publication", async () => {
    const f = fixture(false, "0012_fp1_file_authority_runtime.sql"), bytes = new TextEncoder().encode("original before role policy");
    expect(f.sql.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='storage_role_defaults'").get()!.n).toBe(0);
    await acceptCommentUpload(f.sql, f.env, { kind: "attachment", bytes });
    const parent = f.sql.prepare("SELECT * FROM comment_submission_acceptances").get()!;
    expect(parent).not.toHaveProperty("storage_role_policy_revision");
    expect(parent).not.toHaveProperty("role_selection_revision");
    expect(f.sql.prepare("SELECT storage_profile_id FROM comment_item_acceptances").get()!.storage_profile_id).toBe("managed-profile");
    expect((await f.upload("item-upload", bytes, "application/octet-stream")).status).toBe(200);
    expect((await f.finalize()).status).toBe(200);
    expect(JSON.parse(String(f.sql.prepare("SELECT accepted_result_json FROM comment_item_acceptances").get()!.accepted_result_json)))
      .toMatchObject({ storeKind: "managed", provider: "switchdrive", byteSize: bytes.length });
    expect(f.put).not.toHaveBeenCalled();
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("commits an image File, alias, binding and receipt together and replays a lost commit acknowledgement without another PUT", async () => {
    const f = fixture(), bytes = new TextEncoder().encode("accepted image");
    await acceptCommentSubmission(f.env, { id: "submission-upload", body: "", context: { kind: "sample", sampleId: "sample-upload", expectedUpdatedAt: f.now },
      items: [
        { id: "item-upload", kind: "comment_image", filename: "image.png", mimeType: "image/png", byteSize: bytes.length,
          sha256: await sha256Hex(bytes.slice().buffer), originalFilename: "image.png", originalMimeType: "image/png", originalByteSize: bytes.length },
        { id: "link-item", kind: "link", url: "https://example.com/reference", title: "Reference" },
      ] });
    expect(f.sql.prepare("SELECT purpose,storage_profile_id,storage_profile_revision FROM comment_item_acceptances").get())
      .toEqual({ purpose: "embedded_content", storage_profile_id: "r2-profile", storage_profile_revision: 1 });
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
    expect(f.sql.prepare("SELECT item_id,purpose,storage_profile_id,storage_profile_revision FROM comment_item_acceptances ORDER BY item_id").all())
      .toEqual([
        { item_id: "original-item", purpose: "research_source", storage_profile_id: "r2-profile", storage_profile_revision: 1 },
        { item_id: "preview-item", purpose: "derived_preview", storage_profile_id: "r2-profile", storage_profile_revision: 1 },
      ]);
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
    expect(f.put).toHaveBeenCalledTimes(originalState === "uploaded" ? 2 : 1);
    expect(f.managed.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const manifest = await snapshotFullExportV20(f.env.DB);
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
  it("streams an unchanged R2 original above 5 MiB, downloads exact bytes and retries without another PUT", async () => {
    const f = fixture(), bytes = new Uint8Array(6 * 1024 * 1024 + 19).fill(37);
    await acceptCommentUpload(f.sql, f.env, { kind: "attachment", bytes, filename: "measurement.bin" });
    const attachment = async () => {
      const response = await f.request("/samples/sample-upload");
      expect(response.status).toBe(200);
      const detail = await response.json() as SampleDetail;
      return detail.comments![0].attachments[0];
    };
    expect(await attachment()).toMatchObject({ status: "pending", downloadUrl: null });
    expect((await f.request("/attachments/item-upload/download")).status).toBe(404);
    expect(f.sql.prepare("SELECT storage_role_policy_revision FROM comment_submission_acceptances").get()!.storage_role_policy_revision).toBe(2);
    expect(f.sql.prepare("SELECT role,storage_profile_id,policy_revision FROM storage_role_defaults ORDER BY role").all()).toEqual([
      { role: "internal", storage_profile_id: "r2-profile", policy_revision: 2 }, { role: "originals", storage_profile_id: "r2-profile", policy_revision: 2 },
    ]);
    const response = await f.upload("item-upload", bytes, "application/octet-stream");
    expect(response.status, await response.clone().text()).toBe(200);
    const item = f.sql.prepare("SELECT asset_id,storage_object_id,file_id FROM comment_submission_items").get()!;
    expect(item.asset_id).toEqual(expect.any(String)); expect(item.storage_object_id).toBeNull(); expect(item.file_id).toEqual(expect.any(String));
    const receipt = f.sql.prepare("SELECT accepted_result_json FROM comment_item_acceptances").get()!;
    expect(JSON.parse(String(receipt.accepted_result_json))).toMatchObject({ storeKind: "r2", provider: "r2", byteSize: bytes.length });
    expect((await f.upload("item-upload", bytes, "application/octet-stream")).status).toBe(200);
    expect(f.sql.prepare("SELECT accepted_result_json FROM comment_item_acceptances").get()).toEqual(receipt);
    expect(await attachment()).toMatchObject({ status: "ready", downloadUrl: null });
    expect((await f.request("/attachments/item-upload/download")).status).toBe(404);
    expect((await f.finalize()).status).toBe(200);
    const readyAttachment = await attachment();
    expect(readyAttachment).toMatchObject({ status: "ready", downloadUrl: "/api/attachments/item-upload/download" });
    if (readyAttachment.kind !== "file" || !readyAttachment.downloadUrl) throw new Error("Ready original has no download link");
    const download = await f.request(readyAttachment.downloadUrl.replace(/^\/api/, ""));
    expect(download.status, await download.clone().text()).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    expect(f.put).toHaveBeenCalledTimes(1);
    expect(f.managed).not.toHaveBeenCalled();
  }, 15_000);

  it("keeps a historical accepted SWITCHdrive destination after R2 role bootstrap", async () => {
    const f = fixture(false), oldBytes = new TextEncoder().encode("old accepted original"), nextBytes = new TextEncoder().encode("new R2 original");
    await acceptCommentUpload(f.sql, f.env, { kind: "attachment", bytes: oldBytes, submissionId: "old-submission", itemId: "old-original" });
    const before = f.sql.prepare("SELECT storage_profile_id,candidate_object_key FROM comment_item_acceptances WHERE item_id='old-original'").get();
    expect(before!.storage_profile_id).toBe("managed-profile");
    enableFutureFileAuthority(f.sql);
    await acceptCommentUpload(f.sql, f.env, { kind: "attachment", bytes: nextBytes });
    expect(f.sql.prepare("SELECT storage_profile_id FROM comment_item_acceptances WHERE item_id='item-upload'").get()!.storage_profile_id).toBe("r2-profile");
    // Replaying creation uses the exact saved receipt before looking up defaults.
    const sample = f.sql.prepare("SELECT updated_at FROM samples WHERE id='sample-upload'").get()!;
    const replay = await f.request("/comment-submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      protocol: "comment-submission/1", id: "old-submission", body: "", context: { kind: "sample", sampleId: "sample-upload", expectedUpdatedAt: sample.updated_at },
      items: [{ id: "old-original", kind: "attachment", filename: "result.dat", mimeType: "application/octet-stream", byteSize: oldBytes.length, sha256: await sha256Hex(oldBytes.slice().buffer) }],
    }) });
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(f.sql.prepare("SELECT storage_profile_id,candidate_object_key FROM comment_item_acceptances WHERE item_id='old-original'").get()).toEqual(before);
    const oldUpload = await f.upload("old-original", oldBytes, "application/octet-stream", "old-submission");
    expect(oldUpload.status, await oldUpload.clone().text()).toBe(200);
    expect((await f.upload("item-upload", nextBytes, "application/octet-stream")).status).toBe(200);
    expect((await f.finalize("old-submission")).status).toBe(200);
    expect((await f.finalize()).status).toBe(200);
    const provider = f.sql.prepare("SELECT accepted_result_json FROM comment_item_acceptances WHERE item_id='old-original'").get()!;
    expect(JSON.parse(String(provider.accepted_result_json))).toMatchObject({ storeKind: "managed", provider: "switchdrive" });
    expect(f.managed.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    expect(f.put).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("replays an accepted active destination before fresh storage selection when configuration is unavailable", async () => {
    const f = fixture(), bytes = new TextEncoder().encode("pending frozen image");
    await acceptCommentUpload(f.sql, f.env, { kind: "comment_image", bytes });
    const parent = f.sql.prepare("SELECT * FROM comment_submission_acceptances").get()!;
    const item = f.sql.prepare("SELECT * FROM comment_item_acceptances").get()!;
    const defaults = f.sql.prepare("SELECT * FROM storage_role_defaults ORDER BY role").all();
    delete f.env.R2_BOOTSTRAP_NAMESPACE;
    const replay = await f.request("/comment-submissions", { method: "POST", headers: { "content-type": "application/json" },
      body: String(parent.request_input_json) });
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toMatchObject({ deduplicated: true, request: { status: "pending" } });
    expect(f.sql.prepare("SELECT * FROM comment_submission_acceptances").get()).toEqual(parent);
    expect(f.sql.prepare("SELECT * FROM comment_item_acceptances").get()).toEqual(item);
    const freshInput = { ...JSON.parse(String(parent.request_input_json)), id: "new-unavailable-submission" };
    const fresh = await f.request("/comment-submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(freshInput) });
    expect(fresh.status).toBe(503);
    expect(f.sql.prepare("SELECT count(*) n FROM comment_submissions").get()!.n).toBe(1);
    expect(f.sql.prepare("SELECT * FROM storage_role_defaults ORDER BY role").all()).toEqual(defaults);
    expect(f.put).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled(); expect(f.managed).not.toHaveBeenCalled();
  });

  it("rejects a fresh link-only acceptance if authority activates before its batch and accepts a later retry", async () => {
    const f = fixture(false);
    const input = { protocol: "comment-submission/1", id: "link-submission", body: "one link", context: {
      kind: "sample", sampleId: "sample-upload", expectedUpdatedAt: f.now },
      items: [{ id: "only-link", kind: "link", url: "https://example.com/reference", title: "Reference" }] };
    const batch = f.adapter.batch.bind(f.adapter); let activate = true;
    vi.spyOn(f.adapter, "batch").mockImplementation(async statements => {
      if (activate && statements.some(statement => (statement as unknown as { sql: string }).sql.includes("INSERT INTO comment_submissions"))) {
        activate = false; enableFutureFileAuthority(f.sql);
      }
      return batch(statements);
    });
    const create = () => f.request("/comment-submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const changed = await create();
    expect(changed.status, await changed.clone().text()).toBe(409);
    for (const table of ["comment_submissions", "comment_submission_acceptances", "comment_submission_items", "storage_role_defaults"])
      expect(f.sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(0);
    const retried = await create();
    expect(retried.status, await retried.clone().text()).toBe(201);
    expect(f.sql.prepare("SELECT count(*) n FROM storage_role_defaults").get()!.n).toBe(0);
    expect(f.put).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled(); expect(f.managed).not.toHaveBeenCalled();
  });

  it("rolls bootstrap back with a rejected target and permits text and links without storage configuration", async () => {
    const f = fixture(), bytes = new TextEncoder().encode("unaccepted original");
    const rejected = await f.request("/comment-submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      protocol: "comment-submission/1", id: "bad-submission", body: "", context: { kind: "sample", sampleId: "sample-upload", expectedUpdatedAt: "2020-01-01T00:00:00.000Z" },
      items: [{ id: "bad-original", kind: "attachment", filename: "result.dat", mimeType: "application/octet-stream", byteSize: bytes.length, sha256: await sha256Hex(bytes.slice().buffer) }],
    }) });
    expect(rejected.status).toBe(409);
    expect(f.sql.prepare("SELECT count(*) n FROM storage_role_defaults").get()!.n).toBe(0);
    delete f.env.R2_BOOTSTRAP_NAMESPACE;
    delete f.env.SWITCHDRIVE_APP_PASSWORD;
    const text = await f.request("/comment-submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      protocol: "comment-submission/1", id: "text-submission", body: "text without files", context: { kind: "sample", sampleId: "sample-upload", expectedUpdatedAt: f.now }, items: [],
    }) });
    expect(text.status, await text.clone().text()).toBe(201);
    expect((await f.finalize("text-submission")).status).toBe(200);
    const sample = f.sql.prepare("SELECT updated_at FROM samples WHERE id='sample-upload'").get()!;
    const link = await f.request("/comment-submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      protocol: "comment-submission/1", id: "link-submission", body: "link without files", context: { kind: "sample", sampleId: "sample-upload", expectedUpdatedAt: sample.updated_at },
      items: [{ id: "only-link", kind: "link", url: "https://example.com/reference", title: "Reference" }],
    }) });
    expect(link.status, await link.clone().text()).toBe(201);
    expect((await f.finalize("link-submission")).status).toBe(200);
    expect(f.sql.prepare("SELECT count(*) n FROM storage_role_defaults").get()!.n).toBe(0);
    expect(f.sql.prepare("SELECT count(*) n FROM comment_item_acceptances").get()!.n).toBe(0);
    expect(f.put).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled(); expect(f.managed).not.toHaveBeenCalled();
  });

});
