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

type WrappedStatement = {
  bind: (...values: unknown[]) => WrappedStatement;
  all: <T>() => Promise<{ results: T[]; success: boolean; meta: { changes: number } }>;
  first: <T>() => Promise<T | null>;
  run: () => Promise<unknown>;
  execute: () => unknown;
};

const ACTOR = "mutation-disposition@example.com";
const NOW = "2026-08-18T08:00:00.000Z";
const geometry = { x: 0, y: 0, width: 320, height: 180, zIndex: 0 };

function wrapStatement(
  statement: any,
  beforeExecute: () => void,
): WrappedStatement {
  return {
    bind: (...values: unknown[]) => wrapStatement(
      statement.bind(...values),
      beforeExecute,
    ),
    all: <T>() => statement.all() as Promise<{
      results: T[];
      success: boolean;
      meta: { changes: number };
    }>,
    first: <T>() => statement.first() as Promise<T | null>,
    run: async () => {
      beforeExecute();
      return statement.run();
    },
    execute: () => {
      beforeExecute();
      return statement.execute();
    },
  };
}

function fixture(options: { projectDeleteRaceId?: string } = {}) {
  const database = referenceTestDatabase();
  const adapter = new SqliteD1Database(database);
  let deleteRaceArmed = false;
  const deleteRaceId = options.projectDeleteRaceId ?? null;
  const originalPrepare = adapter.prepare.bind(adapter);
  const routedDatabase = {
    prepare(sql: string) {
      const statement = originalPrepare(sql);
      if (!deleteRaceId || !/^\s*UPDATE\s+project_map_placements\b/i.test(sql)) {
        return statement;
      }
      return wrapStatement(statement, () => {
        if (!deleteRaceArmed) return;
        deleteRaceArmed = false;
        database.prepare(`
          UPDATE projects
          SET deleted_at = ?, deleted_by = ?, deletion_operation_id = ?,
              revision = revision + 1, last_mutation_id = ?,
              updated_by = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `).run(
          "2026-08-18T08:01:00.000Z",
          ACTOR,
          "delete-project-placement-race",
          "delete-project-placement-race",
          ACTOR,
          "2026-08-18T08:01:00.000Z",
          deleteRaceId,
        );
      }) as unknown as ReturnType<SqliteD1Database["prepare"]>;
    },
    batch: adapter.batch.bind(adapter),
  } as unknown as D1Database;
  const env = {
    DB: routedDatabase,
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
  return {
    app,
    env,
    database,
    armProjectDeleteRace() {
      if (!deleteRaceId) throw new Error("No Project deletion race was configured");
      deleteRaceArmed = true;
    },
  };
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

async function createMarkdown(
  app: Hono<AppBindings>,
  env: Env,
  projectId: string,
  suffix: string,
  expectedProjectRevision: number,
  placementGeometry = geometry,
) {
  return jsonRequest(
    app,
    env,
    `/projects/${projectId}/items/markdown`,
    "POST",
    {
      contentId: `content-${suffix}`,
      itemId: `item-${suffix}`,
      placementId: `placement-${suffix}`,
      markdownSource: `# ${suffix}`,
      geometry: placementGeometry,
      expectedProjectRevision,
      operationId: `create-markdown-${suffix}`,
    },
  );
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

function disposition(response: Response) {
  return response.headers.get("x-project-mutation-disposition");
}

describe("Project mutation settlement disposition", () => {
  it("leaves a future Project revision unmarked and later accepts the same frozen request", async () => {
    const { app, env, database } = fixture();
    await createProject(app, env, "project-future-revision");

    const frozenBody = {
      contentId: "content-future",
      itemId: "item-future",
      placementId: "placement-future",
      markdownSource: "# Future",
      geometry,
      expectedProjectRevision: 2,
      operationId: "create-markdown-future",
    };
    const future = await jsonRequest(
      app,
      env,
      "/projects/project-future-revision/items/markdown",
      "POST",
      frozenBody,
    );
    expect(future.status).toBe(409);
    expect(disposition(future)).toBeNull();

    const filler = await createMarkdown(
      app,
      env,
      "project-future-revision",
      "future-filler",
      1,
    );
    expect(filler.status).toBe(201);

    const committed = await jsonRequest(
      app,
      env,
      "/projects/project-future-revision/items/markdown",
      "POST",
      frozenBody,
    );
    expect(committed.status).toBe(201);
    expect(disposition(committed)).toBeNull();
    database.close();
  });

  it("marks a Project revision only when the current revision is strictly greater", async () => {
    const { app, env, database } = fixture();
    await createProject(app, env, "project-stale-revision");
    expect((await createMarkdown(
      app,
      env,
      "project-stale-revision",
      "stale-filler",
      1,
    )).status).toBe(201);

    const stale = await createMarkdown(
      app,
      env,
      "project-stale-revision",
      "stale-request",
      1,
    );
    expect(stale.status).toBe(409);
    expect(disposition(stale)).toBe("authoritative-rejection");
    database.close();
  });

  it("leaves a future placement revision unmarked and accepts it after revision catches up", async () => {
    const { app, env, database } = fixture();
    await createProject(app, env, "project-future-placement");
    expect((await createMarkdown(
      app,
      env,
      "project-future-placement",
      "future-placement",
      1,
    )).status).toBe(201);

    const frozenBody = {
      geometry: { ...geometry, x: 20 },
      expectedRevision: 2,
      operationId: "future-placement-update",
    };
    const future = await jsonRequest(
      app,
      env,
      "/projects/project-future-placement/placements/placement-future-placement",
      "PATCH",
      frozenBody,
    );
    expect(future.status).toBe(409);
    expect(disposition(future)).toBeNull();

    const advance = await jsonRequest(
      app,
      env,
      "/projects/project-future-placement/placements/placement-future-placement",
      "PATCH",
      {
        geometry: { ...geometry, x: 10 },
        expectedRevision: 1,
        operationId: "advance-placement-to-two",
      },
    );
    expect(advance.status).toBe(200);

    const committed = await jsonRequest(
      app,
      env,
      "/projects/project-future-placement/placements/placement-future-placement",
      "PATCH",
      frozenBody,
    );
    expect(committed.status).toBe(200);
    database.close();
  });

  it("marks a placement revision only after the row has advanced beyond expected", async () => {
    const { app, env, database } = fixture();
    await createProject(app, env, "project-stale-placement");
    expect((await createMarkdown(
      app,
      env,
      "project-stale-placement",
      "stale-placement",
      1,
    )).status).toBe(201);
    expect((await jsonRequest(
      app,
      env,
      "/projects/project-stale-placement/placements/placement-stale-placement",
      "PATCH",
      {
        geometry: { ...geometry, x: 10 },
        expectedRevision: 1,
        operationId: "advance-stale-placement",
      },
    )).status).toBe(200);

    const stale = await jsonRequest(
      app,
      env,
      "/projects/project-stale-placement/placements/placement-stale-placement",
      "PATCH",
      {
        geometry: { ...geometry, x: 30 },
        expectedRevision: 1,
        operationId: "stale-placement-request",
      },
    );
    expect(stale.status).toBe(409);
    expect(disposition(stale)).toBe("authoritative-rejection");
    database.close();
  });

  it("keeps a Project delete/restore placement race unmarked until the frozen request commits", async () => {
    const projectId = "project-placement-delete-race";
    const {
      app,
      env,
      database,
      armProjectDeleteRace,
    } = fixture({ projectDeleteRaceId: projectId });
    await createProject(app, env, projectId);
    expect((await createMarkdown(
      app,
      env,
      projectId,
      "placement-delete-race",
      1,
    )).status).toBe(201);

    const frozenBody = {
      geometry: { ...geometry, x: 42 },
      expectedRevision: 1,
      operationId: "placement-after-project-restore",
    };
    armProjectDeleteRace();
    const raced = await jsonRequest(
      app,
      env,
      `/projects/${projectId}/placements/placement-placement-delete-race`,
      "PATCH",
      frozenBody,
    );
    expect(raced.status).toBe(409);
    expect(disposition(raced)).toBeNull();
    expect(database.prepare(`
      SELECT revision FROM project_map_placements
      WHERE id = 'placement-placement-delete-race'
    `).get()).toEqual({ revision: 1 });

    const project = database.prepare(`
      SELECT revision, deleted_at FROM projects WHERE id = ?
    `).get(projectId) as { revision: number; deleted_at: string | null };
    expect(project.deleted_at).not.toBeNull();
    const restored = await jsonRequest(
      app,
      env,
      `/projects/${projectId}/restore`,
      "POST",
      {
        expectedRevision: project.revision,
        operationId: "restore-project-placement-race",
      },
    );
    expect(restored.status).toBe(200);

    const committed = await jsonRequest(
      app,
      env,
      `/projects/${projectId}/placements/placement-placement-delete-race`,
      "PATCH",
      frozenBody,
    );
    expect(committed.status).toBe(200);
    database.close();
  });

  it("marks an immutable destination identity collision without using an error-message allowlist", async () => {
    const { app, env, database } = fixture();
    await createProject(app, env, "project-identity-collision");
    expect((await createMarkdown(
      app,
      env,
      "project-identity-collision",
      "identity-original",
      1,
    )).status).toBe(201);

    const collision = await jsonRequest(
      app,
      env,
      "/projects/project-identity-collision/items/markdown",
      "POST",
      {
        contentId: "content-identity-collision",
        itemId: "item-identity-original",
        placementId: "placement-identity-collision",
        markdownSource: "# Different payload",
        geometry,
        expectedProjectRevision: 2,
        operationId: "create-markdown-identity-collision",
      },
    );
    expect(collision.status).toBe(409);
    expect(disposition(collision)).toBe("authoritative-rejection");
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
    expect(disposition(rejected)).toBeNull();
    expect(await rejected.json()).toEqual({
      error: "The reference target is not currently eligible for Project insertion",
    });
    expect(database.prepare(`
      SELECT revision FROM projects WHERE id = 'project-reference-reversible'
    `).get()).toEqual({ revision: 1 });
    database.close();
  });

  it("leaves inactive attachment-source rejection unmarked when Project revision has not advanced beyond expected", async () => {
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
    expect(disposition(rejected)).toBeNull();
    expect(await rejected.json()).toEqual({
      error: "Source Project attachment is no longer active",
    });
    database.close();
  });
});
