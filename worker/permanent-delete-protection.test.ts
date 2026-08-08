import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { listPermanentDeleteBlockers } from "./blob-lifecycle/permanent-delete";

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
    if (this.bindings.length > 100) throw new Error("D1 binding limit exceeded");
    return this.database.prepare(this.query);
  }
  async first<T>() {
    return (this.statement().get(...this.bindings) as T | undefined) ?? null;
  }
  async all<T>() {
    return { success: true, results: this.statement().all(...this.bindings) as T[], meta: {} };
  }
  async run() {
    const result = this.statement().run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1Database {
  constructor(readonly database: DatabaseSync) {}
  prepare(query: string) {
    return new SqliteD1Statement(this.database, query);
  }
  async batch(statements: SqliteD1Statement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(filename, directory), "utf8"));
  }
  return database;
}

function seedGraph(database: DatabaseSync) {
  database.exec(`
    INSERT INTO samples (id, code, title, created_at, updated_at, deleted_at)
    VALUES ('sample-1', 'S-1', 'Sample', '2026-07-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    INSERT INTO recipe_families (id, name, template_type, created_at)
    VALUES ('family-1', 'Process', 'process', '2026-07-01T00:00:00.000Z');
    INSERT INTO template_versions
      (id, recipe_family_id, name, template_type, version, manifest_hash,
       content_json, created_at)
    VALUES ('template-1', 'family-1', 'Process', 'process', 1, 'manifest-1',
      '{}', '2026-07-01T00:00:00.000Z');
    INSERT INTO runs
      (id, sample_id, recipe_family_id, template_version_id, sequence_no,
       run_group_id, template_name_snapshot, template_type_snapshot,
       template_version_snapshot, status, created_at, deleted_at)
    VALUES ('run-1', 'sample-1', 'family-1', 'template-1', 1, 'group-1',
      'Process', 'process', 1, 'complete', '2026-07-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z');
    INSERT INTO run_steps
      (id, run_id, position, title, status, created_at, updated_at, deleted_at)
    VALUES ('step-1', 'run-1', 1000, 'Step', 'done',
      '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z');
    INSERT INTO events (id, sample_id, kind, body, created_at)
    VALUES ('event-1', 'sample-1', 'comment', 'Audit', '2026-07-01T00:00:00.000Z');
  `);
}

describe("permanent-delete protection", () => {
  it("blocks physical deletion before cascades can change descendants or audit history", () => {
    const database = migratedDatabase();
    seedGraph(database);
    const before = {
      samples: database.prepare("SELECT COUNT(*) AS count FROM samples").get(),
      runs: database.prepare("SELECT COUNT(*) AS count FROM runs").get(),
      steps: database.prepare("SELECT COUNT(*) AS count FROM run_steps").get(),
      events: database.prepare("SELECT COUNT(*) AS count FROM events").get(),
    };
    expect(() => database.prepare("DELETE FROM samples WHERE id = 'sample-1'").run())
      .toThrow(/physical deletion disabled for samples/);
    expect({
      samples: database.prepare("SELECT COUNT(*) AS count FROM samples").get(),
      runs: database.prepare("SELECT COUNT(*) AS count FROM runs").get(),
      steps: database.prepare("SELECT COUNT(*) AS count FROM run_steps").get(),
      events: database.prepare("SELECT COUNT(*) AS count FROM events").get(),
    }).toEqual(before);
    database.close();
  });

  it("protects every current stable source and occurrence table", () => {
    const database = migratedDatabase();
    const protectedTables = [
      "samples",
      "runs",
      "run_steps",
      "comment_submissions",
      "run_step_comments",
      "comment_submission_items",
      "run_step_assets",
      "metrology_template_references",
      "template_versions",
    ];
    const triggers = new Set((database.prepare(
      "SELECT tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_block_physical_delete'",
    ).all() as { tbl_name: string }[]).map((row) => row.tbl_name));
    expect([...triggers]).toEqual(expect.arrayContaining(protectedTables));
    database.close();
  });

  it("returns deterministic structural blockers while destructive authorization remains disabled", async () => {
    const database = migratedDatabase();
    seedGraph(database);
    const blockers = await listPermanentDeleteBlockers(
      new SqliteD1Database(database) as unknown as D1Database,
      { sourceType: "sample", sourceId: "sample-1" },
    );
    expect(blockers).toEqual([
      expect.objectContaining({ relation: "sample_events", blockerType: "event", blockerId: "event-1" }),
      expect.objectContaining({ relation: "sample_runs", blockerType: "run", blockerId: "run-1" }),
    ]);
    database.close();
  });

  it("still blocks deletion when a reverse reference appears after blocker planning", async () => {
    const database = migratedDatabase();
    seedGraph(database);
    const db = new SqliteD1Database(database) as unknown as D1Database;
    const planned = await listPermanentDeleteBlockers(
      db,
      { sourceType: "sample", sourceId: "sample-1" },
    );
    database.prepare(
      `INSERT INTO events (id, sample_id, kind, body, created_at)
       VALUES ('event-race', 'sample-1', 'comment', 'Concurrent audit reference',
         '2026-08-02T00:00:00.000Z')`,
    ).run();

    expect(() => database.prepare("DELETE FROM samples WHERE id = 'sample-1'").run())
      .toThrow(/physical deletion disabled for samples/);
    const finalBlockers = await listPermanentDeleteBlockers(
      db,
      { sourceType: "sample", sourceId: "sample-1" },
    );
    expect(planned.some((blocker) => blocker.blockerId === "event-race")).toBe(false);
    expect(finalBlockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relation: "sample_events",
        blockerType: "event",
        blockerId: "event-race",
      }),
    ]));
    database.close();
  });
});
