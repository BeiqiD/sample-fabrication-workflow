import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import type { Env } from "./types";

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    readonly query: string,
    readonly bindings: unknown[] = [],
    private readonly beforeRun?: () => void,
  ) {}

  bind(...bindings: unknown[]) {
    return new SqliteD1Statement(this.database, this.query, bindings, this.beforeRun);
  }

  private statement(): StatementSync {
    if (this.bindings.length > 100) {
      throw new Error(`D1 allows at most 100 bound parameters; received ${this.bindings.length}`);
    }
    return this.database.prepare(this.query);
  }

  async first<T>() {
    return (this.statement().get(...this.bindings) as T | undefined) ?? null;
  }

  async all<T>() {
    return { success: true, results: this.statement().all(...this.bindings) as T[], meta: {} };
  }

  async run() {
    this.beforeRun?.();
    return this.execute();
  }

  execute() {
    const statement = this.statement();
    if (/^\s*SELECT\b/i.test(this.query)) {
      return { success: true, meta: { changes: 0 }, results: statement.all(...this.bindings) };
    }
    const result = statement.run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) }, results: [] };
  }
}

afterEach(() => vi.unstubAllGlobals());

class SqliteD1Database {
  constructor(
    readonly database: DatabaseSync,
    private readonly beforeBatch?: () => void,
    private readonly beforeRun?: () => void,
  ) {}

  prepare(query: string) {
    return new SqliteD1Statement(this.database, query, [], this.beforeRun);
  }

  async batch(statements: SqliteD1Statement[]) {
    this.beforeBatch?.();
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
      ('family-process', 'Process', 'process', '2026-08-07T10:00:00.000Z'),
      ('family-metrology', 'Metrology', 'module', '2026-08-07T10:00:00.000Z');

    INSERT INTO template_versions
      (id, recipe_family_id, name, template_type, template_kind, version,
       manifest_hash, content_json, created_at)
    VALUES
      ('template-process', 'family-process', 'Process', 'process', 'process', 1,
       'manifest-process', '{}', '2026-08-07T10:00:00.000Z'),
      ('template-metrology', 'family-metrology', 'Metrology', 'module', 'metrology', 1,
       'manifest-metrology', '{}', '2026-08-07T10:00:00.000Z');

    INSERT INTO step_definitions
      (hash, name, canonical_json, created_at)
    VALUES ('definition-1', 'Step', '{"name":"Step"}', '2026-08-07T10:00:00.000Z');

    INSERT INTO template_steps
      (id, template_version_id, logical_step_key, position, definition_hash)
    VALUES
      ('template-step-process', 'template-process', 'process:1', 0, 'definition-1'),
      ('template-step-metrology', 'template-metrology', 'metrology:1', 0, 'definition-1');
  `);
  return database;
}

function addSample(database: DatabaseSync, id = "sample-1", code = "S-1") {
  database.prepare(
    `INSERT INTO samples (id, code, title, status, created_at, updated_at)
     VALUES (?, ?, 'Sample', 'stored', '2026-08-07T10:00:00.000Z', '2026-08-07T10:00:00.000Z')`,
  ).run(id, code);
}

function addRun(
  database: DatabaseSync,
  id = "run-1",
  sampleId = "sample-1",
  stepId = "step-1",
) {
  database.exec(`
    INSERT INTO runs
      (id, sample_id, recipe_family_id, template_version_id, sequence_no, run_group_id,
       template_name_snapshot, template_type_snapshot, template_version_snapshot,
       status, created_at, run_kind)
    VALUES
      ('${id}', '${sampleId}', 'family-process', 'template-process', 1, 'group-1',
       'Process', 'process', 1, 'complete', '2026-08-07T10:05:00.000Z', 'process');

    INSERT INTO run_steps
      (id, run_id, position, status, origin, entry_kind, title, created_at, updated_at)
    VALUES
      ('${stepId}', '${id}', 1000, 'done', 'template', 'fabrication', 'Step',
       '2026-08-07T10:05:00.000Z', '2026-08-07T10:05:00.000Z');
  `);
}

function addReadyManagedAttachment(
  database: DatabaseSync,
  {
    submissionId,
    itemId,
    storageId,
    contextKind,
    sampleId = null,
    scope = null,
  }: {
    submissionId: string;
    itemId: string;
    storageId: string;
    contextKind: "sample" | "run_steps";
    sampleId?: string | null;
    scope?: "common" | "individual" | null;
  },
) {
  database.prepare(
    `INSERT INTO managed_storage_objects
      (id, provider, object_key, original_name, mime_type, byte_size,
       sha256, status, created_at)
     VALUES (?, 'switchdrive', ?, 'result.dat', 'application/octet-stream',
       16, ?, 'ready', '2026-08-07T10:06:00.000Z')`,
  ).run(storageId, `comments/${storageId}.dat`, `hash-${storageId}`);
  database.prepare(
    `INSERT INTO comment_submissions
      (id, context_kind, sample_id, scope, body, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Visible attachment', 'ready',
       '2026-08-07T10:06:00.000Z', '2026-08-07T10:06:00.000Z')`,
  ).run(submissionId, contextKind, sampleId, scope);
  database.prepare(
    `INSERT INTO comment_submission_items
      (id, submission_id, kind, status, position, filename, mime_type,
       byte_size, sha256, storage_object_id, created_at, updated_at)
     VALUES (?, ?, 'attachment', 'ready', 0, 'result.dat',
       'application/octet-stream', 16, ?, ?,
       '2026-08-07T10:06:00.000Z', '2026-08-07T10:06:00.000Z')`,
  ).run(itemId, submissionId, `hash-${storageId}`, storageId);
}

function testEnv(
  database: DatabaseSync,
  beforeBatch?: () => void,
  beforeRun?: () => void,
): Env {
  return {
    AUTH_MODE: "disabled",
    DB: new SqliteD1Database(database, beforeBatch, beforeRun),
    ASSETS: {},
  } as unknown as Env;
}

function request(env: Env, path: string, init?: RequestInit) {
  return worker.fetch(new Request(`https://samples.run/api${path}`, init), env, {} as ExecutionContext);
}

function managedStorageEnv(
  database: DatabaseSync,
  beforeBatch?: () => void,
) {
  return {
    ...testEnv(database, beforeBatch),
    MANAGED_STORAGE_PROVIDER: "switchdrive",
    SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/test-user/",
    SWITCHDRIVE_USERNAME: "test-user",
    SWITCHDRIVE_APP_PASSWORD: "test-password",
  } as Env;
}

function addActualizedVerificationSteps(database: DatabaseSync, count: number) {
  database.prepare(
    `UPDATE run_steps
     SET actualized_at = '2026-08-07T10:05:00.000Z'
     WHERE id = 'step-1'`,
  ).run();
  const insert = database.prepare(
    `INSERT INTO run_steps
      (id, run_id, position, status, origin, entry_kind, title,
       actualized_at, created_at, updated_at)
     VALUES (?, 'run-1', ?, 'done', 'template', 'fabrication', ?,
       '2026-08-07T10:05:00.000Z',
       '2026-08-07T10:05:00.000Z', '2026-08-07T10:05:00.000Z')`,
  );
  for (let index = 2; index <= count; index += 1) {
    insert.run(`step-${index}`, index * 1000, `Step ${index}`);
  }
}

describe("source lifecycle routes", () => {
  it("hides and restores a Sample without deleting its graph or detaching children", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    addSample(database, "sample-child", "S-1-a");
    database.prepare("UPDATE samples SET parent_id = 'sample-1' WHERE id = 'sample-child'").run();
    const env = testEnv(database);

    const deletedResponse = await request(env, "/samples/sample-1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        confirmationCode: "S-1",
        expectedUpdatedAt: "2026-08-07T10:00:00.000Z",
      }),
    });
    expect(deletedResponse.status).toBe(200);
    const deleted = await deletedResponse.json() as { updatedAt: string; deleted: { childrenDetached: number } };
    expect(deleted.deleted.childrenDetached).toBe(0);
    expect(database.prepare(
      "SELECT deleted_at, deleted_by FROM samples WHERE id = 'sample-1'",
    ).get()).toEqual({ deleted_at: deleted.updatedAt, deleted_by: "local-development" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM runs WHERE id = 'run-1'").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT parent_id FROM samples WHERE id = 'sample-child'").get())
      .toEqual({ parent_id: "sample-1" });

    expect((await request(env, "/samples/sample-1")).status).toBe(404);
    const directory = await (await request(env, "/samples")).json() as { samples: Array<{ id: string }> };
    expect(directory.samples.map((sample) => sample.id)).toEqual(["sample-child"]);

    const restoredResponse = await request(env, "/samples/sample-1/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmationCode: "S-1", expectedUpdatedAt: deleted.updatedAt }),
    });
    expect(restoredResponse.status).toBe(200);
    expect(database.prepare(
      "SELECT deleted_at, deleted_by FROM samples WHERE id = 'sample-1'",
    ).get()).toEqual({ deleted_at: null, deleted_by: null });
    expect((await request(env, "/samples/sample-1")).status).toBe(200);
    database.close();
  });

  it("hides and restores a canonical Comment while retaining occurrences and managed files", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    database.exec(`
      INSERT INTO run_steps
        (id, run_id, position, status, origin, entry_kind, title, created_at, updated_at)
      VALUES
        ('step-2', 'run-1', 2000, 'done', 'template', 'fabrication', 'Step 2',
         '2026-08-07T10:05:00.000Z', '2026-08-07T10:05:00.000Z');

      INSERT INTO managed_storage_objects
        (id, provider, object_key, original_name, mime_type, byte_size, sha256, status, created_at)
      VALUES
        ('storage-1', 'test', 'object-1', 'result.dat', 'application/octet-stream',
         5, 'hash-1', 'ready', '2026-08-07T10:06:00.000Z');

      INSERT INTO comment_submissions
        (id, context_kind, scope, body, status, created_at, updated_at)
      VALUES
        ('submission-1', 'run_steps', 'individual', 'Observation', 'ready',
         '2026-08-07T10:06:00.000Z', '2026-08-07T10:06:00.000Z');

      INSERT INTO comment_submission_targets
        (submission_id, sample_id, run_id, run_step_id, expected_updated_at)
      VALUES
        ('submission-1', 'sample-1', 'run-1', 'step-1', '2026-08-07T10:05:00.000Z'),
        ('submission-1', 'sample-1', 'run-1', 'step-2', '2026-08-07T10:05:00.000Z');

      INSERT INTO comment_submission_items
        (id, submission_id, kind, status, position, filename, storage_object_id, created_at, updated_at)
      VALUES
        ('item-1', 'submission-1', 'attachment', 'ready', 0, 'result.dat', 'storage-1',
         '2026-08-07T10:06:00.000Z', '2026-08-07T10:06:00.000Z');

      INSERT INTO run_step_comments
        (id, run_step_id, scope, body, submission_id, created_at, deleted_at, deleted_by)
      VALUES
        ('comment-1', 'step-1', 'individual', 'Observation', 'submission-1',
         '2026-08-07T10:06:00.000Z', '2026-08-07T10:07:00.000Z', 'earlier@example.com'),
        ('comment-2', 'step-2', 'individual', 'Observation', 'submission-1',
         '2026-08-07T10:06:00.000Z', NULL, NULL);
    `);
    const env = testEnv(database);

    expect((await request(env, "/comment-submissions/submission-1", { method: "DELETE" })).status).toBe(200);
    expect(database.prepare(
      "SELECT deleted_at IS NOT NULL AS deleted FROM comment_submissions WHERE id = 'submission-1'",
    ).get()).toEqual({ deleted: 1 });
    expect(database.prepare(
      "SELECT id, deleted_at, deleted_by FROM run_step_comments ORDER BY id",
    ).all()).toEqual([
      { id: "comment-1", deleted_at: "2026-08-07T10:07:00.000Z", deleted_by: "earlier@example.com" },
      { id: "comment-2", deleted_at: expect.any(String), deleted_by: "local-development" },
    ]);
    expect(database.prepare("SELECT status FROM managed_storage_objects WHERE id = 'storage-1'").get())
      .toEqual({ status: "ready" });
    expect(database.prepare("SELECT status, deleted_at FROM comment_submission_items WHERE id = 'item-1'").get())
      .toEqual({ status: "ready", deleted_at: null });

    const hidden = await (await request(env, "/samples/sample-1")).json() as {
      runs: Array<{ steps: Array<{ comments: unknown[] }> }>;
    };
    expect(hidden.runs[0].steps[0].comments).toEqual([]);

    expect((await request(env, "/comment-submissions/submission-1/restore", { method: "POST" })).status).toBe(200);
    expect(database.prepare(
      "SELECT id, deleted_at, deleted_by FROM run_step_comments ORDER BY id",
    ).all()).toEqual([
      { id: "comment-1", deleted_at: "2026-08-07T10:07:00.000Z", deleted_by: "earlier@example.com" },
      { id: "comment-2", deleted_at: null, deleted_by: null },
    ]);
    const restored = await (await request(env, "/samples/sample-1")).json() as {
      runs: Array<{ steps: Array<{ comments: Array<{ submissionId: string }> }> }>;
    };
    expect(restored.runs.flatMap((run) => run.steps).flatMap((step) => step.comments)).toEqual([
      expect.objectContaining({ submissionId: "submission-1" }),
    ]);
    expect(database.prepare(
      "SELECT id, updated_at FROM run_steps WHERE id IN ('step-1', 'step-2') ORDER BY id",
    ).all()).toEqual([
      { id: "step-1", updated_at: "2026-08-07T10:05:00.000Z" },
      { id: "step-2", updated_at: expect.not.stringMatching(/^2026-08-07T10:05:00\\.000Z$/) },
    ]);
    const restoreEvent = database.prepare(
      `SELECT metadata_json FROM events
       WHERE json_extract(metadata_json, '$.action') = 'comment_submission_restored'`,
    ).get() as { metadata_json: string };
    expect(JSON.parse(restoreEvent.metadata_json)).toEqual({
      action: "comment_submission_restored",
      submissionId: "submission-1",
      stepIds: ["step-2"],
    });
    database.close();
  });

  it.each(["item", "canonical"] as const)(
    "exports managed attachment bytes after the %s source is soft-deleted",
    async (deletedSource) => {
      const database = createDatabase();
      addSample(database);
      database.exec(`
        INSERT INTO managed_storage_objects
          (id, provider, object_key, original_name, mime_type, byte_size,
           sha256, status, created_at)
        VALUES
          ('export-storage', 'switchdrive', 'exports/result.dat', 'result.dat',
           'application/octet-stream', 14, 'export-hash', 'ready',
           '2026-08-07T10:06:00.000Z');

        INSERT INTO comment_submissions
          (id, context_kind, sample_id, scope, body, status, created_at, updated_at)
        VALUES
          ('export-submission', 'sample', 'sample-1', NULL, 'Archived result',
           'ready', '2026-08-07T10:06:00.000Z', '2026-08-07T10:06:00.000Z');

        INSERT INTO comment_submission_items
          (id, submission_id, kind, status, position, filename, mime_type,
           byte_size, sha256, storage_object_id, created_at, updated_at)
        VALUES
          ('export-item', 'export-submission', 'attachment', 'ready', 0,
           'result.dat', 'application/octet-stream', 14, 'export-hash',
           'export-storage', '2026-08-07T10:06:00.000Z',
           '2026-08-07T10:06:00.000Z');
      `);
      if (deletedSource === "item") {
        database.prepare(
          `UPDATE comment_submission_items
           SET deleted_at = '2026-08-07T10:07:00.000Z', deleted_by = 'local-development'
           WHERE id = 'export-item'`,
        ).run();
      } else {
        database.prepare(
          `UPDATE comment_submissions
           SET deleted_at = '2026-08-07T10:07:00.000Z', deleted_by = 'local-development'
           WHERE id = 'export-submission'`,
        ).run();
      }
      vi.stubGlobal("fetch", vi.fn(async () => new Response("archived-bytes", {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          etag: "export-etag",
        },
      })));
      const env = managedStorageEnv(database);

      const manifestResponse = await request(env, "/exports/all");
      expect(manifestResponse.status).toBe(200);
      const manifest = await manifestResponse.json() as {
        blobs: Array<{ blobRecordIds: string[]; downloadUrl: string | null }>;
      };
      const exportedBlob = manifest.blobs.find((blob) => blob.blobRecordIds.includes("export-storage"));
      expect(exportedBlob).toEqual(expect.objectContaining({
        downloadUrl: "/api/exports/managed/export-storage",
      }));

      const attachmentResponse = await request(
        env,
        exportedBlob!.downloadUrl!.replace(/^\/api/, ""),
      );
      expect(attachmentResponse.status).toBe(200);
      expect(await attachmentResponse.text()).toBe("archived-bytes");
      database.close();
    },
  );

  it("hides a Sample Comment attachment download after the Sample enters trash but preserves export access", async () => {
    const database = createDatabase();
    addSample(database);
    addReadyManagedAttachment(database, {
      submissionId: "sample-download-submission",
      itemId: "sample-download-item",
      storageId: "sample-download-storage",
      contextKind: "sample",
      sampleId: "sample-1",
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("attachment-bytes", {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    })));
    const env = managedStorageEnv(database);

    expect((await request(env, "/attachments/sample-download-item/download")).status).toBe(200);
    const deletedResponse = await request(env, "/samples/sample-1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        confirmationCode: "S-1",
        expectedUpdatedAt: "2026-08-07T10:00:00.000Z",
      }),
    });
    expect(deletedResponse.status).toBe(200);
    expect((await request(env, "/attachments/sample-download-item/download")).status).toBe(404);
    const exportResponse = await request(env, "/exports/attachments/sample-download-item");
    expect(exportResponse.status).toBe(200);
    expect(await exportResponse.text()).toBe("attachment-bytes");
    database.close();
  });

  it("hides a run-step Comment attachment download after its only Run target enters trash but preserves export access", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    addReadyManagedAttachment(database, {
      submissionId: "run-download-submission",
      itemId: "run-download-item",
      storageId: "run-download-storage",
      contextKind: "run_steps",
      scope: "individual",
    });
    database.exec(`
      INSERT INTO comment_submission_targets
        (submission_id, sample_id, run_id, run_step_id, expected_updated_at)
      VALUES
        ('run-download-submission', 'sample-1', 'run-1', 'step-1',
         '2026-08-07T10:05:00.000Z');

      INSERT INTO run_step_comments
        (id, run_step_id, scope, body, submission_id, created_at)
      VALUES
        ('run-download-comment', 'step-1', 'individual', 'Visible attachment',
         'run-download-submission', '2026-08-07T10:06:00.000Z');
    `);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("attachment-bytes", {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    })));
    const env = managedStorageEnv(database);

    expect((await request(env, "/attachments/run-download-item/download")).status).toBe(200);
    const deletedResponse = await request(env, "/samples/sample-1/runs/run-1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedSampleUpdatedAt: "2026-08-07T10:00:00.000Z" }),
    });
    expect(deletedResponse.status).toBe(200);
    expect((await request(env, "/attachments/run-download-item/download")).status).toBe(404);
    const exportResponse = await request(env, "/exports/attachments/run-download-item");
    expect(exportResponse.status).toBe(200);
    expect(await exportResponse.text()).toBe("attachment-bytes");
    database.close();
  });

  it("keeps a common Comment attachment downloadable while at least one target remains visible", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    addSample(database, "sample-2", "S-2");
    addRun(database, "run-2", "sample-2", "step-2");
    addReadyManagedAttachment(database, {
      submissionId: "common-download-submission",
      itemId: "common-download-item",
      storageId: "common-download-storage",
      contextKind: "run_steps",
      scope: "common",
    });
    database.exec(`
      INSERT INTO comment_submission_targets
        (submission_id, sample_id, run_id, run_step_id, expected_updated_at)
      VALUES
        ('common-download-submission', 'sample-1', 'run-1', 'step-1',
         '2026-08-07T10:05:00.000Z'),
        ('common-download-submission', 'sample-2', 'run-2', 'step-2',
         '2026-08-07T10:05:00.000Z');

      INSERT INTO run_step_comments
        (id, run_step_id, scope, body, submission_id, created_at)
      VALUES
        ('common-download-comment-1', 'step-1', 'common', 'Visible attachment',
         'common-download-submission', '2026-08-07T10:06:00.000Z'),
        ('common-download-comment-2', 'step-2', 'common', 'Visible attachment',
         'common-download-submission', '2026-08-07T10:06:00.000Z');
    `);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("attachment-bytes", {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    })));
    const env = managedStorageEnv(database);

    const deletedResponse = await request(env, "/samples/sample-1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        confirmationCode: "S-1",
        expectedUpdatedAt: "2026-08-07T10:00:00.000Z",
      }),
    });
    expect(deletedResponse.status).toBe(200);
    const downloadResponse = await request(env, "/attachments/common-download-item/download");
    expect(downloadResponse.status).toBe(200);
    expect(await downloadResponse.text()).toBe("attachment-bytes");
    database.close();
  });

  it("requires the canonical Comment before restoring its occurrence or legacy image", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    database.exec(`
      INSERT INTO assets
        (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES
        ('comment-asset', 'comment-image-key', 'comment.png', 'image/png', 10,
         'ready', 'comment-image-hash', '2026-08-07T10:06:00.000Z');

      INSERT INTO comment_submissions
        (id, context_kind, scope, body, status, actor_email, created_at, updated_at)
      VALUES
        ('submission-guarded', 'run_steps', 'individual', 'Guarded observation',
         'ready', 'local-development',
         '2026-08-07T10:06:00.000Z', '2026-08-07T10:06:00.000Z');

      INSERT INTO comment_submission_targets
        (submission_id, sample_id, run_id, run_step_id, expected_updated_at)
      VALUES
        ('submission-guarded', 'sample-1', 'run-1', 'step-1',
         '2026-08-07T10:05:00.000Z');

      INSERT INTO run_step_comments
        (id, run_step_id, scope, body, asset_id, submission_id, actor_email, created_at)
      VALUES
        ('comment-guarded', 'step-1', 'individual', 'Guarded observation',
         'comment-asset', 'submission-guarded', 'local-development',
         '2026-08-07T10:06:00.000Z');
    `);
    const env = testEnv(database);

    expect((await request(env, "/run-step-comments/comment-guarded/asset", {
      method: "DELETE",
    })).status).toBe(200);
    expect((await request(env, "/comment-submissions/submission-guarded", {
      method: "DELETE",
    })).status).toBe(200);

    const occurrenceRestore = await request(
      env,
      "/run-step-comments/comment-guarded/restore",
      { method: "POST" },
    );
    expect(occurrenceRestore.status).toBe(409);
    expect(await occurrenceRestore.json()).toEqual({
      error: "Restore the canonical Comment before restoring this comment",
    });

    const attachmentRestore = await request(
      env,
      "/run-step-comments/comment-guarded/asset/restore",
      { method: "POST" },
    );
    expect(attachmentRestore.status).toBe(409);
    expect(await attachmentRestore.json()).toEqual({
      error: "Restore the canonical Comment before restoring this attachment",
    });

    expect(database.prepare(
      "SELECT deleted_at IS NOT NULL AS deleted FROM run_step_comments WHERE id = 'comment-guarded'",
    ).get()).toEqual({ deleted: 1 });
    database.prepare(
      "UPDATE run_step_comments SET deleted_at = NULL, deleted_by = NULL WHERE id = 'comment-guarded'",
    ).run();
    const hidden = await (await request(env, "/samples/sample-1")).json() as {
      runs: Array<{ steps: Array<{ comments: unknown[] }> }>;
    };
    expect(hidden.runs.flatMap((run) => run.steps).flatMap((step) => step.comments)).toEqual([]);

    expect((await request(env, "/comment-submissions/submission-guarded/restore", {
      method: "POST",
    })).status).toBe(200);
    expect(database.prepare(
      "SELECT deleted_at, asset_deleted_at IS NOT NULL AS asset_deleted FROM run_step_comments WHERE id = 'comment-guarded'",
    ).get()).toEqual({ deleted_at: null, asset_deleted: 1 });
    expect((await request(env, "/run-step-comments/comment-guarded/asset/restore", {
      method: "POST",
    })).status).toBe(200);
    database.close();
  });

  it("rechecks canonical restore target visibility inside the mutation batch", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    database.exec(`
      INSERT INTO comment_submissions
        (id, context_kind, scope, body, status, actor_email, created_at, updated_at,
         deleted_at, deleted_by, deletion_operation_id)
      VALUES
        ('submission-race', 'run_steps', 'common', 'Race observation', 'ready',
         'local-development',
         '2026-08-07T10:06:00.000Z', '2026-08-07T10:07:00.000Z',
         '2026-08-07T10:07:00.000Z', 'local-development', 'canonical-race-delete');
      INSERT INTO comment_submission_targets
        (submission_id, sample_id, run_id, run_step_id, expected_updated_at)
      VALUES
        ('submission-race', 'sample-1', 'run-1', 'step-1',
         '2026-08-07T10:05:00.000Z');
      INSERT INTO run_step_comments
        (id, run_step_id, scope, operation_group_id, body, submission_id,
         actor_email, created_at, updated_at, deleted_at, deleted_by,
         deletion_operation_id)
      VALUES
        ('comment-race', 'step-1', 'common', 'submission-race', 'Race observation',
         'submission-race', 'local-development',
         '2026-08-07T10:06:00.000Z', '2026-08-07T10:07:00.000Z',
         '2026-08-07T10:07:00.000Z', 'local-development', 'canonical-race-delete');
    `);
    let movedToTrash = false;
    const env = testEnv(database, () => {
      if (movedToTrash) return;
      movedToTrash = true;
      database.prepare(
        `UPDATE samples SET deleted_at = '2026-08-07T10:08:00.000Z',
         deleted_by = 'other@example.com' WHERE id = 'sample-1'`,
      ).run();
    });

    const response = await request(env, "/comment-submissions/submission-race/restore", {
      method: "POST",
    });

    expect(response.status).toBe(409);
    expect(database.prepare(
      "SELECT deleted_at FROM comment_submissions WHERE id = 'submission-race'",
    ).get()).toEqual({ deleted_at: "2026-08-07T10:07:00.000Z" });
    expect(database.prepare(
      "SELECT deleted_at FROM run_step_comments WHERE id = 'comment-race'",
    ).get()).toEqual({ deleted_at: "2026-08-07T10:07:00.000Z" });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM events
       WHERE json_extract(metadata_json, '$.action') = 'comment_submission_restored'`,
    ).get()).toEqual({ count: 0 });
    database.close();
  });

  it("soft-deletes and restores execution and metrology attachment occurrences", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    database.exec(`
      INSERT INTO assets
        (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES
        ('asset-1', 'image-key-a', 'image-a.png', 'image/png', 10, 'ready', 'asset-hash-a',
         '2026-08-07T10:06:00.000Z'),
        ('asset-2', 'image-key-b', 'image-b.png', 'image/png', 11, 'ready', 'asset-hash-b',
         '2026-08-07T10:07:00.000Z');

      INSERT INTO run_step_assets (id, run_step_id, asset_id, role, created_at)
      VALUES
        ('step-asset-1', 'step-1', 'asset-1', 'execution', '2026-08-07T10:06:00.000Z'),
        ('step-asset-2', 'step-1', 'asset-2', 'execution', '2026-08-07T10:07:00.000Z');

      INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, created_at)
      VALUES
        ('asset-event-1', 'sample-1', 'image', 'Image A', 'image-key-a',
         '{"runId":"run-1","stepId":"step-1","runStepAssetId":"step-asset-1"}',
         '2026-08-07T10:06:00.000Z'),
        ('asset-event-2', 'sample-1', 'image', 'Image B', 'image-key-b',
         '{"runId":"run-1","stepId":"step-1","runStepAssetId":"step-asset-2"}',
         '2026-08-07T10:07:00.000Z');

      INSERT INTO metrology_template_references
        (id, template_version_id, asset_id, display_name, created_at)
      VALUES
        ('reference-1', 'template-metrology', 'asset-1', 'image.png',
         '2026-08-07T10:06:00.000Z');
    `);
    const env = testEnv(database);

    expect((await request(env, "/samples/sample-1/runs/run-1/steps/step-1/assets", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetKey: "image-key-a" }),
    })).status).toBe(200);
    expect((await request(env, "/samples/sample-1/runs/run-1/steps/step-1/assets", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetKey: "image-key-b" }),
    })).status).toBe(200);
    expect(database.prepare(
      "SELECT id, deleted_at IS NOT NULL AS deleted FROM run_step_assets ORDER BY id",
    ).all()).toEqual([
      { id: "step-asset-1", deleted: 1 },
      { id: "step-asset-2", deleted: 1 },
    ]);

    expect((await request(env, "/samples/sample-1/runs/run-1/steps/step-1/assets/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetKey: "image-key-a" }),
    })).status).toBe(200);
    expect(database.prepare(
      "SELECT id, deleted_at IS NULL AS visible FROM run_step_assets ORDER BY id",
    ).all()).toEqual([
      { id: "step-asset-1", visible: 1 },
      { id: "step-asset-2", visible: 0 },
    ]);
    const imageEvents = database.prepare(
      "SELECT id, asset_key, metadata_json FROM events WHERE id IN ('asset-event-1', 'asset-event-2') ORDER BY id",
    ).all() as Array<{ id: string; asset_key: string | null; metadata_json: string }>;
    expect(imageEvents.map((event) => ({
      id: event.id,
      assetKey: event.asset_key,
      metadata: JSON.parse(event.metadata_json),
    }))).toEqual([
      {
        id: "asset-event-1",
        assetKey: "image-key-a",
        metadata: { runId: "run-1", stepId: "step-1", runStepAssetId: "step-asset-1" },
      },
      {
        id: "asset-event-2",
        assetKey: null,
        metadata: expect.objectContaining({
          runId: "run-1",
          stepId: "step-1",
          runStepAssetId: "step-asset-2",
          assetDeletedAt: expect.any(String),
        }),
      },
    ]);

    expect((await request(env, "/metrology-templates/template-metrology/references/reference-1", {
      method: "DELETE",
    })).status).toBe(200);
    expect(database.prepare(
      "SELECT deleted_at IS NOT NULL AS deleted FROM metrology_template_references WHERE id = 'reference-1'",
    ).get()).toEqual({ deleted: 1 });
    expect((await request(env, "/metrology-templates/template-metrology/references/reference-1/restore", {
      method: "POST",
    })).status).toBe(200);
    expect(database.prepare(
      "SELECT deleted_at, deleted_by FROM metrology_template_references WHERE id = 'reference-1'",
    ).get()).toEqual({ deleted_at: null, deleted_by: null });
    database.close();
  });

  it("enforces attachment ownership and restores a TIFF preview only after its original", async () => {
    const database = createDatabase();
    addSample(database);
    database.exec(`
      INSERT INTO comment_submissions
        (id, context_kind, sample_id, body, status, actor_email, created_at, updated_at)
      VALUES
        ('submission-owned', 'sample', 'sample-1', 'Owned attachment', 'ready',
         'other@example.com', '2026-08-07T10:06:00.000Z', '2026-08-07T10:06:00.000Z'),
        ('submission-tiff', 'sample', 'sample-1', 'TIFF attachment', 'ready',
         'local-development', '2026-08-07T10:06:00.000Z', '2026-08-07T10:06:00.000Z');

      INSERT INTO comment_submission_items
        (id, submission_id, kind, status, position, filename, mime_type, byte_size,
         original_filename, original_mime_type, original_byte_size,
         created_at, updated_at, deleted_at, deleted_by)
      VALUES
        ('owned-item', 'submission-owned', 'attachment', 'ready', 0,
         'owned.dat', 'application/octet-stream', 5,
         'owned.dat', 'application/octet-stream', 5,
         '2026-08-07T10:06:00.000Z', '2026-08-07T10:07:00.000Z',
         '2026-08-07T10:07:00.000Z', 'other@example.com'),
        ('preview-tiff', 'submission-tiff', 'comment_image', 'ready', 0,
         'scan-preview.png', 'image/png', 10,
         'scan.tiff', 'image/tiff', 100,
         '2026-08-07T10:06:00.000Z', '2026-08-07T10:07:00.000Z',
         '2026-08-07T10:07:00.000Z', 'local-development'),
        ('original-tiff', 'submission-tiff', 'attachment', 'ready', 1,
         'scan.tiff', 'image/tiff', 100,
         'scan.tiff', 'image/tiff', 100,
         '2026-08-07T10:06:00.000Z', '2026-08-07T10:07:00.000Z',
         '2026-08-07T10:07:00.000Z', 'local-development');

      UPDATE comment_submission_items
      SET related_item_id = 'original-tiff'
      WHERE id = 'preview-tiff';
      UPDATE comment_submission_items
      SET related_item_id = 'preview-tiff'
      WHERE id = 'original-tiff';
    `);
    const env = testEnv(database);

    const ownershipResponse = await request(
      env,
      "/comment-submissions/submission-owned/items/owned-item/restore",
      { method: "POST" },
    );
    expect(ownershipResponse.status).toBe(403);
    expect(database.prepare("SELECT deleted_at FROM comment_submission_items WHERE id = 'owned-item'").get())
      .toEqual({ deleted_at: "2026-08-07T10:07:00.000Z" });

    const previewFirst = await request(
      env,
      "/comment-submissions/submission-tiff/items/preview-tiff/restore",
      { method: "POST" },
    );
    expect(previewFirst.status).toBe(409);
    expect(await previewFirst.json()).toEqual({
      error: "Restore the original TIFF before restoring its comment preview",
    });

    expect((await request(
      env,
      "/comment-submissions/submission-tiff/items/original-tiff/restore",
      { method: "POST" },
    )).status).toBe(200);
    expect((await request(
      env,
      "/comment-submissions/submission-tiff/items/preview-tiff/restore",
      { method: "POST" },
    )).status).toBe(200);
    expect(database.prepare(
      "SELECT id, deleted_at FROM comment_submission_items WHERE submission_id = 'submission-tiff' ORDER BY position",
    ).all()).toEqual([
      { id: "preview-tiff", deleted_at: null },
      { id: "original-tiff", deleted_at: null },
    ]);
    database.close();
  });

  it("rejects a common-comment group mutation when any target ancestor is deleted", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    database.exec(`
      INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, predecessor_run_id,
         sequence_no, run_group_id, template_name_snapshot, template_type_snapshot,
         template_version_snapshot, status, created_at, run_kind, deleted_at, deleted_by)
      VALUES
        ('run-2', 'sample-1', 'family-process', 'template-process', 'run-1',
         2, 'group-2', 'Process', 'process', 1, 'complete',
         '2026-08-07T10:06:00.000Z', 'process',
         '2026-08-07T10:08:00.000Z', 'local-development');

      INSERT INTO run_steps
        (id, run_id, position, status, origin, entry_kind, title, created_at, updated_at)
      VALUES
        ('step-2', 'run-2', 1000, 'done', 'template', 'fabrication', 'Step 2',
         '2026-08-07T10:06:00.000Z', '2026-08-07T10:06:00.000Z');

      INSERT INTO run_step_comments
        (id, run_step_id, scope, operation_group_id, body, created_at)
      VALUES
        ('common-visible', 'step-1', 'common', 'common-group-1', 'Shared observation',
         '2026-08-07T10:07:00.000Z'),
        ('common-hidden', 'step-2', 'common', 'common-group-1', 'Shared observation',
         '2026-08-07T10:07:00.000Z');
    `);
    const env = testEnv(database);

    const response = await request(env, "/run-step-comments/common-visible", { method: "DELETE" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "A common comment target is no longer available. Restore every target before changing the group.",
    });
    expect(database.prepare(
      "SELECT id, deleted_at FROM run_step_comments WHERE operation_group_id = 'common-group-1' ORDER BY id",
    ).all()).toEqual([
      { id: "common-hidden", deleted_at: null },
      { id: "common-visible", deleted_at: null },
    ]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE json_extract(metadata_json, '$.operationGroupId') = 'common-group-1'",
    ).get()).toEqual({ count: 0 });
    database.close();
  });

  it("rechecks common-comment group visibility inside the restore batch", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    database.exec(`
      INSERT INTO run_step_comments
        (id, run_step_id, scope, operation_group_id, body, created_at,
         updated_at, deleted_at, deleted_by, deletion_operation_id)
      VALUES
        ('common-race', 'step-1', 'common', 'common-race-group',
         'Shared observation', '2026-08-07T10:06:00.000Z',
         '2026-08-07T10:07:00.000Z', '2026-08-07T10:07:00.000Z',
         'local-development', 'common-race-delete');
    `);
    let movedToTrash = false;
    const env = testEnv(database, () => {
      if (movedToTrash) return;
      movedToTrash = true;
      database.prepare(
        `UPDATE runs SET deleted_at = '2026-08-07T10:08:00.000Z',
         deleted_by = 'other@example.com' WHERE id = 'run-1'`,
      ).run();
    });

    const response = await request(env, "/run-step-comments/common-race/restore", {
      method: "POST",
    });

    expect(response.status).toBe(409);
    expect(database.prepare(
      "SELECT deleted_at FROM run_step_comments WHERE id = 'common-race'",
    ).get()).toEqual({ deleted_at: "2026-08-07T10:07:00.000Z" });
    expect(database.prepare("SELECT updated_at FROM run_steps WHERE id = 'step-1'").get())
      .toEqual({ updated_at: "2026-08-07T10:05:00.000Z" });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM events
       WHERE json_extract(metadata_json, '$.action') = 'step_comment_restored'`,
    ).get()).toEqual({ count: 0 });
    database.close();
  });

  it("keeps Comment finalize atomic when a target Run moves to trash", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    database.exec(`
      INSERT INTO comment_submissions
        (id, context_kind, scope, body, status, actor_email, created_at, updated_at)
      VALUES
        ('submission-finalize-race', 'run_steps', 'individual', 'Uploaded observation',
         'uploading', 'local-development',
         '2026-08-07T10:06:00.000Z', '2026-08-07T10:06:00.000Z');
      INSERT INTO comment_submission_targets
        (submission_id, sample_id, run_id, run_step_id, expected_updated_at)
      VALUES
        ('submission-finalize-race', 'sample-1', 'run-1', 'step-1',
         '2026-08-07T10:05:00.000Z');
    `);
    let postRaceState: { step_updated_at: string; sample_updated_at: string } | undefined;
    const env = testEnv(database, () => {
      database.prepare(
        `UPDATE runs SET deleted_at = '2026-08-07T10:08:00.000Z',
         deleted_by = 'other@example.com' WHERE id = 'run-1'`,
      ).run();
      postRaceState = database.prepare(
        `SELECT rs.updated_at AS step_updated_at, s.updated_at AS sample_updated_at
         FROM run_steps rs JOIN runs r ON r.id = rs.run_id
         JOIN samples s ON s.id = r.sample_id WHERE rs.id = 'step-1'`,
      ).get() as { step_updated_at: string; sample_updated_at: string };
    });

    const response = await request(
      env,
      "/comment-submissions/submission-finalize-race/finalize",
      { method: "POST" },
    );

    expect(response.status).toBe(409);
    expect(database.prepare(
      `SELECT status, last_mutation_id FROM comment_submissions
       WHERE id = 'submission-finalize-race'`,
    ).get()).toEqual({ status: "uploading", last_mutation_id: null });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM run_step_comments WHERE submission_id = 'submission-finalize-race'",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM events
       WHERE json_extract(metadata_json, '$.submissionId') = 'submission-finalize-race'`,
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      `SELECT rs.updated_at AS step_updated_at, s.updated_at AS sample_updated_at
       FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id WHERE rs.id = 'step-1'`,
    ).get()).toEqual(postRaceState);
    database.close();
  });

  it("does not orphan a ready Comment attachment when Finalize wins a Cancel race", async () => {
    const database = createDatabase();
    addSample(database);
    database.exec(`
      INSERT INTO managed_storage_objects
        (id, provider, object_key, original_name, mime_type, byte_size,
         sha256, status, created_at)
      VALUES
        ('cancel-storage', 'switchdrive', 'comments/result.dat', 'result.dat',
         'application/octet-stream', 11, 'cancel-hash', 'ready',
         '2026-08-07T10:06:00.000Z');

      INSERT INTO comment_submissions
        (id, context_kind, sample_id, scope, body, status, actor_email,
         created_at, updated_at)
      VALUES
        ('cancel-race', 'sample', 'sample-1', NULL, 'Uploaded result',
         'uploading', 'local-development',
         '2026-08-07T10:06:00.000Z', '2026-08-07T10:06:00.000Z');

      INSERT INTO comment_submission_items
        (id, submission_id, kind, status, position, filename, mime_type,
         byte_size, sha256, storage_object_id, created_at, updated_at)
      VALUES
        ('cancel-item', 'cancel-race', 'attachment', 'ready', 0, 'result.dat',
         'application/octet-stream', 11, 'cancel-hash', 'cancel-storage',
         '2026-08-07T10:06:00.000Z', '2026-08-07T10:06:00.000Z');
    `);
    let finalized = false;
    const env = managedStorageEnv(database, () => {
      if (finalized) return;
      finalized = true;
      database.prepare(
        `UPDATE comment_submissions
         SET status = 'ready', completed_at = '2026-08-07T10:07:00.000Z',
             last_mutation_id = 'finalize-won', updated_at = '2026-08-07T10:07:00.000Z'
         WHERE id = 'cancel-race'`,
      ).run();
      database.prepare(
        `INSERT INTO events
          (id, sample_id, kind, body, metadata_json, actor_email, created_at)
         VALUES
          ('cancel-race-event', 'sample-1', 'comment', 'Uploaded result',
           '{"action":"comment_submission","submissionId":"cancel-race"}',
           'local-development', '2026-08-07T10:07:00.000Z')`,
      ).run();
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ready-bytes", {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    })));

    const cancelResponse = await request(
      env,
      "/comment-submissions/cancel-race/cancel",
      { method: "POST" },
    );

    expect(cancelResponse.status).toBe(409);
    expect(database.prepare(
      "SELECT status, last_mutation_id FROM comment_submissions WHERE id = 'cancel-race'",
    ).get()).toEqual({ status: "ready", last_mutation_id: "finalize-won" });
    expect(database.prepare(
      "SELECT status FROM comment_submission_items WHERE id = 'cancel-item'",
    ).get()).toEqual({ status: "ready" });
    expect(database.prepare(
      "SELECT status, orphaned_at FROM managed_storage_objects WHERE id = 'cancel-storage'",
    ).get()).toEqual({ status: "ready", orphaned_at: null });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE id = 'cancel-race-event'",
    ).get()).toEqual({ count: 1 });

    const downloadResponse = await request(env, "/attachments/cancel-item/download");
    expect(downloadResponse.status).toBe(200);
    expect(await downloadResponse.text()).toBe("ready-bytes");
    database.close();
  });

  it("does not add an ad-hoc Step after its Run moves to trash", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    database.exec(`
      UPDATE run_steps SET status = 'pending' WHERE id = 'step-1';
      UPDATE runs SET status = 'active', completed_at = NULL WHERE id = 'run-1';
    `);
    let sampleUpdatedAt = "";
    const env = testEnv(database, () => {
      database.prepare(
        `UPDATE runs SET deleted_at = '2026-08-07T10:08:00.000Z',
         deleted_by = 'other@example.com' WHERE id = 'run-1'`,
      ).run();
      sampleUpdatedAt = String(database.prepare(
        "SELECT updated_at FROM samples WHERE id = 'sample-1'",
      ).get()?.updated_at);
    });

    const response = await request(env, "/samples/sample-1/runs/run-1/steps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Race step",
        toolName: "",
        parametersText: "",
        commentsText: "",
        deviationNote: "",
        afterStepId: "step-1",
      }),
    });

    expect(response.status).toBe(409);
    expect(database.prepare("SELECT COUNT(*) AS count FROM run_steps WHERE run_id = 'run-1'").get())
      .toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT status, last_mutation_id FROM runs WHERE id = 'run-1'",
    ).get()).toEqual({ status: "active", last_mutation_id: null });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM events
       WHERE json_extract(metadata_json, '$.action') = 'added'`,
    ).get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT updated_at FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ updated_at: sampleUpdatedAt });
    database.close();
  });

  it("does not reactivate a Run that finishes while an ad-hoc Step is being added", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    database.exec(`
      UPDATE run_steps SET status = 'pending' WHERE id = 'step-1';
      UPDATE runs SET status = 'active', completed_at = NULL WHERE id = 'run-1';
    `);
    const env = testEnv(database, () => {
      database.prepare(
        `UPDATE runs SET status = 'complete', completed_at = '2026-08-07T10:08:00.000Z'
         WHERE id = 'run-1'`,
      ).run();
    });

    const response = await request(env, "/samples/sample-1/runs/run-1/steps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Late step",
        toolName: "",
        parametersText: "",
        commentsText: "",
        deviationNote: "",
        afterStepId: "step-1",
      }),
    });

    expect(response.status).toBe(409);
    expect(database.prepare(
      "SELECT status, completed_at, last_mutation_id FROM runs WHERE id = 'run-1'",
    ).get()).toEqual({
      status: "complete",
      completed_at: "2026-08-07T10:08:00.000Z",
      last_mutation_id: null,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM run_steps WHERE run_id = 'run-1'").get())
      .toEqual({ count: 1 });
    database.close();
  });

  it("does not add an ad-hoc Step after its insertion point changes", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    database.exec(`
      UPDATE run_steps SET status = 'pending' WHERE id = 'step-1';
      UPDATE runs SET status = 'active', completed_at = NULL WHERE id = 'run-1';
    `);
    const env = testEnv(database, () => {
      database.prepare(
        `UPDATE run_steps SET deleted_at = '2026-08-07T10:08:00.000Z',
         deleted_by = 'other@example.com' WHERE id = 'step-1'`,
      ).run();
    });

    const response = await request(env, "/samples/sample-1/runs/run-1/steps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Detached step",
        toolName: "",
        parametersText: "",
        commentsText: "",
        deviationNote: "",
        afterStepId: "step-1",
      }),
    });

    expect(response.status).toBe(409);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM run_steps WHERE run_id = 'run-1' AND id <> 'step-1'",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT last_mutation_id FROM runs WHERE id = 'run-1'",
    ).get()).toEqual({ last_mutation_id: null });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM events
       WHERE json_extract(metadata_json, '$.action') = 'added'`,
    ).get()).toEqual({ count: 0 });
    database.close();
  });

  it("does not add embedded metrology after the process Run finishes", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    database.exec(`
      UPDATE run_steps SET status = 'pending' WHERE id = 'step-1';
      UPDATE runs SET status = 'active', completed_at = NULL WHERE id = 'run-1';
    `);
    const env = testEnv(database, () => {
      database.prepare(
        `UPDATE runs SET status = 'complete', completed_at = '2026-08-07T10:08:00.000Z'
         WHERE id = 'run-1'`,
      ).run();
    });

    const response = await request(env, "/samples/sample-1/runs/run-1/metrology", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        templateVersionId: "template-metrology",
        afterStepId: "step-1",
      }),
    });

    expect(response.status).toBe(409);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM run_steps WHERE run_id = 'run-1' AND entry_kind = 'metrology'",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT status, last_mutation_id FROM runs WHERE id = 'run-1'",
    ).get()).toEqual({ status: "complete", last_mutation_id: null });
    database.close();
  });

  it.each(["run", "sample"] as const)(
    "keeps State verification atomic when its %s moves to trash",
    async (deletedAncestor) => {
      const database = createDatabase();
      addSample(database);
      addRun(database);
      let stepUpdatedAt = "";
      const env = testEnv(database, () => {
        if (deletedAncestor === "run") {
          database.prepare(
            `UPDATE runs SET deleted_at = '2026-08-07T10:08:00.000Z',
             deleted_by = 'other@example.com' WHERE id = 'run-1'`,
          ).run();
        } else {
          database.prepare(
            `UPDATE samples SET deleted_at = '2026-08-07T10:08:00.000Z',
             deleted_by = 'other@example.com' WHERE id = 'sample-1'`,
          ).run();
        }
        stepUpdatedAt = String(database.prepare(
          "SELECT updated_at FROM run_steps WHERE id = 'step-1'",
        ).get()?.updated_at);
      });

      const response = await request(
        env,
        "/samples/sample-1/runs/run-1/steps/step-1/verify-state",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            result: "mismatched",
            note: "Race",
            expectedUpdatedAt: "2026-08-07T10:05:00.000Z",
            completeStep: false,
          }),
        },
      );

      expect(response.status).toBe(409);
      expect(database.prepare("SELECT COUNT(*) AS count FROM state_verifications").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM state_verification_steps").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM recipe_change_proposals").get())
        .toEqual({ count: 0 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE kind = 'verification'",
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(
        "SELECT updated_at, last_mutation_id FROM run_steps WHERE id = 'step-1'",
      ).get()).toEqual({ updated_at: stepUpdatedAt, last_mutation_id: null });
      database.close();
    },
  );

  it.each([48, 180])(
    "verifies state across %i covered steps within D1's 100-parameter limit",
    async (coveredStepCount) => {
      const database = createDatabase();
      addSample(database);
      addRun(database);
      addActualizedVerificationSteps(database, coveredStepCount);

      const response = await request(
        testEnv(database),
        `/samples/sample-1/runs/run-1/steps/step-${coveredStepCount}/verify-state`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            result: "matched",
            note: `Covered ${coveredStepCount} steps`,
            expectedUpdatedAt: "2026-08-07T10:05:00.000Z",
            completeStep: false,
          }),
        },
      );

      expect(response.status).toBe(201);
      const payload = await response.json() as {
        verification: { id: string; coveredRunStepIds: string[] };
      };
      expect(payload.verification.coveredRunStepIds).toHaveLength(coveredStepCount);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM state_verification_steps WHERE verification_id = ?",
      ).get(payload.verification.id)).toEqual({ count: coveredStepCount });
      database.close();
    },
  );

  it("keeps execution-image restore atomic when the Run moves to trash", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    database.exec(`
      INSERT INTO assets
        (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES
        ('restore-asset', 'restore-key', 'restore.png', 'image/png', 10, 'ready',
         'restore-hash', '2026-08-07T10:06:00.000Z');
      INSERT INTO run_step_assets
        (id, run_step_id, asset_id, role, created_at, deleted_at, deleted_by)
      VALUES
        ('restore-occurrence', 'step-1', 'restore-asset', 'execution',
         '2026-08-07T10:06:00.000Z', '2026-08-07T10:07:00.000Z',
         'local-development');
      INSERT INTO events
        (id, sample_id, kind, body, asset_key, metadata_json, created_at)
      VALUES
        ('restore-source-event', 'sample-1', 'image', 'Execution image', NULL,
         '{"runId":"run-1","stepId":"step-1","runStepAssetId":"restore-occurrence","assetDeletedAt":"2026-08-07T10:07:00.000Z"}',
         '2026-08-07T10:06:00.000Z');
    `);
    let postRaceState: { step_updated_at: string; sample_updated_at: string } | undefined;
    const env = testEnv(database, () => {
      database.prepare(
        `UPDATE runs SET deleted_at = '2026-08-07T10:08:00.000Z',
         deleted_by = 'other@example.com' WHERE id = 'run-1'`,
      ).run();
      postRaceState = database.prepare(
        `SELECT rs.updated_at AS step_updated_at, s.updated_at AS sample_updated_at
         FROM run_steps rs JOIN runs r ON r.id = rs.run_id
         JOIN samples s ON s.id = r.sample_id WHERE rs.id = 'step-1'`,
      ).get() as { step_updated_at: string; sample_updated_at: string };
    });

    const response = await request(
      env,
      "/samples/sample-1/runs/run-1/steps/step-1/assets/restore",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetKey: "restore-key" }),
      },
    );

    expect(response.status).toBe(409);
    expect(database.prepare(
      `SELECT deleted_at, last_mutation_id FROM run_step_assets
       WHERE id = 'restore-occurrence'`,
    ).get()).toEqual({
      deleted_at: "2026-08-07T10:07:00.000Z",
      last_mutation_id: null,
    });
    expect(database.prepare(
      "SELECT asset_key FROM events WHERE id = 'restore-source-event'",
    ).get()).toEqual({ asset_key: null });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM events
       WHERE json_extract(metadata_json, '$.action') = 'execution_attachment_restored'`,
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      `SELECT rs.updated_at AS step_updated_at, s.updated_at AS sample_updated_at
       FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id WHERE rs.id = 'step-1'`,
    ).get()).toEqual(postRaceState);
    database.close();
  });

  it("guards direct Comment-item restore at the mutation statement", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    database.exec(`
      INSERT INTO comment_submissions
        (id, context_kind, scope, body, status, actor_email, created_at, updated_at)
      VALUES
        ('submission-item-race', 'run_steps', 'individual', 'Attachment',
         'ready', 'local-development',
         '2026-08-07T10:06:00.000Z', '2026-08-07T10:06:00.000Z');
      INSERT INTO comment_submission_targets
        (submission_id, sample_id, run_id, run_step_id, expected_updated_at)
      VALUES
        ('submission-item-race', 'sample-1', 'run-1', 'step-1',
         '2026-08-07T10:05:00.000Z');
      INSERT INTO comment_submission_items
        (id, submission_id, kind, status, position, filename,
         created_at, updated_at, deleted_at, deleted_by)
      VALUES
        ('item-race', 'submission-item-race', 'attachment', 'ready', 0,
         'result.dat', '2026-08-07T10:06:00.000Z',
         '2026-08-07T10:07:00.000Z', '2026-08-07T10:07:00.000Z',
         'local-development');
    `);
    let movedToTrash = false;
    const env = testEnv(database, undefined, () => {
      if (movedToTrash) return;
      movedToTrash = true;
      database.prepare(
        `UPDATE runs SET deleted_at = '2026-08-07T10:08:00.000Z',
         deleted_by = 'other@example.com' WHERE id = 'run-1'`,
      ).run();
    });

    const response = await request(
      env,
      "/comment-submissions/submission-item-race/items/item-race/restore",
      { method: "POST" },
    );

    expect(response.status).toBe(409);
    expect(database.prepare(
      "SELECT deleted_at FROM comment_submission_items WHERE id = 'item-race'",
    ).get()).toEqual({ deleted_at: "2026-08-07T10:07:00.000Z" });
    database.close();
  });

  it("keeps timeline attachment deletion atomic when its Run moves to trash", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    database.exec(`
      INSERT INTO assets
        (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES
        ('timeline-asset', 'timeline-key', 'timeline.png', 'image/png', 10, 'ready',
         'timeline-hash', '2026-08-07T10:06:00.000Z');
      INSERT INTO run_step_assets (id, run_step_id, asset_id, role, created_at)
      VALUES
        ('timeline-occurrence', 'step-1', 'timeline-asset', 'execution',
         '2026-08-07T10:06:00.000Z');
      INSERT INTO events
        (id, sample_id, kind, body, asset_key, metadata_json, created_at)
      VALUES
        ('timeline-event', 'sample-1', 'image', 'Execution image', 'timeline-key',
         '{"runId":"run-1","stepId":"step-1","runStepAssetId":"timeline-occurrence"}',
         '2026-08-07T10:06:00.000Z');
    `);
    const env = testEnv(database, () => {
      database.prepare(
        `UPDATE runs SET deleted_at = '2026-08-07T10:08:00.000Z',
         deleted_by = 'other@example.com' WHERE id = 'run-1'`,
      ).run();
    });

    const response = await request(
      env,
      "/samples/sample-1/events/timeline-event/asset",
      { method: "DELETE" },
    );

    expect(response.status).toBe(409);
    expect(database.prepare(
      `SELECT deleted_at, last_mutation_id FROM run_step_assets
       WHERE id = 'timeline-occurrence'`,
    ).get()).toEqual({ deleted_at: null, last_mutation_id: null });
    expect(database.prepare(
      "SELECT asset_key FROM events WHERE id = 'timeline-event'",
    ).get()).toEqual({ asset_key: "timeline-key" });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM events
       WHERE json_extract(metadata_json, '$.action') = 'image_attachment_deleted'`,
    ).get()).toEqual({ count: 0 });
    database.close();
  });

  it("deletes one execution occurrence and every timeline event that references it", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    database.exec(`
      INSERT INTO assets
        (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES
        ('shared-timeline-asset', 'shared-timeline-key', 'shared.png', 'image/png',
         10, 'ready', 'shared-timeline-hash', '2026-08-07T10:06:00.000Z');
      INSERT INTO run_step_assets (id, run_step_id, asset_id, role, created_at)
      VALUES
        ('shared-timeline-occurrence', 'step-1', 'shared-timeline-asset', 'execution',
         '2026-08-07T10:06:00.000Z');
      INSERT INTO events
        (id, sample_id, kind, body, asset_key, metadata_json, created_at)
      VALUES
        ('shared-timeline-event-a', 'sample-1', 'image', 'Execution image A',
         'shared-timeline-key',
         '{"runId":"run-1","stepId":"step-1","runStepAssetId":"shared-timeline-occurrence"}',
         '2026-08-07T10:06:00.000Z'),
        ('shared-timeline-event-b', 'sample-1', 'image', 'Execution image B',
         'shared-timeline-key',
         '{"runId":"run-1","stepId":"step-1","runStepAssetId":"shared-timeline-occurrence"}',
         '2026-08-07T10:07:00.000Z');
    `);

    const response = await request(
      testEnv(database),
      "/samples/sample-1/events/shared-timeline-event-a/asset",
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(database.prepare(
      `SELECT deleted_at IS NOT NULL AS deleted, last_mutation_id IS NOT NULL AS mutated
       FROM run_step_assets WHERE id = 'shared-timeline-occurrence'`,
    ).get()).toEqual({ deleted: 1, mutated: 1 });
    expect(database.prepare(
      `SELECT id, asset_key,
              json_extract(metadata_json, '$.runStepAssetId') AS occurrence_id,
              json_extract(metadata_json, '$.assetDeletionOperationId') IS NOT NULL AS marked
       FROM events
       WHERE id IN ('shared-timeline-event-a', 'shared-timeline-event-b')
       ORDER BY id`,
    ).all()).toEqual([
      {
        id: "shared-timeline-event-a",
        asset_key: null,
        occurrence_id: "shared-timeline-occurrence",
        marked: 1,
      },
      {
        id: "shared-timeline-event-b",
        asset_key: null,
        occurrence_id: "shared-timeline-occurrence",
        marked: 1,
      },
    ]);
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM events
       WHERE json_extract(metadata_json, '$.action') = 'image_attachment_deleted'`,
    ).get()).toEqual({ count: 1 });
    database.close();
  });

  it("resolves a legacy execution-image event to one occurrence before deletion", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    database.exec(`
      INSERT INTO assets
        (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES
        ('legacy-timeline-asset', 'legacy-timeline-key', 'legacy.png', 'image/png',
         10, 'ready', 'legacy-timeline-hash', '2026-08-07T10:06:00.000Z');
      INSERT INTO run_step_assets (id, run_step_id, asset_id, role, created_at)
      VALUES
        ('legacy-timeline-occurrence', 'step-1', 'legacy-timeline-asset', 'execution',
         '2026-08-07T10:06:00.000Z');
      INSERT INTO events
        (id, sample_id, kind, body, asset_key, metadata_json, created_at)
      VALUES
        ('legacy-timeline-event', 'sample-1', 'image', 'Legacy execution image',
         'legacy-timeline-key', '{"runId":"run-1","stepId":"step-1"}',
         '2026-08-07T10:06:00.000Z');
    `);

    const response = await request(
      testEnv(database),
      "/samples/sample-1/events/legacy-timeline-event/asset",
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(database.prepare(
      `SELECT asset_key,
              json_extract(metadata_json, '$.runStepAssetId') AS occurrence_id
       FROM events WHERE id = 'legacy-timeline-event'`,
    ).get()).toEqual({ asset_key: null, occurrence_id: "legacy-timeline-occurrence" });
    expect(database.prepare(
      "SELECT deleted_at IS NOT NULL AS deleted FROM run_step_assets WHERE id = 'legacy-timeline-occurrence'",
    ).get()).toEqual({ deleted: 1 });
    database.close();
  });

  it("uses deletion operation identity when timestamps and actors collide", async () => {
    const database = createDatabase();
    addSample(database);
    addRun(database);
    database.exec(`
      INSERT INTO run_steps
        (id, run_id, position, status, origin, entry_kind, title, created_at, updated_at)
      VALUES
        ('step-2', 'run-1', 2000, 'done', 'template', 'fabrication', 'Step 2',
         '2026-08-07T10:05:00.000Z', '2026-08-07T10:05:00.000Z');
      INSERT INTO comment_submissions
        (id, context_kind, scope, body, status, actor_email, created_at, updated_at,
         deleted_at, deleted_by, deletion_operation_id)
      VALUES
        ('submission-collision', 'run_steps', 'common', 'Collision', 'ready',
         'local-development', '2026-08-07T10:06:00.000Z',
         '2026-08-07T10:07:00.000Z', '2026-08-07T10:07:00.000Z',
         'local-development', 'canonical-delete-op');
      INSERT INTO comment_submission_targets
        (submission_id, sample_id, run_id, run_step_id, expected_updated_at)
      VALUES
        ('submission-collision', 'sample-1', 'run-1', 'step-1',
         '2026-08-07T10:05:00.000Z'),
        ('submission-collision', 'sample-1', 'run-1', 'step-2',
         '2026-08-07T10:05:00.000Z');
      INSERT INTO run_step_comments
        (id, run_step_id, scope, operation_group_id, body, submission_id,
         actor_email, created_at, updated_at, deleted_at, deleted_by,
         deletion_operation_id)
      VALUES
        ('collision-independent', 'step-1', 'common', 'collision-group', 'Collision',
         'submission-collision', 'local-development',
         '2026-08-07T10:06:00.000Z', '2026-08-07T10:07:00.000Z',
         '2026-08-07T10:07:00.000Z', 'local-development',
         'independent-delete-op'),
        ('collision-canonical', 'step-2', 'common', 'collision-group', 'Collision',
         'submission-collision', 'local-development',
         '2026-08-07T10:06:00.000Z', '2026-08-07T10:07:00.000Z',
         '2026-08-07T10:07:00.000Z', 'local-development',
         'canonical-delete-op');
    `);

    const response = await request(
      testEnv(database),
      "/comment-submissions/submission-collision/restore",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(database.prepare(
      `SELECT id, deleted_at, deletion_operation_id
       FROM run_step_comments
       WHERE id IN ('collision-independent', 'collision-canonical')
       ORDER BY id`,
    ).all()).toEqual([
      {
        id: "collision-canonical",
        deleted_at: null,
        deletion_operation_id: null,
      },
      {
        id: "collision-independent",
        deleted_at: "2026-08-07T10:07:00.000Z",
        deletion_operation_id: "independent-delete-op",
      },
    ]);
    database.close();
  });

  it("keeps a deleted Recipe revision and restores the same identity", async () => {
    const database = createDatabase();
    const env = testEnv(database);

    const deletedResponse = await request(env, "/templates/template-process", { method: "DELETE" });
    expect(deletedResponse.status).toBe(200);
    expect(await deletedResponse.json()).toMatchObject({ ok: true, disposition: "deleted" });
    expect(database.prepare(
      "SELECT id, deleted_at IS NOT NULL AS deleted FROM template_versions WHERE id = 'template-process'",
    ).get()).toEqual({ id: "template-process", deleted: 1 });
    expect((await request(env, "/templates/template-process")).status).toBe(404);
    const hidden = await (await request(env, "/templates")).json() as { templates: Array<{ id: string }> };
    expect(hidden.templates.map((template) => template.id)).not.toContain("template-process");

    expect((await request(env, "/templates/template-process/restore", { method: "POST" })).status).toBe(200);
    expect(database.prepare(
      "SELECT id, deleted_at, deleted_by FROM template_versions WHERE id = 'template-process'",
    ).get()).toEqual({ id: "template-process", deleted_at: null, deleted_by: null });
    expect((await request(env, "/templates/template-process")).status).toBe(200);
    database.close();
  });
});
