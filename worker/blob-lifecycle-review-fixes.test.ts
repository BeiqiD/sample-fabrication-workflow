import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { cleanupCommentUploads } from "./comment-upload-cleanup";
import { listPermanentDeleteBlockers } from "./blob-lifecycle/permanent-delete";
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
    private readonly beforeExecute?: (query: string, bindings: unknown[]) => void,
  ) {}

  prepare(query: string) {
    return new SqliteD1Statement(this.database, query, [], this.beforeExecute);
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

function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(filename, directory), "utf8"));
  }
  return database;
}

function addSample(database: DatabaseSync) {
  database.exec(`
    INSERT INTO samples (id, code, title, created_at, updated_at)
    VALUES ('sample-1', 'S-1', 'Sample', '2026-07-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z');
  `);
}

function addAsset(database: DatabaseSync, id: string, key: string, hashCharacter: string) {
  database.prepare(
    `INSERT INTO assets
      (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
     VALUES (?, ?, ?, 'application/octet-stream', 4, 'ready', ?,
       '2026-07-01T00:00:00.000Z')`,
  ).run(id, key, `${id}.bin`, hashCharacter.repeat(64));
}

function envFor(
  database: DatabaseSync,
  options: {
    beforeExecute?: (query: string, bindings: unknown[]) => void;
    assetPut?: ReturnType<typeof vi.fn>;
    assetDelete?: ReturnType<typeof vi.fn>;
    assetHead?: ReturnType<typeof vi.fn>;
  } = {},
): Env {
  return {
    AUTH_MODE: "disabled",
    DB: new SqliteD1Database(database, options.beforeExecute),
    ASSETS: {
      put: options.assetPut ?? vi.fn(async () => undefined),
      delete: options.assetDelete ?? vi.fn(async () => undefined),
      head: options.assetHead ?? vi.fn(async () => null),
      get: vi.fn(async () => null),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
    },
  } as unknown as Env;
}

afterEach(() => vi.unstubAllGlobals());

describe("blob lifecycle review fixes", () => {
  it("retains sample-record thumbnails and rejects a claimed thumbnail locator", async () => {
    const database = migratedDatabase();
    addSample(database);
    addAsset(database, "asset-primary", "records/primary.bin", "1");
    addAsset(database, "asset-thumbnail", "records/thumbnail.bin", "2");
    addAsset(database, "asset-claimed", "records/claimed.bin", "3");
    database.exec(`
      INSERT INTO blob_gc_ledger
        (store_kind, provider, object_key, blob_record_id, state, operation_id,
         orphaned_at, updated_at)
      VALUES
        ('r2', 'r2', 'records/thumbnail.bin', 'asset-thumbnail', 'orphaned',
          'orphan-thumbnail', '2026-07-10T00:00:00.000Z',
          '2026-07-10T00:00:00.000Z'),
        ('r2', 'r2', 'records/claimed.bin', 'asset-claimed', 'deleting',
          'delete-thumbnail', '2026-07-10T00:00:00.000Z',
          '2026-07-10T00:00:00.000Z');
    `);

    database.prepare(
      `INSERT INTO events
        (id, sample_id, kind, asset_key, metadata_json, created_at)
       VALUES ('event-record', 'sample-1', 'image', 'records/primary.bin', ?,
         '2026-07-10T00:00:00.000Z')`,
    ).run(JSON.stringify({ action: "sample_record", thumbnailKey: "records/thumbnail.bin" }));

    expect(database.prepare(
      "SELECT state FROM blob_gc_ledger WHERE object_key = 'records/thumbnail.bin'",
    ).get()).toBeUndefined();
    expect(database.prepare(
      `SELECT occurrence_type, retention_reason
       FROM blob_retention_edges
       WHERE object_key = 'records/thumbnail.bin'`,
    ).get()).toEqual({
      occurrence_type: "event_thumbnail",
      retention_reason: "sample_record_thumbnail",
    });

    await cleanupCommentUploads(envFor(database), new Date("2026-08-20T00:00:00.000Z"));
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM blob_gc_ledger
       WHERE object_key IN ('records/primary.bin', 'records/thumbnail.bin')`,
    ).get()).toEqual({ count: 0 });

    expect(() => database.prepare(
      `INSERT INTO events
        (id, sample_id, kind, metadata_json, created_at)
       VALUES ('event-claimed', 'sample-1', 'image', ?,
         '2026-07-10T00:00:00.000Z')`,
    ).run(JSON.stringify({ thumbnailKey: "records/claimed.bin" })))
      .toThrow(/blob locator is unavailable/);
    database.close();
  });

  it("turns expired retry windows into a terminal cancelled state and releases their blobs", async () => {
    const database = migratedDatabase();
    addSample(database);
    addAsset(database, "asset-expired", "comments/expired.bin", "4");
    database.exec(`
      INSERT INTO comment_submissions
        (id, context_kind, sample_id, body, status, created_at, updated_at,
         retry_until)
      VALUES ('submission-expired', 'sample', 'sample-1', 'Expired', 'failed',
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z');
      INSERT INTO comment_submission_items
        (id, submission_id, kind, status, position, asset_id, created_at, updated_at)
      VALUES ('item-expired', 'submission-expired', 'comment_image', 'ready', 0,
        'asset-expired', '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z');
    `);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM blob_retention_edges WHERE object_key = 'comments/expired.bin'",
    ).get()).toEqual({ count: 1 });

    const result = await cleanupCommentUploads(
      envFor(database),
      new Date("2026-08-10T00:00:00.000Z"),
    );
    expect(result.retryWindowsClosed).toBe(1);
    expect(database.prepare(
      `SELECT status, retry_closed_at IS NOT NULL AS closed, retry_closed_by
       FROM comment_submissions WHERE id = 'submission-expired'`,
    ).get()).toEqual({
      status: "cancelled",
      closed: 1,
      retry_closed_by: "system:cleanup",
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM blob_retention_edges WHERE object_key = 'comments/expired.bin'",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT state FROM blob_gc_ledger WHERE object_key = 'comments/expired.bin'",
    ).get()).toEqual({ state: "orphaned" });
    database.close();
  });

  it("recovers a concurrent metrology asset registration through the custom UNIQUE trigger", async () => {
    const database = migratedDatabase();
    database.exec(`
      INSERT INTO recipe_families (id, name, template_type, created_at)
      VALUES ('family-metrology', 'Metrology', 'module', '2026-07-01T00:00:00.000Z');
      INSERT INTO template_versions
        (id, recipe_family_id, name, template_type, template_kind, version,
         manifest_hash, content_json, created_at)
      VALUES ('template-metrology', 'family-metrology', 'SEM', 'module',
        'metrology', 1, 'manifest-metrology', '{}',
        '2026-07-01T00:00:00.000Z');
    `);
    let insertedWinner = false;
    const assetPut = vi.fn(async () => undefined);
    const assetDelete = vi.fn(async () => undefined);
    const env = envFor(database, {
      assetPut,
      assetDelete,
      assetHead: vi.fn(async (key: string) => key === "metrology/winner.bin" ? {
        size: 4,
        httpEtag: '"winner-etag"',
        writeHttpMetadata(headers: Headers) {
          headers.set("content-type", "application/octet-stream");
        },
      } : null),
      beforeExecute: (query, bindings) => {
        if (insertedWinner || !/^\s*INSERT INTO assets\b/i.test(query)) return;
        insertedWinner = true;
        database.prepare(
          `INSERT INTO assets
            (id, r2_key, original_name, mime_type, byte_size, status, sha256,
             created_at)
           VALUES ('asset-winner', 'metrology/winner.bin', 'winner.bin',
             'application/octet-stream', 4, 'ready', ?,
             '2026-08-08T00:00:00.000Z')`,
        ).run(String(bindings[7]));
      },
    });

    const response = await worker.fetch(new Request(
      "https://samples.run/api/metrology-templates/template-metrology/references",
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "4",
          "x-filename": "manual.bin",
        },
        body: "data",
      },
    ), env, {} as ExecutionContext);

    expect(response.status).toBe(201);
    expect(assetPut).toHaveBeenCalledTimes(1);
    expect(assetDelete).not.toHaveBeenCalled();
    expect(database.prepare(
      `SELECT asset_id FROM metrology_template_references
       WHERE template_version_id = 'template-metrology'`,
    ).get()).toEqual({ asset_id: "asset-winner" });
    expect(database.prepare(`
      SELECT status, COUNT(*) AS count,
             SUM(CASE WHEN sha256 IS NULL THEN 1 ELSE 0 END) AS null_sha_count
      FROM assets
      GROUP BY status
      ORDER BY status
    `).all()).toEqual([
      { status: "failed", count: 1, null_sha_count: 1 },
      { status: "ready", count: 1, null_sha_count: 0 },
    ]);
    database.close();
  });

  it("implements every declared blocker target and includes recipe-change evidence", async () => {
    const database = migratedDatabase();
    addSample(database);
    database.exec(`
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
         template_version_snapshot, status, created_at)
      VALUES ('run-1', 'sample-1', 'family-1', 'template-1', 1, 'group-1',
        'Process', 'process', 1, 'complete', '2026-07-01T00:00:00.000Z');
      INSERT INTO run_steps
        (id, run_id, position, title, status, created_at, updated_at)
      VALUES ('step-1', 'run-1', 1000, 'Step', 'done',
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    `);
    addAsset(database, "asset-run", "run/asset.bin", "5");
    addAsset(database, "asset-reference", "reference/asset.bin", "6");
    database.exec(`
      INSERT INTO run_step_assets
        (id, run_step_id, asset_id, role, created_at)
      VALUES ('run-asset-1', 'step-1', 'asset-run', 'execution',
        '2026-07-01T00:00:00.000Z');
      INSERT INTO events
        (id, sample_id, kind, metadata_json, created_at)
      VALUES ('event-run-asset', 'sample-1', 'image',
        '{"runStepAssetId":"run-asset-1"}', '2026-07-01T00:00:00.000Z');
      INSERT INTO metrology_template_references
        (id, template_version_id, asset_id, display_name, created_at)
      VALUES ('reference-1', 'template-1', 'asset-reference', 'Reference',
        '2026-07-01T00:00:00.000Z');
      INSERT INTO recipe_change_proposals
        (id, recipe_family_id, source_template_version_id, change_type, body,
         status, created_at)
      VALUES ('proposal-1', 'family-1', 'template-1', 'process', 'Evidence',
        'open', '2026-07-01T00:00:00.000Z');
    `);
    const db = new SqliteD1Database(database) as unknown as D1Database;

    expect(await listPermanentDeleteBlockers(db, {
      sourceType: "run_step_asset",
      sourceId: "run-asset-1",
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: "owning_step", blockerId: "step-1" }),
      expect.objectContaining({ relation: "timeline_events", blockerId: "event-run-asset" }),
    ]));
    expect(await listPermanentDeleteBlockers(db, {
      sourceType: "metrology_template_reference",
      sourceId: "reference-1",
    })).toEqual([
      expect.objectContaining({ relation: "owning_template", blockerId: "template-1" }),
    ]);
    expect(await listPermanentDeleteBlockers(db, {
      sourceType: "template_version",
      sourceId: "template-1",
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relation: "recipe_change_proposals",
        blockerId: "proposal-1",
      }),
    ]));
    await expect(listPermanentDeleteBlockers(db, {
      sourceType: "unknown" as never,
      sourceId: "unknown-1",
    })).rejects.toThrow(/not implemented/);
    database.close();
  });
});
