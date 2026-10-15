import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { routes as projectRoutes } from "./project-routes";
import {
  referenceTestDatabase,
  SqliteD1Database,
} from "./reference-test-support";
import type { Env } from "./types";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };

type ProjectItemResponse = {
  project: { revision: number };
  replayed: boolean;
};

const ACTOR = "orphaned-copy-route@example.com";
const NOW = "2026-08-17T00:00:00.000Z";
const ORPHANED_AT = "2026-08-17T00:01:00.000Z";
const PROJECT_ID = "project-managed-orphaned-direct";
const STORAGE_ID = "storage-managed-orphaned-direct";
const OBJECT_KEY = "managed/copy/orphaned-direct.bin";
const geometry = { x: 40, y: 60, width: 320, height: 180, zIndex: 0 };

function fixture() {
  const database = referenceTestDatabase();
  const env = {
    DB: new SqliteD1Database(database) as unknown as D1Database,
    ASSETS: {} as R2Bucket,
    AUTH_MODE: "disabled",
  } satisfies Env;
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("userEmail", ACTOR);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  });
  app.route("/", projectRoutes);
  return { app, env, database };
}

function jsonRequest(
  app: Hono<AppBindings>,
  env: Env,
  path: string,
  method: string,
  body: unknown,
) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, env);
}

describe("Project attachment copy from orphaned managed storage", () => {
  it("keeps the source orphaned until copy and exercises the orphaned write branch", async () => {
    const { app, env, database } = fixture();

    const project = await jsonRequest(app, env, "/projects", "POST", {
      id: PROJECT_ID,
      title: "Managed orphaned copy",
      operationId: "create-managed-orphaned-project",
    });
    expect(project.status).toBe(201);

    database.prepare(`
      INSERT INTO managed_storage_objects (
        id, provider, object_key, original_name, mime_type, byte_size,
        sha256, status, actor_email, created_at, orphaned_at
      ) VALUES (
        ?, 'switchdrive', ?, 'orphaned-direct.bin',
        'application/octet-stream', 17, ?, 'ready', ?, ?, NULL
      )
    `).run(STORAGE_ID, OBJECT_KEY, "3".repeat(64), ACTOR, NOW);

    const source = await jsonRequest(
      app,
      env,
      `/projects/${PROJECT_ID}/items/attachment`,
      "POST",
      {
        contentId: "content-source",
        itemId: "item-source",
        placementId: "placement-source",
        locator: { storageObjectId: STORAGE_ID },
        caption: "Source attachment",
        sourceUrl: null,
        geometry,
        expectedProjectRevision: 1,
        operationId: "create-managed-orphaned-source",
      },
    );
    expect(source.status).toBe(201);
    expect(database.prepare(`
      SELECT storage_object_id
      FROM project_content_attachments
      WHERE project_content_id = 'content-source'
    `).get()).toEqual({ storage_object_id: STORAGE_ID });
    expect(database.prepare(`
      SELECT revision, next_created_sequence
      FROM projects
      WHERE id = ?
    `).get(PROJECT_ID)).toEqual({ revision: 2, next_created_sequence: 2 });
    expect(database.prepare(`
      SELECT status, orphaned_at
      FROM managed_storage_objects
      WHERE id = ?
    `).get(STORAGE_ID)).toEqual({ status: "ready", orphaned_at: null });

    database.prepare(`
      UPDATE managed_storage_objects
      SET status = 'orphaned', orphaned_at = ?
      WHERE id = ?
    `).run(ORPHANED_AT, STORAGE_ID);
    database.prepare(`
      INSERT INTO blob_gc_ledger (
        store_kind, provider, object_key, blob_record_id, state,
        operation_id, orphaned_at, updated_at
      ) VALUES (
        'managed', 'switchdrive', ?, ?, 'orphaned',
        'orphan-managed-copy-source', ?, ?
      )
    `).run(OBJECT_KEY, STORAGE_ID, ORPHANED_AT, ORPHANED_AT);

    expect(database.prepare(`
      SELECT status, orphaned_at
      FROM managed_storage_objects
      WHERE id = ?
    `).get(STORAGE_ID)).toEqual({
      status: "orphaned",
      orphaned_at: ORPHANED_AT,
    });
    expect(database.prepare(`
      SELECT state
      FROM blob_gc_ledger
      WHERE store_kind = 'managed'
        AND provider = 'switchdrive'
        AND object_key = ?
    `).get(OBJECT_KEY)).toEqual({ state: "orphaned" });

    const input = {
      sourceContentId: "content-source",
      contentId: "content-copy",
      itemId: "item-copy",
      placementId: "placement-copy",
      caption: "Copied from orphaned storage",
      sourceUrl: null,
      geometry: { ...geometry, x: 72, y: 92, zIndex: 1 },
      expectedProjectRevision: 2,
      operationId: "copy-managed-orphaned-source",
    };
    const copied = await jsonRequest(
      app,
      env,
      `/projects/${PROJECT_ID}/items/attachment/copy`,
      "POST",
      input,
    );
    expect(copied.status).toBe(201);
    expect(await copied.json() as ProjectItemResponse).toMatchObject({
      replayed: false,
      project: { revision: 3 },
    });
    expect(database.prepare(`
      SELECT asset_id, storage_object_id, original_name, mime_type, byte_size
      FROM project_content_attachments
      WHERE project_content_id = 'content-copy'
    `).get()).toEqual({
      asset_id: null,
      storage_object_id: STORAGE_ID,
      original_name: "orphaned-direct.bin",
      mime_type: "application/octet-stream",
      byte_size: 17,
    });

    expect(database.prepare(`
      SELECT status, orphaned_at
      FROM managed_storage_objects
      WHERE id = ?
    `).get(STORAGE_ID)).toEqual({ status: "ready", orphaned_at: null });
    expect(database.prepare(`
      SELECT state
      FROM blob_gc_ledger
      WHERE store_kind = 'managed'
        AND provider = 'switchdrive'
        AND object_key = ?
    `).get(OBJECT_KEY)).toBeUndefined();

    const replay = await jsonRequest(
      app,
      env,
      `/projects/${PROJECT_ID}/items/attachment/copy`,
      "POST",
      input,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json() as ProjectItemResponse).toMatchObject({ replayed: true });
    database.close();
  });
});
