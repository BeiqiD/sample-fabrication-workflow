import { snapshotFullExportV24 } from "../export-v24-snapshot";
import { primaryD1 } from "../d1-primary";
import type { Env } from "../types";
import { RECOVERY_SCHEMA_SHA256, RECOVERY_TABLES } from "../../shared/contracts/system-recovery-catalog";
import { RECOVERY_MIGRATIONS, RECOVERY_SCHEMA_STATEMENTS } from "./trusted-schema";
import { recoveryTableSnapshotSql, validateSystemRecoveryImage, type SystemRecoveryImageV1 } from "../../shared/contracts/system-recovery-image";
import { SYSTEM_BACKUP_RECORDS_SCHEMA, SYSTEM_BACKUP_MAX_RECORDS_BYTES, planSystemBackupSources, sourceBackupCheckpoint,
  systemBackupProtectedConfiguration, validateSystemBackupContentImage, validateSystemBackupMigrationLedger,
  type SystemBackupRecordsV1, type SystemBackupMigrationLedger } from "../../shared/contracts/system-backup";
import { stableJson } from "../../shared/domain/content-addressing";
import { canonicalFileAuthoritySchemaSql } from "../../shared/contracts/export-file-authority";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const tables = RECOVERY_TABLES.filter(table => !table.local);
/** Bound the complete image BEFORE selecting any rows. Escaping can expand a
 * source byte at most sixfold; typed cell/key overhead is counted explicitly. */
function balancedSum(terms: string[]): string {
  if (terms.length === 1) return terms[0];
  const split = Math.floor(terms.length / 2);
  return `(${balancedSum(terms.slice(0, split))}+${balancedSum(terms.slice(split))})`;
}
const sourceRowCount = balancedSum(tables.map(table => `(SELECT count(*) FROM ${quote(table.name)})`));
const sourceMetadataSize = balancedSum(tables.map(table => `(SELECT COALESCE(sum(${balancedSum([
  String(512 + table.columns.length * 80), ...table.columns.map(column => `COALESCE(length(CAST(${quote(column)} AS BLOB)),0)*6`),
])}),0) FROM ${quote(table.name)})`));
// Independent scalar aggregates avoid D1's compound-SELECT compiler budget
// altogether. CASE rejects an oversized row count before scanning cell bytes.
export const SYSTEM_BACKUP_SNAPSHOT_BUDGET_SQL = `SELECT CASE WHEN (${sourceRowCount})>16384 THEN json('System backup snapshot budget exceeded')
  WHEN (${sourceMetadataSize})>${4 * 1024 * 1024} THEN json('System backup snapshot budget exceeded') ELSE 1 END`;

export interface CaptureSystemBackupOptions { backupId: string; createdAt?: string; acquireHolds?: boolean }
export const SYSTEM_BACKUP_SCHEMA_AUDIT_SQL = "SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name";
const protectedPlatformDdl: Record<string, string> = {
  _cf_KV: "CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID",
  _cf_METADATA: "CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB)",
};
function platformDdlTokens(sql: string) {
  const tokens = sql.match(/[A-Za-z_][A-Za-z0-9_]*|[(),;]/g) ?? [];
  if (tokens.join("") !== sql.replace(/[\t\n\f\r ]/g, "")) return null;
  if (tokens.at(-1) === ";") tokens.pop();
  return tokens.map(token => token.toLowerCase());
}
/** Exact engine-owned platform definitions cannot mask custom tables or
 * attached application triggers/indexes. No prefix is an omission rule. */
export function reviewedSystemBackupSourceSchema(objects: Record<string, unknown>[]) {
  return objects.filter(object => {
    if (object.name === "d1_migrations") {
      if (object.type !== "table" || object.tableName !== "d1_migrations") throw new Error("System backup platform migration ledger object is invalid");
      return false;
    }
    if (typeof object.name !== "string" || !Object.hasOwn(protectedPlatformDdl, object.name)) return true;
    if (object.type !== "table" || object.tableName !== object.name || typeof object.sql !== "string"
      || stableJson(platformDdlTokens(object.sql)) !== stableJson(platformDdlTokens(protectedPlatformDdl[object.name])))
      throw new Error("System backup protected platform DDL is invalid");
    return false;
  });
}
const normalizedReviewedSchema = RECOVERY_SCHEMA_STATEMENTS.map(statement => ({ ...statement,
  sql: canonicalFileAuthoritySchemaSql(statement.sql) }));
const MIGRATION_LEDGER_BUDGET_SQL = `SELECT iif(count(*)<=256 AND COALESCE(sum(length(CAST(id AS TEXT))+length(CAST(name AS BLOB))*6+COALESCE(length(CAST(applied_at AS BLOB)),0)*6+256),0)<=65536,1,json('System backup migration ledger budget exceeded')) FROM d1_migrations`;
/** Code-owned holds cover physical locations even when a mutable active pointer
 * moves during this historical backup. They are installed in the same primary
 * batch as the frozen data, before any source query executes. */
export function installSystemBackupHolds(db: D1Database, backupId: string, now: string): D1PreparedStatement[] {
  return [db.prepare(`INSERT INTO system_recovery_legacy_holds(job_id,store_kind,provider,object_key)
    SELECT ?,store_kind,provider,object_key FROM (
      SELECT store_kind,provider,object_key FROM blob_retention_edges
      UNION SELECT 'r2','r2',r2_key FROM assets WHERE r2_key IS NOT NULL
      UNION SELECT 'managed',provider,object_key FROM managed_storage_objects
      UNION SELECT 'r2','r2',workbook_asset_key FROM imports WHERE workbook_asset_key IS NOT NULL
      UNION SELECT 'r2','r2',manifest_asset_key FROM imports WHERE manifest_asset_key IS NOT NULL
      UNION SELECT 'r2','r2',source_asset_key FROM template_versions WHERE source_asset_key IS NOT NULL
      UNION SELECT 'r2','r2',asset_key FROM events WHERE asset_key IS NOT NULL
    ) sources WHERE NOT EXISTS(SELECT 1 FROM system_recovery_legacy_holds h WHERE h.job_id=?
      AND h.store_kind=sources.store_kind AND h.provider=sources.provider AND h.object_key=sources.object_key)
      AND NOT EXISTS(SELECT 1 FROM blob_gc_ledger gc WHERE gc.store_kind=sources.store_kind AND gc.provider=sources.provider
        AND gc.object_key=sources.object_key AND gc.state IN('deleting','deleted'))
      AND NOT EXISTS(SELECT 1 FROM file_shadow_legacy_deletion_claims gc WHERE gc.store_kind=sources.store_kind
        AND gc.provider=sources.provider AND gc.object_key=sources.object_key)
      AND NOT EXISTS(SELECT 1 FROM legacy_file_mappings m JOIN file_location_gc_ledger gc ON gc.location_id=m.location_id
        WHERE gc.state IN('deleting','deleted') AND m.store_kind=sources.store_kind
          AND m.provider=sources.provider AND m.object_key=sources.object_key)`)
    .bind(backupId, backupId),
  db.prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at)
    SELECT 'fp5_'||lower(hex(randomblob(16))),l.location_id,'export',?,'Frozen system backup source',?
    FROM file_location_publications l JOIN file_location_availability a ON a.location_id=l.location_id
    WHERE a.availability='available' AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
      AND NOT EXISTS(SELECT 1 FROM file_location_gc_ledger gc WHERE gc.location_id=l.location_id AND gc.state IN('deleting','deleted'))
      AND NOT EXISTS(SELECT 1 FROM file_location_holds h WHERE h.location_id=l.location_id AND h.operation_id=?)`)
    .bind(`fp5-backup:${backupId}`, now, `fp5-backup:${backupId}`)];
}
/** Interception retains the versioned content reader unchanged. Its canonical
 * queries, native clock/schema/rowids, and exact privileged typed image all
 * execute in ONE fresh-primary D1 batch. No later live query builds this image. */
export async function captureSystemBackupSnapshot(database: D1Database, options: CaptureSystemBackupOptions): Promise<SystemBackupRecordsV1> {
  const db = primaryD1(database), createdAt = options.createdAt ?? new Date().toISOString();
  let captured: Array<D1Result<Record<string, unknown>>> | undefined;
  let sourceMigrationLedger: SystemBackupMigrationLedger = { status: "unavailable", entries: [] };
  // Only platform table presence and its fixed column names are inspected
  // outside the atomic snapshot. Receipt values are read in that batch.
  const ledgerExists = await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='d1_migrations'").first<{ name: string }>();
  if (ledgerExists) {
    const columns = await db.prepare("PRAGMA table_info('d1_migrations')").all<{ name: string }>();
    if (!columns.success || stableJson(columns.results.map(column => column.name).sort()) !== stableJson(["id", "name", "applied_at"].sort()))
      throw new Error("System backup source migration ledger schema is unsupported");
  }
  let batches = 0;
  const wrapper = {
    prepare(sql: string) { return db.prepare(sql); },
    withSession() { return wrapper; },
    async batch(statements: D1PreparedStatement[]) {
      if (++batches !== 1) throw new Error("System backup requires one exact source snapshot");
      const holds = options.acquireHolds === false ? [] : installSystemBackupHolds(db as D1Database, options.backupId, createdAt);
      const fence = options.acquireHolds === false ? [] : [db.prepare(`SELECT iif(NOT EXISTS(SELECT 1 FROM system_recovery_maintenance
        WHERE singleton=1 AND state='fenced' AND checkpoint_sha256 IS NOT NULL AND backup_job_id IS NOT ?),1,
        json('Source checkpoint forbids another backup hold owner'))`).bind(options.backupId)];
      // The first guard bounds source work before INSERT SELECT. The second
      // includes new canonical own holds before materializing any rows; D1
      // atomically rolls those holds back if the resulting image is too large.
      const prefix = [...fence, db.prepare(SYSTEM_BACKUP_SNAPSHOT_BUDGET_SQL),
        ...(ledgerExists ? [db.prepare(MIGRATION_LEDGER_BUDGET_SQL)] : []), ...holds,
        ...(holds.length ? [db.prepare(SYSTEM_BACKUP_SNAPSHOT_BUDGET_SQL)] : [])];
      const suffix = [...tables.map(table => db.prepare(recoveryTableSnapshotSql(table))), db.prepare(SYSTEM_BACKUP_SCHEMA_AUDIT_SQL),
        ...(ledgerExists ? [db.prepare("SELECT CAST(id AS TEXT) AS id,name,applied_at AS appliedAt FROM d1_migrations ORDER BY d1_migrations.id")] : [])];
      const result = await db.batch([...prefix, ...statements, ...suffix]);
      if (result.some(item => !item.success)) throw new Error("System backup snapshot was incomplete");
      const suffixIndex = prefix.length + statements.length;
      const observedSchema = reviewedSystemBackupSourceSchema(result[suffixIndex + tables.length].results as Record<string, unknown>[])
        .map(statement => ({ ...statement, sql: canonicalFileAuthoritySchemaSql(String(statement.sql)) }));
      if (stableJson(observedSchema) !== stableJson(normalizedReviewedSchema))
        throw new Error("System backup source schema differs from the reviewed recovery catalog");
      if (ledgerExists) sourceMigrationLedger = validateSystemBackupMigrationLedger({ status: "observed", entries:
        (result[suffixIndex + tables.length + 1].results as Array<{ id: unknown; name: unknown; appliedAt: unknown }>).map(row => ({ id: row.id, name: row.name, appliedAt: row.appliedAt,
          rawSha256: RECOVERY_MIGRATIONS.find(migration => migration.name === row.name)?.sha256 ?? null })) });
      captured = result.slice(suffixIndex, suffixIndex + tables.length) as Array<D1Result<Record<string, unknown>>>;
      return result.slice(prefix.length, prefix.length + statements.length);
    },
  };
  const content = await snapshotFullExportV24(wrapper as unknown as D1Database, { backupHoldOwner: options.backupId });
  if (!captured || captured.length !== tables.length) throw new Error("System backup physical image is incomplete");
  const image = validateSystemRecoveryImage({ version: 1, kind: "system-recovery-image", schemaSha256: RECOVERY_SCHEMA_SHA256,
    sourceSnapshotClock: content.artifacts.sourceSchema.value.snapshotClock,
    tables: Object.fromEntries(tables.map((table, index) => [table.name, { columns: [...table.columns], rows: captured![index].results.map(row => ({
      rowid: row.rowid, cells: JSON.parse(String(row.cells)),
    })) }])) } as SystemRecoveryImageV1, { schemaSha256: RECOVERY_SCHEMA_SHA256, tables: RECOVERY_TABLES, maxMetadataBytes: SYSTEM_BACKUP_MAX_RECORDS_BYTES });
  await validateSystemBackupContentImage(content, image);
  const records: SystemBackupRecordsV1 = { schema: SYSTEM_BACKUP_RECORDS_SCHEMA, backupId: options.backupId, createdAt, content, image,
    protectedConfiguration: systemBackupProtectedConfiguration(image), sourceMigrationLedger,
    origin: { format: "native", schemaVersion: 24, archiveSha256: null, legacyArtifacts: null, migrationEvidence: [] } };
  planSystemBackupSources(content);
  if (new TextEncoder().encode(stableJson(records)).byteLength > SYSTEM_BACKUP_MAX_RECORDS_BYTES) throw new Error("system_backup_records_budget");
  return records;
}
export function snapshotSystemBackup(env: Pick<Env, "DB">, backupId: string, options: Omit<CaptureSystemBackupOptions, "backupId"> = {}) {
  return captureSystemBackupSnapshot(env.DB, { ...options, backupId });
}
export function recaptureSystemBackupSnapshot(env: Pick<Env, "DB">, backupId: string) {
  return captureSystemBackupSnapshot(env.DB, { backupId, acquireHolds: false });
}
export { sourceBackupCheckpoint };
