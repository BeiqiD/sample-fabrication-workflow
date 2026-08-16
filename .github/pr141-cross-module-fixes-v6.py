from pathlib import Path

runner = Path(".github/pr141-cross-module-fixes-v5.py")
exec(compile(runner.read_text(), str(runner), "exec"), {"__name__": "__main__"})


def replace_once(path: str, old: str, new: str) -> None:
    file_path = Path(path)
    text = file_path.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"{path}: expected one replacement target")
    file_path.write_text(text.replace(old, new, 1))


# Reapply the already-verified persistent failure-accounting regression to its
# existing fault-injection suite.
path = "worker/blob-registration-reconciliation.test.ts"
replace_once(
    path,
    '''        meta: { changes: 0 },
      };
    }
    const result = this.statement().run(...this.bindings);
''',
    '''        meta: { changes: 0 },
      };
    }
    this.owner.beforeMutation(this.query);
    const result = this.statement().run(...this.bindings);
''',
)
replace_once(
    path,
    '''    private readonly failBeforeInsert = false,
    private readonly failPromotionBeforeCommit = false,
  ) {}
''',
    '''    private readonly failBeforeInsert = false,
    private readonly failPromotionBeforeCommit = false,
    private readonly failCommentFailureRecording = false,
  ) {}
''',
)
replace_once(
    path,
    '''  beforeMutation(query: string) {
    if (this.failPromotionBeforeCommit && this.promotionPattern().test(query)) {
''',
    '''  beforeMutation(query: string) {
    const normalized = query.replace(/\\s+/g, " ");
    if (
      this.failCommentFailureRecording
      && normalized.includes(
        "UPDATE comment_submission_items SET status = 'failed'",
      )
    ) {
      throw new Error("injected persistent Comment failure-accounting outage");
    }
    if (this.failPromotionBeforeCommit && this.promotionPattern().test(query)) {
''',
)
replace_once(
    path,
    '''afterEach(() => {
  vi.unstubAllGlobals();
});
''',
    '''afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
''',
)
marker = '''  it("returns 503 when managed metadata staging fails twice before provider write", async () => {
'''
new_test = '''  it("preserves the original 503 when Comment failure accounting is unavailable", async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 116, 117, 118]);
    const database = databaseWithUpload("comment_image", bytes.byteLength);
    const put = vi.fn();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = {
      AUTH_MODE: "disabled",
      DB: new FaultD1Database(
        database,
        "assets",
        false,
        "promotion",
        true,
        false,
        true,
      ) as unknown as D1Database,
      ASSETS: {
        put,
        delete: vi.fn(),
        head: vi.fn(async () => null),
        get: vi.fn(async () => null),
        list: vi.fn(async () => ({ objects: [], truncated: false })),
      } as unknown as R2Bucket,
    } satisfies Env;

    const response = await worker.fetch(new Request(
      "https://app.test/api/comment-submissions/submission-upload/items/item-upload/content",
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
      expect.objectContaining({
        submissionId: "submission-upload",
        itemId: "item-upload",
      }),
    );
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM assets",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT status, error_message
      FROM comment_submission_items WHERE id = 'item-upload'
    `).get()).toEqual({
      status: "uploading",
      error_message: null,
    });
    database.close();
  });

''' + marker
replace_once(path, marker, new_test)

# Use a real through-0024 partial-import fixture, then apply the publication,
# recovery, supersession, and Timeline-projection migrations.
Path("worker/supersession-cross-module.test.ts").write_text(r'''import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/content-addressing";
import { encodeReferenceRouteId } from "../shared/reference-destinations";
import worker from "./index";
import { SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const migrationDirectory = new URL("../migrations/", import.meta.url);
const migrationNames = () => readdirSync(migrationDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

function applyMigrations(
  database: DatabaseSync,
  predicate: (name: string) => boolean,
) {
  for (const filename of migrationNames().filter(predicate)) {
    database.exec(readFileSync(new URL(filename, migrationDirectory), "utf8"));
  }
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

describe("supersession cross-module contract", () => {
  it("keeps Timeline actions and stable Reference IDs on the live survivor", async () => {
    const database = new DatabaseSync(":memory:");
    applyMigrations(
      database,
      (name) => name <= "0024_blob_integrity_quarantine.sql",
    );
    const bytes = Uint8Array.from([137, 80, 78, 71, 121, 122, 123]);
    const sha256 = await sha256Hex(bytesBuffer(bytes));

    database.exec(`
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
        actor_email, created_at, completed_at, operation_id, finalization_id
      ) VALUES (
        'failed-import', 'failed', 'failed.xlsx', '${"1".repeat(64)}',
        'Sheet1', 'process', 'owner@example.com',
        '2026-08-16T00:00:00.000Z', '2026-08-16T00:01:00.000Z',
        'import-operation', NULL
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
      ) VALUES
        ('execution-legacy', 'step', 'legacy-asset', 'execution', 0,
         'legacy@example.com', '2026-08-16T00:00:00.000Z'),
        ('execution-canonical', 'step', 'canonical-asset', 'execution', 1,
         'canonical@example.com', '2026-08-16T00:00:01.000Z');

      UPDATE run_step_assets
      SET deleted_at = '2026-08-16T00:02:00.000Z',
          deleted_by = 'cleanup@example.com'
      WHERE id = 'execution-canonical';

      INSERT INTO metrology_template_references (
        id, template_version_id, asset_id, display_name, position,
        actor_email, created_at
      ) VALUES
        ('metrology-legacy', 'template-metrology', 'legacy-asset',
         'Legacy reference', 0, 'legacy@example.com',
         '2026-08-16T00:00:00.000Z'),
        ('metrology-canonical', 'template-metrology', 'canonical-asset',
         'Canonical reference', 1, 'canonical@example.com',
         '2026-08-16T00:00:01.000Z');

      UPDATE metrology_template_references
      SET deleted_at = '2026-08-16T00:02:00.000Z',
          deleted_by = 'cleanup@example.com'
      WHERE id = 'metrology-canonical';

      INSERT INTO events (
        id, sample_id, kind, asset_key, metadata_json, created_at
      ) VALUES (
        'timeline-image', 'sample', 'image', 'legacy/image.png',
        '{"runId":"run","stepId":"step","runStepAssetId":"execution-legacy","thumbnailKey":"legacy/image.png"}',
        '2026-08-16T00:03:00.000Z'
      );
    `);

    applyMigrations(
      database,
      (name) => name > "0024_blob_integrity_quarantine.sql",
    );
    database.exec(`
      UPDATE imports
      SET recovery_operation_id = 'recovery-operation'
      WHERE id = 'failed-import';

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

    expect(database.prepare(`
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
      DB: new SqliteD1Database(database) as unknown as D1Database,
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
    expect(database.prepare(`
      SELECT deleted_at IS NOT NULL AS deleted
      FROM run_step_assets WHERE id = 'execution-canonical'
    `).get()).toEqual({ deleted: 1 });
    expect(database.prepare(`
      SELECT asset_key FROM events WHERE id = 'timeline-image'
    `).get()).toEqual({ asset_key: null });
    database.close();
  });
});
''')
