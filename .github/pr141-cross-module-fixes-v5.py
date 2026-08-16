from pathlib import Path

# Reuse the fully verified Reference, media, Comment, documentation, and tests
# patch, then move Timeline synchronization to the database boundary and keep
# the recovery batch/index endpoint unchanged.
runner = Path(".github/pr141-cross-module-fixes-v4.py")
exec(compile(runner.read_text(), str(runner), "exec"), {"__name__": "__main__"})

# Timeline projection is now enforced by a database trigger rather than an
# application batch statement. Keep the original recovery/result protocol and
# deletion endpoint; the trigger supplies the current actionable occurrence ID.
for source_path in [
    "worker/fabublox-import-recovery.ts",
    "worker/index.ts",
    "worker/fabublox-import-recovery.test.ts",
    "worker/blob-registration-reconciliation.test.ts",
]:
    Path(source_path).write_bytes(
        Path("/tmp/pr141-original")
        .joinpath(source_path)
        .read_bytes()
    )

migration = Path("migrations/0029_supersession_timeline_projection.sql")
migration.write_text('''PRAGMA foreign_keys = ON;

-- Timeline rows are a mutable projection of the currently actionable
-- execution-image occurrence. Stable legacy occurrence IDs remain in the
-- occurrence table and Reference registry, while Timeline actions follow the
-- one-hop immutable supersession survivor in the same D1 transaction.
CREATE TRIGGER run_step_assets_sync_supersession_timeline
AFTER UPDATE OF superseded_by_occurrence_id ON run_step_assets
WHEN OLD.superseded_by_occurrence_id IS NULL
  AND NEW.superseded_by_occurrence_id IS NOT NULL
BEGIN
  UPDATE events
  SET asset_key = CASE
        WHEN asset_key = (
          SELECT legacy_asset.r2_key
          FROM assets legacy_asset
          WHERE legacy_asset.id = OLD.asset_id
        )
        THEN (
          SELECT survivor_asset.r2_key
          FROM run_step_assets survivor
          JOIN assets survivor_asset ON survivor_asset.id = survivor.asset_id
          WHERE survivor.id = NEW.superseded_by_occurrence_id
        )
        ELSE asset_key
      END,
      metadata_json = json_set(
        metadata_json,
        '$.supersededRunStepAssetId',
        COALESCE(
          json_extract(metadata_json, '$.supersededRunStepAssetId'),
          NEW.id
        ),
        '$.runStepAssetId',
        NEW.superseded_by_occurrence_id
      )
  WHERE json_valid(metadata_json)
    AND json_type(metadata_json, '$.runStepAssetId') = 'text'
    AND CAST(json_extract(metadata_json, '$.runStepAssetId') AS TEXT) = NEW.id;

  UPDATE events
  SET metadata_json = json_set(
        metadata_json,
        '$.thumbnailKey',
        (
          SELECT survivor_asset.r2_key
          FROM run_step_assets survivor
          JOIN assets survivor_asset ON survivor_asset.id = survivor.asset_id
          WHERE survivor.id = NEW.superseded_by_occurrence_id
        )
      )
  WHERE json_valid(metadata_json)
    AND json_type(metadata_json, '$.thumbnailKey') = 'text'
    AND CAST(json_extract(metadata_json, '$.thumbnailKey') AS TEXT) = (
      SELECT legacy_asset.r2_key
      FROM assets legacy_asset
      WHERE legacy_asset.id = OLD.asset_id
    );
END;
''')

# Independent cross-module tests avoid coupling these invariants to the large
# legacy recovery fixture or its positional batch accounting.
test = Path("worker/supersession-cross-module.test.ts")
test.write_text(r'''import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeReferenceRouteId } from "../shared/reference-destinations";
import { sha256Hex } from "../shared/content-addressing";
import worker from "./index";
import { SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

function database() {
  const result = new DatabaseSync(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    result.exec(readFileSync(new URL(filename, directory), "utf8"));
  }
  return result;
}

function bytesBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function r2Object(bytes: Uint8Array) {
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    size: bytes.byteLength,
    httpEtag: '"supersession"',
    writeHttpMetadata(headers: Headers) {
      headers.set("content-type", "image/png");
    },
  };
}

class FaultStatement {
  constructor(
    private readonly owner: FaultDatabase,
    readonly query: string,
    readonly bindings: unknown[] = [],
  ) {}

  bind(...bindings: unknown[]) {
    return new FaultStatement(this.owner, this.query, bindings);
  }

  private statement(): StatementSync {
    return this.owner.database.prepare(this.query);
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
    this.owner.beforeMutation(this.query);
    const result = this.statement().run(...this.bindings);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }

  execute() {
    if (/^\s*SELECT\b/i.test(this.query)) {
      return {
        success: true,
        results: this.statement().all(...this.bindings),
        meta: { changes: 0 },
      };
    }
    this.owner.beforeMutation(this.query);
    const result = this.statement().run(...this.bindings);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }
}

class FaultDatabase {
  constructor(readonly database: DatabaseSync) {}

  prepare(query: string) {
    return new FaultStatement(this, query);
  }

  withSession() {
    return this;
  }

  beforeMutation(query: string) {
    const normalized = query.replace(/\s+/g, " ");
    if (/INSERT\s+INTO\s+assets\s*\(/i.test(normalized)) {
      throw new Error("injected persistent metadata staging outage");
    }
    if (normalized.includes(
      "UPDATE comment_submission_items SET status = 'failed'",
    )) {
      throw new Error("injected persistent failure-accounting outage");
    }
  }

  async batch(statements: FaultStatement[]) {
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("supersession cross-module contract", () => {
  it("keeps Timeline actions and stable Reference IDs on the live survivor", async () => {
    const db = database();
    const bytes = Uint8Array.from([137, 80, 78, 71, 121, 122, 123]);
    const sha256 = await sha256Hex(bytesBuffer(bytes));
    db.exec(`
      INSERT INTO recipe_families (id, name, template_type, created_at)
      VALUES
        ('family-process', 'Process', 'process', '2026-08-16T00:00:00.000Z'),
        ('family-metrology', 'Metrology', 'module', '2026-08-16T00:00:00.000Z');

      INSERT INTO template_versions (
        id, recipe_family_id, name, template_type, version, manifest_hash,
        content_json, created_at, template_kind
      ) VALUES
        ('template-process', 'family-process', 'Process', 'process', 1,
         'manifest-process', '{}', '2026-08-16T00:00:00.000Z', 'process'),
        ('template-metrology', 'family-metrology', 'Metrology', 'module', 1,
         'manifest-metrology', '{}', '2026-08-16T00:00:00.000Z', 'metrology');

      INSERT INTO imports (
        id, status, source_filename, source_sha256, sheet_name, template_type,
        actor_email, created_at, completed_at, operation_id,
        recovery_operation_id
      ) VALUES (
        'failed-import', 'failed', 'failed.xlsx', '${"1".repeat(64)}',
        'Sheet1', 'process', 'owner@example.com',
        '2026-08-16T00:00:00.000Z', '2026-08-16T00:01:00.000Z',
        'import-operation', 'recovery-operation'
      );

      INSERT INTO assets (
        id, import_id, r2_key, original_name, mime_type, byte_size, status,
        sha256, created_at
      ) VALUES
        ('legacy-asset', 'failed-import', 'legacy/image.png', 'legacy.png',
         'image/png', ${bytes.byteLength}, 'failed', '${sha256}',
         '2026-08-16T00:00:00.000Z'),
        ('canonical-asset', NULL, 'ready/image.png', 'canonical.png',
         'image/png', ${bytes.byteLength}, 'ready', '${sha256}',
         '2026-08-15T00:00:00.000Z');

      INSERT INTO samples (id, code, title, created_at, updated_at)
      VALUES (
        'sample', 'S-1', 'Sample',
        '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z'
      );

      INSERT INTO runs (
        id, sample_id, recipe_family_id, template_version_id, sequence_no,
        run_group_id, template_name_snapshot, template_type_snapshot,
        template_version_snapshot, status, created_at
      ) VALUES (
        'run', 'sample', 'family-process', 'template-process', 1, 'group',
        'Process', 'process', 1, 'complete', '2026-08-16T00:00:00.000Z'
      );

      INSERT INTO run_steps (
        id, run_id, position, title, status, created_at, updated_at
      ) VALUES (
        'step', 'run', 0, 'Step', 'done',
        '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z'
      );

      INSERT INTO run_step_assets (
        id, run_step_id, asset_id, role, position, actor_email, created_at
      ) VALUES (
        'execution-legacy', 'step', 'legacy-asset', 'execution', 0,
        'legacy@example.com', '2026-08-16T00:00:00.000Z'
      );

      INSERT INTO run_step_assets (
        id, run_step_id, asset_id, role, position, actor_email, created_at,
        deleted_at, deleted_by
      ) VALUES (
        'execution-canonical', 'step', 'canonical-asset', 'execution', 1,
        'canonical@example.com', '2026-08-16T00:00:01.000Z',
        '2026-08-16T00:02:00.000Z', 'cleanup@example.com'
      );

      INSERT INTO metrology_template_references (
        id, template_version_id, asset_id, display_name, position,
        actor_email, created_at
      ) VALUES (
        'metrology-legacy', 'template-metrology', 'legacy-asset',
        'Legacy reference', 0, 'legacy@example.com',
        '2026-08-16T00:00:00.000Z'
      );

      INSERT INTO metrology_template_references (
        id, template_version_id, asset_id, display_name, position,
        actor_email, created_at, deleted_at, deleted_by
      ) VALUES (
        'metrology-canonical', 'template-metrology', 'canonical-asset',
        'Canonical reference', 1, 'canonical@example.com',
        '2026-08-16T00:00:01.000Z',
        '2026-08-16T00:02:00.000Z', 'cleanup@example.com'
      );

      INSERT INTO events (
        id, sample_id, kind, asset_key, metadata_json, created_at
      ) VALUES (
        'timeline-image', 'sample', 'image', 'legacy/image.png',
        '{"runId":"run","stepId":"step","runStepAssetId":"execution-legacy","thumbnailKey":"legacy/image.png"}',
        '2026-08-16T00:03:00.000Z'
      );
    `);

    db.exec(`
      UPDATE run_step_assets
      SET deleted_at = '2026-08-16T00:04:00.000Z',
          deleted_by = 'system:fabublox-import-recovery',
          last_mutation_id = 'recovery-operation',
          superseded_by_occurrence_id = 'execution-canonical',
          superseded_at = '2026-08-16T00:04:00.000Z',
          superseded_by = 'system:fabublox-import-recovery',
          supersession_operation_id = 'recovery-operation'
      WHERE id = 'execution-legacy';

      UPDATE metrology_template_references
      SET deleted_at = '2026-08-16T00:04:00.000Z',
          deleted_by = 'system:fabublox-import-recovery',
          superseded_by_occurrence_id = 'metrology-canonical',
          superseded_at = '2026-08-16T00:04:00.000Z',
          superseded_by = 'system:fabublox-import-recovery',
          supersession_operation_id = 'recovery-operation'
      WHERE id = 'metrology-legacy';
    `);

    expect(db.prepare(`
      SELECT asset_key,
             json_extract(metadata_json, '$.runStepAssetId') AS current_id,
             json_extract(metadata_json, '$.supersededRunStepAssetId') AS legacy_id,
             json_extract(metadata_json, '$.thumbnailKey') AS thumbnail_key
      FROM events WHERE id = 'timeline-image'
    `).get()).toEqual({
      asset_key: "ready/image.png",
      current_id: "execution-canonical",
      legacy_id: "execution-legacy",
      thumbnail_key: "ready/image.png",
    });

    const stored = new Map([["ready/image.png", bytes]]);
    const env = {
      AUTH_MODE: "disabled",
      DB: new SqliteD1Database(db) as unknown as D1Database,
      ASSETS: {
        get: vi.fn(async (key: string) => {
          const value = stored.get(key);
          return value ? r2Object(value) : null;
        }),
        head: vi.fn(async (key: string) => {
          const value = stored.get(key);
          return value ? r2Object(value) : null;
        }),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(async () => ({ objects: [], truncated: false })),
      } as unknown as R2Bucket,
    } satisfies Env;

    const references = await worker.fetch(new Request(
      "https://app.test/api/references/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targets: [
            { type: "execution_image", id: "execution-legacy" },
            { type: "metrology_reference", id: "metrology-legacy" },
          ],
        }),
      },
    ), env, executionContext);
    expect(references.status).toBe(200);
    expect(await references.json()).toMatchObject({
      results: [
        {
          target: { type: "execution_image", id: "execution-legacy" },
          resolution: "resolved",
          source: { title: "legacy.png", state: "superseded" },
        },
        {
          target: { type: "metrology_reference", id: "metrology-legacy" },
          resolution: "resolved",
          source: { title: "Legacy reference", state: "superseded" },
        },
      ],
    });

    const media = await worker.fetch(new Request(
      `https://app.test/api/references/media/execution_image/${
        encodeReferenceRouteId("execution-legacy")
      }?step=step`,
    ), env, executionContext);
    expect(media.status).toBe(200);
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(bytes);

    const deletion = await worker.fetch(new Request(
      "https://app.test/api/samples/sample/events/timeline-image/asset",
      { method: "DELETE" },
    ), env, executionContext);
    expect(deletion.status).toBe(200);
    expect(db.prepare(`
      SELECT deleted_at IS NOT NULL AS deleted
      FROM run_step_assets WHERE id = 'execution-canonical'
    `).get()).toEqual({ deleted: 1 });
    expect(db.prepare(`
      SELECT asset_key FROM events WHERE id = 'timeline-image'
    `).get()).toEqual({ asset_key: null });
    db.close();
  });

  it("preserves the original 503 when Comment failure accounting also fails", async () => {
    const db = database();
    const bytes = Uint8Array.from([137, 80, 78, 71, 131, 132, 133]);
    db.exec(`
      INSERT INTO samples (id, code, title, created_at, updated_at)
      VALUES (
        'upload-sample', 'UPLOAD', 'Upload sample',
        '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z'
      );

      INSERT INTO comment_submissions (
        id, context_kind, sample_id, body, status, actor_email,
        created_at, updated_at, retry_until
      ) VALUES (
        'submission', 'sample', 'upload-sample', '', 'uploading',
        'local-development', '2026-08-16T00:00:00.000Z',
        '2026-08-16T00:00:00.000Z', '2026-08-17T00:00:00.000Z'
      );

      INSERT INTO comment_submission_items (
        id, submission_id, kind, status, position, filename, mime_type,
        byte_size, created_at, updated_at
      ) VALUES (
        'item', 'submission', 'comment_image', 'pending', 0, 'image.png',
        'image/png', ${bytes.byteLength}, '2026-08-16T00:00:00.000Z',
        '2026-08-16T00:00:00.000Z'
      );
    `);

    const put = vi.fn();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = {
      AUTH_MODE: "disabled",
      DB: new FaultDatabase(db) as unknown as D1Database,
      ASSETS: {
        put,
        delete: vi.fn(),
        head: vi.fn(async () => null),
        get: vi.fn(async () => null),
        list: vi.fn(async () => ({ objects: [], truncated: false })),
      } as unknown as R2Bucket,
    } satisfies Env;

    const response = await worker.fetch(new Request(
      "https://app.test/api/comment-submissions/submission/items/item/content",
      {
        method: "PUT",
        headers: {
          "content-type": "image/png",
          "x-upload-size": String(bytes.byteLength),
        },
        body: bytes,
      },
    ), env, executionContext);

    expect(response.status).toBe(503);
    expect(put).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      "Could not record Comment upload failure",
      expect.objectContaining({ submissionId: "submission", itemId: "item" }),
    );
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM assets",
    ).get()).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT status, error_message
      FROM comment_submission_items WHERE id = 'item'
    `).get()).toEqual({ status: "uploading", error_message: null });
    db.close();
  });
});
''')
