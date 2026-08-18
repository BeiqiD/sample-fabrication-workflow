import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { routes as projectRoutes } from "./project-routes";
import {
  referenceTestDatabase,
  SqliteD1Database,
} from "./reference-test-support";
import { removeProjectItem } from "./projects/service";
import type { Env } from "./types";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };

type ProjectItemResponse = {
  project: { revision: number };
  replayed: boolean;
};

type ManagedStatus = "ready" | "orphaned";
type ManagedGuard = "gc" | "quarantine";

const ACTOR = "copy-route@example.com";
const NOW = "2026-08-17T00:00:00.000Z";
const geometry = { x: 40, y: 60, width: 320, height: 180, zIndex: 0 };

class InterleavingSqliteD1Database extends SqliteD1Database {
  beforeNextBatch: (() => Promise<void>) | null = null;

  override async batch(statements: D1PreparedStatement[]) {
    const interleave = this.beforeNextBatch;
    this.beforeNextBatch = null;
    if (interleave) await interleave();
    return super.batch(statements);
  }
}

function fixture() {
  const database = referenceTestDatabase();
  const adapter = new InterleavingSqliteD1Database(database);
  const env = {
    DB: adapter as unknown as D1Database,
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
  return { app, env, database, adapter };
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

async function createProject(
  app: Hono<AppBindings>,
  env: Env,
  projectId: string,
) {
  const response = await jsonRequest(app, env, "/projects", "POST", {
    id: projectId,
    title: projectId,
    operationId: `create-${projectId}`,
  });
  expect(response.status).toBe(201);
}

function seedAsset(
  database: ReturnType<typeof referenceTestDatabase>,
  id: string,
  key: string,
  byteSize = 42,
  shaCharacter = "a",
) {
  database.prepare(`
    INSERT INTO assets (
      id, r2_key, original_name, mime_type, byte_size,
      status, created_at, sha256
    ) VALUES (?, ?, ?, 'image/png', ?, 'ready', ?, ?)
  `).run(id, key, `${id}.png`, byteSize, NOW, shaCharacter.repeat(64));
}

function seedManagedStorage(
  database: ReturnType<typeof referenceTestDatabase>,
  id: string,
  objectKey: string,
  status: ManagedStatus,
  shaCharacter: string,
) {
  database.prepare(`
    INSERT INTO managed_storage_objects (
      id, provider, object_key, original_name, mime_type, byte_size,
      sha256, status, actor_email, created_at, orphaned_at
    ) VALUES (?, 'switchdrive', ?, ?, 'application/octet-stream', 17,
              ?, ?, ?, ?, ?)
  `).run(
    id,
    objectKey,
    `${id}.bin`,
    shaCharacter.repeat(64),
    status,
    ACTOR,
    NOW,
    status === "orphaned" ? NOW : null,
  );
}

async function createSourceAttachment(
  app: Hono<AppBindings>,
  env: Env,
  projectId: string,
  locator: { assetId: string } | { storageObjectId: string },
  operationId = "create-source-attachment",
) {
  const response = await jsonRequest(
    app,
    env,
    `/projects/${projectId}/items/attachment`,
    "POST",
    {
      contentId: "content-source",
      itemId: "item-source",
      placementId: "placement-source",
      locator,
      caption: "Original caption",
      sourceUrl: null,
      geometry,
      expectedProjectRevision: 1,
      operationId,
    },
  );
  expect(response.status).toBe(201);
}

function copyInput(
  expectedProjectRevision = 2,
  suffix = "copy",
) {
  return {
    sourceContentId: "content-source",
    contentId: `content-${suffix}`,
    itemId: `item-${suffix}`,
    placementId: `placement-${suffix}`,
    caption: "Frozen copied caption",
    sourceUrl: "https://example.com/copied-source",
    geometry: { ...geometry, x: 72, y: 92, zIndex: 1 },
    expectedProjectRevision,
    operationId: `copy-attachment-${suffix}`,
  };
}

function expectNoDestinationRows(
  database: ReturnType<typeof referenceTestDatabase>,
  suffix: string,
) {
  expect(database.prepare(`
    SELECT COUNT(*) AS count FROM project_contents WHERE id = ?
  `).get(`content-${suffix}`)).toEqual({ count: 0 });
  expect(database.prepare(`
    SELECT COUNT(*) AS count FROM project_items WHERE id = ?
  `).get(`item-${suffix}`)).toEqual({ count: 0 });
  expect(database.prepare(`
    SELECT COUNT(*) AS count FROM project_map_placements WHERE id = ?
  `).get(`placement-${suffix}`)).toEqual({ count: 0 });
  expect(database.prepare(`
    SELECT COUNT(*) AS count FROM project_content_attachments
    WHERE project_content_id = ?
  `).get(`content-${suffix}`)).toEqual({ count: 0 });
}

describe("Project attachment copy route", () => {
  it("authorizes the source occurrence, reuses only its server-side asset binding, and replays exactly", async () => {
    const { app, env, database } = fixture();
    await createProject(app, env, "project-copy");
    seedAsset(
      database,
      "asset-copy-source",
      "projects/copy/source.png",
    );
    await createSourceAttachment(
      app,
      env,
      "project-copy",
      { assetId: "asset-copy-source" },
    );

    const input = copyInput();
    const copied = await jsonRequest(
      app,
      env,
      "/projects/project-copy/items/attachment/copy",
      "POST",
      input,
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
        original_name: "asset-copy-source.png",
        mime_type: "image/png",
        byte_size: 42,
      },
      {
        project_content_id: "content-source",
        asset_id: "asset-copy-source",
        storage_object_id: null,
        original_name: "asset-copy-source.png",
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
      input,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json() as ProjectItemResponse).toMatchObject({ replayed: true });

    const locatorInjection = await jsonRequest(
      app,
      env,
      "/projects/project-copy/items/attachment/copy",
      "POST",
      { ...input, locator: { assetId: "another-asset" } },
    );
    expect(locatorInjection.status).toBe(400);
    expect(await locatorInjection.json()).toEqual({
      error: "Invalid Project attachment copy request",
    });
    database.close();
  });

  it("rolls back the whole copy when source removal interleaves after authorization read", async () => {
    const { app, env, database, adapter } = fixture();
    await createProject(app, env, "project-copy-race");
    seedAsset(
      database,
      "asset-copy-race",
      "projects/copy/race.png",
      18,
      "b",
    );
    await createSourceAttachment(
      app,
      env,
      "project-copy-race",
      { assetId: "asset-copy-race" },
      "create-source-race",
    );

    adapter.beforeNextBatch = async () => {
      const independent = new SqliteD1Database(database) as unknown as D1Database;
      await removeProjectItem(
        independent,
        "project-copy-race",
        "item-source",
        {
          expectedItemRevision: 1,
          expectedContentRevision: 1,
          operationId: "remove-source-in-copy-window",
        },
        ACTOR,
        "2026-08-17T00:01:00.000Z",
      );
    };

    const response = await jsonRequest(
      app,
      env,
      "/projects/project-copy-race/items/attachment/copy",
      "POST",
      copyInput(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Project revision, source attachment, blob, or identity conflict",
    });
    expect(database.prepare(`
      SELECT revision, next_created_sequence
      FROM projects WHERE id = 'project-copy-race'
    `).get()).toEqual({ revision: 2, next_created_sequence: 2 });
    expect(database.prepare(`
      SELECT deleted_at, revision FROM project_items WHERE id = 'item-source'
    `).get()).toMatchObject({ revision: 2 });
    expect(database.prepare(`
      SELECT deleted_at FROM project_items WHERE id = 'item-source'
    `).get()).not.toEqual({ deleted_at: null });
    expectNoDestinationRows(database, "copy");
    database.close();
  });

  it("allows exact replay after source removal but rejects a new copy from an inactive source", async () => {
    const { app, env, database } = fixture();
    await createProject(app, env, "project-copy-removal");
    seedAsset(
      database,
      "asset-copy-removal",
      "projects/copy/removal.png",
      21,
      "c",
    );
    await createSourceAttachment(
      app,
      env,
      "project-copy-removal",
      { assetId: "asset-copy-removal" },
      "create-source-removal",
    );
    const input = copyInput();
    expect((await jsonRequest(
      app,
      env,
      "/projects/project-copy-removal/items/attachment/copy",
      "POST",
      input,
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
      input,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json() as ProjectItemResponse).toMatchObject({ replayed: true });

    const rejected = await jsonRequest(
      app,
      env,
      "/projects/project-copy-removal/items/attachment/copy",
      "POST",
      copyInput(removedPayload.project.revision, "new-copy"),
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({
      error: "Source Project attachment is no longer active",
    });
    expectNoDestinationRows(database, "new-copy");
    database.close();
  });

  it("copies ready and orphaned managed-storage bindings and replays them exactly", async () => {
    for (const [index, status] of (["ready", "orphaned"] as const).entries()) {
      const { app, env, database } = fixture();
      const projectId = `project-managed-${status}`;
      const storageId = `storage-${status}`;
      await createProject(app, env, projectId);
      seedManagedStorage(
        database,
        storageId,
        `managed/copy/${status}.bin`,
        status,
        index === 0 ? "d" : "e",
      );
      await createSourceAttachment(
        app,
        env,
        projectId,
        { storageObjectId: storageId },
        `create-source-${status}`,
      );
      const input = copyInput();
      const copied = await jsonRequest(
        app,
        env,
        `/projects/${projectId}/items/attachment/copy`,
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
        storage_object_id: storageId,
        original_name: `${storageId}.bin`,
        mime_type: "application/octet-stream",
        byte_size: 17,
      });

      const replay = await jsonRequest(
        app,
        env,
        `/projects/${projectId}/items/attachment/copy`,
        "POST",
        input,
      );
      expect(replay.status).toBe(200);
      expect(await replay.json() as ProjectItemResponse).toMatchObject({ replayed: true });
      database.close();
    }
  });

  it("rejects new managed-storage copies after GC or quarantine while preserving exact replay", async () => {
    for (const [index, guard] of (["gc", "quarantine"] as const).entries()) {
      const { app, env, database } = fixture();
      const projectId = `project-managed-${guard}`;
      const storageId = `storage-${guard}`;
      const objectKey = `managed/copy/${guard}.bin`;
      await createProject(app, env, projectId);
      seedManagedStorage(
        database,
        storageId,
        objectKey,
        "ready",
        index === 0 ? "f" : "1",
      );
      await createSourceAttachment(
        app,
        env,
        projectId,
        { storageObjectId: storageId },
        `create-source-${guard}`,
      );
      const originalInput = copyInput();
      expect((await jsonRequest(
        app,
        env,
        `/projects/${projectId}/items/attachment/copy`,
        "POST",
        originalInput,
      )).status).toBe(201);

      if (guard === "gc") {
        database.prepare(`
          INSERT INTO blob_gc_ledger (
            store_kind, provider, object_key, blob_record_id, state,
            operation_id, deletion_started_at, updated_at
          ) VALUES (
            'managed', 'switchdrive', ?, ?, 'deleting',
            'delete-managed-copy', ?, ?
          )
        `).run(objectKey, storageId, NOW, NOW);
      } else {
        database.prepare(`
          INSERT INTO blob_integrity_quarantine (
            store_kind, provider, object_key, blob_record_id, reason,
            expected_byte_size, observed_byte_size, operation_id,
            detected_at, last_checked_at
          ) VALUES (
            'managed', 'switchdrive', ?, ?, 'size_mismatch',
            17, 18, 'quarantine-managed-copy', ?, ?
          )
        `).run(objectKey, storageId, NOW, NOW);
      }

      const replay = await jsonRequest(
        app,
        env,
        `/projects/${projectId}/items/attachment/copy`,
        "POST",
        originalInput,
      );
      expect(replay.status).toBe(200);
      expect(await replay.json() as ProjectItemResponse).toMatchObject({ replayed: true });

      const rejected = await jsonRequest(
        app,
        env,
        `/projects/${projectId}/items/attachment/copy`,
        "POST",
        copyInput(3, `guarded-${guard}`),
      );
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toEqual({
        error: "Project revision, source attachment, blob, or identity conflict",
      });
      expect(database.prepare(`
        SELECT revision, next_created_sequence FROM projects WHERE id = ?
      `).get(projectId)).toEqual({ revision: 3, next_created_sequence: 3 });
      expectNoDestinationRows(database, `guarded-${guard}`);
      database.close();
    }
  });

  it("does not authorize attachment content from another Project", async () => {
    const { app, env, database } = fixture();
    for (const projectId of ["project-source", "project-target"]) {
      await createProject(app, env, projectId);
    }
    seedAsset(
      database,
      "asset-cross-project",
      "projects/copy/cross.png",
      12,
      "2",
    );
    await createSourceAttachment(
      app,
      env,
      "project-source",
      { assetId: "asset-cross-project" },
      "create-cross-source",
    );

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
