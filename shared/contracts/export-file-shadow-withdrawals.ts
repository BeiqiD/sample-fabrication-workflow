import type { ExportSchemaObject, ExportTables, FileShadowSourceRowids } from "./export";
import { stableJson } from "../domain/content-addressing";
import { sqliteTableColumns } from "../domain/sqlite-table-columns";
import { fileShadowSchemaFingerprint, validateFileShadowRows } from "./export-file-shadow";
import { checkedShadowWithdrawalRequest, FILE_SHADOW_WITHDRAWAL_EXPORT_COLUMNS, shadowWithdrawalRequestSha256 } from "./file-shadow-withdrawal";

// Independent V16 checkpoint. V15's reviewed fingerprint is never widened.
export const FILE_SHADOW_WITHDRAWAL_SCHEMA_FINGERPRINT_SHA256 = "53410c31bc29660cac3cf7e32918a4bf5d4b3001961ed2688071753795f66438";

function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Full export rejected: invalid File shadow withdrawal ${reason}`);
}

export async function validateFileShadowWithdrawalExport(tables: ExportTables, schemaObjects: ExportSchemaObject[], sourceRowids?: FileShadowSourceRowids) {
  ensure(await fileShadowSchemaFingerprint(schemaObjects) === FILE_SHADOW_WITHDRAWAL_SCHEMA_FINGERPRINT_SHA256, "schema fingerprint");
  await validateFileShadowRows(tables, schemaObjects, sourceRowids);
  await validateFileShadowWithdrawalRows(tables, schemaObjects);
}

/** Shared rows only: callers must authenticate their own exact schema checkpoint. */
export async function validateFileShadowWithdrawalRows(tables: ExportTables, schemaObjects: ExportSchemaObject[]) {
  for (const [name, columns] of Object.entries(FILE_SHADOW_WITHDRAWAL_EXPORT_COLUMNS)) {
    const schema = schemaObjects.find((entry) => entry.type === "table" && entry.name === name);
    ensure(schema && typeof schema.sql === "string" && stableJson(sqliteTableColumns(schema.sql, name).sort()) === stableJson([...columns].sort()), "schema columns");
    ensure(Array.isArray(tables[name]), "table inventory");
    const seen = new Set<string>();
    const operations = new Set(tables.file_shadow_operations.map((row) => row.id));
    for (const row of tables[name]) {
      ensure(stableJson(Object.keys(row).sort()) === stableJson([...columns].sort()), "row columns");
      ensure(typeof row.request_json === "string", "request JSON");
      let parsed: unknown;
      try { parsed = JSON.parse(row.request_json); } catch { throw new Error("Full export rejected: invalid File shadow withdrawal request JSON"); }
      const request = checkedShadowWithdrawalRequest(parsed);
      ensure(stableJson(request) === row.request_json && request.operationId === row.operation_id, "canonical request identity");
      ensure(await shadowWithdrawalRequestSha256(request) === row.request_sha256, "request digest");
      ensure(!seen.has(request.operationId) && !operations.has(request.operationId), "operation exclusion");
      ensure(typeof row.created_by === "string" && row.created_by.length > 0 && row.created_by.length <= 256 && !row.created_by.includes("\0")
        && typeof row.created_at === "string" && row.created_at.length <= 200 && !row.created_at.includes("\0")
        && Number.isFinite(Date.parse(row.created_at)), "receipt metadata");
      seen.add(request.operationId);
    }
  }
}
