import { inspectFabubloxRecoveryAssets } from "./fabublox-recovery-assets";
import { primaryD1 } from "./d1-primary";
import type { Env } from "./types";

export const FABUBLOX_IMPORT_LEASE_MS = 24 * 60 * 60 * 1_000;
const STALE_IMPORT_BATCH_SIZE = 25;

export interface FabubloxImportState {
  status: "pending" | "ready" | "failed";
  operation_id: string | null;
  finalization_id: string | null;
  recovery_operation_id: string | null;
  template_version_id: string | null;
}

export function fabubloxImportLeaseExpiresAt(now = new Date()) {
  return new Date(now.getTime() + FABUBLOX_IMPORT_LEASE_MS).toISOString();
}

export async function readFabubloxImportState(
  db: D1Database,
  importId: string,
): Promise<FabubloxImportState | null> {
  return primaryD1(db).prepare(`
    SELECT status, operation_id, finalization_id,
           recovery_operation_id, template_version_id
    FROM imports
    WHERE id = ?
  `).bind(importId).first<FabubloxImportState>();
}

function emptyCleanupResult() {
  return {
    importsFailed: 0,
    relationshipsRemoved: 0,
    templateStepsRemoved: 0,
    templatesQuarantined: 0,
    assetsReleased: 0,
    objectsQueued: 0,
  };
}

export async function queueFabubloxImportCleanup(
  env: Env,
  input: {
    importId: string;
    operationId: string;
    error: unknown;
    now?: Date;
    recoveryOperationId?: string;
  },
) {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const recoveryOperationId = input.recoveryOperationId ?? crypto.randomUUID();
  const message = (input.error instanceof Error
    ? input.error.message
    : String(input.error)).slice(0, 1_000);
  const db = primaryD1(env.DB);

  // Provider verification happens before the durable recovery claim. A
  // transient R2 failure therefore leaves the import retryable instead of
  // committing half of the cleanup. Every asset is checked because a later
  // statement may transfer private ownership or make the locator public.
  const current = await readFabubloxImportState(db, input.importId);
  if (!current
    || current.operation_id !== input.operationId
    || current.finalization_id !== null
    || !["pending", "failed"].includes(current.status)
    || (current.recovery_operation_id !== null
      && current.recovery_operation_id !== recoveryOperationId)) {
    return emptyCleanupResult();
  }
  const inspections = await inspectFabubloxRecoveryAssets(
    env,
    db,
    input.importId,
  );
  const inspectionPayload = JSON.stringify(inspections);

  const results = await db.batch([
    // Claim the exact unfinished operation. This also resumes legacy failed
    // rows that predate durable recovery identity. Every later statement is
    // gated by the persisted recovery ID, so a competing finalization cannot
    // be torn down after it wins. Only import-owned direct provenance is
    // released here; durable occurrences owned by other sources remain intact.
    db.prepare(`
      UPDATE imports
      SET status = 'failed',
          error_message = COALESCE(error_message, ?),
          completed_at = COALESCE(completed_at, ?),
          lease_expires_at = NULL,
          recovery_operation_id = ?,
          workbook_asset_key = NULL,
          manifest_asset_key = NULL
      WHERE id = ? AND operation_id = ? AND finalization_id IS NULL
        AND status IN ('pending', 'failed')
        AND (recovery_operation_id IS NULL OR recovery_operation_id = ?)
    `).bind(
      message,
      timestamp,
      recoveryOperationId,
      input.importId,
      input.operationId,
      recoveryOperationId,
    ),
    // A pending revision should never have been registered, but tombstone a
    // pre-existing row defensively before removing its partial source record.
    db.prepare(`
      UPDATE reference_targets
      SET tombstoned_at = COALESCE(tombstoned_at, ?), last_validated_at = ?
      WHERE target_type = 'recipe_revision'
        AND target_id = (
          SELECT template_version_id FROM imports
          WHERE id = ? AND status = 'failed'
            AND recovery_operation_id = ?
        )
    `).bind(timestamp, timestamp, input.importId, recoveryOperationId),
    // A state-image occurrence belongs to the state, not to the import that
    // originally registered the asset row. Remove it only when the state is
    // exclusive to this partial template. Other templates, every surviving
    // Run step or Run initial state, Sample inherited state, and explicit
    // verification history retain the relationship regardless of asset origin.
    db.prepare(`
      DELETE FROM state_representation_assets
      WHERE state_hash IN (
        SELECT tv.initial_state_hash
        FROM imports i
        JOIN template_versions tv ON tv.id = i.template_version_id
        WHERE i.id = ? AND i.status = 'failed'
          AND i.recovery_operation_id = ?
          AND tv.initial_state_hash IS NOT NULL
        UNION
        SELECT ts.expected_state_hash
        FROM imports i
        JOIN template_steps ts ON ts.template_version_id = i.template_version_id
        WHERE i.id = ? AND i.status = 'failed'
          AND i.recovery_operation_id = ?
          AND ts.expected_state_hash IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM template_versions other
        WHERE other.id <> (
          SELECT template_version_id FROM imports
          WHERE id = ? AND status = 'failed'
            AND recovery_operation_id = ?
        )
          AND other.initial_state_hash = state_representation_assets.state_hash
      )
      AND NOT EXISTS (
        SELECT 1
        FROM template_steps other
        WHERE other.template_version_id <> (
          SELECT template_version_id FROM imports
          WHERE id = ? AND status = 'failed'
            AND recovery_operation_id = ?
        )
          AND other.expected_state_hash = state_representation_assets.state_hash
      )
      AND NOT EXISTS (
        SELECT 1
        FROM run_steps rs
        WHERE rs.expected_state_hash = state_representation_assets.state_hash
      )
      AND NOT EXISTS (
        SELECT 1
        FROM runs r
        WHERE r.initial_state_hash = state_representation_assets.state_hash
      )
      AND NOT EXISTS (
        SELECT 1
        FROM samples s
        WHERE s.inherited_state_hash = state_representation_assets.state_hash
      )
      AND NOT EXISTS (
        SELECT 1
        FROM state_verifications sv
        WHERE sv.expected_state_hash = state_representation_assets.state_hash
      )
    `).bind(
      input.importId,
      recoveryOperationId,
      input.importId,
      recoveryOperationId,
      input.importId,
      recoveryOperationId,
      input.importId,
      recoveryOperationId,
    ),
    // Through-0024 databases could point Run records at staged template steps.
    // Remove the join rows and nullable FK before deleting the partial steps.
    db.prepare(`
      DELETE FROM run_step_plan_links
      WHERE template_step_id IN (
        SELECT ts.id
        FROM template_steps ts
        JOIN imports i ON i.template_version_id = ts.template_version_id
        WHERE i.id = ? AND i.status = 'failed'
          AND i.recovery_operation_id = ?
      )
    `).bind(input.importId, recoveryOperationId),
    db.prepare(`
      UPDATE run_steps
      SET template_step_id = NULL
      WHERE template_step_id IN (
        SELECT ts.id
        FROM template_steps ts
        JOIN imports i ON i.template_version_id = ts.template_version_id
        WHERE i.id = ? AND i.status = 'failed'
          AND i.recovery_operation_id = ?
      )
    `).bind(input.importId, recoveryOperationId),
    // Template revisions are stable identities and cannot be physically
    // deleted. Remove their cascade-owned step rows, then quarantine the
    // revision in place and release only its direct source locator. Event and
    // other occurrence keys are independent durable edges and are not altered.
    db.prepare(`
      DELETE FROM template_steps
      WHERE template_version_id = (
        SELECT template_version_id FROM imports
        WHERE id = ? AND status = 'failed'
          AND recovery_operation_id = ?
      )
    `).bind(input.importId, recoveryOperationId),
    db.prepare(`
      UPDATE template_versions
      SET source_asset_key = NULL,
          initial_state_hash = NULL,
          archived_at = COALESCE(archived_at, ?),
          archived_by = COALESCE(archived_by, 'system:fabublox-import-recovery'),
          deleted_at = COALESCE(deleted_at, ?),
          deleted_by = COALESCE(deleted_by, 'system:fabublox-import-recovery')
      WHERE id = (
        SELECT template_version_id FROM imports
        WHERE id = ? AND status = 'failed'
          AND recovery_operation_id = ?
      )
    `).bind(timestamp, timestamp, input.importId, recoveryOperationId),
    // Restore provider-backed metadata before any availability transition.
    // Legacy failed rows may have lost both SHA and the authoritative byte
    // count; R2 bytes inspected before the claim are the repair source.
    db.prepare(`
      UPDATE assets
      SET sha256 = (
            SELECT json_extract(entry.value, '$.sha256')
            FROM json_each(?) entry
            WHERE json_extract(entry.value, '$.id') = assets.id
          ),
          byte_size = CAST((
            SELECT json_extract(entry.value, '$.byteSize')
            FROM json_each(?) entry
            WHERE json_extract(entry.value, '$.id') = assets.id
          ) AS INTEGER),
          status = CASE
            WHEN EXISTS (
              SELECT 1 FROM json_each(?) entry
              WHERE json_extract(entry.value, '$.id') = assets.id
                AND json_extract(entry.value, '$.canonicalAssetId') IS NOT NULL
            )
            THEN 'failed'
            ELSE status
          END
      WHERE import_id = ?
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM json_each(?) entry
          WHERE json_extract(entry.value, '$.id') = assets.id
            AND json_extract(entry.value, '$.available') = 1
        )
    `).bind(
      inspectionPayload,
      inspectionPayload,
      inspectionPayload,
      input.importId,
      input.importId,
      recoveryOperationId,
      inspectionPayload,
    ),

    // A recovered legacy locator can contain bytes already represented by a
    // healthy canonical asset. Rebind every durable occurrence to that winner
    // after the claim and metadata repair, then release only the old physical
    // locator. Each statement is claim-gated and publication triggers verify
    // that the canonical row is still healthy at commit time.
    db.prepare(`
      WITH rebinds AS (
        SELECT CAST(json_extract(entry.value, '$.id') AS TEXT) AS legacy_id,
               CAST(json_extract(entry.value, '$.canonicalAssetId') AS TEXT) AS canonical_id
        FROM json_each(?) entry
        WHERE json_extract(entry.value, '$.canonicalAssetId') IS NOT NULL
      )
      INSERT OR IGNORE INTO state_representation_assets (
        state_hash, asset_id, position
      )
      SELECT sra.state_hash, rebinds.canonical_id, sra.position
      FROM state_representation_assets sra
      JOIN rebinds ON rebinds.legacy_id = sra.asset_id
      JOIN assets legacy ON legacy.id = rebinds.legacy_id
      WHERE legacy.import_id = ?
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
    `).bind(
      inspectionPayload,
      input.importId,
      input.importId,
      recoveryOperationId,
    ),
    db.prepare(`
      WITH rebinds AS (
        SELECT CAST(json_extract(entry.value, '$.id') AS TEXT) AS legacy_id
        FROM json_each(?) entry
        WHERE json_extract(entry.value, '$.canonicalAssetId') IS NOT NULL
      )
      DELETE FROM state_representation_assets
      WHERE asset_id IN (SELECT legacy_id FROM rebinds)
        AND EXISTS (
          SELECT 1 FROM assets legacy
          WHERE legacy.id = state_representation_assets.asset_id
            AND legacy.import_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
    `).bind(
      inspectionPayload,
      input.importId,
      input.importId,
      recoveryOperationId,
    ),
    db.prepare(`
      WITH rebinds AS (
        SELECT CAST(json_extract(entry.value, '$.id') AS TEXT) AS legacy_id,
               CAST(json_extract(entry.value, '$.canonicalAssetId') AS TEXT) AS canonical_id
        FROM json_each(?) entry
        WHERE json_extract(entry.value, '$.canonicalAssetId') IS NOT NULL
      )
      UPDATE OR IGNORE run_step_assets
      SET asset_id = (
        SELECT canonical_id FROM rebinds
        WHERE legacy_id = run_step_assets.asset_id
      )
      WHERE asset_id IN (SELECT legacy_id FROM rebinds)
        AND EXISTS (
          SELECT 1 FROM assets legacy
          WHERE legacy.id = run_step_assets.asset_id
            AND legacy.import_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
    `).bind(
      inspectionPayload,
      input.importId,
      input.importId,
      recoveryOperationId,
    ),
    db.prepare(`
      WITH rebinds AS (
        SELECT CAST(json_extract(entry.value, '$.id') AS TEXT) AS legacy_id
        FROM json_each(?) entry
        WHERE json_extract(entry.value, '$.canonicalAssetId') IS NOT NULL
      )
      DELETE FROM run_step_assets
      WHERE asset_id IN (SELECT legacy_id FROM rebinds)
        AND EXISTS (
          SELECT 1 FROM assets legacy
          WHERE legacy.id = run_step_assets.asset_id
            AND legacy.import_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
    `).bind(
      inspectionPayload,
      input.importId,
      input.importId,
      recoveryOperationId,
    ),
    db.prepare(`
      WITH rebinds AS (
        SELECT CAST(json_extract(entry.value, '$.id') AS TEXT) AS legacy_id,
               CAST(json_extract(entry.value, '$.canonicalAssetId') AS TEXT) AS canonical_id
        FROM json_each(?) entry
        WHERE json_extract(entry.value, '$.canonicalAssetId') IS NOT NULL
      )
      UPDATE run_step_comments
      SET asset_id = (
        SELECT canonical_id FROM rebinds
        WHERE legacy_id = run_step_comments.asset_id
      )
      WHERE asset_id IN (SELECT legacy_id FROM rebinds)
        AND EXISTS (
          SELECT 1 FROM assets legacy
          WHERE legacy.id = run_step_comments.asset_id
            AND legacy.import_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
    `).bind(
      inspectionPayload,
      input.importId,
      input.importId,
      recoveryOperationId,
    ),
    db.prepare(`
      WITH rebinds AS (
        SELECT CAST(json_extract(entry.value, '$.id') AS TEXT) AS legacy_id,
               CAST(json_extract(entry.value, '$.canonicalAssetId') AS TEXT) AS canonical_id
        FROM json_each(?) entry
        WHERE json_extract(entry.value, '$.canonicalAssetId') IS NOT NULL
      )
      UPDATE state_verifications
      SET evidence_asset_id = (
        SELECT canonical_id FROM rebinds
        WHERE legacy_id = state_verifications.evidence_asset_id
      )
      WHERE evidence_asset_id IN (SELECT legacy_id FROM rebinds)
        AND EXISTS (
          SELECT 1 FROM assets legacy
          WHERE legacy.id = state_verifications.evidence_asset_id
            AND legacy.import_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
    `).bind(
      inspectionPayload,
      input.importId,
      input.importId,
      recoveryOperationId,
    ),
    db.prepare(`
      WITH rebinds AS (
        SELECT CAST(json_extract(entry.value, '$.id') AS TEXT) AS legacy_id,
               CAST(json_extract(entry.value, '$.canonicalAssetId') AS TEXT) AS canonical_id
        FROM json_each(?) entry
        WHERE json_extract(entry.value, '$.canonicalAssetId') IS NOT NULL
      )
      UPDATE OR IGNORE metrology_template_references
      SET asset_id = (
        SELECT canonical_id FROM rebinds
        WHERE legacy_id = metrology_template_references.asset_id
      )
      WHERE asset_id IN (SELECT legacy_id FROM rebinds)
        AND EXISTS (
          SELECT 1 FROM assets legacy
          WHERE legacy.id = metrology_template_references.asset_id
            AND legacy.import_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
    `).bind(
      inspectionPayload,
      input.importId,
      input.importId,
      recoveryOperationId,
    ),
    db.prepare(`
      WITH rebinds AS (
        SELECT CAST(json_extract(entry.value, '$.id') AS TEXT) AS legacy_id
        FROM json_each(?) entry
        WHERE json_extract(entry.value, '$.canonicalAssetId') IS NOT NULL
      )
      DELETE FROM metrology_template_references
      WHERE asset_id IN (SELECT legacy_id FROM rebinds)
        AND EXISTS (
          SELECT 1 FROM assets legacy
          WHERE legacy.id = metrology_template_references.asset_id
            AND legacy.import_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
    `).bind(
      inspectionPayload,
      input.importId,
      input.importId,
      recoveryOperationId,
    ),
    db.prepare(`
      WITH rebinds AS (
        SELECT CAST(json_extract(entry.value, '$.id') AS TEXT) AS legacy_id,
               CAST(json_extract(entry.value, '$.canonicalAssetId') AS TEXT) AS canonical_id
        FROM json_each(?) entry
        WHERE json_extract(entry.value, '$.canonicalAssetId') IS NOT NULL
      )
      UPDATE comment_submission_items
      SET asset_id = (
        SELECT canonical_id FROM rebinds
        WHERE legacy_id = comment_submission_items.asset_id
      )
      WHERE asset_id IN (SELECT legacy_id FROM rebinds)
        AND EXISTS (
          SELECT 1 FROM assets legacy
          WHERE legacy.id = comment_submission_items.asset_id
            AND legacy.import_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
    `).bind(
      inspectionPayload,
      input.importId,
      input.importId,
      recoveryOperationId,
    ),
    db.prepare(`
      WITH rebinds AS (
        SELECT CAST(json_extract(entry.value, '$.id') AS TEXT) AS legacy_id,
               CAST(json_extract(entry.value, '$.canonicalAssetId') AS TEXT) AS canonical_id
        FROM json_each(?) entry
        WHERE json_extract(entry.value, '$.canonicalAssetId') IS NOT NULL
      )
      UPDATE project_content_attachments
      SET asset_id = (
        SELECT canonical_id FROM rebinds
        WHERE legacy_id = project_content_attachments.asset_id
      )
      WHERE asset_id IN (SELECT legacy_id FROM rebinds)
        AND EXISTS (
          SELECT 1 FROM assets legacy
          WHERE legacy.id = project_content_attachments.asset_id
            AND legacy.import_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
    `).bind(
      inspectionPayload,
      input.importId,
      input.importId,
      recoveryOperationId,
    ),
    db.prepare(`
      WITH rebinds AS (
        SELECT CAST(json_extract(entry.value, '$.objectKey') AS TEXT) AS legacy_key,
               CAST(json_extract(entry.value, '$.canonicalObjectKey') AS TEXT) AS canonical_key
        FROM json_each(?) entry
        WHERE json_extract(entry.value, '$.canonicalObjectKey') IS NOT NULL
      )
      UPDATE events
      SET asset_key = (
        SELECT canonical_key FROM rebinds
        WHERE legacy_key = events.asset_key
      )
      WHERE asset_key IN (SELECT legacy_key FROM rebinds)
        AND EXISTS (
          SELECT 1 FROM assets legacy
          WHERE legacy.r2_key = events.asset_key
            AND legacy.import_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
    `).bind(
      inspectionPayload,
      input.importId,
      input.importId,
      recoveryOperationId,
    ),
    db.prepare(`
      WITH rebinds AS (
        SELECT CAST(json_extract(entry.value, '$.objectKey') AS TEXT) AS legacy_key,
               CAST(json_extract(entry.value, '$.canonicalObjectKey') AS TEXT) AS canonical_key
        FROM json_each(?) entry
        WHERE json_extract(entry.value, '$.canonicalObjectKey') IS NOT NULL
      )
      UPDATE events
      SET metadata_json = json_set(
        metadata_json,
        '$.thumbnailKey',
        (
          SELECT canonical_key FROM rebinds
          WHERE legacy_key = CAST(json_extract(events.metadata_json, '$.thumbnailKey') AS TEXT)
        )
      )
      WHERE json_valid(metadata_json)
        AND CAST(json_extract(metadata_json, '$.thumbnailKey') AS TEXT)
          IN (SELECT legacy_key FROM rebinds)
        AND EXISTS (
          SELECT 1 FROM assets legacy
          WHERE legacy.r2_key = CAST(json_extract(events.metadata_json, '$.thumbnailKey') AS TEXT)
            AND legacy.import_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
    `).bind(
      inspectionPayload,
      input.importId,
      input.importId,
      recoveryOperationId,
    ),
    db.prepare(`
      WITH rebinds AS (
        SELECT CAST(json_extract(entry.value, '$.objectKey') AS TEXT) AS legacy_key,
               CAST(json_extract(entry.value, '$.canonicalObjectKey') AS TEXT) AS canonical_key
        FROM json_each(?) entry
        WHERE json_extract(entry.value, '$.canonicalObjectKey') IS NOT NULL
      )
      UPDATE imports
      SET workbook_asset_key = CASE
            WHEN workbook_asset_key IN (SELECT legacy_key FROM rebinds)
            THEN (
              SELECT canonical_key FROM rebinds
              WHERE legacy_key = imports.workbook_asset_key
            )
            ELSE workbook_asset_key
          END,
          manifest_asset_key = CASE
            WHEN manifest_asset_key IN (SELECT legacy_key FROM rebinds)
            THEN (
              SELECT canonical_key FROM rebinds
              WHERE legacy_key = imports.manifest_asset_key
            )
            ELSE manifest_asset_key
          END
      WHERE (
          workbook_asset_key IN (SELECT legacy_key FROM rebinds)
          OR manifest_asset_key IN (SELECT legacy_key FROM rebinds)
        )
        AND EXISTS (
          SELECT 1 FROM imports failed
          WHERE failed.id = ? AND failed.status = 'failed'
            AND failed.recovery_operation_id = ?
        )
    `).bind(
      inspectionPayload,
      input.importId,
      recoveryOperationId,
    ),
    db.prepare(`
      WITH rebinds AS (
        SELECT CAST(json_extract(entry.value, '$.objectKey') AS TEXT) AS legacy_key,
               CAST(json_extract(entry.value, '$.canonicalObjectKey') AS TEXT) AS canonical_key
        FROM json_each(?) entry
        WHERE json_extract(entry.value, '$.canonicalObjectKey') IS NOT NULL
      )
      UPDATE template_versions
      SET source_asset_key = (
        SELECT canonical_key FROM rebinds
        WHERE legacy_key = template_versions.source_asset_key
      )
      WHERE source_asset_key IN (SELECT legacy_key FROM rebinds)
        AND EXISTS (
          SELECT 1 FROM imports failed
          WHERE failed.id = ? AND failed.status = 'failed'
            AND failed.recovery_operation_id = ?
        )
    `).bind(
      inspectionPayload,
      input.importId,
      recoveryOperationId,
    ),
    db.prepare(`
      UPDATE assets
      SET status = 'failed', sha256 = NULL
      WHERE import_id = ?
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM json_each(?) entry
          WHERE json_extract(entry.value, '$.id') = assets.id
            AND json_extract(entry.value, '$.canonicalAssetId') IS NOT NULL
        )
    `).bind(
      input.importId,
      input.importId,
      recoveryOperationId,
      inspectionPayload,
    ),
    // Missing and size-mismatched provider objects stay auditable/exportable
    // but can never be promoted merely because metadata relationships survive.
    db.prepare(`
      INSERT INTO blob_integrity_quarantine (
        store_kind, provider, object_key, blob_record_id, reason,
        expected_byte_size, observed_byte_size, operation_id,
        detected_at, last_checked_at
      )
      SELECT 'r2', 'r2', a.r2_key, a.id,
             json_extract(entry.value, '$.quarantineReason'),
             CAST(json_extract(entry.value, '$.expectedByteSize') AS INTEGER),
             CAST(json_extract(entry.value, '$.observedByteSize') AS INTEGER),
             ?, ?, ?
      FROM json_each(?) entry
      JOIN assets a ON a.id = json_extract(entry.value, '$.id')
      WHERE a.import_id = ?
        AND json_extract(entry.value, '$.quarantineReason') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
      ON CONFLICT(store_kind, provider, object_key) DO UPDATE SET
        blob_record_id = COALESCE(blob_integrity_quarantine.blob_record_id, excluded.blob_record_id),
        last_checked_at = excluded.last_checked_at
    `).bind(
      recoveryOperationId,
      timestamp,
      timestamp,
      inspectionPayload,
      input.importId,
      input.importId,
      recoveryOperationId,
    ),
    // Only an independently public consumer may make the asset a standalone
    // ready winner. Generic blob retention is deliberately not sufficient.
    db.prepare(`
      UPDATE assets
      SET import_id = NULL, status = 'ready'
      WHERE import_id = ?
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM json_each(?) entry
          WHERE json_extract(entry.value, '$.id') = assets.id
            AND json_extract(entry.value, '$.available') = 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) entry
          WHERE json_extract(entry.value, '$.id') = assets.id
            AND json_extract(entry.value, '$.canonicalAssetId') IS NOT NULL
        )
        AND EXISTS (
          SELECT 1 FROM fabublox_recovery_public_asset_edges public_edge
          WHERE public_edge.asset_id = assets.id
        )
    `).bind(
      input.importId,
      input.importId,
      recoveryOperationId,
      inspectionPayload,
      inspectionPayload,
    ),
    // A public relationship whose provider object is missing remains a failed,
    // quarantined standalone record. It stays in export and blocks live reads.
    db.prepare(`
      UPDATE assets
      SET import_id = NULL, status = 'failed', sha256 = NULL
      WHERE import_id = ?
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM json_each(?) entry
          WHERE json_extract(entry.value, '$.id') = assets.id
            AND json_extract(entry.value, '$.available') = 0
        )
        AND EXISTS (
          SELECT 1 FROM fabublox_recovery_public_asset_edges public_edge
          WHERE public_edge.asset_id = assets.id
        )
    `).bind(
      input.importId,
      input.importId,
      recoveryOperationId,
      inspectionPayload,
    ),
    // Private FabuBlox consumers inherit ownership instead of causing early
    // publication. Pending imports have priority, followed by an unresolved
    // legacy failed import. A provider-unavailable inherited asset remains
    // failed, and the SQL finalization guard prevents that owner from becoming
    // ready until the asset is repaired.
    db.prepare(`
      WITH ranked_successors AS (
        SELECT edge.asset_id, edge.import_id, edge.import_status,
               ROW_NUMBER() OVER (
                 PARTITION BY edge.asset_id
                 ORDER BY CASE edge.import_status WHEN 'pending' THEN 0 ELSE 1 END,
                          edge.import_created_at, edge.import_id
               ) AS successor_rank
        FROM fabublox_recovery_import_asset_edges edge
        WHERE edge.import_id <> ?
      ),
      selected_successors AS (
        SELECT asset_id, import_id, import_status
        FROM ranked_successors
        WHERE successor_rank = 1
      ),
      preflight AS (
        SELECT json_extract(entry.value, '$.id') AS asset_id,
               json_extract(entry.value, '$.available') AS available,
               json_extract(entry.value, '$.canonicalAssetId') AS canonical_asset_id
        FROM json_each(?) entry
      )
      UPDATE assets
      SET import_id = (
            SELECT successor.import_id
            FROM selected_successors successor
            WHERE successor.asset_id = assets.id
          ),
          status = CASE
            WHEN COALESCE((
              SELECT preflight.available FROM preflight
              WHERE preflight.asset_id = assets.id
            ), 0) = 1
              AND (
                SELECT successor.import_status
                FROM selected_successors successor
                WHERE successor.asset_id = assets.id
              ) = 'pending'
            THEN 'pending'
            ELSE 'failed'
          END,
          sha256 = CASE
            WHEN COALESCE((
              SELECT preflight.available FROM preflight
              WHERE preflight.asset_id = assets.id
            ), 0) = 1
              AND (
                SELECT successor.import_status
                FROM selected_successors successor
                WHERE successor.asset_id = assets.id
              ) = 'pending'
            THEN sha256
            ELSE NULL
          END
      WHERE import_id = ?
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM fabublox_recovery_public_asset_edges public_edge
          WHERE public_edge.asset_id = assets.id
        )
        AND EXISTS (
          SELECT 1 FROM selected_successors successor
          WHERE successor.asset_id = assets.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM preflight
          WHERE preflight.asset_id = assets.id
            AND preflight.canonical_asset_id IS NOT NULL
        )
    `).bind(
      input.importId,
      inspectionPayload,
      input.importId,
      input.importId,
      recoveryOperationId,
    ),
    // Assets with neither a public consumer nor a viable unresolved import
    // owner are released by this failed import. Physical GC still consults the
    // broader retention view, so a historical edge can defer deletion without
    // accidentally making the asset public.
    db.prepare(`
      UPDATE assets
      SET status = 'failed', sha256 = NULL
      WHERE import_id = ?
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM fabublox_recovery_public_asset_edges public_edge
          WHERE public_edge.asset_id = assets.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM fabublox_recovery_import_asset_edges private_edge
          WHERE private_edge.asset_id = assets.id
            AND private_edge.import_id <> ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) entry
          WHERE json_extract(entry.value, '$.id') = assets.id
            AND json_extract(entry.value, '$.canonicalAssetId') IS NOT NULL
        )
    `).bind(
      input.importId,
      input.importId,
      recoveryOperationId,
      input.importId,
      inspectionPayload,
    ),
    // A prior interrupted cleanup may already have marked a retained locator
    // orphaned. Release only the unclaimed state; deleting/deleted claims remain
    // terminal and are never revived.
    db.prepare(`
      DELETE FROM blob_gc_ledger
      WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
        AND object_key IN (
          SELECT a.r2_key
          FROM assets a
          JOIN json_each(?) entry
            ON json_extract(entry.value, '$.id') = a.id
          WHERE EXISTS (
            SELECT 1 FROM blob_retention_edges bre
            WHERE bre.store_kind = 'r2' AND bre.provider = 'r2'
              AND bre.object_key = a.r2_key
          )
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
    // Queue only failed-import assets that have no remaining physical edge.
    // Deletion rechecks the same retention view before claiming.
    db.prepare(`
      INSERT INTO blob_gc_ledger (
        store_kind, provider, object_key, blob_record_id, state, operation_id,
        orphaned_at, deletion_started_at, deleted_at,
        attempt_count, last_error, updated_at
      )
      SELECT 'r2', 'r2', a.r2_key, a.id, 'orphaned', ?,
             a.created_at, NULL, NULL, 0, NULL, ?
      FROM assets a
      WHERE a.import_id = ? AND a.status = 'failed'
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_retention_edges bre
          WHERE bre.store_kind = 'r2' AND bre.provider = 'r2'
            AND bre.object_key = a.r2_key
        )
      ON CONFLICT(store_kind, provider, object_key) DO UPDATE SET
        blob_record_id = excluded.blob_record_id,
        operation_id = excluded.operation_id,
        orphaned_at = COALESCE(blob_gc_ledger.orphaned_at, excluded.orphaned_at),
        deletion_started_at = NULL,
        deleted_at = NULL,
        last_error = NULL,
        updated_at = excluded.updated_at
      WHERE blob_gc_ledger.state = 'orphaned'
    `).bind(
      recoveryOperationId,
      timestamp,
      input.importId,
      input.importId,
      recoveryOperationId,
    ),
  ]);

  if (!Number(results[0].meta.changes ?? 0)) return emptyCleanupResult();
  const relationshipResultIndexes = [2, 3, 4];
  return {
    importsFailed: Number(results[0].meta.changes ?? 0),
    relationshipsRemoved: relationshipResultIndexes.reduce(
      (total, index) => total + Number(results[index].meta.changes ?? 0),
      0,
    ),
    templateStepsRemoved: Number(results[5].meta.changes ?? 0),
    templatesQuarantined: Number(results[6].meta.changes ?? 0),
    assetsReleased:
      Number(results[22].meta.changes ?? 0)
      + Number(results[25].meta.changes ?? 0)
      + Number(results[27].meta.changes ?? 0),
    objectsQueued: Number(results[29].meta.changes ?? 0),
  };
}

export async function reapStaleFabubloxImports(env: Env, now = new Date()) {
  const timestamp = now.toISOString();
  const legacyCutoff = new Date(now.getTime() - FABUBLOX_IMPORT_LEASE_MS).toISOString();
  const rows = await primaryD1(env.DB).prepare(`
    SELECT candidate.id, candidate.operation_id, candidate.status
    FROM imports candidate
    WHERE candidate.operation_id IS NOT NULL
      AND candidate.finalization_id IS NULL
      AND (
        (
          candidate.status = 'pending'
          AND (
            candidate.lease_expires_at <= ?
            OR (candidate.lease_expires_at IS NULL AND candidate.created_at <= ?)
          )
        )
        OR (
          candidate.status = 'failed'
          AND candidate.recovery_operation_id IS NULL
          AND (
            candidate.template_version_id IS NOT NULL
            OR candidate.workbook_asset_key IS NOT NULL
            OR candidate.manifest_asset_key IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM assets a WHERE a.import_id = candidate.id
            )
          )
        )
      )
    ORDER BY CASE candidate.status WHEN 'failed' THEN 0 ELSE 1 END,
             COALESCE(candidate.lease_expires_at, candidate.completed_at, candidate.created_at),
             candidate.id
    LIMIT ?
  `).bind(timestamp, legacyCutoff, STALE_IMPORT_BATCH_SIZE).all<{
    id: string;
    operation_id: string;
    status: "pending" | "failed";
  }>();

  let staleImportsFailed = 0;
  let staleImportAssetsReleased = 0;
  let staleImportObjectsQueued = 0;
  let staleImportRecoveryFailures = 0;
  for (const row of rows.results) {
    try {
      const result = await queueFabubloxImportCleanup(env, {
        importId: row.id,
        operationId: row.operation_id,
        error: new Error(row.status === "pending"
          ? "FabuBlox import lease expired before finalization"
          : "Resuming cleanup for a legacy failed FabuBlox import"),
        now,
      });
      staleImportsFailed += result.importsFailed;
      staleImportAssetsReleased += result.assetsReleased;
      staleImportObjectsQueued += result.objectsQueued;
    } catch (error) {
      staleImportRecoveryFailures += 1;
      console.error("Could not recover stale FabuBlox import", row.id, error);
    }
  }
  return {
    staleImportsFailed,
    staleImportAssetsReleased,
    staleImportObjectsQueued,
    staleImportRecoveryFailures,
  };
}
