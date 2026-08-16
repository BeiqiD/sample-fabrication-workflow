from __future__ import annotations

from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    file_path = Path(path)
    text = file_path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one exact replacement target, found {count}")
    file_path.write_text(text.replace(old, new, 1))


def replace_last(path: str, old: str, new: str) -> None:
    file_path = Path(path)
    text = file_path.read_text()
    index = text.rfind(old)
    if index < 0:
        raise SystemExit(f"{path}: final replacement target not found")
    file_path.write_text(text[:index] + new + text[index + len(old):])


def replace_regex_once(path: str, pattern: str, replacement: str) -> None:
    file_path = Path(path)
    text = file_path.read_text()
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{path}: expected one regex replacement target, found {count}")
    file_path.write_text(updated)


# Comment upload failure accounting is subordinate to the original upload error.
replace_once(
    "worker/comment-submission-routes.ts",
    '''  return Boolean(results[1].meta.changes);
}

async function managedKeyForSubmission(
''',
    '''  return Boolean(results[1].meta.changes);
}

async function markItemFailedBestEffort(
  env: Env,
  submissionId: string,
  itemId: string,
  message: string,
) {
  try {
    return await markItemFailed(env, submissionId, itemId, message);
  } catch (recordingError) {
    console.warn("Could not record Comment upload failure", {
      submissionId,
      itemId,
      error: recordingError instanceof Error
        ? recordingError.message
        : String(recordingError),
    });
    return false;
  }
}

async function managedKeyForSubmission(
''',
)
replace_once(
    "worker/comment-submission-routes.ts",
    '''  } catch (error) {
    const message = error instanceof HTTPException ? error.message : "The file upload failed";
    await markItemFailed(c.env, submissionId, itemId, message);
    throw error;
  }
});
''',
    '''  } catch (error) {
    const message = error instanceof HTTPException ? error.message : "The file upload failed";
    await markItemFailedBestEffort(c.env, submissionId, itemId, message);
    throw error;
  }
});
''',
)

# Timeline metadata is a mutable projection of the live attachment occurrence.
timeline_marker = '''    db.prepare(`
      WITH rebinds AS (
        SELECT CAST(json_extract(entry.value, '$.objectKey') AS TEXT) AS legacy_key,
               CAST(json_extract(entry.value, '$.canonicalObjectKey') AS TEXT) AS canonical_key
        FROM json_each(?) entry
        WHERE json_extract(entry.value, '$.canonicalObjectKey') IS NOT NULL
      )
      UPDATE events
      SET asset_key = (
'''
timeline_projection = '''    // Timeline events project the currently actionable execution-image
    // occurrence. Keep the superseded ID as provenance, but point
    // runStepAssetId at the surviving occurrence before replacing the key.
    db.prepare(`
      WITH rebinds AS (
        SELECT CAST(json_extract(entry.value, '$.id') AS TEXT) AS legacy_id
        FROM json_each(?) entry
        WHERE json_extract(entry.value, '$.canonicalAssetId') IS NOT NULL
      )
      UPDATE events
      SET metadata_json = json_set(
            metadata_json,
            '$.supersededRunStepAssetId',
            COALESCE(
              json_extract(metadata_json, '$.supersededRunStepAssetId'),
              json_extract(metadata_json, '$.runStepAssetId')
            ),
            '$.runStepAssetId',
            (
              SELECT rsa.superseded_by_occurrence_id
              FROM run_step_assets rsa
              JOIN rebinds ON rebinds.legacy_id = rsa.asset_id
              WHERE rsa.id = CAST(
                json_extract(events.metadata_json, '$.runStepAssetId')
                AS TEXT
              )
            )
          )
      WHERE json_valid(metadata_json)
        AND json_type(metadata_json, '$.runStepAssetId') = 'text'
        AND EXISTS (
          SELECT 1
          FROM run_step_assets rsa
          JOIN rebinds ON rebinds.legacy_id = rsa.asset_id
          WHERE rsa.id = CAST(
            json_extract(events.metadata_json, '$.runStepAssetId') AS TEXT
          )
            AND rsa.superseded_by_occurrence_id IS NOT NULL
        )
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
    `).bind(
      inspectionPayload,
      input.importId,
      recoveryOperationId,
    ),
''' + timeline_marker
replace_once(
    "worker/fabublox-import-recovery.ts",
    timeline_marker,
    timeline_projection,
)

# Deletion remains resilient to a pre-repair Timeline projection by resolving
# the one-hop immutable supersession link at the authoritative endpoint.
replace_once(
    "worker/index.ts",
    '''        `SELECT rsa.id
         FROM run_step_assets rsa
         JOIN assets a ON a.id = rsa.asset_id
         JOIN run_steps rs ON rs.id = rsa.run_step_id
         JOIN runs r ON r.id = rs.run_id
         JOIN samples s ON s.id = r.sample_id
         WHERE rsa.id = ? AND rsa.run_step_id = ? AND rsa.role = 'execution'
           AND a.r2_key = ? AND rs.id = ? AND r.id = ? AND s.id = ?
           AND rsa.deleted_at IS NULL AND rs.deleted_at IS NULL
           AND r.deleted_at IS NULL AND s.deleted_at IS NULL`,
''',
    '''        `SELECT effective_occurrence.id
         FROM run_step_assets origin
         LEFT JOIN run_step_assets successor
           ON successor.id = origin.superseded_by_occurrence_id
         JOIN run_step_assets effective_occurrence
           ON effective_occurrence.id = COALESCE(successor.id, origin.id)
         JOIN assets a ON a.id = effective_occurrence.asset_id
         JOIN run_steps rs ON rs.id = effective_occurrence.run_step_id
         JOIN runs r ON r.id = rs.run_id
         JOIN samples s ON s.id = r.sample_id
         WHERE origin.id = ?
           AND effective_occurrence.run_step_id = ?
           AND effective_occurrence.role = 'execution'
           AND effective_occurrence.superseded_by_occurrence_id IS NULL
           AND a.r2_key = ? AND rs.id = ? AND r.id = ? AND s.id = ?
           AND effective_occurrence.deleted_at IS NULL
           AND rs.deleted_at IS NULL
           AND r.deleted_at IS NULL AND s.deleted_at IS NULL`,
''',
)

# Reference adapters resolve the stable legacy occurrence through its immutable,
# provider-verified survivor without changing the target ID.
execution_block = r'''async function executionImages(db: D1Database, ids: string[]) {
  if (!ids.length) return new Map<string, ResolvedReferenceRecord>();
  const rows = await db.prepare(`
    SELECT rsa.id, rsa.role, rsa.created_at, rsa.deleted_at,
           rsa.superseded_by_occurrence_id,
           original_asset.original_name AS original_name,
           effective_asset.original_name AS effective_original_name,
           effective_asset.mime_type,
           rs.id AS step_id, rs.title AS step_title, rs.position AS step_position,
           rs.deleted_at AS step_deleted_at,
           r.id AS run_id, r.sequence_no, r.deleted_at AS run_deleted_at,
           s.id AS sample_id, s.code AS sample_code, s.deleted_at AS sample_deleted_at
    FROM run_step_assets rsa
    LEFT JOIN run_step_assets successor
      ON successor.id = rsa.superseded_by_occurrence_id
    LEFT JOIN assets original_asset ON original_asset.id = rsa.asset_id
    LEFT JOIN assets effective_asset
      ON effective_asset.id = COALESCE(successor.asset_id, rsa.asset_id)
    LEFT JOIN run_steps rs ON rs.id = rsa.run_step_id
    LEFT JOIN runs r ON r.id = rs.run_id
    LEFT JOIN samples s ON s.id = r.sample_id
    WHERE rsa.id IN (SELECT value FROM json_each(?))
      AND rsa.role = 'execution'
      AND effective_asset.status = 'ready'
      AND ${publishedAssetSql("effective_asset")}
      AND (
        rsa.superseded_by_occurrence_id IS NULL
        OR (
          successor.id IS NOT NULL
          AND successor.superseded_by_occurrence_id IS NULL
        )
      )
    ORDER BY rsa.id
  `).bind(idsJson(ids)).all<Record<string, unknown>>();
  return rowsToMap(rows.results, (row) => {
    const context = processContext(row);
    const consistent = Boolean(
      context
      && text(row.original_name)
      && text(row.effective_original_name),
    );
    return {
      id: text(row.id)!,
      record: {
        source: source({
          title: text(row.original_name)
            ?? text(row.effective_original_name)
            ?? "Execution image",
          subtitle: text(row.mime_type),
          kind: text(row.role),
          state: row.superseded_by_occurrence_id ? "superseded" : "ready",
          updatedAt: text(row.created_at),
          deletedAt: text(row.deleted_at),
        }),
        contexts: context ? [context] : [],
        consistent,
      },
    };
  });
}'''
replace_regex_once(
    "worker/references/adapters.ts",
    r'''async function executionImages\(db: D1Database, ids: string\[\]\) \{.*?\n\}(?=\n\nasync function metrologyReferences)''',
    execution_block,
)

metrology_block = r'''async function metrologyReferences(db: D1Database, ids: string[]) {
  if (!ids.length) return new Map<string, ResolvedReferenceRecord>();
  const rows = await db.prepare(`
    SELECT mtr.id, mtr.display_name, mtr.created_at, mtr.deleted_at,
           mtr.superseded_by_occurrence_id,
           effective_asset.original_name, effective_asset.mime_type,
           tv.id AS template_id, tv.name AS template_name, tv.version,
           tv.archived_at AS template_archived_at,
           tv.deleted_at AS template_deleted_at
    FROM metrology_template_references mtr
    LEFT JOIN metrology_template_references successor
      ON successor.id = mtr.superseded_by_occurrence_id
    LEFT JOIN assets effective_asset
      ON effective_asset.id = COALESCE(successor.asset_id, mtr.asset_id)
    LEFT JOIN template_versions tv ON tv.id = mtr.template_version_id
    WHERE mtr.id IN (SELECT value FROM json_each(?))
      AND effective_asset.status = 'ready'
      AND ${publishedAssetSql("effective_asset")}
      AND ${publishedTemplateVersionSql("tv")}
      AND (
        mtr.superseded_by_occurrence_id IS NULL
        OR (
          successor.id IS NOT NULL
          AND successor.superseded_by_occurrence_id IS NULL
        )
      )
    ORDER BY mtr.id
  `).bind(idsJson(ids)).all<Record<string, unknown>>();
  return rowsToMap(rows.results, (row) => {
    const context = templateContext(row);
    const consistent = Boolean(
      context
      && text(row.display_name)
      && text(row.original_name),
    );
    return {
      id: text(row.id)!,
      record: {
        source: source({
          title: text(row.display_name) ?? "Metrology reference",
          subtitle: text(row.original_name) ?? text(row.mime_type),
          kind: "metrology_reference",
          state: row.superseded_by_occurrence_id ? "superseded" : "ready",
          updatedAt: text(row.created_at),
          deletedAt: text(row.deleted_at),
          archivedAt: text(row.template_archived_at),
        }),
        contexts: context ? [context] : [],
        consistent,
      },
    };
  });
}'''
replace_regex_once(
    "worker/references/adapters.ts",
    r'''async function metrologyReferences\(db: D1Database, ids: string\[\]\) \{.*?\n\}(?=\n\nasync function recipeRevisions)''',
    metrology_block,
)

# Reference media follows the same effective-occurrence rule.
replace_regex_once(
    "worker/reference-routes.ts",
    r'''  const source = await c\.env\.DB\.prepare\(`\n    SELECT a\.r2_key, a\.original_name, a\.mime_type\n    FROM run_step_assets rsa\n    JOIN assets a ON a\.id = rsa\.asset_id AND a\.status = 'ready'\n    JOIN run_steps rs ON rs\.id = rsa\.run_step_id AND rs\.deleted_at IS NULL\n    JOIN runs r ON r\.id = rs\.run_id AND r\.deleted_at IS NULL\n    JOIN samples s ON s\.id = r\.sample_id AND s\.deleted_at IS NULL\n    WHERE rsa\.id = \?\n      AND rs\.id = \?\n      AND rsa\.role = 'execution'\n      AND rsa\.deleted_at IS NULL\n      AND \(\n        a\.import_id IS NULL\n        OR EXISTS \(\n          SELECT 1 FROM imports i\n          WHERE i\.id = a\.import_id AND i\.status = 'ready'\n        \)\n      \)\n      AND NOT EXISTS \(\n        SELECT 1\n        FROM blob_gc_ledger bg\n        WHERE bg\.store_kind = 'r2'\n          AND bg\.provider = 'r2'\n          AND bg\.object_key = a\.r2_key\n          AND bg\.state IN \('deleting', 'deleted'\)\n      \)\n      AND NOT EXISTS \(\n        SELECT 1\n        FROM blob_integrity_quarantine biq\n        WHERE biq\.store_kind = 'r2'\n          AND biq\.provider = 'r2'\n          AND biq\.object_key = a\.r2_key\n      \)\n  `\)\.bind\(id, stepId\)\.first<MediaSource>\(\);''',
    '''  const source = await c.env.DB.prepare(`
    SELECT a.r2_key, a.original_name, a.mime_type
    FROM run_step_assets origin
    LEFT JOIN run_step_assets successor
      ON successor.id = origin.superseded_by_occurrence_id
    JOIN run_step_assets effective_occurrence
      ON effective_occurrence.id = COALESCE(successor.id, origin.id)
    JOIN assets a
      ON a.id = effective_occurrence.asset_id AND a.status = 'ready'
    JOIN run_steps rs
      ON rs.id = effective_occurrence.run_step_id AND rs.deleted_at IS NULL
    JOIN runs r ON r.id = rs.run_id AND r.deleted_at IS NULL
    JOIN samples s ON s.id = r.sample_id AND s.deleted_at IS NULL
    WHERE origin.id = ?
      AND rs.id = ?
      AND origin.role = 'execution'
      AND effective_occurrence.role = 'execution'
      AND effective_occurrence.deleted_at IS NULL
      AND effective_occurrence.superseded_by_occurrence_id IS NULL
      AND (
        a.import_id IS NULL
        OR EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = a.import_id AND i.status = 'ready'
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2'
          AND bg.provider = 'r2'
          AND bg.object_key = a.r2_key
          AND bg.state IN ('deleting', 'deleted')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2'
          AND biq.provider = 'r2'
          AND biq.object_key = a.r2_key
      )
  `).bind(id, stepId).first<MediaSource>();''',
)

# Contract documentation now describes the implemented provider-verification
# boundary rather than deferring it.
replace_once(
    "docs/BLOB_LIFECYCLE_CONTRACT.md",
    '''Last reviewed: 2026-08-09 after the reference/search and reusable Project
discovery foundation through PR #130
''',
    '''Last reviewed: 2026-08-16 during the provider-integrity and recovery
architecture review in PR #141
''',
)
replace_once(
    "docs/BLOB_LIFECYCLE_CONTRACT.md",
    '''## Explicit first-implementation boundaries

These are documented deferrals, not implied features.

### Provider `HEAD`/`stat` before dedup reuse

Deduplication excludes locators in `deleting` or `deleted` ledger state, but it
does not probe the provider before every reuse. A ready metadata row whose bytes
drifted missing may be selected and fail later retrieval/export. A later
storage-integrity slice may add provider stat, quarantine, and replacement
registration. The source/retention history remains safe in the meantime.

### Direct-key physical GC
''',
    '''## Provider verification and integrity quarantine

Deduplication verifies the selected physical locator before reuse. R2 uses
provider `HEAD`; managed storage uses the adapter's metadata-only `stat`
operation. A transient provider, authentication, transport, configuration, or
primary-authority failure returns retryable `503` and does not change
quarantine or GC state.

Confirmed absence and byte-size mismatch create a locator-scoped
`blob_integrity_quarantine` record. Quarantine preserves source, occurrence,
blob-record, and export history while excluding the locator from ordinary
delivery and future deduplication. It also releases the content hash so
provider-verified identical bytes may be registered at a new unique locator.
Existing historical edges remain visible for audit and export, but new
relationships cannot bind the quarantined locator.

## Explicit first-implementation boundaries

These are documented deferrals, not implied features.

### Direct-key physical GC
''',
)

# Cross-module recovery regression coverage.
replace_once(
    "worker/fabublox-import-recovery.test.ts",
    '''import { sha256Hex } from "../shared/content-addressing";
import worker from "./index";
''',
    '''import { sha256Hex } from "../shared/content-addressing";
import { encodeReferenceRouteId } from "../shared/reference-destinations";
import worker from "./index";
''',
)

replace_once(
    "worker/fabublox-import-recovery.test.ts",
    '''      INSERT INTO run_step_assets (
        id, run_step_id, asset_id, role, position, actor_email, created_at,
        deleted_at, deleted_by
      ) VALUES (
        'run-asset-canonical', 'recovery-step', 'canonical-winner',
        'execution', 1, 'canonical-run@example.com',
        '2026-07-01T00:01:00.000Z',
        '2026-07-02T00:00:00.000Z', 'legacy-cleanup@example.com'
      );

      INSERT INTO blob_integrity_quarantine (
''',
    '''      INSERT INTO run_step_assets (
        id, run_step_id, asset_id, role, position, actor_email, created_at,
        deleted_at, deleted_by
      ) VALUES (
        'run-asset-canonical', 'recovery-step', 'canonical-winner',
        'execution', 1, 'canonical-run@example.com',
        '2026-07-01T00:01:00.000Z',
        '2026-07-02T00:00:00.000Z', 'legacy-cleanup@example.com'
      );

      INSERT INTO events (
        id, sample_id, kind, asset_key, metadata_json, created_at
      ) VALUES (
        'recovery-timeline-image', 'recovery-sample', 'image',
        'imports/a/shared.png',
        '{"runId":"recovery-run","stepId":"recovery-step","runStepAssetId":"run-asset-legacy"}',
        '2026-07-01T00:04:00.000Z'
      );

      INSERT INTO blob_integrity_quarantine (
''',
)

replace_last(
    "worker/fabublox-import-recovery.test.ts",
    '''    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM blob_retention_edges
''',
    '''    expect(database.prepare(`
      SELECT asset_key,
             json_extract(metadata_json, '$.runStepAssetId')
               AS run_step_asset_id,
             json_extract(metadata_json, '$.supersededRunStepAssetId')
               AS superseded_run_step_asset_id
      FROM events WHERE id = 'recovery-timeline-image'
    `).get()).toEqual({
      asset_key: "ready/canonical-shared.png",
      run_step_asset_id: "run-asset-canonical",
      superseded_run_step_asset_id: "run-asset-legacy",
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM blob_retention_edges
''',
)

finalization_marker = '''    expect((await worker.fetch(new Request(
      "https://app.test/api/templates/template-b",
    ), env, executionContext)).status).toBe(200);

    const retry = await reapStaleFabubloxImports(
'''
finalization_replacement = '''    expect((await worker.fetch(new Request(
      "https://app.test/api/templates/template-b",
    ), env, executionContext)).status).toBe(200);

    const references = await worker.fetch(new Request(
      "https://app.test/api/references/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targets: [
            { type: "execution_image", id: "run-asset-legacy" },
            { type: "metrology_reference", id: "reference-legacy" },
          ],
        }),
      },
    ), env, executionContext);
    expect(references.status).toBe(200);
    expect(await references.json()).toMatchObject({
      results: [
        {
          target: { type: "execution_image", id: "run-asset-legacy" },
          resolution: "resolved",
          source: {
            title: "shared.png",
            state: "superseded",
            deletedAt: "2026-08-20T00:00:00.000Z",
          },
        },
        {
          target: { type: "metrology_reference", id: "reference-legacy" },
          resolution: "resolved",
          source: {
            title: "legacy.png",
            state: "superseded",
            deletedAt: "2026-08-20T00:00:00.000Z",
          },
        },
      ],
    });

    const media = await worker.fetch(new Request(
      `https://app.test/api/references/media/execution_image/${
        encodeReferenceRouteId("run-asset-legacy")
      }?step=recovery-step`,
    ), env, executionContext);
    expect(media.status).toBe(200);
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(bytes);

    const deletion = await worker.fetch(new Request(
      "https://app.test/api/samples/recovery-sample/events/recovery-timeline-image/asset",
      { method: "DELETE" },
    ), env, executionContext);
    expect(deletion.status).toBe(200);
    expect(database.prepare(`
      SELECT deleted_at IS NOT NULL AS deleted
      FROM run_step_assets WHERE id = 'run-asset-canonical'
    `).get()).toEqual({ deleted: 1 });
    expect(database.prepare(`
      SELECT asset_key,
             json_extract(metadata_json, '$.runStepAssetId')
               AS run_step_asset_id,
             json_extract(metadata_json, '$.supersededRunStepAssetId')
               AS superseded_run_step_asset_id
      FROM events WHERE id = 'recovery-timeline-image'
    `).get()).toEqual({
      asset_key: null,
      run_step_asset_id: "run-asset-canonical",
      superseded_run_step_asset_id: "run-asset-legacy",
    });

    const retry = await reapStaleFabubloxImports(
'''
replace_last(
    "worker/fabublox-import-recovery.test.ts",
    finalization_marker,
    finalization_replacement,
)

# Fault-injection coverage proves secondary failure accounting cannot overwrite
# the primary retryable registration result.
replace_once(
    "worker/blob-registration-reconciliation.test.ts",
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
    "worker/blob-registration-reconciliation.test.ts",
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
    "worker/blob-registration-reconciliation.test.ts",
    '''  beforeMutation(query: string) {
    if (this.failPromotionBeforeCommit && this.promotionPattern().test(query)) {
''',
    '''  beforeMutation(query: string) {
    const normalized = query.replace(/\s+/g, " ");
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
    "worker/blob-registration-reconciliation.test.ts",
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

managed_test_marker = '''  it("returns 503 when managed metadata staging fails twice before provider write", async () => {
'''
comment_failure_test = '''  it("preserves the original 503 when Comment failure accounting is unavailable", async () => {
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

''' + managed_test_marker
replace_once(
    "worker/blob-registration-reconciliation.test.ts",
    managed_test_marker,
    comment_failure_test,
)

# Ensure generated changes are clean and no temporary patch artifacts leak.
for path in [
    "worker/comment-submission-routes.ts",
    "worker/fabublox-import-recovery.ts",
    "worker/index.ts",
    "worker/references/adapters.ts",
    "worker/reference-routes.ts",
    "docs/BLOB_LIFECYCLE_CONTRACT.md",
    "worker/fabublox-import-recovery.test.ts",
    "worker/blob-registration-reconciliation.test.ts",
]:
    if not Path(path).read_text().endswith("\n"):
        raise SystemExit(f"{path}: missing trailing newline")
