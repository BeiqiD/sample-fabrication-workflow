import type { ReadSqlCell, ReadSqlRow } from "../runtime/read-sql";
function text(value: ReadSqlCell | undefined, field: string): string {
  if (typeof value !== "string") throw new TypeError(`Invalid structure SQL text: ${field}`);
  return value;
}
function nullableText(value: ReadSqlCell | undefined, field: string): string | null {
  return value === null ? null : text(value, field);
}
function position(value: ReadSqlCell | undefined, field: string): number {
  if (typeof value !== "number" && typeof value !== "bigint") throw new TypeError(`Invalid structure SQL position: ${field}`);
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(numeric) || typeof value === "bigint" && (!Number.isSafeInteger(numeric) || BigInt(numeric) !== value)
    || Number.isInteger(numeric) && !Number.isSafeInteger(numeric)) throw new RangeError(`Structure SQL position outside exact range: ${field}`);
  return numeric;
}
export function structureStateAssetRow(row: ReadSqlRow) {
  return { r2_key: nullableText(row.r2_key, "stateAsset.legacyKey"), sha256: text(row.sha256, "stateAsset.sha256"),
    assetId: text(row.assetId, "stateAsset.assetId"), file_id: nullableText(row.file_id, "stateAsset.fileId") };
}
export function structureExecutionAssetRow(row: ReadSqlRow) {
  return { ...structureStateAssetRow(row), occurrenceId: text(row.occurrenceId, "executionAsset.occurrenceId"),
    position: position(row.position, "executionAsset.position") };
}
export function structureSourceRow(row: ReadSqlRow) {
  return { step_id: nullableText(row.step_id, "structure.stepId"), state_hash: nullableText(row.state_hash, "structure.stateHash"),
    step_title: nullableText(row.step_title, "structure.stepTitle") };
}
