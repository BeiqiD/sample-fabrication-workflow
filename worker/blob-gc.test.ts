import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/content-addressing";
import worker from "./index";
import { cleanupCommentUploads } from "./comment-upload-cleanup";
import type { Env } from "./types";

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    readonly query: string,
    readonly bindings: unknown[] = [],
    private readonly beforeExecute?: (query: string, bindings: unknown[]) => void,
  ) {}

  bind(...bindings: unknown[]) {
    return new SqliteD1Statement(this.database, this.query, bindings, this.beforeExecute);
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
    return this.execute();
  }

  execute() {
    this.beforeExecute?.(this.query, this.bindings);
    const statement = this.statement();
    if (/^\s*SELECT\b/i.test(this.query)) {
      return { success: true, meta: { changes: 0 }, results: statement.all(...this.bindings) };
    }
    const result = statement.run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) }, results: [] };
  }
}

class SqliteD1Database {
  constructor(
    readonly database: DatabaseSync,
    private readonly beforeBatch?: () => void,
    private readonly beforeExecute?: (query: string, bindings: unknown[]) => void,
  ) {}
  prepare(query: string) {
    return new SqliteD1Statement(this.database, query, [], this.beforeExecute);
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

function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(filename, directory), "utf8"));
  }
  database.exec(`
    INSERT INTO samples (id, code, title, created_at, updated_at)
    VALUES ('sample-1', 'S-1', 'Sample', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
  `);
  return database;
}

function envFor(
  database: DatabaseSync,
  assetDelete = vi.fn(async () => undefined),
  options: {
    assetPut?: ReturnType<typeof vi.fn>;
    beforeBatch?: () => void;
    beforeExecute?: (query: string, bindings: unknown[]) => void;
  } = {},
): Env {
  return {
    AUTH_MODE: "disabled",
    DB: new SqliteD1Database(database, options.beforeBatch, options.beforeExecute),
    ASSETS: { delete: assetDelete, put: options.assetPut ?? vi.fn(async () => undefined) },
    MANAGED_STORAGE_PROVIDER: "switchdrive",
    SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/test-user/",
    SWITCHDRIVE_USERNAME: "test-user",
    SWITCHDRIVE_APP_PASSWORD: "test-password",
  } as unknown as Env;
}

function cancel(env: Env, submissionId: string) {
  return worker.fetch(new Request(
    `https://samples.run/api/comment-submissions/${submissionId}/cancel`,
    { method: "POST" },
  ), env, {} as ExecutionContext);
}

afterEach(() => vi.unstubAllGlobals());

describe("blob garbage collection", () => {

  it("reaps an expired FabuBlox lease, releases its hash, and retries queued deletion", async () => {
    const database = migratedDatabase();
    const bytes = new TextEncoder().encode('data');
    const sha = await sha256Hex(bytes.buffer);
    database.prepare(`
      INSERT INTO imports (
        id, status, source_filename, source_sha256, sheet_name, template_type,
        warning_count, created_at, operation_id, lease_expires_at
      ) VALUES (
        'stale-import', 'pending', 'stale.xlsx', ?, 'Process', 'process',
        0, '2026-01-01T00:00:00.000Z', 'stale-operation',
        '2026-01-02T00:00:00.000Z'
      )
    `).run(sha);
    database.prepare(`
      INSERT INTO assets (
        id, import_id, r2_key, original_name, mime_type, byte_size,
        status, created_at, sha256
      ) VALUES (
        'stale-import-asset', 'stale-import', 'imports/stale/source.xlsx',
        'stale.xlsx', 'application/octet-stream', 4,
        'pending', '2026-01-01T00:00:00.000Z', ?
      )
    `).run(sha);
    const assetDelete = vi.fn()
      .mockRejectedValueOnce(new Error('temporary R2 delete outage'))
      .mockResolvedValue(undefined);
    const assetPut = vi.fn(async () => undefined);
    const env = envFor(database, assetDelete, { assetPut });

    const first = await cleanupCommentUploads(env, new Date('2026-08-14T00:00:00.000Z'));
    expect(first).toMatchObject({
      staleImportsFailed: 1,
      staleImportAssetsReleased: 1,
      staleImportObjectsQueued: 1,
      staleImportRecoveryFailures: 0,
      failures: 1,
    });
    expect(database.prepare(`
      SELECT status, recovery_operation_id IS NOT NULL AS recovered
      FROM imports WHERE id = 'stale-import'
    `).get()).toEqual({ status: 'failed', recovered: 1 });
    expect(database.prepare(`
      SELECT status, sha256 FROM assets WHERE id = 'stale-import-asset'
    `).get()).toEqual({ status: 'failed', sha256: null });
    expect(database.prepare(`
      SELECT state, last_error IS NOT NULL AS has_error
      FROM blob_gc_ledger WHERE object_key = 'imports/stale/source.xlsx'
    `).get()).toEqual({ state: 'orphaned', has_error: 1 });

    const replacement = await worker.fetch(new Request(
      'https://samples.run/api/assets',
      {
        method: 'POST',
        headers: { 'content-type': 'image/png', 'x-filename': 'replacement.png' },
        body: bytes,
      },
    ), env, {} as ExecutionContext);
    expect(replacement.status).toBe(201);
    expect(assetPut).toHaveBeenCalledTimes(1);

    const second = await cleanupCommentUploads(env, new Date('2026-08-15T00:00:00.000Z'));
    expect(second.failures).toBe(0);
    expect(database.prepare(`
      SELECT state FROM blob_gc_ledger
      WHERE object_key = 'imports/stale/source.xlsx'
    `).get()).toEqual({ state: 'deleted' });
    expect(assetDelete).toHaveBeenCalledTimes(2);
    database.close();
  });
  it("keeps shared R2 and managed bytes while another unfinished submission can finalize", async () => {
    const database = migratedDatabase();
    database.exec(`
      INSERT INTO assets
        (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES ('asset-shared', 'comments/shared.webp', 'shared.webp', 'image/webp', 4,
        'ready', '${"a".repeat(64)}', '2026-07-01T00:00:00.000Z');
      INSERT INTO managed_storage_objects
        (id, provider, object_key, original_name, mime_type, byte_size, sha256,
         status, created_at)
      VALUES ('managed-shared', 'switchdrive', 'comments/shared.bin', 'shared.bin',
        'application/octet-stream', 4, '${"b".repeat(64)}', 'ready',
        '2026-07-01T00:00:00.000Z');
      INSERT INTO comment_submissions
        (id, context_kind, sample_id, body, status, created_at, updated_at, retry_until)
      VALUES
        ('submission-a', 'sample', 'sample-1', 'A', 'uploading',
          '2026-07-01T00:00:00.000Z', '2026-08-08T00:00:00.000Z',
          '2026-08-20T00:00:00.000Z'),
        ('submission-b', 'sample', 'sample-1', 'B', 'uploading',
          '2026-07-01T00:00:00.000Z', '2026-08-08T00:00:00.000Z',
          '2026-08-20T00:00:00.000Z');
      INSERT INTO comment_submission_items
        (id, submission_id, kind, status, position, asset_id, created_at, updated_at)
      VALUES
        ('image-a', 'submission-a', 'comment_image', 'ready', 0, 'asset-shared',
          '2026-07-01T00:00:00.000Z', '2026-08-08T00:00:00.000Z'),
        ('image-b', 'submission-b', 'comment_image', 'ready', 0, 'asset-shared',
          '2026-07-01T00:00:00.000Z', '2026-08-08T00:00:00.000Z');
      INSERT INTO comment_submission_items
        (id, submission_id, kind, status, position, storage_object_id, created_at, updated_at)
      VALUES
        ('file-a', 'submission-a', 'attachment', 'ready', 1, 'managed-shared',
          '2026-07-01T00:00:00.000Z', '2026-08-08T00:00:00.000Z'),
        ('file-b', 'submission-b', 'attachment', 'ready', 1, 'managed-shared',
          '2026-07-01T00:00:00.000Z', '2026-08-08T00:00:00.000Z');
    `);
    const env = envFor(database);

    expect((await cancel(env, "submission-a")).status).toBe(200);
    expect(database.prepare("SELECT COUNT(*) AS count FROM blob_gc_ledger").get())
      .toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT status FROM managed_storage_objects WHERE id = 'managed-shared'",
    ).get()).toEqual({ status: "ready" });

    expect((await cancel(env, "submission-b")).status).toBe(200);
    expect(database.prepare(
      "SELECT store_kind, state FROM blob_gc_ledger ORDER BY store_kind",
    ).all()).toEqual([
      { store_kind: "managed", state: "orphaned" },
      { store_kind: "r2", state: "orphaned" },
    ]);
    database.close();
  });

  it("keeps Cancel atomic when Finalize wins the transition", async () => {
    const database = migratedDatabase();
    database.exec(`
      INSERT INTO managed_storage_objects
        (id, provider, object_key, original_name, mime_type, byte_size, sha256,
         status, created_at)
      VALUES ('managed-finalize', 'switchdrive', 'comments/finalize.bin', 'finalize.bin',
        'application/octet-stream', 4, '${"1".repeat(64)}', 'ready',
        '2026-07-01T00:00:00.000Z');
      INSERT INTO comment_submissions
        (id, context_kind, sample_id, body, status, created_at, updated_at, retry_until)
      VALUES ('finalize-wins', 'sample', 'sample-1', 'Ready', 'uploading',
        '2026-07-01T00:00:00.000Z', '2026-08-08T00:00:00.000Z',
        '2026-08-20T00:00:00.000Z');
      INSERT INTO comment_submission_items
        (id, submission_id, kind, status, position, storage_object_id, created_at, updated_at)
      VALUES ('finalize-item', 'finalize-wins', 'attachment', 'ready', 0,
        'managed-finalize', '2026-07-01T00:00:00.000Z', '2026-08-08T00:00:00.000Z');
    `);
    let raced = false;
    const env = envFor(database, undefined, {
      beforeBatch: () => {
        if (raced) return;
        raced = true;
        database.prepare(
          `UPDATE comment_submissions
           SET status = 'ready', completed_at = '2026-08-08T00:01:00.000Z',
               retry_closed_at = '2026-08-08T00:01:00.000Z', retry_closed_by = 'finalize',
               last_mutation_id = 'finalize-won', updated_at = '2026-08-08T00:01:00.000Z'
           WHERE id = 'finalize-wins'`,
        ).run();
      },
    });

    expect((await cancel(env, "finalize-wins")).status).toBe(409);
    expect(database.prepare(
      "SELECT status, last_mutation_id FROM comment_submissions WHERE id = 'finalize-wins'",
    ).get()).toEqual({ status: "ready", last_mutation_id: "finalize-won" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM blob_gc_ledger").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it("retains bytes when Cancel wins while an upload completion is being recorded", async () => {
    const database = migratedDatabase();
    database.exec(`
      INSERT INTO comment_submissions
        (id, context_kind, sample_id, body, status, created_at, updated_at, retry_until)
      VALUES ('upload-race', 'sample', 'sample-1', 'Image', 'uploading',
        '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z',
        '2026-08-20T00:00:00.000Z');
      INSERT INTO comment_submission_items
        (id, submission_id, kind, status, position, filename, mime_type, byte_size,
         created_at, updated_at)
      VALUES ('upload-race-item', 'upload-race', 'comment_image', 'pending', 0,
        'image.png', 'image/png', 4, '2026-08-08T00:00:00.000Z',
        '2026-08-08T00:00:00.000Z');
    `);
    let cancelled = false;
    const assetDelete = vi.fn(async () => undefined);
    const assetPut = vi.fn(async () => undefined);
    const env = envFor(database, assetDelete, {
      assetPut,
      beforeExecute: (query) => {
        if (cancelled || !query.includes("SET status = CASE")) return;
        cancelled = true;
        database.exec(`
          UPDATE comment_submissions
          SET status = 'cancelled', cancelled_at = '2026-08-08T00:01:00.000Z',
              retry_closed_at = '2026-08-08T00:01:00.000Z', retry_closed_by = 'cancel',
              updated_at = '2026-08-08T00:01:00.000Z'
          WHERE id = 'upload-race';
          UPDATE comment_submission_items SET status = 'cancelled'
          WHERE id = 'upload-race-item';
        `);
      },
    });
    const response = await worker.fetch(new Request(
      "https://samples.run/api/comment-submissions/upload-race/items/upload-race-item/content",
      {
        method: "PUT",
        headers: { "content-type": "image/png", "x-upload-size": "4" },
        body: "data",
      },
    ), env, {} as ExecutionContext);

    expect(response.status).toBe(409);
    expect(assetPut).toHaveBeenCalledTimes(1);
    expect(assetDelete).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT status, asset_id IS NOT NULL AS linked FROM comment_submission_items WHERE id = 'upload-race-item'",
    ).get()).toEqual({ status: "cancelled", linked: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM blob_retention_edges").get())
      .toEqual({ count: 0 });

    await cleanupCommentUploads(env, new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000));
    expect(database.prepare(
      "SELECT state FROM blob_gc_ledger WHERE blob_record_id = (SELECT asset_id FROM comment_submission_items WHERE id = 'upload-race-item')",
    ).get()).toEqual({ state: "orphaned" });
    database.close();
  });

  it("claims both providers, keeps asset readiness metadata, and finalizes by operation id", async () => {
    const database = migratedDatabase();
    database.exec(`
      INSERT INTO assets
        (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES ('asset-old', 'orphan/old.webp', 'old.webp', 'image/webp', 4,
        'ready', '${"c".repeat(64)}', '2026-07-01T00:00:00.000Z');
      INSERT INTO managed_storage_objects
        (id, provider, object_key, original_name, mime_type, byte_size, sha256,
         status, created_at, orphaned_at)
      VALUES ('managed-old', 'switchdrive', 'orphan/old.bin', 'old.bin',
        'application/octet-stream', 4, '${"d".repeat(64)}', 'orphaned',
        '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
      INSERT INTO blob_gc_ledger
        (store_kind, provider, object_key, blob_record_id, state, operation_id,
         orphaned_at, updated_at)
      VALUES
        ('r2', 'r2', 'orphan/old.webp', 'asset-old', 'orphaned', 'mark-r2',
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
        ('managed', 'switchdrive', 'orphan/old.bin', 'managed-old', 'orphaned',
          'mark-managed', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    `);
    const assetDelete = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`Unexpected provider call ${init?.method}`);
    }));
    const result = await cleanupCommentUploads(
      envFor(database, assetDelete),
      new Date("2026-08-20T00:00:00.000Z"),
    );
    expect(result).toEqual(expect.objectContaining({ imageDeleted: 1, managedDeleted: 1, failures: 0 }));
    expect(assetDelete).toHaveBeenCalledWith("orphan/old.webp");
    expect(database.prepare(
      "SELECT store_kind, state FROM blob_gc_ledger ORDER BY store_kind",
    ).all()).toEqual([
      { store_kind: "managed", state: "deleted" },
      { store_kind: "r2", state: "deleted" },
    ]);
    expect(database.prepare("SELECT status FROM assets WHERE id = 'asset-old'").get())
      .toEqual({ status: "ready" });
    expect(database.prepare("SELECT status FROM managed_storage_objects WHERE id = 'managed-old'").get())
      .toEqual({ status: "deleted" });
    database.close();
  });

  it("retries a stale deleting claim after provider success and converges idempotently", async () => {
    const database = migratedDatabase();
    database.exec(`
      INSERT INTO assets
        (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES ('asset-retry', 'orphan/retry.webp', 'retry.webp', 'image/webp', 4,
        'ready', '${"e".repeat(64)}', '2026-07-01T00:00:00.000Z');
      INSERT INTO blob_gc_ledger
        (store_kind, provider, object_key, blob_record_id, state, operation_id,
         orphaned_at, deletion_started_at, attempt_count, updated_at)
      VALUES ('r2', 'r2', 'orphan/retry.webp', 'asset-retry', 'deleting',
        'delete-operation', '2026-08-01T00:00:00.000Z',
        '2026-08-19T00:00:00.000Z', 1, '2026-08-19T00:00:00.000Z');
    `);
    const assetDelete = vi.fn(async () => undefined);
    const result = await cleanupCommentUploads(
      envFor(database, assetDelete),
      new Date("2026-08-20T00:00:00.000Z"),
    );
    expect(result.imageDeleted).toBe(1);
    expect(assetDelete).toHaveBeenCalledWith("orphan/retry.webp");
    expect(database.prepare(
      "SELECT state, operation_id, attempt_count FROM blob_gc_ledger WHERE object_key = 'orphan/retry.webp'",
    ).get()).toEqual({ state: "deleted", operation_id: "delete-operation", attempt_count: 2 });
    database.close();
  });

  it("records provider deletion failures as retryable orphan work", async () => {
    const database = migratedDatabase();
    database.exec(`
      INSERT INTO assets
        (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES ('asset-provider-failure', 'orphan/provider-failure.bin', 'failure.bin',
        'application/octet-stream', 4, 'ready', '${"2".repeat(64)}',
        '2026-07-01T00:00:00.000Z');
      INSERT INTO blob_gc_ledger
        (store_kind, provider, object_key, blob_record_id, state, operation_id,
         orphaned_at, updated_at)
      VALUES ('r2', 'r2', 'orphan/provider-failure.bin', 'asset-provider-failure',
        'orphaned', 'mark-failure', '2026-08-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z');
    `);
    const result = await cleanupCommentUploads(
      envFor(database, vi.fn(async () => { throw new Error("provider timeout"); })),
      new Date("2026-08-20T00:00:00.000Z"),
    );
    expect(result.failures).toBe(1);
    expect(database.prepare(
      `SELECT state, deletion_started_at, attempt_count, last_error
       FROM blob_gc_ledger WHERE object_key = 'orphan/provider-failure.bin'`,
    ).get()).toEqual({
      state: "orphaned",
      deletion_started_at: null,
      attempt_count: 1,
      last_error: "provider timeout",
    });
    database.close();
  });

  it("bounds orphan discovery at 100 rows without exceeding D1 bindings", async () => {
    const database = migratedDatabase();
    const insert = database.prepare(
      `INSERT INTO assets
       (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
       VALUES (?, ?, ?, 'application/octet-stream', 1, 'ready', ?,
         '2026-07-01T00:00:00.000Z')`,
    );
    for (let index = 0; index < 130; index += 1) {
      const id = `bounded-${String(index).padStart(3, "0")}`;
      insert.run(id, `bounded/${id}.bin`, `${id}.bin`, index.toString(16).padStart(64, "0"));
    }
    const result = await cleanupCommentUploads(
      envFor(database),
      new Date("2026-08-08T00:00:00.000Z"),
    );
    expect(result.orphanCandidatesMarked).toBe(100);
    expect(database.prepare("SELECT COUNT(*) AS count FROM blob_gc_ledger").get())
      .toEqual({ count: 100 });
    database.close();
  });

  it("closes expired retries explicitly while a retry that wins first extends the window", async () => {
    const database = migratedDatabase();
    database.exec(`
      INSERT INTO comment_submissions
        (id, context_kind, sample_id, body, status, created_at, updated_at, retry_until)
      VALUES
        ('expired', 'sample', 'sample-1', 'Expired', 'failed',
          '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
          '2026-08-02T00:00:00.000Z'),
        ('retry-wins', 'sample', 'sample-1', 'Retry', 'failed',
          '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
          '2026-08-02T00:00:00.000Z');
      INSERT INTO comment_submission_items
        (id, submission_id, kind, status, position, created_at, updated_at)
      VALUES
        ('expired-item', 'expired', 'comment_image', 'failed', 0,
          '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
        ('retry-item', 'retry-wins', 'comment_image', 'failed', 0,
          '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    `);
    const env = envFor(database);
    const retryResponse = await worker.fetch(new Request(
      "https://samples.run/api/comment-submissions/retry-wins/items/retry-item/fail",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Retry later" }),
      },
    ), env, {} as ExecutionContext);
    expect(retryResponse.status).toBe(200);

    await cleanupCommentUploads(env, new Date("2026-08-10T00:00:00.000Z"));
    expect(database.prepare(
      "SELECT retry_closed_at IS NOT NULL AS closed FROM comment_submissions WHERE id = 'expired'",
    ).get()).toEqual({ closed: 1 });
    expect(database.prepare(
      "SELECT retry_closed_at, retry_until FROM comment_submissions WHERE id = 'retry-wins'",
    ).get()).toEqual(expect.objectContaining({ retry_closed_at: null }));

    const closedResponse = await worker.fetch(new Request(
      "https://samples.run/api/comment-submissions/expired/items/expired-item/fail",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Too late" }),
      },
    ), env, {} as ExecutionContext);
    expect(closedResponse.status).toBe(409);
    database.close();
  });
});
