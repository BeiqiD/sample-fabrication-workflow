import { primaryD1 } from "../d1-primary";
import { buildFullExportV26FromSnapshot, nativeV26SnapshotSql, type NativeExportSnapshotResult } from "../export-v26-core";
import { type CaptureSystemBackupOptions } from "./backup-snapshot";
import { installPortableSystemBackupHolds } from "./portable-backup-holds";
import { inspectV26CloudflareSchema } from "./v26-cloudflare-schema";
import { recoveryTableSnapshotSql } from "../../shared/contracts/system-recovery-image";
import type { ExportSchemaObject } from "../../shared/contracts/export";
import { createFullExportV26, portableBusinessSchemaV26 } from "../../shared/contracts/export-portable-runtime-v26";
import { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, PORTABLE_RUNTIME_RECOVERY_TABLES,
  PORTABLE_RUNTIME_RECOVERY_MIGRATIONS } from "../../shared/contracts/portable-runtime-v26-recovery-catalog";
import { SYSTEM_BACKUP_MAX_RECORDS_BYTES } from "../../shared/contracts/system-backup";
import { SYSTEM_BACKUP_RECORDS_SCHEMA_V3, systemBackupProtectedConfigurationV3, protectedIdentityPolicy,
  validateCloudflareMigrationProvenanceV3, validateSystemBackupRecordsV3, type SystemBackupRecordsV3 } from "../../shared/contracts/system-backup-v3";
import { stableJson } from "../../shared/domain/content-addressing";

const tables = PORTABLE_RUNTIME_RECOVERY_TABLES.filter(table => !table.local);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function balancedSum(terms: string[]): string {
  if (terms.length === 1) return terms[0];
  const split = Math.floor(terms.length / 2);
  return `(${balancedSum(terms.slice(0, split))}+${balancedSum(terms.slice(split))})`;
}
const count = balancedSum(tables.map(table => `(SELECT count(*) FROM ${quote(table.name)})`));
const metadata = balancedSum(tables.map(table => `(SELECT COALESCE(sum(${balancedSum([
  String(512 + table.columns.length * 80), ...table.columns.map(column => `COALESCE(length(CAST(${quote(column)} AS BLOB)),0)*6`),
])}),0) FROM ${quote(table.name)})`));
export const CURRENT_SYSTEM_BACKUP_SNAPSHOT_BUDGET_SQL = `SELECT CASE WHEN (${count})>16384 THEN json('Current backup snapshot budget exceeded')
  WHEN (${metadata})>${4 * 1024 * 1024} THEN json('Current backup snapshot budget exceeded') ELSE 1 END`;
const ledgerBudget = `SELECT iif(count(*)<=256 AND COALESCE(sum(length(CAST(id AS TEXT))+length(CAST(name AS BLOB))*6+COALESCE(length(CAST(applied_at AS BLOB)),0)*6+256),0)<=65536,1,json('Current backup migration ledger budget exceeded')) FROM d1_migrations`;
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }

/** Real Cloudflare source capture. Every cell, receipt and observed schema is
 * frozen in one primary batch alongside the actual byte holds. No Node ledger,
 * environment adapter or archive-provided SQL is fabricated. The source schema
 * is checked again from that same batch before the image is admitted. */
export async function capturePortableV26SystemBackupSnapshot(database: D1Database, options: CaptureSystemBackupOptions): Promise<SystemBackupRecordsV3> {
  const db = primaryD1(database), createdAt = options.createdAt ?? new Date().toISOString();
  ensure(typeof options.backupId === "string" && options.backupId.length > 0 && options.backupId.length <= 128 && !options.backupId.includes("\0")
    && Number.isFinite(Date.parse(createdAt)) && new Date(createdAt).toISOString() === createdAt, "current_backup_identity");
  // Reject unreviewed current/platform DDL before installing byte holds. The
  // exact schema is still observed and checked again in the frozen batch.
  const preflight = await db.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name").all<ExportSchemaObject>();
  ensure(preflight.success, "current_backup_schema_unavailable");
  const platform = await inspectV26CloudflareSchema(preflight.results);
  // Presence decides only which fixed receipt query is safe to compile. Its DDL
  // and all platform-owned objects are admitted from the atomic observation.
  const ledgerPresent = platform.ledgerPresent;
  const holds = options.acquireHolds === false ? [] : installPortableSystemBackupHolds(db as D1Database, options.backupId, createdAt);
  const fence = options.acquireHolds === false ? [] : [db.prepare(`SELECT iif(NOT EXISTS(SELECT 1 FROM system_recovery_maintenance
    WHERE singleton=1 AND state='fenced' AND checkpoint_sha256 IS NOT NULL AND backup_job_id IS NOT ?),1,
    json('Source checkpoint forbids another backup hold owner'))`).bind(options.backupId)];
  const prefix = [...fence, db.prepare(CURRENT_SYSTEM_BACKUP_SNAPSHOT_BUDGET_SQL),
    ...(ledgerPresent ? [db.prepare(ledgerBudget)] : []), ...holds,
    ...(holds.length ? [db.prepare(CURRENT_SYSTEM_BACKUP_SNAPSHOT_BUDGET_SQL)] : [])];
  const contentSql = nativeV26SnapshotSql();
  const suffix = [...tables.map(table => db.prepare(recoveryTableSnapshotSql(table))),
    db.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name"),
    ...(ledgerPresent ? [db.prepare("SELECT CAST(id AS TEXT) AS id,name,applied_at AS appliedAt FROM d1_migrations ORDER BY d1_migrations.id")] : [])];
  const results = await db.batch([...prefix, ...contentSql.map(sql => db.prepare(sql)), ...suffix]);
  ensure(results.every(result => result.success), "current_backup_snapshot_incomplete");
  const at = prefix.length + contentSql.length;
  const observed = await inspectV26CloudflareSchema(results[at + tables.length].results as ExportSchemaObject[]);
  ensure(observed.ledgerPresent === ledgerPresent, "current_backup_platform_changed");
  const business = await buildFullExportV26FromSnapshot(results.slice(prefix.length, at) as NativeExportSnapshotResult[], {
    backupHoldOwner: options.backupId, projectSchema: () => portableBusinessSchemaV26(observed.applicationObjects),
  });
  const content = await createFullExportV26(business, observed.applicationObjects);
  const imageTables = Object.fromEntries(tables.map((spec, index) => [spec.name, { columns: [...spec.columns],
    rows: (results[at + index].results as Array<{ rowid: string | null; cells: string }>).map(row => ({ rowid: row.rowid, cells: JSON.parse(row.cells) })),
  }]));
  const sourceMigrationLedger = validateCloudflareMigrationProvenanceV3({ kind: "cloudflare-observed-migrations/1",
    status: ledgerPresent ? "observed" : "unavailable", entries: ledgerPresent
      ? (results[at + tables.length + 1].results as Array<{ id: string; name: string; appliedAt: string | null }>).map(row => ({
        ...row, rawSha256: PORTABLE_RUNTIME_RECOVERY_MIGRATIONS.find(migration => migration.name === row.name)?.sha256 ?? null,
      })) : [] });
  const records = await validateSystemBackupRecordsV3({ schema: SYSTEM_BACKUP_RECORDS_SCHEMA_V3, backupId: options.backupId, createdAt, content,
    image: { version: 3, kind: "system-recovery-image", checkpointId: PORTABLE_RUNTIME_CHECKPOINT_ID,
      schemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, sourceSnapshotClock: content.artifacts.sourceSchema.value.snapshotClock,
      tables: imageTables }, protectedIdentity: protectedIdentityPolicy(),
    protectedConfiguration: systemBackupProtectedConfigurationV3({ tables: imageTables }), sourceMigrationLedger,
    origin: { format: "native", schemaVersion: 26, capturePolicy: "atomic-primary-with-byte-holds/1" } });
  ensure(new TextEncoder().encode(stableJson(records)).byteLength <= SYSTEM_BACKUP_MAX_RECORDS_BYTES, "current_backup_records_budget");
  return records;
}
