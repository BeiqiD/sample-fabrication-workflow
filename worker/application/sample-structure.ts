import { sha256Hex, stableJson } from "../../shared/content-addressing";
import { CURRENT_SAMPLE_STRUCTURE_SQL } from "../sample-structure-query";
import type { SplitExecutionAsset } from "../sample-split-state";
import { publishedAssetSql } from "../template-publication";

// Shared read model for Sample split and Execution start/plan operations.
export type SampleStructureState = {
  sourceStateHash: string | null;
  executionAssets: SplitExecutionAsset[];
  stepId: string | null;
  stateHash: string | null;
  stepTitle: string | null;
  imageKeys: string[];
  imageHashes: string[];
};

export async function stateAssets(db: D1Database, stateHash: string | null) {
  if (!stateHash) return [];
  const rows = await db.prepare(
    `SELECT a.r2_key, a.sha256
     FROM state_representation_assets sra
     JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
     WHERE sra.state_hash = ?
       AND ${publishedAssetSql("a")}
     ORDER BY sra.position, a.id`,
  ).bind(stateHash).all<{ r2_key: string; sha256: string }>();
  return rows.results;
}

export async function loadCurrentSampleStructure(db: D1Database, sampleId: string): Promise<SampleStructureState> {
  const row = await db.prepare(
    CURRENT_SAMPLE_STRUCTURE_SQL,
  ).bind(sampleId, sampleId, sampleId).first<{ step_id: string | null; state_hash: string | null; step_title: string | null }>();
  const executionAssets = row?.step_id ? await db.prepare(
    `SELECT rsa.id AS occurrenceId, a.id AS assetId, a.r2_key, a.sha256, rsa.position
     FROM run_step_assets rsa
     JOIN assets a ON a.id = rsa.asset_id AND a.status = 'ready'
     WHERE rsa.run_step_id = ? AND rsa.role = 'execution' AND rsa.deleted_at IS NULL
     ORDER BY rsa.position, a.id`,
  ).bind(row.step_id).all<SplitExecutionAsset>() : { results: [] };
  const assets = executionAssets.results.length
    ? executionAssets.results
    : await stateAssets(db, row?.state_hash ?? null);
  const stateHash = executionAssets.results.length
    ? `execution-assets:${await sha256Hex(stableJson(executionAssets.results.map((asset) => asset.sha256)))}`
    : row?.state_hash ?? null;
  return {
    sourceStateHash: row?.state_hash ?? null,
    executionAssets: executionAssets.results,
    stepId: row?.step_id ?? null,
    stateHash,
    stepTitle: row?.step_title ?? null,
    imageKeys: assets.map((asset) => asset.r2_key),
    imageHashes: assets.map((asset) => asset.sha256),
  };
}

export async function stateImageKeys(db: D1Database, stateHash: string | null) {
  return (await stateAssets(db, stateHash)).map((row) => row.r2_key);
}
