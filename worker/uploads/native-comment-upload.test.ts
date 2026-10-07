import { Hono } from "hono";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../shared/content-addressing";
import { validateCommentAcceptedItemResultV21 } from "../../shared/contracts/comment-acceptance";
import { routes } from "../comment-submission-routes";
import { routes as sampleRoutes } from "../samples/routes";
import type { SampleDetail } from "../../shared/types";
import { futureActiveRuntimeDatabase } from "../files/authority-runtime-test-support";
import { handleError } from "../platform/http";
import { setStorageRoleDefaults } from "../storage/storage-role-policy";
import type { Env } from "../types";
import { nativeAcceptanceFixture, nativeAcceptanceActor } from "./native-acceptance-test-support";

const actor = nativeAcceptanceActor;
const databases: ReturnType<typeof futureActiveRuntimeDatabase>[] = [];
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach(db => db.close()); });

async function fixture(internalNative = true) {
  const base = await nativeAcceptanceFixture(internalNative);
  const { sql, db, env, now, objects, s3Fetch, r2Put, r2Get, admission } = base;
  databases.push(sql);
  const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
  app.onError(handleError);
  app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); });
  app.route("/api", routes);
  app.route("/api", sampleRoutes);
  const request = (path: string, init?: RequestInit) => app.fetch(new Request(`https://app.test/api${path}`, init), env, context);
  const create = (input: unknown) => request("/comment-submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const upload = async (id: string, bytes: Uint8Array, mime = "image/png", submission = "submission-native") => request(
    `/comment-submissions/${submission}/items/${id}/content`, { method: "PUT", body: bytes.slice().buffer,
      headers: { "content-type": mime, "x-upload-size": String(bytes.length), "x-content-sha256": await sha256Hex(bytes.slice().buffer) } });
  const finalize = (id = "submission-native") => request(`/comment-submissions/${id}/finalize`, { method: "POST" });
  const accept = async (bytes: Uint8Array, kind: "comment_image" | "attachment" = "comment_image") => {
    const input = { protocol: "comment-submission/1", id: "submission-native", body: "", context: {
      kind: "sample", sampleId: "sample-native", expectedUpdatedAt: now }, items: [{ id: "item-native", kind,
        filename: kind === "comment_image" ? "image.png" : "measurement.bin", mimeType: kind === "comment_image" ? "image/png" : "application/octet-stream",
        byteSize: bytes.length, sha256: await sha256Hex(bytes.slice().buffer), ...(kind === "comment_image" ? {
          originalFilename: "image.png", originalMimeType: "image/png", originalByteSize: bytes.length } : {}) }] };
    const response = await create(input); expect(response.status, await response.clone().text()).toBe(201);
    return input;
  };
  return { sql, db, env, now, objects, s3Fetch, r2Put, r2Get, admission, request, create, upload, finalize, accept };
}

describe("native S3 accepted Comment publication", () => {
  it.each(["comment_image", "attachment"] as const)("publishes %s with explicit File provenance and replays a lost acknowledgement without PUT", async kind => {
    const f = await fixture(), bytes = kind === "attachment" ? new Uint8Array(6 * 1024 * 1024 + 19).fill(37)
      : new TextEncoder().encode("native accepted Comment bytes");
    await f.accept(bytes, kind);
    expect(f.sql.prepare("SELECT storage_role_policy_revision,role_selection_revision FROM comment_submission_acceptances").get())
      .toEqual({ storage_role_policy_revision: 3, role_selection_revision: 3 });
    const batch = f.db.batch.bind(f.db); let loseAck = true;
    vi.spyOn(f.db, "batch").mockImplementation(async statements => {
      const result = await batch(statements);
      if (loseAck && statements.some(statement => (statement as unknown as { sql: string }).sql.includes("INSERT INTO file_location_publications"))) {
        loseAck = false; throw new Error("Lost native Comment publication acknowledgement");
      }
      return result;
    });
    const response = await f.upload("item-native", bytes, kind === "attachment" ? "application/octet-stream" : "image/png");
    expect(response.status, await response.clone().text()).toBe(200);
    const bound = f.sql.prepare(`SELECT i.file_id,i.asset_id,i.storage_object_id,a.r2_key,a.object_key,a.storage_profile_id,
      a.storage_profile_revision,a.file_id AS alias_file_id,r.accepted_result_json,c.state
      FROM comment_submission_items i JOIN assets a ON a.id=i.asset_id JOIN comment_item_acceptances r ON r.item_id=i.id
      JOIN file_acceptance_candidates c ON c.acceptance_id=i.id AND c.acceptance_kind='comment_item'`).get()!;
    expect(bound).toMatchObject({ r2_key: null, storage_object_id: null, storage_profile_id: f.admission.nativeProfileId,
      storage_profile_revision: 1, alias_file_id: bound.file_id, state: "ready" });
    const result = validateCommentAcceptedItemResultV21(JSON.parse(String(bound.accepted_result_json)));
    expect(result).toMatchObject({ schema: "comment-upload/2", storeKind: "file", provider: "s3", fileId: bound.file_id,
      blobRecordId: bound.asset_id, storageProfileId: f.admission.nativeProfileId, byteSize: bytes.length });
    const receipt = f.sql.prepare("SELECT * FROM comment_item_acceptances").get();
    expect((await f.upload("item-native", bytes, kind === "attachment" ? "application/octet-stream" : "image/png")).status).toBe(200);
    expect(f.sql.prepare("SELECT * FROM comment_item_acceptances").get()).toEqual(receipt);
    expect((await f.finalize()).status).toBe(200);
    if (kind === "attachment") {
      const download = await f.request("/attachments/item-native/download");
      expect(download.status, await download.clone().text()).toBe(200);
      const downloaded = Buffer.from(await download.arrayBuffer());
      expect(downloaded.byteLength).toBe(bytes.byteLength);
      expect(downloaded.equals(Buffer.from(bytes))).toBe(true);
    } else {
      const sample = await (await f.request("/samples/sample-native")).json() as SampleDetail;
      expect(sample.comments![0].images[0]).toMatchObject({ assetKey: null, assetId: bound.asset_id,
        fileId: bound.file_id, assetUrl: `/api/file-assets/${bound.asset_id}` });
      expect((await f.request("/comment-submissions/submission-native/items/item-native", { method: "DELETE" })).status).toBe(200);
      const restored = await f.request("/comment-submissions/submission-native/items/item-native/restore", { method: "POST" });
      expect(restored.status, await restored.clone().text()).toBe(200);
    }
    expect((await f.request("/comment-submissions/submission-native", { method: "DELETE" })).status).toBe(200);
    const restoredComment = await f.request("/comment-submissions/submission-native/restore", { method: "POST" });
    expect(restoredComment.status, await restoredComment.clone().text()).toBe(200);
    expect(f.sql.prepare("SELECT file_id,asset_id FROM comment_submission_items WHERE id='item-native'").get())
      .toEqual({ file_id: bound.file_id, asset_id: bound.asset_id });
    expect(f.s3Fetch.mock.calls.filter(([input]) => (input as Request).method === "PUT")).toHaveLength(1);
    expect(f.s3Fetch.mock.calls.filter(([input]) => (input as Request).method === "DELETE")).toHaveLength(0);
    expect(f.r2Put).not.toHaveBeenCalled(); expect(f.r2Get).not.toHaveBeenCalled();
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }, 30_000);

  it("freezes split original/preview targets before later default changes", async () => {
    const f = await fixture(false), original = new TextEncoder().encode("original bytes"), preview = new TextEncoder().encode("preview bytes");
    const input = { protocol: "comment-submission/1", id: "submission-native", body: "", context: {
      kind: "sample", sampleId: "sample-native", expectedUpdatedAt: f.now }, items: [
      { id: "original-native", kind: "attachment", filename: "original.jpg", mimeType: "image/jpeg", byteSize: original.length,
        sha256: await sha256Hex(original.slice().buffer), relatedCommentImageId: "preview-native" },
      { id: "preview-native", kind: "comment_image", filename: "preview.webp", mimeType: "image/webp", byteSize: preview.length,
        sha256: await sha256Hex(preview.slice().buffer), originalFilename: "original.jpg", originalMimeType: "image/jpeg",
        originalByteSize: original.length, relatedAttachmentId: "original-native" },
    ] };
    const created = await f.create(input); expect(created.status, await created.clone().text()).toBe(201);
    const frozen = f.sql.prepare("SELECT item_id,storage_profile_id,role_selection_revision FROM comment_item_acceptances ORDER BY item_id").all();
    expect(frozen).toEqual([{ item_id: "original-native", storage_profile_id: f.admission.nativeProfileId, role_selection_revision: 3 },
      { item_id: "preview-native", storage_profile_id: "r2-profile", role_selection_revision: 3 }]);
    await setStorageRoleDefaults(f.env, { operationId: crypto.randomUUID(), expectedPolicyRevision: 3,
      internalProfileId: "r2-profile", originalsProfileId: "r2-profile" }, actor);
    const replay = await f.create(input); expect(replay.status, await replay.clone().text()).toBe(200);
    expect(f.sql.prepare("SELECT item_id,storage_profile_id,role_selection_revision FROM comment_item_acceptances ORDER BY item_id").all()).toEqual(frozen);
    expect((await f.upload("preview-native", preview, "image/webp")).status).toBe(200);
    expect((await f.upload("original-native", original, "image/jpeg")).status).toBe(200);
    expect((await f.finalize()).status).toBe(200);
    expect(f.s3Fetch.mock.calls.filter(([input]) => (input as Request).method === "PUT")).toHaveLength(1);
    expect(f.r2Put).toHaveBeenCalledTimes(1);
    expect(f.sql.prepare("SELECT count(*) n FROM file_derivations").get()!.n).toBe(0);
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rolls native publication back atomically and leaves an uncertain write owned without another PUT", async () => {
    const f = await fixture(), bytes = new TextEncoder().encode("unpublished native bytes");
    await f.accept(bytes);
    f.sql.exec(`CREATE TRIGGER test_reject_native_comment BEFORE UPDATE ON comment_item_acceptances WHEN NEW.status='ready'
      BEGIN SELECT RAISE(ABORT,'test native receipt rejection'); END`);
    expect((await f.upload("item-native", bytes)).status).toBe(202);
    const receipt = f.sql.prepare("SELECT execution_token,status FROM comment_item_acceptances").get();
    expect(receipt).toMatchObject({ execution_token: expect.any(String), status: "pending" });
    expect(f.sql.prepare("SELECT state FROM file_acceptance_candidates").get()!.state).toBe("candidate");
    expect(f.sql.prepare("SELECT file_id,asset_id,storage_object_id FROM comment_submission_items").get())
      .toEqual({ file_id: null, asset_id: null, storage_object_id: null });
    for (const table of ["assets", "file_publications", "file_location_publications"])
      expect(f.sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(0);
    f.sql.exec("DROP TRIGGER test_reject_native_comment");
    expect((await f.upload("item-native", bytes)).status).toBe(202);
    expect(f.sql.prepare("SELECT execution_token,status FROM comment_item_acceptances").get()).toEqual(receipt);
    expect(f.s3Fetch.mock.calls.filter(([input]) => (input as Request).method === "PUT")).toHaveLength(1);
    expect(f.s3Fetch.mock.calls.filter(([input]) => (input as Request).method === "DELETE")).toHaveLength(0);
    expect(f.r2Put).not.toHaveBeenCalled();
  });

  it("observes missing ready native bytes without repairing, falling back or mutating the receipt", async () => {
    const f = await fixture(), bytes = new TextEncoder().encode("historical native result");
    await f.accept(bytes);
    expect((await f.upload("item-native", bytes)).status).toBe(200); expect((await f.finalize()).status).toBe(200);
    const receipt = f.sql.prepare("SELECT * FROM comment_item_acceptances").get();
    const [url, stored] = [...f.objects.entries()].find(([url]) => url.includes("/comments/"))!;
    f.objects.delete(url);
    const missing = await f.request("/comment-submissions/submission-native/acceptance");
    expect(missing.status).toBe(200); expect(await missing.json()).toMatchObject({ request: { status: "unavailable", items: [{ status: "unavailable" }] } });
    expect(f.sql.prepare("SELECT * FROM comment_item_acceptances").get()).toEqual(receipt);
    f.objects.set(url, stored);
    const available = await f.request("/comment-submissions/submission-native/acceptance");
    expect(available.status).toBe(200); expect(await available.json()).toMatchObject({ request: { status: "ready", items: [{ status: "ready" }] } });
    expect(f.s3Fetch.mock.calls.filter(([input]) => (input as Request).method === "PUT")).toHaveLength(1);
    expect(f.s3Fetch.mock.calls.filter(([input]) => (input as Request).method === "DELETE")).toHaveLength(0);
    expect(f.r2Get).not.toHaveBeenCalled();
  });
});
