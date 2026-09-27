import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import worker from "./index";
import type { Env } from "./types";

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    readonly query: string,
    readonly bindings: unknown[] = [],
  ) {}

  bind(...bindings: unknown[]) {
    return new SqliteD1Statement(this.database, this.query, bindings);
  }

  private statement(): StatementSync {
    return this.database.prepare(this.query);
  }

  async first<T>() {
    return (this.statement().get(...this.bindings) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      success: true,
      results: this.statement().all(...this.bindings) as T[],
      meta: {},
    };
  }

  async run() {
    return this.execute();
  }

  execute() {
    const statement = this.statement();
    const before = Number(this.database.prepare("SELECT total_changes() AS count").get()?.count);
    const results = statement.columns().length > 0
      ? statement.all(...this.bindings)
      : (statement.run(...this.bindings), []);
    return {
      success: true,
      meta: { changes: Number(this.database.prepare("SELECT total_changes() AS count").get()?.count) - before },
      results,
    };
  }
}

class SqliteD1Database {
  lastBatch: ReturnType<SqliteD1Statement["execute"]>[] = [];

  constructor(readonly database: DatabaseSync, private readonly beforeBatch?: () => void) {}

  prepare(query: string) {
    return new SqliteD1Statement(this.database, query);
  }

  async batch(statements: SqliteD1Statement[]) {
    this.beforeBatch?.();
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.lastBatch = results;
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  const migrationDirectory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(filename, migrationDirectory), "utf8"));
  }
  database.exec(`
    INSERT INTO samples (id, code, title, status, created_at, updated_at)
    VALUES ('sample-1', 'S-1', 'Sample', 'active',
            '2026-07-29T10:00:00.000Z', '2026-07-29T10:10:00.000Z');

    INSERT INTO recipe_families (id, name, template_type, created_at)
    VALUES ('family-1', 'Process', 'process', '2026-07-29T10:00:00.000Z');

    INSERT INTO template_versions
      (id, recipe_family_id, name, template_type, version, manifest_hash, content_json, created_at)
    VALUES
      ('template-1', 'family-1', 'Process', 'process', 1, 'manifest-1', '{}',
       '2026-07-29T10:00:00.000Z');

    INSERT INTO runs
      (id, sample_id, recipe_family_id, template_version_id, sequence_no, run_group_id,
       template_name_snapshot, template_type_snapshot, template_version_snapshot,
       status, created_at, run_kind)
    VALUES
      ('run-1', 'sample-1', 'family-1', 'template-1', 1, 'group-1',
       'Process', 'process', 1, 'active', '2026-07-29T10:00:00.000Z', 'process');

    INSERT INTO run_steps
      (id, run_id, position, status, origin, entry_kind, created_at, updated_at)
    VALUES
      ('step-done', 'run-1', 1000, 'done', 'template', 'fabrication',
       '2026-07-29T10:00:00.000Z', '2026-07-29T10:05:00.000Z'),
      ('step-pending', 'run-1', 2000, 'pending', 'template', 'fabrication',
       '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z'),
      ('step-blocked', 'run-1', 3000, 'blocked', 'template', 'fabrication',
       '2026-07-29T10:00:00.000Z', '2026-07-29T10:06:00.000Z'),
      ('inline-metrology', 'run-1', 4000, 'pending', 'ad_hoc', 'metrology',
       '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z');
  `);
  return database;
}

function testEnv(database: DatabaseSync): Env {
  return {
    AUTH_MODE: "disabled",
    DB: new SqliteD1Database(database),
    ASSETS: {},
  } as unknown as Env;
}

function finishRequest(env: Env, body: {
  expectedSampleUpdatedAt: string;
  confirmSkipUnfinishedSteps?: boolean;
}) {
  return worker.fetch(new Request(
    "https://samples.run/api/samples/sample-1/runs/run-1/finish",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  ), env, {} as ExecutionContext);
}

describe("finish process run route", () => {
  it("requires explicit confirmation before skipping unfinished fabrication steps", async () => {
    const database = createDatabase();
    const env = testEnv(database);

    const blocked = await finishRequest(env, {
      expectedSampleUpdatedAt: "2026-07-29T10:10:00.000Z",
    });

    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({
      error: "Finishing this run will mark 2 unfinished steps as skipped. Confirm this action before continuing.",
    });
    expect(database.prepare("SELECT status FROM runs WHERE id = 'run-1'").get())
      .toEqual({ status: "active" });
    expect(database.prepare(
      "SELECT id, status FROM run_steps WHERE id IN ('step-pending', 'step-blocked') ORDER BY id",
    ).all()).toEqual([
      { id: "step-blocked", status: "blocked" },
      { id: "step-pending", status: "pending" },
    ]);
    database.close();
  });

  it("atomically skips the confirmed steps, completes the run, and records the batch", async () => {
    const database = createDatabase();
    const env = testEnv(database);

    const response = await finishRequest(env, {
      expectedSampleUpdatedAt: "2026-07-29T10:10:00.000Z",
      confirmSkipUnfinishedSteps: true,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, skippedStepCount: 2 });
    // Native D1 includes shadow trigger writes in meta.changes. Only the two
    // returned run_steps rows count towards the exact completion fence.
    const batch = (env.DB as unknown as SqliteD1Database).lastBatch;
    expect(batch[1].meta.changes).toBeGreaterThan(2);
    expect(batch[1].results).toHaveLength(2);
    expect(database.prepare(
      "SELECT status, completed_at FROM runs WHERE id = 'run-1'",
    ).get()).toEqual({ status: "complete", completed_at: expect.any(String) });
    expect(database.prepare(
      `SELECT id, status, actualized_at, updated_by
       FROM run_steps WHERE id IN ('step-pending', 'step-blocked') ORDER BY id`,
    ).all()).toEqual([
      {
        id: "step-blocked",
        status: "skipped",
        actualized_at: expect.any(String),
        updated_by: "local-development",
      },
      {
        id: "step-pending",
        status: "skipped",
        actualized_at: expect.any(String),
        updated_by: "local-development",
      },
    ]);
    expect(database.prepare("SELECT status FROM run_steps WHERE id = 'inline-metrology'").get())
      .toEqual({ status: "pending" });
    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "stored" });

    const event = database.prepare(
      `SELECT body, metadata_json FROM events
       WHERE sample_id = 'sample-1' AND kind = 'run'
       ORDER BY created_at DESC LIMIT 1`,
    ).get() as { body: string; metadata_json: string };
    expect(event.body).toContain("2 unfinished steps marked skipped");
    expect(JSON.parse(event.metadata_json)).toEqual({
      action: "process_run_finished",
      runId: "run-1",
      skippedUnfinishedStepCount: 2,
      skippedUnfinishedStepIds: ["step-pending", "step-blocked"],
    });
    database.close();
  });

  it("keeps the sample revision fence when another request wins before the batch", async () => {
    const database = createDatabase();
    const env = testEnv(database);
    env.DB = new SqliteD1Database(database, () => {
      database.prepare("UPDATE samples SET updated_at = ? WHERE id = 'sample-1'")
        .run("2026-07-29T10:11:00.000Z");
    }) as unknown as D1Database;
    try {
      const response = await finishRequest(env, {
        expectedSampleUpdatedAt: "2026-07-29T10:10:00.000Z",
        confirmSkipUnfinishedSteps: true,
      });
      expect(response.status).toBe(409);
      expect(database.prepare("SELECT status FROM runs WHERE id = 'run-1'").get())
        .toEqual({ status: "active" });
      expect(database.prepare("SELECT id, status FROM run_steps WHERE id IN ('step-pending', 'step-blocked') ORDER BY id").all())
        .toEqual([{ id: "step-blocked", status: "blocked" }, { id: "step-pending", status: "pending" }]);
      expect(database.prepare("SELECT id FROM events WHERE kind = 'run'").all()).toEqual([]);
    } finally { database.close(); }
  });

  it("finishes a run with no unfinished steps using an exact zero-row result", async () => {
    const database = createDatabase();
    database.exec(`
      UPDATE run_steps SET status = 'done' WHERE entry_kind = 'fabrication';
      UPDATE runs SET status = 'active' WHERE id = 'run-1';
    `);
    const env = testEnv(database);
    try {
      const response = await finishRequest(env, {
        expectedSampleUpdatedAt: "2026-07-29T10:10:00.000Z",
      });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, skippedStepCount: 0 });
      expect((env.DB as unknown as SqliteD1Database).lastBatch[1].results).toEqual([]);
      expect(database.prepare("SELECT status FROM runs WHERE id = 'run-1'").get())
        .toEqual({ status: "complete" });
    } finally { database.close(); }
  });
});
