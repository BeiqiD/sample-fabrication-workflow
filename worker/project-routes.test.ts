import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { routes as projectRoutes } from "./project-routes";
import {
  referenceTestDatabase,
  SqliteD1Database,
} from "./reference-test-support";
import type { Env } from "./types";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };
const ACTOR = "route-user@example.com";
const NOW = "2026-08-09T22:00:00.000Z";
const geometry = { x: 0, y: 0, width: 320, height: 180, zIndex: 0 };

function fixture() {
  const database = referenceTestDatabase();
  const adapter = new SqliteD1Database(database);
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const uploaded = new Map<string, Uint8Array>();
  const head = vi.fn(async (key: string) => {
    const body = key === "projects/route-asset.bin" ? bytes : uploaded.get(key);
    if (!body) return null;
    return {
      size: body.byteLength,
      httpEtag: '"route-etag"',
      writeHttpMetadata(headers: Headers) {
        headers.set("content-type", "application/octet-stream");
      },
    };
  });
  const bucket = {
    head,
    async put(key: string, value: ArrayBuffer | ArrayBufferView) {
      const source = value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      uploaded.set(key, new Uint8Array(source));
    },
    async delete(key: string) {
      uploaded.delete(key);
    },
    async get(key: string) {
      const body = key === "projects/route-asset.bin" ? bytes : uploaded.get(key);
      if (!body) return null;
      return {
        body: new Blob([body]).stream(),
        httpEtag: '"route-etag"',
        writeHttpMetadata(headers: Headers) {
          headers.set("content-type", "application/octet-stream");
        },
      };
    },
  } as unknown as R2Bucket;
  const env = {
    DB: adapter as unknown as D1Database,
    ASSETS: bucket,
    AUTH_MODE: "disabled",
  } satisfies Env;
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("userEmail", ACTOR);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    throw error;
  });
  app.route("/", projectRoutes);
  return { app, env, database, bytes, uploaded, head };
}

function jsonRequest(
  app: Hono<AppBindings>,
  env: Env,
  path: string,
  method: string,
  body?: unknown,
) {
  return app.request(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);
}

function attachmentUploadRequest(
  app: Hono<AppBindings>,
  env: Env,
  filename: string,
  mimeType: string,
  body: Uint8Array,
) {
  return app.request("/project-assets", {
    method: "POST",
    headers: {
      "content-type": mimeType,
      "x-project-filename-uri": encodeURIComponent(filename),
    },
    body,
  }, env);
}

function seedRouteAsset(database: ReturnType<typeof referenceTestDatabase>) {
  database.prepare(`
    INSERT INTO assets (
      id, r2_key, original_name, mime_type, byte_size,
      status, actor_email, created_at, sha256
    ) VALUES ('route-asset', 'projects/route-asset.bin', 'route-asset.bin',
      'application/octet-stream', 4, 'ready', ?, ?, ?)
  `).run(ACTOR, NOW, "a".repeat(64));
}

describe("Project persistence routes", () => {
  it("maps validation, replay, snapshot, and conflict states to stable HTTP responses", async () => {
    const { app, env, database } = fixture();
    const invalid = await jsonRequest(app, env, "/projects", "POST", {
      id: "../project",
      title: "Invalid",
      operationId: "create-invalid",
    });
    expect(invalid.status).toBe(400);

    const createBody = {
      id: "project-route",
      title: "Route Project",
      operationId: "create-project-route",
    };
    const created = await jsonRequest(app, env, "/projects", "POST", createBody);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      project: { id: "project-route", revision: 1 },
      replayed: false,
    });
    const replay = await jsonRequest(app, env, "/projects", "POST", createBody);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true });

    const markdown = await jsonRequest(
      app,
      env,
      "/projects/project-route/items/markdown",
      "POST",
      {
        contentId: "content-route",
        itemId: "item-route",
        placementId: "placement-route",
        markdownSource: "# Route",
        geometry,
        expectedProjectRevision: 1,
        operationId: "create-markdown-route",
      },
    );
    expect(markdown.status).toBe(201);

    const snapshot = await app.request("/projects/project-route", {}, env);
    expect(snapshot.status).toBe(200);
    const snapshotBody = await snapshot.json<Record<string, unknown>>();
    expect(snapshotBody).toMatchObject({
      schemaVersion: 1,
      project: { id: "project-route", revision: 2 },
    });
    expect(JSON.stringify(snapshotBody)).not.toContain("last_mutation_id");
    expect(JSON.stringify(snapshotBody)).not.toContain("object_key");

    const futureMove = await jsonRequest(
      app,
      env,
      "/projects/project-route/placements/placement-route",
      "PATCH",
      {
        geometry: { ...geometry, x: 100 },
        expectedRevision: 99,
        operationId: "future-move-route",
      },
    );
    expect(futureMove.status).toBe(409);
    expect(futureMove.headers.get("x-project-mutation-disposition")).toBeNull();
    expect(await futureMove.json()).toMatchObject({ error: "Placement revision conflict" });
    database.close();
  });

  it("deduplicates generic bytes independently of contextual upload filename and MIME", async () => {
    const { app, env, database, uploaded } = fixture();
    const body = Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55]);

    const blankName = await attachmentUploadRequest(app, env, "   ", "application/pdf", body);
    expect(blankName.status).toBe(400);
    expect(uploaded.size).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM assets").get()).toEqual({ count: 0 });

    const first = await attachmentUploadRequest(app, env, "实验结果.pdf", "application/pdf", body);
    expect(first.status).toBe(201);
    const firstBody = await first.json<{ id: string; key: string; deduplicated: boolean }>();
    expect(firstBody.deduplicated).toBe(false);
    expect(uploaded.get(firstBody.key)).toEqual(body);
    expect(database.prepare(`
      SELECT original_name, mime_type, byte_size
      FROM assets WHERE id = ?
    `).get(firstBody.id)).toEqual({
      original_name: "实验结果.pdf",
      mime_type: "application/pdf",
      byte_size: body.byteLength,
    });

    const exactDuplicate = await attachmentUploadRequest(app, env, "实验结果.pdf", "application/pdf", body);
    expect(exactDuplicate.status).toBe(200);
    expect(await exactDuplicate.json()).toMatchObject({
      id: firstBody.id,
      key: firstBody.key,
      deduplicated: true,
    });

    uploaded.delete(firstBody.key);
    const repaired = await attachmentUploadRequest(app, env, "实验结果.pdf", "application/pdf", body);
    expect(repaired.status).toBe(201);
    const repairedBody = await repaired.json<{ id: string; key: string; deduplicated: boolean }>();
    expect(repairedBody).toMatchObject({ deduplicated: false });
    expect(repairedBody.id).not.toBe(firstBody.id);
    expect(database.prepare(`
      SELECT reason, expected_byte_size, observed_byte_size
      FROM blob_integrity_quarantine
      WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = ?
    `).get(firstBody.key)).toEqual({
      reason: "missing",
      expected_byte_size: body.byteLength,
      observed_byte_size: null,
    });

    const renamedDuplicate = await attachmentUploadRequest(app, env, "renamed.pdf", "application/pdf", body);
    expect(renamedDuplicate.status).toBe(200);
    expect(await renamedDuplicate.json()).toMatchObject({
      id: repairedBody.id,
      key: repairedBody.key,
      deduplicated: true,
    });

    const retypedDuplicate = await attachmentUploadRequest(app, env, "实验结果.pdf", "application/octet-stream", body);
    expect(retypedDuplicate.status).toBe(200);
    expect(await retypedDuplicate.json()).toMatchObject({
      id: repairedBody.id,
      key: repairedBody.key,
      deduplicated: true,
    });
    expect(uploaded.size).toBe(1);
    expect(database.prepare(`
      SELECT original_name, mime_type, byte_size
      FROM assets WHERE id = ?
    `).get(repairedBody.id)).toEqual({
      original_name: "实验结果.pdf",
      mime_type: "application/pdf",
      byte_size: body.byteLength,
    });
    database.close();
  });

  it("uses authoritative asset metadata for attachment occurrences and streams only while active", async () => {
    const { app, env, database, bytes } = fixture();
    seedRouteAsset(database);
    await jsonRequest(app, env, "/projects", "POST", {
      id: "project-media",
      title: "Media Project",
      operationId: "create-project-media",
    });
    const attachment = await jsonRequest(
      app,
      env,
      "/projects/project-media/items/attachment",
      "POST",
      {
        contentId: "content-media",
        itemId: "item-media",
        placementId: "placement-media",
        locator: { assetId: "route-asset" },
        caption: null,
        sourceUrl: null,
        geometry,
        expectedProjectRevision: 1,
        operationId: "create-attachment-media",
      },
    );
    expect(attachment.status).toBe(201);
    const attachmentBody = await attachment.json<Record<string, unknown>>();
    expect(attachmentBody).toMatchObject({
      attachment: {
        originalName: "route-asset.bin",
        mimeType: "application/octet-stream",
        byteSize: 4,
      },
    });
    expect(JSON.stringify(attachmentBody)).toContain(
      "/api/projects/project-media/contents/content-media/file",
    );
    expect(JSON.stringify(attachmentBody)).not.toContain("projects/route-asset.bin");

    const filePath = "/projects/project-media/contents/content-media/file";
    const file = await app.request(filePath, {}, env);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toContain("attachment");
    expect(file.headers.get("content-type")).toContain("application/octet-stream");
    expect(file.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);

    const removed = await jsonRequest(
      app,
      env,
      "/projects/project-media/items/item-media",
      "DELETE",
      {
        expectedItemRevision: 1,
        expectedContentRevision: 1,
        operationId: "remove-item-media",
      },
    );
    expect(removed.status).toBe(200);
    expect((await removed.json<Record<string, unknown>>())).toMatchObject({
      item: { id: "item-media", revision: 2 },
      content: { id: "content-media", revision: 2 },
    });
    expect((await app.request(filePath, {}, env)).status).toBe(404);

    const missing = await app.request(
      "/projects/project-media/contents/missing-content/file",
      {},
      env,
    );
    expect(missing.status).toBe(404);
    database.close();
  });
});
