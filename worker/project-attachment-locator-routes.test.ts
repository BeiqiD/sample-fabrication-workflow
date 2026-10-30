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

const ACTOR = "locator-route@example.com";
const geometry = { x: 0, y: 0, width: 320, height: 180, zIndex: 0 };

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

describe("Project attachment locator route contract", () => {
  it("rejects missing, null, numeric, and simultaneously present locator keys", async () => {
    const { app, env, database } = fixture();
    const created = await jsonRequest(app, env, "/projects", "POST", {
      id: "project-locator-route",
      title: "Locator Route",
      operationId: "create-project-locator-route",
    });
    expect(created.status).toBe(201);

    const locators = [
      {},
      { assetId: null, storageObjectId: "storage-a" },
      { assetId: "asset-a", storageObjectId: null },
      { assetId: 42 },
      { storageObjectId: 42 },
      { assetId: "asset-a", storageObjectId: "storage-a" },
    ];

    for (const [index, locator] of locators.entries()) {
      const response = await jsonRequest(
        app,
        env,
        "/projects/project-locator-route/items/attachment",
        "POST",
        {
          contentId: `content-locator-${index}`,
          itemId: `item-locator-${index}`,
          placementId: `placement-locator-${index}`,
          locator,
          caption: null,
          sourceUrl: null,
          geometry,
          expectedProjectRevision: 1,
          operationId: `create-attachment-locator-${index}`,
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Invalid Project attachment creation request",
      });
    }

    expect(database.prepare(`
      SELECT revision, next_created_sequence
      FROM projects
      WHERE id = 'project-locator-route'
    `).get()).toEqual({
      revision: 1,
      next_created_sequence: 1,
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM project_contents",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM project_items",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM project_content_attachments",
    ).get()).toEqual({ count: 0 });
    database.close();
  });

  it("rejects assets owned by a pending import at service, SQL, and media boundaries", async () => {
    const { app, env, database } = fixture();
    const get = vi.fn(async () => ({
      body: new ReadableStream({ start(controller) { controller.close(); } }),
      size: 4,
      httpEtag: '"project-import"',
      writeHttpMetadata(headers: Headers) { headers.set('content-type', 'image/png'); },
    }));
    env.ASSETS = { get } as unknown as R2Bucket;
    expect((await jsonRequest(app, env, "/projects", "POST", {
      id: "project-import-readiness",
      title: "Import readiness",
      operationId: "create-project-import-readiness",
    })).status).toBe(201);
    database.exec(`
      INSERT INTO imports (
        id, status, source_filename, source_sha256, sheet_name, template_type,
        warning_count, created_at, completed_at, operation_id, finalization_id
      ) VALUES (
        'project-import', 'ready', 'source.xlsx', '${'8'.repeat(64)}',
        'Process', 'process', 0, '2026-08-14T00:00:00.000Z',
        '2026-08-14T00:01:00.000Z', 'project-import-operation',
        'project-import-finalization'
      );
      INSERT INTO assets (
        id, import_id, r2_key, original_name, mime_type, byte_size,
        status, created_at, sha256
      ) VALUES (
        'project-import-asset', 'project-import', 'imports/project/image.png',
        'image.png', 'image/png', 4, 'ready',
        '2026-08-14T00:00:00.000Z', '${'9'.repeat(64)}'
      );
    `);

    const created = await jsonRequest(
      app,
      env,
      "/projects/project-import-readiness/items/attachment",
      "POST",
      {
        contentId: "content-import-ready",
        itemId: "item-import-ready",
        placementId: "placement-import-ready",
        locator: { assetId: "project-import-asset" },
        caption: null,
        sourceUrl: null,
        geometry,
        expectedProjectRevision: 1,
        operationId: "create-import-ready-attachment",
      },
    );
    expect(created.status).toBe(201);

    database.prepare(`
      UPDATE imports SET status = 'pending', finalization_id = NULL,
        completed_at = NULL, lease_expires_at = '2026-08-15T00:00:00.000Z'
      WHERE id = 'project-import'
    `).run();
    const media = await app.request(
      "/projects/project-import-readiness/contents/content-import-ready/file",
      {},
      env,
    );
    expect(media.status).toBe(404);
    expect(get).not.toHaveBeenCalled();

    const rejected = await jsonRequest(
      app,
      env,
      "/projects/project-import-readiness/items/attachment",
      "POST",
      {
        contentId: "content-import-pending",
        itemId: "item-import-pending",
        placementId: "placement-import-pending",
        locator: { assetId: "project-import-asset" },
        caption: null,
        sourceUrl: null,
        geometry,
        expectedProjectRevision: 2,
        operationId: "create-import-pending-attachment",
      },
    );
    expect(rejected.status).toBe(409);

    database.exec(`
      INSERT INTO project_contents (
        id, project_id, content_type, revision, last_mutation_id,
        created_by, updated_by, created_at, updated_at
      ) VALUES (
        'content-import-sql', 'project-import-readiness', 'attachment', 1,
        'content-import-sql-operation', '${ACTOR}', '${ACTOR}',
        '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'
      );
    `);
    expect(() => database.prepare(`
      INSERT INTO project_content_attachments (
        project_content_id, asset_id, original_name, mime_type, byte_size,
        created_by, created_at, creation_operation_id
      ) VALUES (
        'content-import-sql', 'project-import-asset', 'image.png', 'image/png', 4,
        '${ACTOR}', '2026-08-14T00:00:00.000Z', 'sql-import-guard'
      )
    `).run()).toThrow('blob locator is unavailable');

    database.exec(`
      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size,
        status, created_at, sha256
      ) VALUES (
        'project-standalone-asset', 'projects/standalone.png', 'standalone.png',
        'image/png', 4, 'ready', '2026-08-14T00:00:00.000Z',
        '${'a'.repeat(64)}'
      );
      INSERT INTO project_content_attachments (
        project_content_id, asset_id, original_name, mime_type, byte_size,
        created_by, created_at, creation_operation_id
      ) VALUES (
        'content-import-sql', 'project-standalone-asset', 'standalone.png',
        'image/png', 4, '${ACTOR}', '2026-08-14T00:00:00.000Z',
        'sql-standalone-attachment'
      );
    `);
    expect(() => database.prepare(`
      UPDATE project_content_attachments
      SET asset_id = 'project-import-asset'
      WHERE project_content_id = 'content-import-sql'
    `).run()).toThrow('blob locator is unavailable');
    expect(database.prepare(`
      SELECT asset_id FROM project_content_attachments
      WHERE project_content_id = 'content-import-sql'
    `).get()).toEqual({ asset_id: 'project-standalone-asset' });
    database.close();
  });

});
