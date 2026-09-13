import type { DatabaseSync } from "node:sqlite";
import { referenceTestDatabase, seedReferenceGraph } from "./reference-test-support";
import { describe, expect, it } from "vitest";
import worker from "./index";
import type { Env } from "./types";

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly bindings: unknown[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new SqliteD1Statement(this.database, this.sql, values);
  }

  async all<T>() {
    return {
      results: this.database.prepare(this.sql).all(...this.bindings) as T[],
      success: true,
      meta: { changes: 0 },
    };
  }

  async first<T>() {
    return (this.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  }
}

function testDatabase() {
  const database = referenceTestDatabase();
  seedReferenceGraph(database);
  database.exec(`
    INSERT INTO samples
      (id, code, title, status, created_at, updated_at)
    VALUES
      ('sample-1', 'S-1', 'Sample', 'stored',
       '2026-07-24T10:00:00.000Z', '2026-07-24T10:00:00.000Z');
  `);
  return database;
}

function testEnv(database: DatabaseSync): Env {
  return {
    AUTH_MODE: "disabled",
    DB: {
      prepare: (sql: string) => new SqliteD1Statement(database, sql),
      batch: (statements: SqliteD1Statement[]) => Promise.all(statements.map((statement) => statement.run())),
    } as unknown as D1Database,
    ASSETS: {} as R2Bucket,
  };
}

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

function request(env: Env, path: string, method: "POST" | "PATCH", body: unknown) {
  return worker.fetch(new Request(`https://app.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env, executionContext);
}

describe("metrology lifecycle routes", () => {
  it("synchronizes sample status and accepts post-completion result edits", async () => {
    const database = testDatabase();
    const env = testEnv(database);

    const startResponse = await request(env, "/api/samples/sample-1/metrology-runs", "POST", {
      templateVersionId: "reference-metrology-template",
    });
    const { id: runId } = await startResponse.json() as { id: string };
    const started = database.prepare(
      `SELECT r.status AS run_status, s.status AS sample_status, rs.id AS step_id, rs.updated_at
       FROM runs r
       JOIN samples s ON s.id = r.sample_id
       JOIN run_steps rs ON rs.run_id = r.id
       WHERE r.id = ?`,
    ).get(runId) as { run_status: string; sample_status: string; step_id: string; updated_at: string };

    expect(startResponse.status).toBe(201);
    expect(started).toMatchObject({ run_status: "active", sample_status: "active" });

    const doneResponse = await request(
      env,
      `/api/samples/sample-1/runs/${runId}/steps/${started.step_id}`,
      "PATCH",
      {
        status: "done",
        title: "AFM",
        toolName: "",
        parametersText: "",
        commentsText: "",
        deviationNote: "",
        notes: "",
        expectedUpdatedAt: started.updated_at,
      },
    );
    const completed = database.prepare(
      `SELECT r.status AS run_status, s.status AS sample_status, rs.updated_at
       FROM runs r
       JOIN samples s ON s.id = r.sample_id
       JOIN run_steps rs ON rs.run_id = r.id
       WHERE r.id = ?`,
    ).get(runId) as { run_status: string; sample_status: string; updated_at: string };

    expect(doneResponse.status).toBe(200);
    expect(completed).toMatchObject({ run_status: "complete", sample_status: "stored" });

    const editResponse = await request(
      env,
      `/api/samples/sample-1/runs/${runId}/steps/${started.step_id}`,
      "PATCH",
      {
        status: "done",
        title: "AFM",
        toolName: "Dimension 3100",
        parametersText: "Flatten order 1",
        commentsText: "Post-processing completed",
        deviationNote: "",
        notes: "",
        expectedUpdatedAt: completed.updated_at,
      },
    );
    const edited = database.prepare(
      `SELECT r.status AS run_status, s.status AS sample_status,
              rs.tool_name, rs.parameters_text, rs.comments_text
       FROM runs r
       JOIN samples s ON s.id = r.sample_id
       JOIN run_steps rs ON rs.run_id = r.id
       WHERE r.id = ?`,
    ).get(runId);

    expect(editResponse.status).toBe(200);
    expect(edited).toEqual({
      run_status: "complete",
      sample_status: "stored",
      tool_name: "Dimension 3100",
      parameters_text: "Flatten order 1",
      comments_text: "Post-processing completed",
    });
    database.close();
  });
});
