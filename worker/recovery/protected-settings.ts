import { stableJson } from "../../shared/domain/content-addressing";
import type { SystemBackupRecordsV1 } from "../../shared/contracts/system-backup";
import { recoveryTableSnapshotSql, type SystemRecoveryImage, type SystemRecoveryTable } from "../../shared/contracts/system-recovery-image";
import { RECOVERY_TABLES, RECOVERY_SEED_TABLE_ROWS } from "./trusted-schema";

export interface RecoverySettingsReport {
  included: boolean; policy: "quarantined"; keyIds: string[];
  rootKeysIncluded: false; nativeBindingsEnabled: false; automaticExecution: false;
  freshConfigurationRequired: true;
}
export function recoveryProtectedSettingsReport(records: SystemBackupRecordsV1): RecoverySettingsReport {
  const policy = records.protectedConfiguration;
  if (policy.rootKeysIncluded !== false || policy.automaticExecution !== false
    || policy.policy !== "encrypted-configuration-quarantine/1") throw new Error("protected_settings_policy");
  return { included: policy.tableNames.some(name => records.image.tables[name]?.rows.length), policy: "quarantined",
    keyIds: [...policy.keyIds], rootKeysIncluded: false, nativeBindingsEnabled: false,
    automaticExecution: false, freshConfigurationRequired: true };
}
export function recoveryIdentifier(name: string) { return `"${name.replaceAll('"', '""')}"`; }
export async function readRecoveryTable(database: D1Database, name: string): Promise<SystemRecoveryTable> {
  const spec = RECOVERY_TABLES.find(table => table.name === name);
  if (!spec) throw new Error("unreviewed_recovery_table");
  const rows: SystemRecoveryTable["rows"] = [];
  const sql = recoveryTableSnapshotSql(spec);
  for (let offset = 0;; offset += 16) {
    const result = await database.prepare(`${sql} LIMIT 16 OFFSET ?`).bind(offset)
      .all<{ rowid: string | null; cells: string }>();
    if (!result.success) throw new Error("target_table_unavailable");
    rows.push(...result.results.map(row => ({ rowid: row.rowid, cells: JSON.parse(row.cells) })));
    if (result.results.length < 16) break;
    if (rows.length > 16_384) throw new Error("target_rows_exceed_budget");
  }
  return { columns: [...spec.columns], rows };
}
function sameTable(left: SystemRecoveryTable, right: SystemRecoveryTable) {
  return stableJson(left.columns) === stableJson(right.columns)
    && stableJson(left.rows.map(stableJson).sort()) === stableJson(right.rows.map(stableJson).sort());
}
/** Freshness admits only migration-owned seed values. Random installation IDs
 * and the migration clock are structurally checked, never matched to one build. */
export function isRecoverySeedTable(name: string, observed: SystemRecoveryTable): boolean {
  const seed = RECOVERY_SEED_TABLE_ROWS[name];
  if (!seed || observed.rows.length !== seed.rows.length || stableJson(observed.columns) !== stableJson(seed.columns)) return false;
  const copy = structuredClone(observed);
  const randomColumns = name === "research_package_source_identity" ? ["installation_id"]
    : name === "system_recovery_runtime" ? ["installation_id", "incarnation"] : [];
  const clockColumns = name === "system_recovery_runtime" || name === "system_recovery_maintenance" ? ["updated_at"] : [];
  for (let index = 0; index < copy.rows.length; index++) {
    for (const name of randomColumns) {
      const position = copy.columns.indexOf(name), value = copy.rows[index].cells[position];
      if (position < 0 || value?.type !== "text" || !/^[0-9a-f]{32}$/.test(value.value)) return false;
      copy.rows[index].cells[position] = seed.rows[index].cells[position];
    }
    for (const name of clockColumns) {
      const position = copy.columns.indexOf(name), value = copy.rows[index].cells[position];
      if (position < 0 || value?.type !== "text" || !Number.isFinite(Date.parse(value.value))) return false;
      copy.rows[index].cells[position] = seed.rows[index].cells[position];
    }
  }
  return sameTable(copy, seed);
}
export function recoveryImageTableRows(image: SystemRecoveryImage) {
  return Object.values(image.tables).reduce((total, table) => total + table.rows.length, 0);
}
export async function assertRecoveredCapabilitiesInert(database: D1Database): Promise<void> {
  const statements = [
    "SELECT count(*) AS invalid FROM file_authority_runtime_guard WHERE enabled<>0 OR incarnation IS NOT NULL",
    "SELECT count(*) AS invalid FROM file_shadow_runtime_guard WHERE enabled<>0 OR incarnation IS NOT NULL",
    "SELECT count(*) AS invalid FROM file_job_runtime_guard WHERE enabled<>0 OR incarnation IS NOT NULL OR last_heartbeat_at IS NOT NULL",
    "SELECT count(*) AS invalid FROM system_recovery_runtime WHERE enabled<>0 OR last_heartbeat_at IS NOT NULL",
    "SELECT count(*) AS invalid FROM system_storage_native_bindings",
    "SELECT count(*) AS invalid FROM file_job_cleanup_grants",
    "SELECT count(*) AS invalid FROM system_research_package_cleanup_grants",
    "SELECT count(*) AS invalid FROM file_shadow_runtime_incarnations",
  ];
  const results = await database.batch(statements.map(sql => database.prepare(sql)));
  if (results.some(result => !result.success || result.results.length !== 1 || (result.results[0] as Record<string, unknown>).invalid !== 0)) {
    throw new Error("recovered_execution_not_inert");
  }
}
