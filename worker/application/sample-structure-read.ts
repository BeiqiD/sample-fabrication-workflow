import { nativeAssetUrl } from "../../shared/contracts/r2-upload";
import { sha256Hex, stableJson } from "../../shared/content-addressing";
import { CURRENT_SAMPLE_STRUCTURE_SQL } from "../sample-structure-query";
import { readSqlFileAuthorityMode } from "../files/authority-mode";
import type { FileAssetMediaRef } from "../../shared/types";
import { publishedAssetSql } from "../template-publication";
import type { ReadSqlDatabase } from "../runtime/read-sql";
import { structureExecutionAssetRow, structureSourceRow, structureStateAssetRow } from "./structure-read-decoding";

export type StructureExecutionAsset = {
  occurrenceId: string; assetId: string; r2_key: string | null;
  file_id?: string | null; sha256: string; position: number;
};
export interface SampleStructureReadCapabilities {
  database(): ReadSqlDatabase;
  /** Fresh actual primary owner; not provider or byte authority. */
  authorityDatabase(): ReadSqlDatabase;
}

// Shared read model for Sample split and Execution start/plan operations.
export type SampleStructureState = {
  sourceStateHash: string | null;
  executionAssets: StructureExecutionAsset[];
  stepId: string | null;
  stateHash: string | null;
  stepTitle: string | null;
  imageKeys: string[];
  images?: FileAssetMediaRef[];
  imageHashes: string[];
};

export async function stateAssetsSql(capabilities: SampleStructureReadCapabilities, stateHash: string | null) {
  if (!stateHash) return [];
  const db = capabilities.database();
  const active = await readSqlFileAuthorityMode(capabilities.authorityDatabase) === "active";
  const rows = await db.prepare(
    `SELECT a.r2_key, a.sha256, a.id assetId, ${active ? 'sra.file_id' : 'NULL'} file_id
     FROM state_representation_assets sra
     JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
     WHERE sra.state_hash = ?
       AND ${publishedAssetSql("a")}
     ORDER BY sra.position, a.id`,
  ).bind(stateHash).all();
  return rows.results.map(structureStateAssetRow);
}

export async function loadCurrentSampleStructureSql(capabilities: SampleStructureReadCapabilities, sampleId: string): Promise<SampleStructureState> {
  const db = capabilities.database();
  const row = await db.prepare(
    CURRENT_SAMPLE_STRUCTURE_SQL,
  ).bind(sampleId, sampleId, sampleId).first();
  const source = row === null ? null : structureSourceRow(row);
  const active = await readSqlFileAuthorityMode(capabilities.authorityDatabase) === "active";
  const executionRows = source?.step_id ? await db.prepare(
    `SELECT rsa.id AS occurrenceId, a.id AS assetId, a.r2_key, a.sha256, rsa.position, ${active ? 'rsa.file_id' : 'NULL'} file_id
     FROM run_step_assets rsa
     JOIN assets a ON a.id = rsa.asset_id AND a.status = 'ready'
     WHERE rsa.run_step_id = ? AND rsa.role = 'execution' AND rsa.deleted_at IS NULL
     ORDER BY rsa.position, a.id`,
  ).bind(source.step_id).all() : { results: [] };
  const executionAssets = executionRows.results.map(structureExecutionAssetRow);
  const assets = executionAssets.length
    ? executionAssets
    : await stateAssetsSql(capabilities, source?.state_hash ?? null);
  const stateHash = executionAssets.length
    ? `execution-assets:${await sha256Hex(stableJson(executionAssets.map((asset) => asset.sha256)))}`
    : source?.state_hash ?? null;
  return {
    sourceStateHash: source?.state_hash ?? null,
    executionAssets: executionAssets,
    stepId: source?.step_id ?? null,
    stateHash,
    stepTitle: source?.step_title ?? null,
    imageKeys: assets.flatMap(asset => asset.r2_key === null ? [] : [asset.r2_key]),
    ...(assets.some(asset => asset.r2_key === null) ? { images: assets.flatMap(asset => asset.r2_key === null
      ? [{ assetId: asset.assetId, fileId: asset.file_id ?? null, url: nativeAssetUrl(asset.assetId) }] : []) } : {}),
    imageHashes: assets.map((asset) => asset.sha256),
  };
}

export async function stateImageKeysSql(capabilities: SampleStructureReadCapabilities, stateHash: string | null) {
  return (await stateAssetsSql(capabilities, stateHash)).flatMap(row => row.r2_key === null ? [] : [row.r2_key]);
}
