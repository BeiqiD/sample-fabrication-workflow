import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../migrations/0001_alpha_state_chain.sql", import.meta.url), "utf8"));
  database.exec("ALTER TABLE samples ADD COLUMN deleted_at TEXT; ALTER TABLE samples ADD COLUMN deleted_by TEXT;");
  database.prepare(
    `INSERT INTO samples
      (id, code, title, description, status, location, pinned, created_at, updated_at)
     VALUES ('sample-1', 'S-001', 'Sample one', 'Initial description', 'stored', 'Box 1', 1,
             '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z')`,
  ).run();
  return database;
}

function testEnv(database: DatabaseSync): Env {
  return {
    AUTH_MODE: "disabled",
    DB: {
      prepare: (sql: string) => new SqliteD1Statement(database, sql),
      batch: async (statements: SqliteD1Statement[]) => Promise.all(statements.map((statement) => statement.run())),
    } as unknown as D1Database,
    ASSETS: {} as R2Bucket,
  };
}

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

async function patch(env: Env, input: Record<string, unknown>) {
  return worker.fetch(new Request("https://app.test/api/samples/sample-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }), env, executionContext);
}

describe("sample description update route", () => {
  it("updates and clears Description without changing other sample details", async () => {
    const database = testDatabase();
    const env = testEnv(database);

    const updateResponse = await patch(env, {
      description: "  Updated sample context  ",
      expectedUpdatedAt: "2026-08-01T10:00:00.000Z",
    });
    expect(updateResponse.status).toBe(200);
    const updated = database.prepare(
      "SELECT title, description, status, location, pinned, updated_at FROM samples WHERE id = 'sample-1'",
    ).get() as Record<string, unknown>;
    expect(updated).toMatchObject({
      title: "Sample one",
      description: "Updated sample context",
      status: "stored",
      location: "Box 1",
      pinned: 1,
    });

    const clearResponse = await patch(env, {
      description: "   ",
      expectedUpdatedAt: String(updated.updated_at),
    });
    expect(clearResponse.status).toBe(200);
    const cleared = database.prepare("SELECT description FROM samples WHERE id = 'sample-1'").get() as { description: string | null };
    expect(cleared.description).toBeNull();
  });

  it("rejects a Description longer than the existing 10,000-character limit", async () => {
    const database = testDatabase();
    const response = await patch(testEnv(database), {
      description: "x".repeat(10_001),
      expectedUpdatedAt: "2026-08-01T10:00:00.000Z",
    });
    const payload = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Description is too long");
    const row = database.prepare("SELECT description, updated_at FROM samples WHERE id = 'sample-1'").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      description: "Initial description",
      updated_at: "2026-08-01T10:00:00.000Z",
    });
  });
});
