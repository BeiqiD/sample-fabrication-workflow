import { HTTPException } from "hono/http-exception";
import { hashStateRepresentation, stableJson, STATE_HASH_SCHEME } from "../shared/content-addressing";
import { CURRENT_SAMPLE_STRUCTURE_SQL } from "./sample-structure-query";
import { publishedAssetSql } from "./template-publication";

export type SplitExecutionAsset = {
  occurrenceId: string;
  assetId: string;
  r2_key: string;
  sha256: string;
  position: number;
};

type SplitStructure = {
  stepId: string | null;
  sourceStateHash: string | null;
  stateHash: string | null;
  executionAssets: SplitExecutionAsset[];
};

export async function prepareSplitInheritedState(
  db: D1Database,
  parentId: string,
  expectedUpdatedAt: string,
  structure: SplitStructure,
  now: string,
) {
  const execution = structure.executionAssets;
  if (execution.some((asset) => !/^[a-f0-9]{64}$/i.test(asset.sha256))) {
    throw new HTTPException(409, { message: "The current structure images need verified identities before splitting." });
  }
  const source = structure.stepId !== null || structure.sourceStateHash !== null
    ? [structure.stepId, structure.sourceStateHash] : [];
  // The same source-selection query is used for the initial read and every
  // guarded write, including changes that do not advance samples.updated_at.
  const sourceGuard = `
    EXISTS (SELECT 1 FROM samples parent
      WHERE parent.id = ? AND parent.updated_at = ? AND parent.deleted_at IS NULL)
    AND COALESCE((SELECT json_array(step_id, state_hash)
      FROM (${CURRENT_SAMPLE_STRUCTURE_SQL})), '[]') = ?
    AND (SELECT json_group_array(json_array(occurrence_id, asset_id, sha256, r2_key, position))
      FROM (
        SELECT rsa.id AS occurrence_id, a.id AS asset_id, a.sha256, a.r2_key, rsa.position
        FROM run_step_assets rsa JOIN assets a ON a.id = rsa.asset_id AND a.status = 'ready'
        WHERE rsa.run_step_id = ? AND rsa.role = 'execution' AND rsa.deleted_at IS NULL
        ORDER BY rsa.position, a.id
      )) = ?
    AND NOT EXISTS (
      SELECT 1 FROM run_step_assets rsa JOIN assets a ON a.id = rsa.asset_id
      WHERE rsa.run_step_id = ? AND rsa.role = 'execution' AND rsa.deleted_at IS NULL
        AND a.status = 'ready' AND (
          NOT (${publishedAssetSql("a")})
          OR EXISTS (SELECT 1 FROM blob_gc_ledger bg
            WHERE bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
              AND bg.state IN ('deleting', 'deleted'))
          OR EXISTS (SELECT 1 FROM blob_integrity_quarantine biq
            WHERE biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key)
        )
    )`;
  const sourceBindings = [
    parentId, expectedUpdatedAt, parentId, parentId, parentId, JSON.stringify(source),
    structure.stepId, JSON.stringify(execution.map((asset) => [
      asset.occurrenceId, asset.assetId, asset.sha256, asset.r2_key, asset.position,
    ])), structure.stepId,
  ];
  if (!execution.length) return {
    stateHash: structure.stateHash, statements: [] as D1PreparedStatement[],
    guardSql: sourceGuard, guardBindings: sourceBindings,
  };

  // Use the existing persistent diagram scheme; execution-assets:* is only a
  // comparison token and is never a valid inherited-state foreign key.
  const state = await hashStateRepresentation(execution.map((asset) => asset.sha256));
  const canonical = stableJson(state.canonical);
  const canonicalGuard = `EXISTS (SELECT 1 FROM state_representations
    WHERE hash = ? AND hash_scheme = ? AND representation_type = 'diagram' AND content_json = ?)`;
  const canonicalBindings = [state.hash, STATE_HASH_SCHEME, canonical];
  const representationGuard = `${canonicalGuard}
    AND (SELECT count(*) FROM state_representation_assets WHERE state_hash = ?) = ?
    AND (SELECT json_group_array(sha256) FROM (
      SELECT a.sha256 FROM state_representation_assets sra JOIN assets a ON a.id = sra.asset_id
      WHERE sra.state_hash = ? AND a.status = 'ready' AND ${publishedAssetSql("a")}
        AND NOT EXISTS (SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted'))
        AND NOT EXISTS (SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key)
      ORDER BY sra.position, a.id
    )) = ?`;
  const representationBindings = [...canonicalBindings, state.hash, execution.length, state.hash,
    JSON.stringify(execution.map((asset) => asset.sha256))];
  const existing = await db.prepare(`SELECT (${representationGuard}) AS valid
    FROM state_representations WHERE hash = ?`).bind(...representationBindings, state.hash).first<{ valid: number }>();
  if (existing && !existing.valid) {
    throw new HTTPException(409, { message: "The recorded structure is inconsistent. Resolve it before splitting." });
  }
  const statements = [
    db.prepare(`INSERT OR IGNORE INTO state_representations
      (hash, hash_scheme, representation_type, content_json, created_at)
      SELECT ?, ?, 'diagram', ?, ? WHERE ${sourceGuard}`)
      .bind(state.hash, STATE_HASH_SCHEME, canonical, now, ...sourceBindings),
    // These statements must remain adjacent in the same D1 batch. changes()
    // identifies a state created by the preceding INSERT, so a raced existing
    // empty representation cannot be silently repaired by this split.
    // One INSERT owns the whole ordered mapping, including all image positions.
    db.prepare(`INSERT INTO state_representation_assets (state_hash, asset_id, position)
      SELECT ?, value, CAST(key AS INTEGER) FROM json_each(?)
      WHERE changes() = 1 AND ${sourceGuard} AND ${canonicalGuard}
        AND NOT EXISTS (SELECT 1 FROM state_representation_assets WHERE state_hash = ?)`)
      .bind(state.hash, JSON.stringify(execution.map((asset) => asset.assetId)),
        ...sourceBindings, ...canonicalBindings, state.hash),
  ];
  return {
    stateHash: state.hash,
    statements,
    // A conflicting or partial existing representation must never be rewritten
    // or accepted as the child's immutable structure snapshot.
    guardSql: `${sourceGuard} AND ${representationGuard}`,
    guardBindings: [...sourceBindings, ...representationBindings],
  };
}
