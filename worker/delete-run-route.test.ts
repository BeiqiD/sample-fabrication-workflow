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

function restoreRequest(env: Env, runId: string, expectedSampleUpdatedAt: string) {
  return worker.fetch(new Request(
    `https://samples.run/api/samples/sample-1/runs/${runId}/restore`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedSampleUpdatedAt }),
    },
  ), env, {} as ExecutionContext);
}

describe("run trash and restore routes", () => {
  it("hides and restores an active run without destroying its execution graph or files", async () => {
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

    const env = testEnv(database);
    const response = await deleteRequest(env, "run-delete", "2026-07-30T10:05:00.000Z");

    expect(response.status).toBe(200);
    const deletedPayload = await response.json() as { ok: true; updatedAt: string };
    expect(deletedPayload).toMatchObject({ ok: true, updatedAt: expect.any(String) });
    expect(database.prepare("SELECT deleted_at, deleted_by FROM runs WHERE id = 'run-delete'").get())
      .toEqual({ deleted_at: deletedPayload.updatedAt, deleted_by: "local-development" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM run_steps WHERE id = 'step-delete'").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM run_step_comments WHERE id = 'comment-delete'").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM run_step_assets WHERE id = 'step-asset'").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT status FROM comment_submissions WHERE id = 'submission-delete'").get())
      .toEqual({ status: "ready" });
    expect(database.prepare("SELECT status FROM managed_storage_objects WHERE id = 'storage-1'").get())
      .toEqual({ status: "ready" });
    expect(database.prepare("SELECT status FROM assets WHERE id = 'asset-1'").get())
      .toEqual({ status: "ready" });
    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "stored" });

    const runEvent = database.prepare(
      "SELECT body, asset_key, metadata_json FROM events WHERE id = 'run-event'",
    ).get() as { body: string; asset_key: string | null; metadata_json: string };
    expect(runEvent.body).toBe("Executed a step");
    expect(runEvent.asset_key).toBe("asset-key");
    expect(JSON.parse(runEvent.metadata_json)).toEqual({
      runId: "run-delete",
      stepId: "step-delete",
      thumbnailKey: "thumb-key",
    });
    expect(database.prepare("SELECT body FROM events WHERE id = 'comment-event'").get())
      .toEqual({ body: "Step comment: Delete this comment" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE json_extract(metadata_json, '$.action') = 'run_deleted'",
    ).get()).toEqual({ count: 1 });

    const hiddenResponse = await worker.fetch(new Request(
      "https://samples.run/api/samples/sample-1",
    ), env, {} as ExecutionContext);
    const hiddenDetail = await hiddenResponse.json() as { runs: Array<{ id: string }> };
    expect(hiddenResponse.status).toBe(200);
    expect(hiddenDetail.runs).toEqual([]);

    const restoredResponse = await restoreRequest(env, "run-delete", deletedPayload.updatedAt);
    expect(restoredResponse.status).toBe(200);
    const restoredPayload = await restoredResponse.json() as { ok: true; updatedAt: string };
    expect(database.prepare("SELECT deleted_at, deleted_by FROM runs WHERE id = 'run-delete'").get())
      .toEqual({ deleted_at: null, deleted_by: null });
    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "active" });
    expect(restoredPayload.updatedAt > deletedPayload.updatedAt).toBe(true);

    const restoredDetail = await (await worker.fetch(new Request(
      "https://samples.run/api/samples/sample-1",
    ), env, {} as ExecutionContext)).json() as { runs: Array<{ id: string; steps: unknown[] }> };
    expect(restoredDetail.runs).toHaveLength(1);
    expect(restoredDetail.runs[0]).toMatchObject({ id: "run-delete" });
    expect(restoredDetail.runs[0].steps).toHaveLength(1);
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
      .toEqual([{ id: "comment-delete" }, { id: "comment-keep" }]);
    expect(database.prepare("SELECT run_id FROM comment_submission_targets ORDER BY run_id").all())
      .toEqual([{ run_id: "run-delete" }, { run_id: "run-keep" }]);
    database.close();
  });

  it("preserves successor links and verification identities while the run is hidden", async () => {
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
      predecessor_run_id: "run-delete",
      anchor_step_id: "step-delete",
    });
    expect(database.prepare("SELECT previous_step_id FROM run_steps WHERE id = 'step-after'").get())
      .toEqual({ previous_step_id: "step-delete" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM state_verifications WHERE id = 'verification-delete'").get())
      .toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT previous_verification_id FROM state_verifications WHERE id = 'verification-after'",
    ).get()).toEqual({ previous_verification_id: "verification-delete" });
    expect(database.prepare(
      "SELECT run_step_id FROM state_verification_steps WHERE verification_id = 'verification-after' ORDER BY ordinal",
    ).all()).toEqual([{ run_step_id: "step-delete" }, { run_step_id: "step-after" }]);
    expect(database.prepare("SELECT body FROM events WHERE id = 'preserved-event'").get())
      .toEqual({ body: "Finished deleted run" });
    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "active" });
    database.close();
  });

  it("returns 409 instead of restoring a run whose predecessor already has a visible successor", async () => {
    const database = createDatabase();
    addSample(database);
    database.exec(`
      INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, predecessor_run_id,
         sequence_no, run_group_id, template_name_snapshot, template_type_snapshot,
         template_version_snapshot, status, created_at, run_kind, deleted_at, deleted_by)
      VALUES
        ('run-root', 'sample-1', 'family-process', 'template-process', NULL,
         1, 'group-root', 'Process', 'process', 1, 'complete',
         '2026-07-30T10:01:00.000Z', 'process', NULL, NULL),
        ('run-deleted', 'sample-1', 'family-process', 'template-process', 'run-root',
         2, 'group-deleted', 'Process', 'process', 1, 'complete',
         '2026-07-30T10:02:00.000Z', 'process', '2026-07-30T10:03:00.000Z', 'operator@example.com'),
        ('run-replacement', 'sample-1', 'family-process', 'template-process', 'run-root',
         3, 'group-replacement', 'Process', 'process', 1, 'complete',
         '2026-07-30T10:04:00.000Z', 'process', NULL, NULL);
    `);

    const response = await restoreRequest(testEnv(database), "run-deleted", "2026-07-30T10:00:00.000Z");

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Another visible run already succeeds this run's predecessor.",
    });
    expect(database.prepare("SELECT deleted_at FROM runs WHERE id = 'run-deleted'").get())
      .toEqual({ deleted_at: "2026-07-30T10:03:00.000Z" });
    database.close();
  });

  it("starts a replacement run after a deleted non-first run", async () => {
    const database = createDatabase();
    addSample(database);
    database.exec(`
      INSERT INTO state_representations
        (hash, representation_type, content_json, created_at)
      VALUES
        ('state-initial', 'diagram', '{}', '2026-07-30T10:00:00.000Z');

      UPDATE template_versions
      SET initial_state_hash = 'state-initial',
          content_json = '{"initialSubstrateStep":{"stepNumber":"0","name":"Substrate Stack"}}'
      WHERE id = 'template-process';

      INSERT INTO step_definitions (hash, name, canonical_json, created_at)
      VALUES ('definition-process', 'Process step', '{}', '2026-07-30T10:00:00.000Z');

      INSERT INTO template_steps
        (id, template_version_id, logical_step_key, position, definition_hash)
      VALUES
        ('template-step-process', 'template-process', 'process:1', 1000, 'definition-process');

      INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, predecessor_run_id,
         sequence_no, run_group_id, template_name_snapshot, template_type_snapshot,
         template_version_snapshot, status, created_at, run_kind, deleted_at, deleted_by)
      VALUES
        ('run-root', 'sample-1', 'family-process', 'template-process', NULL,
         1, 'group-root', 'Process', 'process', 1, 'complete',
         '2026-07-30T10:01:00.000Z', 'process', NULL, NULL),
        ('run-deleted', 'sample-1', 'family-process', 'template-process', 'run-root',
         2, 'group-deleted', 'Process', 'process', 1, 'complete',
         '2026-07-30T10:02:00.000Z', 'process', '2026-07-30T10:03:00.000Z', 'operator@example.com');
    `);
    const env = testEnv(database);

    const response = await worker.fetch(new Request(
      "https://samples.run/api/samples/sample-1/runs",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateVersionId: "template-process",
          substrateConfirmation: {
            confirmed: true,
            expectedSampleUpdatedAt: "2026-07-30T10:00:00.000Z",
            expectedPreviousStateHash: null,
            expectedTemplateStructureKey: "initial-substrate:template-process",
            expectedTemplateStateHash: "state-initial",
            expectedLatestRunId: "run-root",
          },
        }),
      },
    ), env, {} as ExecutionContext);

    expect(response.status).toBe(201);
    const payload = await response.json() as { id: string };
    expect(database.prepare(
      "SELECT predecessor_run_id, sequence_no, deleted_at FROM runs WHERE id = ?",
    ).get(payload.id)).toEqual({
      predecessor_run_id: "run-root",
      sequence_no: 3,
      deleted_at: null,
    });
    expect(database.prepare(
      "SELECT id, predecessor_run_id, deleted_at FROM runs WHERE predecessor_run_id = 'run-root' ORDER BY sequence_no",
    ).all()).toEqual([
      { id: "run-deleted", predecessor_run_id: "run-root", deleted_at: "2026-07-30T10:03:00.000Z" },
      { id: payload.id, predecessor_run_id: "run-root", deleted_at: null },
    ]);
    database.close();
  });

  it("does not restore an older active process run after a newer visible process run exists", async () => {
    const database = createDatabase();
    addSample(database);
    database.exec(`
      INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, predecessor_run_id,
         sequence_no, run_group_id, template_name_snapshot, template_type_snapshot,
         template_version_snapshot, status, created_at, run_kind, deleted_at, deleted_by)
      VALUES
        ('run-old-active', 'sample-1', 'family-process', 'template-process', NULL,
         1, 'group-old', 'Process', 'process', 1, 'active',
         '2026-07-30T10:01:00.000Z', 'process', '2026-07-30T10:02:00.000Z', 'operator@example.com'),
        ('run-new-complete', 'sample-1', 'family-process', 'template-process', 'run-old-active',
         2, 'group-new', 'Process', 'process', 1, 'complete',
         '2026-07-30T10:03:00.000Z', 'process', NULL, NULL);
    `);

    const response = await restoreRequest(testEnv(database), "run-old-active", "2026-07-30T10:00:00.000Z");

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "An active process run can only be restored when it is the latest visible process run.",
    });
    expect(database.prepare("SELECT status, deleted_at FROM runs WHERE id = 'run-old-active'").get())
      .toEqual({ status: "active", deleted_at: "2026-07-30T10:02:00.000Z" });
    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "stored" });
    database.close();
  });
});
