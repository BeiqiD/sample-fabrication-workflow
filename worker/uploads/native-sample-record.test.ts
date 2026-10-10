import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SampleDetail } from "../../shared/types";
import { handleError } from "../platform/http";
import { routes as sampleRoutes } from "../samples/routes";
import type { Env } from "../types";
import { nativeAcceptanceFixture } from "./native-acceptance-test-support";
import { acceptAndUploadR2Asset } from "./r2-upload-acceptance";

const databases: Awaited<ReturnType<typeof nativeAcceptanceFixture>>["sql"][] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach(db => db.close()); });
async function fixture() {
  const f = await nativeAcceptanceFixture(); databases.push(f.sql);
  const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
  app.onError(handleError); app.use("*", async (c, next) => { c.set("userEmail", f.actor); await next(); });
  app.route("/api", sampleRoutes);
  const request = (path: string, init?: RequestInit) => app.fetch(new Request(`https://app.test/api${path}`, init), f.env);
  const create = (input: Record<string, unknown>) => request("/samples/sample-native/records", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "stored", location: "", pinned: false, expectedUpdatedAt: f.now, ...input }) });
  const upload = async () => {
    const bytes = new TextEncoder().encode("native sample record image");
    const value = await acceptAndUploadR2Asset(f.env, { requestId: crypto.randomUUID(), actorEmail: f.actor,
      ingress: "ordinary_image", originalName: "record.png", mimeType: "image/png", bytes: bytes.buffer });
    expect(value.state.status).toBe("ready"); if (!value.state.result) throw new Error("Native image was not published");
    return value.state.result;
  };
  return { ...f, request, create, upload };
}

describe("native File sample records", () => {
  it("attaches by exact native asset ID, renders its URL and unlinks only the occurrence", async () => {
    const f = await fixture(), uploaded = await f.upload();
    expect(uploaded.key).toBeNull();
    const response = await f.create({ assetId: uploaded.id });
    expect(response.status, await response.clone().text()).toBe(201);
    const event = f.sql.prepare("SELECT id,asset_key,asset_file_id,metadata_json FROM events WHERE kind='image'").get()!;
    expect(event.asset_key).toBeNull(); expect(event.asset_file_id).toEqual(expect.any(String));
    expect(JSON.parse(String(event.metadata_json))).toMatchObject({ action: "sample_record", assetId: uploaded.id });
    const detailResponse = await f.request("/samples/sample-native");
    expect(detailResponse.status, await detailResponse.clone().text()).toBe(200);
    const detail = await detailResponse.json() as SampleDetail;
    expect(detail.events.find(row => row.id === event.id)).toMatchObject({ assetKey: null, assetId: uploaded.id,
      fileId: event.asset_file_id, assetUrl: `/api/file-assets/${uploaded.id}` });
    const removed = await f.request(`/samples/sample-native/events/${event.id}/asset`, { method: "DELETE" });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(f.sql.prepare("SELECT asset_file_id FROM events WHERE id=?").get(String(event.id))!.asset_file_id).toBe(event.asset_file_id);
    expect(JSON.parse(String(f.sql.prepare("SELECT metadata_json FROM events WHERE id=?").get(String(event.id))!.metadata_json)))
      .toMatchObject({ assetDeletedAt: expect.any(String), assetId: uploaded.id });
    const next = await (await f.request("/samples/sample-native")).json() as SampleDetail;
    expect(next.events.find(row => row.id === event.id)?.assetUrl).toBeUndefined();
    expect((await f.request(`/samples/sample-native/events/${event.id}/asset`, { method: "DELETE" })).status).toBe(409);
    expect(f.s3Fetch.mock.calls.filter(([input]) => (input as Request).method === "PUT")).toHaveLength(1);
    expect(f.s3Fetch.mock.calls.filter(([input]) => (input as Request).method === "DELETE")).toHaveLength(0);
    expect(f.r2Put).not.toHaveBeenCalled();
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("deletes a native photo note with the File binding retained and a photo audit label", async () => {
    const f = await fixture(), uploaded = await f.upload();
    expect((await f.create({ assetId: uploaded.id })).status).toBe(201);
    const event = f.sql.prepare("SELECT id,asset_file_id FROM events WHERE kind='image'").get()!;
    const removed = await f.request(`/samples/sample-native/records/${event.id}`, { method: "DELETE" });
    expect(removed.status, await removed.clone().text()).toBe(200);
    const row = f.sql.prepare("SELECT asset_file_id,metadata_json FROM events WHERE id=?").get(String(event.id))!;
    expect(row.asset_file_id).toBe(event.asset_file_id);
    expect(JSON.parse(String(row.metadata_json))).toMatchObject({ hadAsset: true, deletedAt: expect.any(String) });
    expect(f.sql.prepare("SELECT body FROM events WHERE kind='comment'").get()!.body).toContain("Photo attachment");
    expect(f.s3Fetch.mock.calls.filter(([input]) => (input as Request).method === "DELETE")).toHaveLength(0);
  });

  it("rejects contradictory or unavailable asset inputs without changing sample details", async () => {
    const f = await fixture(), uploaded = await f.upload();
    const before = f.sql.prepare("SELECT updated_at,location,status FROM samples WHERE id='sample-native'").get();
    expect((await f.create({ assetId: uploaded.id, assetKey: "different/r2/key", location: "changed" })).status).toBe(400);
    expect((await f.create({ assetId: "missing-native-alias", location: "changed" })).status).toBe(400);
    expect(f.sql.prepare("SELECT updated_at,location,status FROM samples WHERE id='sample-native'").get()).toEqual(before);
    expect(f.sql.prepare("SELECT count(*) n FROM events").get()!.n).toBe(0);
    expect(f.s3Fetch.mock.calls.filter(([input]) => (input as Request).method === "PUT")).toHaveLength(1);
  });
});
