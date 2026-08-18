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

const ACTOR = "mutation-disposition@example.com";
const NOW = "2026-08-18T08:00:00.000Z";
const geometry = { x: 0, y: 0, width: 320, height: 180, zIndex: 0 };

function fixture() {
  const database = referenceTestDatabase();
  const adapter = new SqliteD1Database(database);
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
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
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
) {
  database.prepare(`
    INSERT INTO assets (
      id, r2_key, original_name, mime_type, byte_size,
      status, created_at, sha256
    ) VALUES (?, ?, ?, 'image/png', 42, 'ready', ?, ?)
  `).run(id, `projects/${id}.png`, `${id}.png`, NOW, "a".repeat(64));
}

describe("Project mutation settlement disposition", () => {
  it("marks a monotonic revision mismatch as authoritative rejection", async () => {
    const { app, env, database } = fixture();
    await createProject(app, env, "project-monotonic");
    const created = await jsonRequest(
      app,
      env,
      "/projects/project-monotonic/items/markdown",
      "POST",
      {
        contentId: "content-monotonic",
        itemId: "item-monotonic",
        placementId: "placement-monotonic",
        markdownSource: "# Monotonic",
        geometry,
        expectedProjectRevision: 1,
        operationId: "create-markdown-monotonic",
      },
    );
    expect(created.status).toBe(201);

    const stale = await jsonRequest(
      app,
      env,
      "/projects/project-monotonic/placements/placement-monotonic",
      "PATCH",
      {
        geometry: { ...geometry, x: 10 },
        expectedRevision: 99,
        operationId: "stale-placement-monotonic",
      },
    );
    expect(stale.status).toBe(409);
    expect(stale.headers.get("x-project-mutation-disposition")).toBe(
      "authoritative-rejection",
    );
    expect(await stale.json()).toEqual({ error: "Placement revision conflict" });
    database.close();
  });

  it("leaves reversible Reference unavailability unmarked while Project revision is unchanged", async () => {
    const { app, env, database } = fixture();
    await createProject(app, env, "project-reference-reversible");

    const rejected = await jsonRequest(
      app,
      env,
      "/projects/project-reference-reversible/items/reference",
      "POST",
      {
        itemId: "item-reference-reversible",
        placementId: "placement-reference-reversible",
        target: { type: "sample", id: "sample-that-does-not-exist" },
        geometry,
        expectedProjectRevision: 1,
        operationId: "create-reference-reversible",
      },
    );
    expect(rejected.status).toBe(409);
    expect(rejected.headers.get("x-project-mutation-disposition")).toBeNull();
    expect(await rejected.json()).toEqual({
      error: "The reference target is not currently eligible for Project insertion",
    });
    expect(database.prepare(`
      SELECT revision FROM projects WHERE id = 'project-reference-reversible'
    `).get()).toEqual({ revision: 1 });
    database.close();
  });

  it("leaves inactive attachment-source rejection unmarked when item lifecycle does not advance Project revision", async () => {
    const { app, env, database } = fixture();
    await createProject(app, env, "project-attachment-reversible");
    seedAsset(database, "asset-reversible");

    const source = await jsonRequest(
      app,
      env,
      "/projects/project-attachment-reversible/items/attachment",
      "POST",
      {
        contentId: "content-source",
        itemId: "item-source",
        placementId: "placement-source",
        locator: { assetId: "asset-reversible" },
        caption: null,
        sourceUrl: null,
        geometry,
        expectedProjectRevision: 1,
        operationId: "create-source-reversible",
      },
    );
    expect(source.status).toBe(201);

    const removed = await jsonRequest(
      app,
      env,
      "/projects/project-attachment-reversible/items/item-source",
      "DELETE",
      {
        expectedItemRevision: 1,
        expectedContentRevision: 1,
        operationId: "remove-source-reversible",
      },
    );
    expect(removed.status).toBe(200);
    expect(database.prepare(`
      SELECT revision FROM projects WHERE id = 'project-attachment-reversible'
    `).get()).toEqual({ revision: 2 });

    const rejected = await jsonRequest(
      app,
      env,
      "/projects/project-attachment-reversible/items/attachment/copy",
      "POST",
      {
        sourceContentId: "content-source",
        contentId: "content-copy-reversible",
        itemId: "item-copy-reversible",
        placementId: "placement-copy-reversible",
        caption: null,
        sourceUrl: null,
        geometry: { ...geometry, x: 32, y: 32, zIndex: 1 },
        expectedProjectRevision: 2,
        operationId: "copy-source-reversible",
      },
    );
    expect(rejected.status).toBe(409);
    expect(rejected.headers.get("x-project-mutation-disposition")).toBeNull();
    expect(await rejected.json()).toEqual({
      error: "Source Project attachment is no longer active",
    });
    database.close();
  });
});