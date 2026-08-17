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

const ACTOR = "copy-route@example.com";
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

function copyInput(expectedProjectRevision = 2) {
  return {
    sourceContentId: "content-source",
    contentId: "content-copy",
    itemId: "item-copy",
    placementId: "placement-copy",
    caption: "Frozen copied caption",
    sourceUrl: "https://example.com/copied-source",
    geometry: { ...geometry, x: 72, y: 92, zIndex: 1 },
    expectedProjectRevision,
    operationId: "copy-attachment",
  };
}

describe("Project attachment copy route", () => {
  it("authorizes the source occurrence, reuses only its server-side blob binding, and replays exactly", async () => {
    const { app, env, database } = fixture();
    expect((await jsonRequest(app, env, "/projects", "POST", {
      id: "project-copy",
      title: "Attachment copy",
      operationId: "create-project-copy",
    })).status).toBe(201);
    database.exec(`
      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size,
        status, created_at, sha256
      ) VALUES (
        'asset-copy-source', 'projects/copy/source.png', 'source.png',
        'image/png', 42, 'ready', '2026-08-17T00:00:00.000Z',
        '${"a".repeat(64)}'
      );
    `);
    expect((await jsonRequest(
      app,
      env,
      "/projects/project-copy/items/attachment",
      "POST",
      {
        contentId: "content-source",
        itemId: "item-source",
        placementId: "placement-source",
        locator: { assetId: "asset-copy-source" },
        caption: "Original caption",
        sourceUrl: null,
        geometry,
        expectedProjectRevision: 1,
        operationId: "create-source-attachment",
      },
    )).status).toBe(201);

    const copied = await jsonRequest(
      app,
      env,
      "/projects/project-copy/items/attachment/copy",
      "POST",
      copyInput(),
    );
    expect(copied.status).toBe(201);
    const copiedPayload = await copied.json() as ProjectItemResponse;
    expect(copiedPayload).toMatchObject({ replayed: false, project: { revision: 3 } });
    expect(database.prepare(`
      SELECT project_content_id, asset_id, storage_object_id,
             original_name, mime_type, byte_size
      FROM project_content_attachments
      WHERE project_content_id IN ('content-source', 'content-copy')
      ORDER BY project_content_id
    `).all()).toEqual([
      {
        project_content_id: "content-copy",
        asset_id: "asset-copy-source",
        storage_object_id: null,
        original_name: "source.png",
        mime_type: "image/png",
        byte_size: 42,
      },
      {
        project_content_id: "content-source",
        asset_id: "asset-copy-source",
        storage_object_id: null,
        original_name: "source.png",
        mime_type: "image/png",
        byte_size: 42,
      },
    ]);
    expect(database.prepare(`
      SELECT attachment_caption, attachment_source_url
      FROM project_contents
      WHERE id = 'content-copy'
    `).get()).toEqual({
      attachment_caption: "Frozen copied caption",
      attachment_source_url: "https://example.com/copied-source",
    });

    const replay = await jsonRequest(
      app,
      env,
      "/projects/project-copy/items/attachment/copy",
      "POST",
      copyInput(),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json() as ProjectItemResponse).toMatchObject({ replayed: true });

    const locatorInjection = await jsonRequest(
      app,
      env,
      "/projects/project-copy/items/attachment/copy",
      "POST",
      { ...copyInput(), locator: { assetId: "another-asset" } },
    );
    expect(locatorInjection.status).toBe(400);
    expect(await locatorInjection.json()).toEqual({
      error: "Invalid Project attachment copy request",
    });
    database.close();
  });

  it("allows exact replay after source removal but rejects a new copy from an inactive source", async () => {
    const { app, env, database } = fixture();
    expect((await jsonRequest(app, env, "/projects", "POST", {
      id: "project-copy-removal",
      title: "Attachment copy removal",
      operationId: "create-project-copy-removal",
    })).status).toBe(201);
    database.exec(`
      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size,
        status, created_at, sha256
      ) VALUES (
        'asset-copy-removal', 'projects/copy/removal.png', 'removal.png',
        'image/png', 21, 'ready', '2026-08-17T00:00:00.000Z',
        '${"b".repeat(64)}'
      );
    `);
    expect((await jsonRequest(
      app,
      env,
      "/projects/project-copy-removal/items/attachment",
      "POST",
      {
        contentId: "content-source",
        itemId: "item-source",
        placementId: "placement-source",
        locator: { assetId: "asset-copy-removal" },
        caption: null,
        sourceUrl: null,
        geometry,
        expectedProjectRevision: 1,
        operationId: "create-source-removal",
      },
    )).status).toBe(201);
    expect((await jsonRequest(
      app,
      env,
      "/projects/project-copy-removal/items/attachment/copy",
      "POST",
      copyInput(),
    )).status).toBe(201);

    const removed = await jsonRequest(
      app,
      env,
      "/projects/project-copy-removal/items/item-source",
      "DELETE",
      {
        expectedItemRevision: 1,
        expectedContentRevision: 1,
        operationId: "remove-source-after-copy",
      },
    );
    expect(removed.status).toBe(200);
    const removedPayload = await removed.json() as ProjectItemResponse;

    const replay = await jsonRequest(
      app,
      env,
      "/projects/project-copy-removal/items/attachment/copy",
      "POST",
      copyInput(),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json() as ProjectItemResponse).toMatchObject({ replayed: true });

    const rejected = await jsonRequest(
      app,
      env,
      "/projects/project-copy-removal/items/attachment/copy",
      "POST",
      {
        ...copyInput(removedPayload.project.revision),
        contentId: "content-new-copy",
        itemId: "item-new-copy",
        placementId: "placement-new-copy",
        operationId: "new-copy-after-removal",
      },
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({
      error: "Source Project attachment is no longer active",
    });
    database.close();
  });

  it("does not authorize attachment content from another Project", async () => {
    const { app, env, database } = fixture();
    for (const projectId of ["project-source", "project-target"]) {
      expect((await jsonRequest(app, env, "/projects", "POST", {
        id: projectId,
        title: projectId,
        operationId: `create-${projectId}`,
      })).status).toBe(201);
    }
    database.exec(`
      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size,
        status, created_at, sha256
      ) VALUES (
        'asset-cross-project', 'projects/copy/cross.png', 'cross.png',
        'image/png', 12, 'ready', '2026-08-17T00:00:00.000Z',
        '${"c".repeat(64)}'
      );
    `);
    expect((await jsonRequest(
      app,
      env,
      "/projects/project-source/items/attachment",
      "POST",
      {
        contentId: "content-source",
        itemId: "item-source",
        placementId: "placement-source",
        locator: { assetId: "asset-cross-project" },
        caption: null,
        sourceUrl: null,
        geometry,
        expectedProjectRevision: 1,
        operationId: "create-cross-source",
      },
    )).status).toBe(201);

    const rejected = await jsonRequest(
      app,
      env,
      "/projects/project-target/items/attachment/copy",
      "POST",
      { ...copyInput(1), operationId: "copy-cross-project" },
    );
    expect(rejected.status).toBe(404);
    expect(await rejected.json()).toEqual({
      error: "Source Project attachment not found",
    });
    database.close();
  });
});
