import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/content-addressing";
import worker from "./index";
import { acceptCommentSubmission, acceptCommentUpload, uploadAcceptedCommentItem, commentManagedFetch } from "./comment-acceptance-test-support";
import { cleanupCommentUploads } from "./comment-upload-cleanup";
import { collectBlobGarbage, type BlobGarbageCollectionDependencies } from "./blob-lifecycle/gc";
import { reclaimBlobDeletion, refreshOrphanGrace } from "./blob-lifecycle/reachability";
import { ByteDeletionError } from "./files/byte-deleter";
import type { BlobLocator } from "./blob-lifecycle/types";
import type { Env } from "./types";

// Match observed native D1 repeated-SQL reuse, never cached query results.
// SQLite still recompiles automatically after schema or trigger changes.
const compiledByDatabase = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
function compiledStatement(database: DatabaseSync, query: string) {
  let compiled = compiledByDatabase.get(database);
  if (!compiled) { compiled = new Map(); compiledByDatabase.set(database, compiled); }
  let statement = compiled.get(query);
  if (statement) compiled.delete(query);
  else statement = database.prepare(query);
  compiled.set(query, statement);
  if (compiled.size > 256) compiled.delete(compiled.keys().next().value!);
  return statement;
}

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
    return compiledStatement(this.database, this.query);
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
    private readonly beforeBatch?: () => void | Promise<void>,
    private readonly beforeExecute?: (query: string, bindings: unknown[]) => void,
  ) {}
  prepare(query: string) {
    return new SqliteD1Statement(this.database, query, [], this.beforeExecute);
  }
  async batch(statements: SqliteD1Statement[]) {
    await this.beforeBatch?.();
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
    initialAssets?: ReadonlyMap<string, Uint8Array>;
    beforeBatch?: () => void | Promise<void>;
    beforeExecute?: (query: string, bindings: unknown[]) => void;
  } = {},
): Env {
  const uploaded = new Map<string, Uint8Array>(options.initialAssets);
  return {
    AUTH_MODE: "disabled",
    R2_BOOTSTRAP_NAMESPACE: JSON.stringify({ kind: "local-r2", installationId: "4e5c6dd7-325b-4eae-8499-518eaa0fcb40", bucketName: "test-assets" }),
    DB: new SqliteD1Database(database, options.beforeBatch, options.beforeExecute),
    ASSETS: {
      delete: assetDelete,
      put: async (key: string, value: ArrayBuffer, metadata: unknown) => {
        await options.assetPut?.(key, value, metadata);
        uploaded.set(key, new Uint8Array(value.slice(0)));
      },
      head: async (key: string) => {
        const row = database.prepare(`
          SELECT byte_size FROM assets WHERE r2_key = ?
        `).get(key) as { byte_size: number } | undefined;
        if (!row) return null;
        return {
          size: Number(row.byte_size),
          httpEtag: '"blob-gc-test"',
          writeHttpMetadata(headers: Headers) {
            headers.set("content-type", "application/octet-stream");
          },
        };
      },
      get: async (key: string) => {
        const row = database.prepare(`
          SELECT byte_size FROM assets WHERE r2_key = ?
        `).get(key) as { byte_size: number } | undefined;
        if (!row) return null;
        const bytes = uploaded.get(key) ?? new Uint8Array(Number(row.byte_size));
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          size: bytes.byteLength,
          httpEtag: '"blob-gc-test"',
          writeHttpMetadata(headers: Headers) {
            headers.set("content-type", "application/octet-stream");
          },
        };
      },
    },
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

function orphanFixture(database: DatabaseSync, storeKind: BlobLocator["storeKind"]): BlobLocator {
  const locator: BlobLocator = {
    storeKind,
    provider: storeKind === "r2" ? "r2" : "switchdrive",
    objectKey: "orphan/fenced.bin",
    blobRecordId: "fenced-blob",
  };
  if (storeKind === "r2") {
    database.prepare(`
      INSERT INTO assets
        (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES (?, ?, 'fenced.bin', 'application/octet-stream', 4, 'ready', ?,
        '2026-07-01T00:00:00.000Z')
    `).run(locator.blobRecordId, locator.objectKey, "9".repeat(64));
  } else {
    database.prepare(`
      INSERT INTO managed_storage_objects
        (id, provider, object_key, original_name, mime_type, byte_size, sha256,
         status, created_at, orphaned_at)
      VALUES (?, ?, ?, 'fenced.bin', 'application/octet-stream', 4, ?, 'orphaned',
        '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
    `).run(locator.blobRecordId, locator.provider, locator.objectKey, "9".repeat(64));
  }
  database.prepare(`
    INSERT INTO blob_gc_ledger
      (store_kind, provider, object_key, blob_record_id, state, operation_id,
       orphaned_at, updated_at)
    VALUES (?, ?, ?, ?, 'orphaned', 'mark-fenced',
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
  `).run(locator.storeKind, locator.provider, locator.objectKey, locator.blobRecordId);
  return locator;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function gcDependencies(
  database: DatabaseSync,
  storage: BlobGarbageCollectionDependencies["storage"],
): BlobGarbageCollectionDependencies {
  let operation = 0;
  return {
    db: new SqliteD1Database(database),
    storage,
    newOperationId: () => `test-operation-${operation++}`,
  };
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
    const env = envFor(database, assetDelete, {
      assetPut,
      initialAssets: new Map([["imports/stale/source.xlsx", bytes]]),
    });

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
    `).get()).toEqual({ state: 'deleting', has_error: 1 });

    const replacement = await worker.fetch(new Request(
      'https://samples.run/api/assets',
      {
        method: 'POST',
        headers: { "x-upload-request-id": crypto.randomUUID(), 'content-type': 'image/png', 'x-filename': 'replacement.png' },
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
  it("keeps shared R2 and managed bytes while another accepted submission can finalize", async () => {
    const database = migratedDatabase();
    const imageBytes = new TextEncoder().encode("img1"), fileBytes = new TextEncoder().encode("data");
    vi.stubGlobal("fetch", vi.fn(commentManagedFetch()));
    const env = envFor(database);
    for (const suffix of ["a", "b"]) {
      await acceptCommentSubmission(env, {
        id: `submission-${suffix}`, body: "Shared bytes",
        context: { kind: "sample", sampleId: "sample-1", expectedUpdatedAt: "2026-07-01T00:00:00.000Z" },
        items: [
          { id: `image-item-${suffix}`, kind: "comment_image", filename: "shared.png", mimeType: "image/png",
            byteSize: imageBytes.byteLength, sha256: await sha256Hex(imageBytes.buffer),
            originalFilename: "shared.png", originalMimeType: "image/png", originalByteSize: imageBytes.byteLength },
          { id: `file-item-${suffix}`, kind: "attachment", filename: "shared.bin", mimeType: "application/octet-stream",
            byteSize: fileBytes.byteLength, sha256: await sha256Hex(fileBytes.buffer) },
        ],
      });
      await uploadAcceptedCommentItem(env, `submission-${suffix}`, `image-item-${suffix}`, "comment_image", imageBytes);
      await uploadAcceptedCommentItem(env, `submission-${suffix}`, `file-item-${suffix}`, "attachment", fileBytes);
    }
    expect(database.prepare("SELECT COUNT(*) AS count FROM assets").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM managed_storage_objects").get()).toEqual({ count: 1 });
    expect((await cancel(env, "submission-a")).status).toBe(200);
    expect(database.prepare("SELECT COUNT(*) AS count FROM blob_gc_ledger").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT status FROM managed_storage_objects").get()).toEqual({ status: "ready" });
    expect((await cancel(env, "submission-b")).status).toBe(200);
    await cleanupCommentUploads(env, new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000));
    expect(database.prepare("SELECT store_kind, state FROM blob_gc_ledger ORDER BY store_kind").all()).toEqual([
      { store_kind: "managed", state: "orphaned" }, { store_kind: "r2", state: "orphaned" },
    ]);
    database.close();
  });

  it("keeps Cancel atomic when Finalize wins the accepted transition", async () => {
    const database = migratedDatabase();
    const bytes = new TextEncoder().encode("data");
    vi.stubGlobal("fetch", vi.fn(commentManagedFetch()));
    const plainEnv = envFor(database);
    await acceptCommentUpload(database, plainEnv, { kind: "attachment", bytes,
      sampleId: "sample-1", submissionId: "finalize-wins", itemId: "finalize-item" });
    await uploadAcceptedCommentItem(plainEnv, "finalize-wins", "finalize-item", "attachment", bytes);
    let raced = false;
    let published: unknown;
    const env = envFor(database, undefined, {
      beforeBatch: async () => {
        if (raced) return;
        raced = true;
        const finalized = await worker.fetch(new Request("https://samples.run/api/comment-submissions/finalize-wins/finalize",
          { method: "POST" }), plainEnv, {} as ExecutionContext);
        expect(finalized.status, await finalized.text()).toBe(200);
        published = database.prepare("SELECT status, last_mutation_id FROM comment_submissions WHERE id = 'finalize-wins'").get();
      },
    });
    expect((await cancel(env, "finalize-wins")).status).toBe(409);
    expect(raced).toBe(true);
    expect(published).toMatchObject({ status: "ready", last_mutation_id: expect.any(String) });
    expect(database.prepare("SELECT status, last_mutation_id FROM comment_submissions WHERE id = 'finalize-wins'").get()).toEqual(published);
    expect(database.prepare("SELECT COUNT(*) AS count FROM blob_gc_ledger").get()).toEqual({ count: 0 });
    database.close();
  });

  it("retains bytes when Cancel wins while an upload completion is being recorded", async () => {
    const database = migratedDatabase();
    const bytes = new TextEncoder().encode("data");
    await acceptCommentUpload(database, envFor(database), { kind: "comment_image", bytes,
      sampleId: "sample-1", submissionId: "upload-race", itemId: "upload-race-item" });
    let cancelled = false;
    const assetDelete = vi.fn(async () => undefined);
    const assetPut = vi.fn(async () => undefined);
    let providerWritten = false;
    const env = envFor(database, assetDelete, {
      assetPut: async (...args: unknown[]) => { providerWritten = true; await assetPut(...args); },
      beforeBatch: async () => {
        if (cancelled || !providerWritten) return;
        cancelled = true;
        expect((await cancel(envFor(database), "upload-race")).status).toBe(200);
      },
    });
    const response = await worker.fetch(new Request(
      "https://samples.run/api/comment-submissions/upload-race/items/upload-race-item/content",
      {
        method: "PUT",
        headers: { "content-type": "image/png", "x-upload-size": "4", "x-content-sha256": await sha256Hex(bytes.buffer) },
        body: "data",
      },
    ), env, {} as ExecutionContext);

    expect(response.status).toBe(409);
    expect(assetPut).toHaveBeenCalledTimes(1);
    expect(assetDelete).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT status, asset_id IS NOT NULL AS linked FROM comment_submission_items WHERE id = 'upload-race-item'",
    ).get()).toEqual({ status: "cancelled", linked: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM blob_retention_edges").get())
      .toEqual({ count: 0 });

    await cleanupCommentUploads(env, new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000));
    expect(database.prepare(
      "SELECT state FROM blob_gc_ledger WHERE blob_record_id = (SELECT candidate_blob_id FROM comment_item_acceptances WHERE item_id = 'upload-race-item')",
    ).get()).toEqual({ state: "orphaned" });
    database.close();
  });

  it("claims both providers, keeps asset readiness metadata, and finalizes by exact attempt", async () => {
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

  it("keeps provider deletion failures in a deleting claim", async () => {
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
      state: "deleting",
      deletion_started_at: "2026-08-20T00:00:00.000Z",
      attempt_count: 1,
      last_error: "deletion_unavailable",
    });
    database.close();
  });

  for (const storeKind of ["r2", "managed"] as const) {
    for (const oldOutcome of ["success", "failure"] as const) {
      it(`fences a delayed ${storeKind} ${oldOutcome} from a newer in-flight deletion attempt`, async () => {
        const database = migratedDatabase();
        const locator = orphanFixture(database, storeKind);
        const started = [deferred(), deferred()];
        const completed = [deferred(), deferred()];
        let attempt = 0;
        const remove = vi.fn(async () => {
          const index = attempt++;
          started[index].resolve();
          await completed[index].promise;
        });
        const stat = vi.fn(async () => ({
          outcome: "available" as const, byteSize: 4,
          contentType: "application/octet-stream", etag: null,
        }));
        const dependencies = gcDependencies(database, { remove, stat });
        const first = collectBlobGarbage(dependencies, new Date("2026-08-20T00:00:00.000Z"));
        await started[0].promise;
        const second = collectBlobGarbage(dependencies, new Date("2026-08-20T00:16:00.000Z"));
        await started[1].promise;
        const renewed = database.prepare("SELECT * FROM blob_gc_ledger").get();
        expect(renewed).toMatchObject({
          state: "deleting", attempt_count: 2, last_error: null,
          deletion_started_at: "2026-08-20T00:16:00.000Z",
        });
        expect(stat).toHaveBeenCalledExactlyOnceWith(locator);

        if (oldOutcome === "success") completed[0].resolve();
        else completed[0].reject(new Error("private provider URL and credential"));
        expect(await first).toMatchObject({ imageDeleted: 0, managedDeleted: 0, failures: 1 });
        // The old acknowledgement/failure arrives while attempt 2 is still
        // deleting. Checking only operation_id would finalize or reset it here.
        expect(database.prepare("SELECT * FROM blob_gc_ledger").get()).toEqual(renewed);
        if (storeKind === "managed") {
          expect(database.prepare("SELECT status FROM managed_storage_objects").get())
            .toEqual({ status: "orphaned" });
        }
        completed[1].resolve();
        expect(await second).toMatchObject({
          imageDeleted: storeKind === "r2" ? 1 : 0,
          managedDeleted: storeKind === "managed" ? 1 : 0,
          failures: 0,
        });
        expect(database.prepare("SELECT state, attempt_count FROM blob_gc_ledger").get())
          .toEqual({ state: "deleted", attempt_count: 2 });
        if (storeKind === "managed") {
          expect(database.prepare("SELECT status FROM managed_storage_objects").get())
            .toEqual({ status: "deleted" });
        }
        database.close();
      });
    }

    it(`holds an unknown ${storeKind} deletion until absence is observed, without eager retry`, async () => {
      const database = migratedDatabase();
      const locator = orphanFixture(database, storeKind);
      const remove = vi.fn(async () => { throw new Error("https://private-provider/?password=secret"); });
      const stat = vi.fn(async () => ({ outcome: "missing" as const }));
      const dependencies = gcDependencies(database, { remove, stat });
      const first = await collectBlobGarbage(dependencies, new Date("2026-08-20T00:00:00.000Z"));
      expect(first.failures).toBe(1);
      expect(remove).toHaveBeenCalledExactlyOnceWith(locator);
      expect(stat).not.toHaveBeenCalled();
      expect(database.prepare("SELECT state, last_error FROM blob_gc_ledger").get())
        .toEqual({ state: "deleting", last_error: "deletion_unavailable" });
      expect(await refreshOrphanGrace(
        envFor(database).DB, locator, "try-reuse", new Date("2026-08-20T00:01:00.000Z"),
      )).toBe(false);
      database.exec(`
        INSERT INTO comment_submissions
          (id, context_kind, sample_id, body, status, created_at, updated_at, retry_until)
        VALUES ('claim-retention', 'sample', 'sample-1', '', 'uploading',
          '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z',
          '2026-08-27T00:00:00.000Z')
      `);
      const retain = () => database.exec(`
        INSERT INTO comment_submission_items
          (id, submission_id, kind, status, position,
           ${storeKind === "r2" ? "asset_id" : "storage_object_id"}, created_at, updated_at)
        VALUES ('claim-retention-item', 'claim-retention',
          '${storeKind === "r2" ? "comment_image" : "attachment"}', 'ready', 0,
          'fenced-blob', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')
      `);
      expect(retain).toThrow(/blob locator is unavailable/);
      await collectBlobGarbage(dependencies, new Date("2026-08-20T00:14:00.000Z"));
      expect(remove).toHaveBeenCalledTimes(1);
      expect(stat).not.toHaveBeenCalled();

      const retry = await collectBlobGarbage(dependencies, new Date("2026-08-20T00:16:00.000Z"));
      expect(retry).toMatchObject({
        imageDeleted: storeKind === "r2" ? 1 : 0,
        managedDeleted: storeKind === "managed" ? 1 : 0,
        failures: 0,
      });
      expect(stat).toHaveBeenCalledExactlyOnceWith(locator);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(database.prepare("SELECT state, attempt_count, last_error FROM blob_gc_ledger").get())
        .toEqual({ state: "deleted", attempt_count: 2, last_error: null });
      // Deletion is still a tombstone: absence does not authorize reuse of a key
      // that an older outcome-unknown request could still target.
      expect(retain).toThrow(/blob locator is unavailable/);
      database.close();
    });
  }

  it.each(["denied", "unavailable", "invalid_locator"] as const)(
    "stores only a fixed error code for %s deletion failures",
    async (reason) => {
      const database = migratedDatabase();
      orphanFixture(database, "r2");
      const stat = vi.fn(async () => ({ outcome: "missing" as const }));
      await collectBlobGarbage(gcDependencies(database, {
        remove: async () => { throw new ByteDeletionError(reason); }, stat,
      }), new Date("2026-08-20T00:00:00.000Z"));
      expect(stat).not.toHaveBeenCalled();
      expect(database.prepare("SELECT state, last_error FROM blob_gc_ledger").get())
        .toEqual({ state: "deleting", last_error: `deletion_${reason}` });
      database.close();
    },
  );

  it("keeps a stale claim deleting when its exact provider cannot confirm existence", async () => {
    const database = migratedDatabase();
    const locator = orphanFixture(database, "managed");
    const remove = vi.fn(async () => { throw new Error("provider failed"); });
    const stat = vi.fn(async () => ({
      outcome: "provider_unavailable" as const,
      message: "private URL and credential from an untrusted adapter",
    }));
    const dependencies = gcDependencies(database, { remove, stat });
    await collectBlobGarbage(dependencies, new Date("2026-08-20T00:00:00.000Z"));
    const result = await collectBlobGarbage(dependencies, new Date("2026-08-20T00:16:00.000Z"));
    expect(result).toMatchObject({ imageDeleted: 0, managedDeleted: 0, failures: 1 });
    expect(stat).toHaveBeenCalledExactlyOnceWith(locator);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(database.prepare("SELECT state, attempt_count, last_error FROM blob_gc_ledger").get())
      .toEqual({ state: "deleting", attempt_count: 2, last_error: "deletion_confirmation_unavailable" });
    expect(database.prepare("SELECT status FROM managed_storage_objects").get())
      .toEqual({ status: "orphaned" });
    database.close();
  });

  it("uses the returned attempt count to fence claims with identical timestamps", async () => {
    const database = migratedDatabase();
    const locator = orphanFixture(database, "r2");
    const started = deferred();
    const completed = deferred();
    const now = new Date("2026-08-20T00:00:00.000Z");
    const dependencies = gcDependencies(database, {
      remove: async () => { started.resolve(); await completed.promise; },
      stat: async () => ({ outcome: "missing" }),
    });
    const first = collectBlobGarbage(dependencies, now);
    await started.promise;
    const oldClaim = database.prepare("SELECT operation_id FROM blob_gc_ledger").get() as {
      operation_id: string;
    };
    // Exercise the SQL capability directly so both claims have one timestamp.
    // Production scheduling still uses the unchanged 15-minute lease duration.
    expect(await reclaimBlobDeletion(
      dependencies.db, locator, oldClaim.operation_id, now, now.toISOString(),
    )).toEqual({
      operationId: oldClaim.operation_id, attemptCount: 2, deletionStartedAt: now.toISOString(),
    });
    const renewed = database.prepare("SELECT * FROM blob_gc_ledger").get();
    completed.resolve();
    expect(await first).toMatchObject({ imageDeleted: 0, failures: 1 });
    expect(database.prepare("SELECT * FROM blob_gc_ledger").get()).toEqual(renewed);
    database.close();
  });

  for (const storeKind of ["r2", "managed"] as const) {
    it(`preserves a committed ${storeKind} tombstone when the database acknowledgement is lost`, async () => {
      const database = migratedDatabase();
      const locator = orphanFixture(database, storeKind);
      let lostAcknowledgement = false;
      const isFinalization = (query: string) => /SET state = 'deleted'/.test(query);
      class LostAcknowledgementStatement extends SqliteD1Statement {
        override bind(...bindings: unknown[]) {
          return new LostAcknowledgementStatement(database, this.query, bindings);
        }
        override async run() {
          const result = await super.run();
          if (isFinalization(this.query) && !lostAcknowledgement) {
            lostAcknowledgement = true;
            throw new Error("private database endpoint: acknowledgement lost");
          }
          return result;
        }
      }
      class LostAcknowledgementDatabase extends SqliteD1Database {
        override prepare(query: string) {
          return new LostAcknowledgementStatement(database, query);
        }
        override async batch(statements: SqliteD1Statement[]) {
          const result = await super.batch(statements);
          if (statements.some((statement) => isFinalization(statement.query)) && !lostAcknowledgement) {
            lostAcknowledgement = true;
            throw new Error("private database endpoint: acknowledgement lost");
          }
          return result;
        }
      }
      const remove = vi.fn(async () => undefined);
      const stat = vi.fn(async () => ({ outcome: "available" as const, byteSize: 4,
        contentType: "application/octet-stream", etag: null }));
      const dependencies = gcDependencies(database, { remove, stat });
      dependencies.db = new LostAcknowledgementDatabase(database);
      const result = await collectBlobGarbage(dependencies, new Date("2026-08-20T00:00:00.000Z"));
      expect(result).toMatchObject({ imageDeleted: 0, managedDeleted: 0, failures: 1 });
      expect(lostAcknowledgement).toBe(true);
      expect(database.prepare("SELECT state, last_error FROM blob_gc_ledger").get())
        .toEqual({ state: "deleted", last_error: null });
      if (storeKind === "managed") {
        expect(database.prepare("SELECT status FROM managed_storage_objects").get())
          .toEqual({ status: "deleted" });
      }
      expect(remove).toHaveBeenCalledExactlyOnceWith(locator);
      expect(await collectBlobGarbage(dependencies, new Date("2026-08-21T00:00:00.000Z")))
        .toMatchObject({ imageDeleted: 0, managedDeleted: 0, failures: 0 });
      expect(remove).toHaveBeenCalledTimes(1);
      expect(stat).not.toHaveBeenCalled();
      database.close();
    });
  }

  it("rolls back both managed finalization updates when the object status update fails", async () => {
    const database = migratedDatabase();
    orphanFixture(database, "managed");
    database.exec(`
      CREATE TRIGGER reject_managed_finalization
      BEFORE UPDATE OF status ON managed_storage_objects
      WHEN NEW.status = 'deleted'
      BEGIN SELECT RAISE(ABORT, 'private database failure'); END
    `);
    const dependencies = gcDependencies(database, {
      remove: async () => undefined,
      stat: async () => ({ outcome: "missing" }),
    });
    const result = await collectBlobGarbage(dependencies, new Date("2026-08-20T00:00:00.000Z"));
    expect(result).toMatchObject({ imageDeleted: 0, managedDeleted: 0, failures: 1 });
    expect(database.prepare("SELECT state, deleted_at, last_error FROM blob_gc_ledger").get())
      .toEqual({ state: "deleting", deleted_at: null, last_error: "deletion_unavailable" });
    expect(database.prepare("SELECT status FROM managed_storage_objects").get())
      .toEqual({ status: "orphaned" });
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
  it("collects an expired explicit Run attachment while preserving recent and shared bytes", async () => {
    const database = migratedDatabase();
    database.exec(`
      INSERT INTO recipe_families (id, name, template_type, created_at)
      VALUES ('run-family', 'Process', 'process', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days'));
      INSERT INTO template_versions
        (id, recipe_family_id, name, template_type, version, manifest_hash,
         content_json, created_at)
      VALUES ('run-template', 'run-family', 'Process', 'process', 1,
        'run-manifest', '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days'));
      INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, sequence_no,
         run_group_id, template_name_snapshot, template_type_snapshot,
         template_version_snapshot, status, created_at)
      VALUES ('run-attachments', 'sample-1', 'run-family', 'run-template', 1,
        'run-attachments-group', 'Process', 'process', 1, 'complete',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days'));
      INSERT INTO run_steps
        (id, run_id, position, title, status, created_at, updated_at)
      VALUES ('run-attachment-step', 'run-attachments', 1000, 'Measure', 'done',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days'));
      INSERT INTO state_representations (hash, content_json, created_at)
      VALUES ('run-shared-state', '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days'));
      INSERT INTO assets
        (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES
        ('run-expired-asset', 'blobs/run-expired.bin', 'expired.bin',
         'application/octet-stream', 4, 'ready', '${"1".repeat(64)}',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days')),
        ('run-recent-asset', 'blobs/run-recent.bin', 'recent.bin',
         'application/octet-stream', 4, 'ready', '${"2".repeat(64)}',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days')),
        ('run-shared-asset', 'blobs/run-shared.bin', 'shared.bin',
         'application/octet-stream', 4, 'ready', '${"3".repeat(64)}',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days'));
      INSERT INTO run_step_assets
        (id, run_step_id, asset_id, role, created_at, deleted_at)
      VALUES
        ('run-expired-occurrence', 'run-attachment-step', 'run-expired-asset', 'execution',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours')),
        ('run-recent-occurrence', 'run-attachment-step', 'run-recent-asset', 'execution',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-23 hours')),
        ('run-shared-occurrence', 'run-attachment-step', 'run-shared-asset', 'state_observation',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours'));
      INSERT INTO state_representation_assets (state_hash, asset_id, position)
      VALUES ('run-shared-state', 'run-shared-asset', 0);
    `);
    const assetDelete = vi.fn(async () => undefined);
    const env = envFor(database, assetDelete);
    const now = new Date();

    const first = await cleanupCommentUploads(env, now);
    expect(first.orphanCandidatesMarked).toBe(1);
    expect(database.prepare(`
      SELECT object_key, state FROM blob_gc_ledger ORDER BY object_key
    `).all()).toEqual([{ object_key: "blobs/run-expired.bin", state: "orphaned" }]);
    expect(assetDelete).not.toHaveBeenCalled();

    const second = await cleanupCommentUploads(
      env,
      new Date(now.getTime() + 8 * 24 * 60 * 60 * 1_000),
    );
    expect(second.imageDeleted).toBe(1);
    expect(assetDelete).toHaveBeenCalledTimes(1);
    expect(assetDelete).toHaveBeenCalledWith("blobs/run-expired.bin");
    expect(database.prepare(`
      SELECT state FROM blob_gc_ledger WHERE object_key = 'blobs/run-expired.bin'
    `).get()).toEqual({ state: "deleted" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM blob_gc_ledger
      WHERE object_key IN ('blobs/run-recent.bin', 'blobs/run-shared.bin')
    `).get()).toEqual({ count: 0 });
    database.close();
  });
});
