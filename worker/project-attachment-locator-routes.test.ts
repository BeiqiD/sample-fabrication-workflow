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
  it("rejects null, numeric, and simultaneously present locator keys", async () => {
    const { app, env, database } = fixture();
    const created = await jsonRequest(app, env, "/projects", "POST", {
      id: "project-locator-route",
      title: "Locator Route",
      operationId: "create-project-locator-route",
    });
    expect(created.status).toBe(201);

    const locators = [
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
});
