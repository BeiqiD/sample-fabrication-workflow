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
    const result = this.statement().run(...this.bindings);
    return {
      success: true,
      meta: { changes: Number(result.changes) },
      results: [],
    };
  }
}

class SqliteD1Database {
  constructor(readonly database: DatabaseSync) {}

  prepare(query: string) {
    return new SqliteD1Statement(this.database, query);
  }

  async batch(statements: SqliteD1Statement[]) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
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
    INSERT INTO recipe_families (id, name, template_type, created_at)
    VALUES
      ('family-process', 'Process', 'process', '2026-07-30T10:00:00.000Z'),
      ('family-metrology', 'Metrology', 'process', '2026-07-30T10:00:00.000Z');

    INSERT INTO template_versions
      (id, recipe_family_id, name, template_type, template_kind, version,
       manifest_hash, content_json, created_at)
    VALUES
      ('template-process', 'family-process', 'Process', 'process', 'process', 1,
       'manifest-process', '{}', '2026-07-30T10:00:00.000Z'),
      ('template-metrology', 'family-metrology', 'Metrology', 'process', 'metrology', 1,
       'manifest-metrology', '{}', '2026-07-30T10:00:00.000Z');
  `);
  return database;
}

function addSample(database: DatabaseSync, id = "sample-1") {
  database.prepare(
    `INSERT INTO samples (id, code, title, status, created_at, updated_at)
     VALUES (?, ?, 'Sample', 'stored', '2026-07-30T10:00:00.000Z', '2026-07-30T10:00:00.000Z')`,
  ).run(id, id);
}

function testEnv(database: DatabaseSync): Env {
  return {
    AUTH_MODE: "disabled",
    DB: new SqliteD1Database(database),
    ASSETS: {},
  } as unknown as Env;
}

function deleteRequest(env: Env, runId: string, expectedSampleUpdatedAt: string) {
  return worker.fetch(new Request(
    `https://samples.run/api/samples/sample-1/runs/${runId}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedSampleUpdatedAt }),
    },
  ), env, {} as ExecutionContext);
}

describe("delete run route", () => {
  it("removes an active run while preserving text timeline history and orphaning its files", async () => {
    const database = createDatabase();
    addSample(database);
    database.exec(`
      INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, sequence_no, run_group_id,
         template_name_snapshot, template_type_snapshot, template_version_snapshot,
         status, created_at, run_kind)
      VALUES
        ('run-delete', 'sample-1', 'family-process', 'template-process', 1, 'group-delete',
         'Process', 'process', 1, 'active', '2026-07-30T10:05:00.000Z', 'process');

      INSERT INTO run_steps
        (id, run_id, position, status, origin, entry_kind, created_at, updated_at)
      VALUES
        ('step-delete', 'run-delete', 1000, 'pending', 'template', 'fabrication',
         '2026-07-30T10:05:00.000Z', '2026-07-30T10:05:00.000Z');

      INSERT INTO assets
        (id, r2_key, original_name, mime_type, byte_size, status, created_at)
      VALUES
        ('asset-1', 'asset-key', 'image.png', 'image/png', 123, 'ready',
         '2026-07-30T10:05:00.000Z');

      INSERT INTO run_step_assets (id, run_step_id, asset_id, role, created_at)
      VALUES ('step-asset', 'step-delete', 'asset-1', 'execution', '2026-07-30T10:05:00.000Z');

      INSERT INTO managed_storage_objects
        (id, provider, object_key, original_name, mime_type, byte_size, sha256, status, created_at)
      VALUES
        ('storage-1', 'test', 'object-1', 'result.dat', 'application/octet-stream',
         456, 'storage-hash', 'ready', '2026-07-30T10:05:00.000Z');

      INSERT INTO comment_submissions
        (id, context_kind, scope, body, status, created_at, updated_at)
      VALUES
        ('submission-delete', 'run_steps', 'individual', 'Delete this comment', 'ready',
         '2026-07-30T10:06:00.000Z', '2026-07-30T10:06:00.000Z');

      INSERT INTO comment_submission_targets
        (submission_id, sample_id, run_id, run_step_id, expected_updated_at)
      VALUES
        ('submission-delete', 'sample-1', 'run-delete', 'step-delete',
         '2026-07-30T10:05:00.000Z');

      INSERT INTO comment_submission_items
        (id, submission_id, kind, status, position, filename, storage_object_id,
         created_at, updated_at)
      VALUES
        ('item-delete', 'submission-delete', 'attachment', 'ready', 0, 'result.dat',
         'storage-1', '2026-07-30T10:06:00.000Z', '2026-07-30T10:06:00.000Z');

      INSERT INTO run_step_comments
        (id, run_step_id, scope, body, submission_id, created_at)
      VALUES
        ('comment-delete', 'step-delete', 'individual', 'Delete this comment',
         'submission-delete', '2026-07-30T10:06:00.000Z');

      INSERT INTO events
        (id, sample_id, kind, body, asset_key, metadata_json, created_at)
      VALUES
        ('run-event', 'sample-1', 'step', 'Executed a step', 'asset-key',
         '{"runId":"run-delete","stepId":"step-delete","thumbnailKey":"thumb-key"}',
         '2026-07-30T10:06:00.000Z'),
        ('comment-event', 'sample-1', 'comment', 'Step comment: Delete this comment', NULL,
         '{"action":"comment_submission","submissionId":"submission-delete"}',
         '2026-07-30T10:06:00.000Z');
    `);

    const response = await deleteRequest(testEnv(database), "run-delete", "2026-07-30T10:05:00.000Z");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, updatedAt: expect.any(String) });
    expect(database.prepare("SELECT COUNT(*) AS count FROM runs WHERE id = 'run-delete'").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM run_steps WHERE id = 'step-delete'").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM run_step_comments WHERE id = 'comment-delete'").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM run_step_assets WHERE id = 'step-asset'").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT status FROM comment_submissions WHERE id = 'submission-delete'").get())
      .toEqual({ status: "cancelled" });
    expect(database.prepare("SELECT status FROM managed_storage_objects WHERE id = 'storage-1'").get())
      .toEqual({ status: "orphaned" });
    expect(database.prepare("SELECT status FROM assets WHERE id = 'asset-1'").get())
      .toEqual({ status: "ready" });
    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "stored" });

    const runEvent = database.prepare(
      "SELECT body, asset_key, metadata_json FROM events WHERE id = 'run-event'",
    ).get() as { body: string; asset_key: string | null; metadata_json: string };
    expect(runEvent.body).toBe("Executed a step");
    expect(runEvent.asset_key).toBeNull();
    expect(JSON.parse(runEvent.metadata_json)).toMatchObject({
      runId: "run-delete",
      runDeletedAt: expect.any(String),
      runDeletedBy: "local-development",
    });
    expect(JSON.parse(runEvent.metadata_json)).not.toHaveProperty("thumbnailKey");
    expect(database.prepare("SELECT body FROM events WHERE id = 'comment-event'").get())
      .toEqual({ body: "Deleted step comment" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE json_extract(metadata_json, '$.action') = 'run_deleted'",
    ).get()).toEqual({ count: 1 });
    database.close();
  });

  it("keeps a shared comment and file available for its remaining run target", async () => {
    const database = createDatabase();
    addSample(database);
    database.exec(`
      INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, sequence_no, run_group_id,
         template_name_snapshot, template_type_snapshot, template_version_snapshot,
         status, created_at, run_kind)
      VALUES
        ('run-delete', 'sample-1', 'family-process', 'template-process', 1, 'group-delete',
         'Process', 'process', 1, 'complete', '2026-07-30T10:05:00.000Z', 'process'),
        ('run-keep', 'sample-1', 'family-metrology', 'template-metrology', 2, 'group-keep',
         'Metrology', 'process', 1, 'complete', '2026-07-30T10:06:00.000Z', 'metrology');

      INSERT INTO run_steps
        (id, run_id, position, status, origin, entry_kind, created_at, updated_at)
      VALUES
        ('step-delete', 'run-delete', 1000, 'done', 'template', 'fabrication',
         '2026-07-30T10:05:00.000Z', '2026-07-30T10:05:00.000Z'),
        ('step-keep', 'run-keep', 1000, 'done', 'template', 'metrology',
         '2026-07-30T10:06:00.000Z', '2026-07-30T10:06:00.000Z');

      INSERT INTO managed_storage_objects
        (id, provider, object_key, original_name, mime_type, byte_size, sha256, status, created_at)
      VALUES
        ('storage-shared', 'test', 'object-shared', 'shared.dat', 'application/octet-stream',
         456, 'shared-hash', 'ready', '2026-07-30T10:06:00.000Z');

      INSERT INTO comment_submissions
        (id, context_kind, scope, body, status, created_at, updated_at)
      VALUES
        ('submission-shared', 'run_steps', 'common', 'Shared comment', 'ready',
         '2026-07-30T10:06:00.000Z', '2026-07-30T10:06:00.000Z');

      INSERT INTO comment_submission_targets
        (submission_id, sample_id, run_id, run_step_id, expected_updated_at)
      VALUES
        ('submission-shared', 'sample-1', 'run-delete', 'step-delete',
         '2026-07-30T10:00:00.000Z'),
        ('submission-shared', 'sample-1', 'run-keep', 'step-keep',
         '2026-07-30T10:00:00.000Z');

      INSERT INTO comment_submission_items
        (id, submission_id, kind, status, position, filename, storage_object_id,
         created_at, updated_at)
      VALUES
        ('item-shared', 'submission-shared', 'attachment', 'ready', 0, 'shared.dat',
         'storage-shared', '2026-07-30T10:06:00.000Z', '2026-07-30T10:06:00.000Z');

      INSERT INTO run_step_comments
        (id, run_step_id, scope, operation_group_id, body, submission_id, created_at)
      VALUES
        ('comment-delete', 'step-delete', 'common', 'operation-1', 'Shared comment',
         'submission-shared', '2026-07-30T10:06:00.000Z'),
        ('comment-keep', 'step-keep', 'common', 'operation-1', 'Shared comment',
         'submission-shared', '2026-07-30T10:06:00.000Z');
    `);

    const response = await deleteRequest(testEnv(database), "run-delete", "2026-07-30T10:00:00.000Z");

    expect(response.status).toBe(200);
    expect(database.prepare("SELECT status FROM comment_submissions WHERE id = 'submission-shared'").get())
      .toEqual({ status: "ready" });
    expect(database.prepare("SELECT status FROM managed_storage_objects WHERE id = 'storage-shared'").get())
      .toEqual({ status: "ready" });
    expect(database.prepare("SELECT id FROM run_step_comments ORDER BY id").all())
      .toEqual([{ id: "comment-keep" }]);
    expect(database.prepare("SELECT run_id FROM comment_submission_targets").all())
      .toEqual([{ run_id: "run-keep" }]);
    database.close();
  });

  it("reconnects a later process run and removes only deleted-run verification entities", async () => {
    const database = createDatabase();
    addSample(database);
    database.exec(`
      INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, predecessor_run_id,
         anchor_step_id, sequence_no, run_group_id, template_name_snapshot,
         template_type_snapshot, template_version_snapshot, status, created_at, run_kind)
      VALUES
        ('run-before', 'sample-1', 'family-process', 'template-process', NULL, NULL, 1,
         'group-before', 'Process', 'process', 1, 'complete',
         '2026-07-30T10:05:00.000Z', 'process');

      INSERT INTO run_steps
        (id, run_id, position, status, origin, entry_kind, actualized_at, created_at, updated_at)
      VALUES
        ('step-before', 'run-before', 1000, 'done', 'template', 'fabrication',
         '2026-07-30T10:06:00.000Z', '2026-07-30T10:05:00.000Z',
         '2026-07-30T10:06:00.000Z');

      INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, predecessor_run_id,
         anchor_step_id, sequence_no, run_group_id, template_name_snapshot,
         template_type_snapshot, template_version_snapshot, status, created_at, run_kind)
      VALUES
        ('run-delete', 'sample-1', 'family-process', 'template-process', 'run-before',
         'step-before', 2, 'group-delete', 'Process', 'process', 1, 'complete',
         '2026-07-30T10:10:00.000Z', 'process');

      INSERT INTO run_steps
        (id, run_id, previous_step_id, position, status, origin, entry_kind,
         actualized_at, created_at, updated_at)
      VALUES
        ('step-delete', 'run-delete', 'step-before', 1000, 'done', 'template',
         'fabrication', '2026-07-30T10:11:00.000Z',
         '2026-07-30T10:10:00.000Z', '2026-07-30T10:11:00.000Z');

      INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, predecessor_run_id,
         anchor_step_id, sequence_no, run_group_id, template_name_snapshot,
         template_type_snapshot, template_version_snapshot, status, created_at, run_kind)
      VALUES
        ('run-after', 'sample-1', 'family-process', 'template-process', 'run-delete',
         'step-delete', 3, 'group-after', 'Process', 'process', 1, 'active',
         '2026-07-30T10:20:00.000Z', 'process');

      INSERT INTO run_steps
        (id, run_id, previous_step_id, position, status, origin, entry_kind,
         created_at, updated_at)
      VALUES
        ('step-after', 'run-after', 'step-delete', 1000, 'pending', 'template',
         'fabrication', '2026-07-30T10:20:00.000Z', '2026-07-30T10:20:00.000Z');

      INSERT INTO state_verifications
        (id, sample_id, after_run_step_id, result, status, created_at)
      VALUES
        ('verification-delete', 'sample-1', 'step-delete', 'matched', 'valid',
         '2026-07-30T10:12:00.000Z');

      INSERT INTO state_verifications
        (id, sample_id, after_run_step_id, previous_verification_id, result, status, created_at)
      VALUES
        ('verification-after', 'sample-1', 'step-after', 'verification-delete',
         'matched', 'valid', '2026-07-30T10:21:00.000Z');

      INSERT INTO state_verification_steps (verification_id, run_step_id, ordinal)
      VALUES
        ('verification-delete', 'step-delete', 0),
        ('verification-after', 'step-delete', 0),
        ('verification-after', 'step-after', 1);

      INSERT INTO events (id, sample_id, kind, body, metadata_json, created_at)
      VALUES
        ('preserved-event', 'sample-1', 'run', 'Finished deleted run',
         '{"runId":"run-delete","action":"process_run_finished"}',
         '2026-07-30T10:12:00.000Z');
    `);

    const response = await deleteRequest(testEnv(database), "run-delete", "2026-07-30T10:20:00.000Z");

    expect(response.status).toBe(200);
    expect(database.prepare(
      "SELECT predecessor_run_id, anchor_step_id FROM runs WHERE id = 'run-after'",
    ).get()).toEqual({
      predecessor_run_id: "run-before",
      anchor_step_id: "step-before",
    });
    expect(database.prepare("SELECT previous_step_id FROM run_steps WHERE id = 'step-after'").get())
      .toEqual({ previous_step_id: "step-before" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM state_verifications WHERE id = 'verification-delete'").get())
      .toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT previous_verification_id FROM state_verifications WHERE id = 'verification-after'",
    ).get()).toEqual({ previous_verification_id: null });
    expect(database.prepare(
      "SELECT run_step_id FROM state_verification_steps WHERE verification_id = 'verification-after'",
    ).all()).toEqual([{ run_step_id: "step-after" }]);
    expect(database.prepare("SELECT body FROM events WHERE id = 'preserved-event'").get())
      .toEqual({ body: "Finished deleted run" });
    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "active" });
    database.close();
  });
});
