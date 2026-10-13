import type { DatabaseSync } from "node:sqlite";
import { stableJson } from "../../shared/domain/content-addressing.ts";
import { recoveryTableSnapshotSql, type RecoveryTableSpec, type SystemRecoveryTable } from "../../shared/contracts/system-recovery-image.ts";
import { PORTABLE_RUNTIME_RECOVERY_TABLES as tables, PORTABLE_RUNTIME_SCHEMA_STATEMENTS as schema,
  PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, PORTABLE_RUNTIME_SEED_TABLE_ROWS as seeds } from "../../worker/recovery/portable-runtime-v28-trusted-schema.ts";
import type { SystemBackupRecordsV5, SystemBackupManifestV5 } from "../../shared/contracts/system-backup-v5.ts";
import { disabledProtectedAccountTable } from "./restore-v28-candidate.ts";
import { admitInstallationRecoverySource } from "../migrations.ts";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate.ts";
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function ensure(value: unknown): asserts value { if (!value) throw new Error("target_unavailable"); }
export function nodeV28TargetReadTable(native: DatabaseSync, spec: RecoveryTableSpec): SystemRecoveryTable {
  const rows = native.prepare(recoveryTableSnapshotSql(spec)).all() as Array<{ rowid: string | null; cells: string }>;
  return { columns: [...spec.columns], rows: rows.map(row => ({ rowid: row.rowid, cells: JSON.parse(row.cells) })) };
}
export function nodeV28TargetEqual(left: SystemRecoveryTable, right: SystemRecoveryTable): boolean {
  return stableJson(left.columns) === stableJson(right.columns)
    && stableJson(left.rows.map(stableJson).sort()) === stableJson(right.rows.map(stableJson).sort());
}
export function nodeV28TargetImageTable(records: SystemBackupRecordsV5, name: string): SystemRecoveryTable {
  const value = records.image.tables[name]; ensure(value);
  return name === "local_accounts" ? disabledProtectedAccountTable(value) : value;
}
/** Actual Native V28/catalog/cell proof. All source-local authority tables are
 * seed/inert; only the explicit account-disabled policy differs in historical
 * typed cells. Source SQL never supplies target DDL or migration authority. */
export function verifyNodeV28InertTarget(native: DatabaseSync, records: SystemBackupRecordsV5,
  manifest: SystemBackupManifestV5, guard: () => void): { installationId: string; originalRows: number; disabledAccountCells: number } {
  guard();
  const observed = native.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND tbl_name NOT IN('node_installation','node_migrations') ORDER BY type,name").all();
  ensure(stableJson(observed) === stableJson(schema));
  let originalRows = 0;
  for (const spec of tables.filter(value => !value.local)) {
    guard(); const expected = nodeV28TargetImageTable(records, spec.name);
    ensure(nodeV28TargetEqual(nodeV28TargetReadTable(native, spec), expected)); originalRows += expected.rows.length;
  }
  guard(); ensure(native.prepare("PRAGMA foreign_key_check").all().length === 0);
  guard(); ensure(native.prepare("PRAGMA integrity_check").all().every(row => Object.values(row)[0] === "ok"));
  for (const name of ["file_shadow_runtime_guard", "file_authority_runtime_guard", "file_job_runtime_guard", "system_recovery_runtime"])
    ensure(native.prepare(`SELECT enabled FROM ${quote(name)} WHERE singleton=1`).get()?.enabled === 0);
  ensure(native.prepare("SELECT state FROM system_recovery_maintenance WHERE singleton=1").get()?.state === "fenced");
  ensure(native.prepare("SELECT schema_version,enforcement,revision FROM collaboration_control WHERE singleton=1").get()?.schema_version === 2
    && native.prepare("SELECT enforcement FROM collaboration_control WHERE singleton=1").get()?.enforcement === "disabled"
    && native.prepare("SELECT revision FROM collaboration_control WHERE singleton=1").get()?.revision === 1);
  for (const name of ["system_storage_native_bindings", "file_job_cleanup_grants", "system_research_package_cleanup_grants", "file_shadow_runtime_incarnations",
    "system_recovery_jobs", "system_recovery_write_leases", "system_recovery_target_claim", "system_recovery_target_files",
    "local_identity_installation", "local_admin_grants", "local_sessions", "local_login_throttle", "local_storage_profile_checks",
    "local_storage_profile_admissions", "local_storage_profile_bindings", "collaboration_members", "collaboration_identities", "collaboration_resources", "collaboration_grants"])
    ensure(native.prepare(`SELECT count(*) n FROM ${quote(name)}`).get()?.n === 0);
  guard(); const installation = admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE).receipt;
  ensure(installation.checkpointId === "portable-runtime/v28" && (records.sourceMigrationLedger.kind !== "node-reviewed-migrations/1"
    || installation.installationId !== records.sourceMigrationLedger.installationId));
  ensure(manifest.contentSchemaVersion === 28 && manifest.completeness === "complete"
    && records.image.schemaSha256 === PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256);
  const accounts = records.image.tables.local_accounts, index = accounts.columns.indexOf("enabled"); ensure(index >= 0);
  const disabledAccountCells = accounts.rows.filter(row => { const cell = row.cells[index]; return !cell || cell.type !== "integer" || cell.value !== "0"; }).length;
  guard(); return { installationId: installation.installationId, originalRows, disabledAccountCells };
}
export function assertNodeV28TargetSeeds(native: DatabaseSync, guard: () => void): void {
  for (const spec of tables) { guard(); ensure(nodeV28TargetEqual(nodeV28TargetReadTable(native, spec), seeds[spec.name]!)); }
}
