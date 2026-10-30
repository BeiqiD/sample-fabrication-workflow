// Explicit SOURCE-only V5/V28 target catalog. No default version, migration or activation changes.
import { SYSTEM_BACKUP_RECORDS_SCHEMA_V5, validateSystemRecoveryImageV5,
  type SystemBackupRecordsV5, type SystemRecoveryImageV5 } from "../../shared/contracts/system-backup-v5";
import { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256,
  PORTABLE_RUNTIME_SCHEMA_STATEMENTS, PORTABLE_RUNTIME_RECOVERY_TABLES,
  PORTABLE_RUNTIME_SEED_TABLE_ROWS, PORTABLE_RUNTIME_RECOVERY_MIGRATIONS } from "./portable-runtime-v28-trusted-schema";
import { isRecoveryInteger, validateSystemRecoveryCell,
  type SystemRecoveryCell, type SystemRecoveryTable } from "../../shared/contracts/system-recovery-image";
import type { ReviewedRecoveryTableSpec, ReviewedRecoverySchemaStatement, ReviewedRecoveryMigration } from "./versioned-catalog";
import { stableJson } from "../../shared/domain/content-addressing";

export interface ReviewedV5RecoveryCatalogCandidate {
  readonly imageVersion: 5;
  readonly recordsSchema: typeof SYSTEM_BACKUP_RECORDS_SCHEMA_V5;
  readonly checkpointId: typeof PORTABLE_RUNTIME_CHECKPOINT_ID;
  readonly schemaSha256: string;
  readonly schemaStatements: readonly Readonly<ReviewedRecoverySchemaStatement>[];
  readonly tables: readonly Readonly<ReviewedRecoveryTableSpec>[];
  readonly seedTableRows: Readonly<Record<string, SystemRecoveryTable>>;
  readonly migrations: readonly Readonly<ReviewedRecoveryMigration>[];
}

/** The exclusively owning constructor generates these fresh values. This
 * data-only helper cannot attest randomness, acquire a target or open a DB. */
export interface V5RecoveryDestinationIdentityCandidate {
  installationId: string;
  incarnation: string;
  clock: string;
}

function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`v5_recovery_catalog_candidate_${reason}`);
}
function cloneTable(table: SystemRecoveryTable): SystemRecoveryTable {
  return { columns: [...table.columns], rows: table.rows.map(row => ({ rowid: row.rowid, cells: row.cells.map(cell => ({ ...cell })) })) };
}
function freezeTable(table: SystemRecoveryTable): SystemRecoveryTable {
  const copy = cloneTable(table);
  for (const row of copy.rows) {
    row.cells.forEach(cell => Object.freeze(cell));
    Object.freeze(row.cells); Object.freeze(row);
  }
  Object.freeze(copy.columns); Object.freeze(copy.rows);
  return Object.freeze(copy);
}
const singletonLocalTables = new Set(["file_authority_runtime_guard", "file_shadow_runtime_guard", "file_job_runtime_guard",
  "system_recovery_runtime", "system_recovery_maintenance", "collaboration_control"]);
const requiredEmptyLocalTables = ["local_identity_installation", "local_admin_grants", "local_sessions", "local_login_throttle",
  "local_storage_profile_checks", "local_storage_profile_admissions", "local_storage_profile_bindings",
  "collaboration_members", "collaboration_identities", "collaboration_resources", "collaboration_grants",
  "system_storage_native_bindings", "file_job_cleanup_grants", "system_research_package_cleanup_grants",
  "file_shadow_runtime_incarnations", "system_recovery_jobs", "system_recovery_write_leases",
  "system_recovery_target_claim", "system_recovery_target_files", "system_recovery_target_provenance"] as const;

function cell(table: SystemRecoveryTable, column: string): SystemRecoveryCell {
  const position = table.columns.indexOf(column);
  ensure(position >= 0 && table.rows.length === 1 && table.rows[0].cells[position], `singleton_cell:${column}`);
  return table.rows[0].cells[position];
}
function exactCell(table: SystemRecoveryTable, column: string, expected: SystemRecoveryCell) {
  ensure(stableJson(cell(table, column)) === stableJson(expected), `seed_cell:${column}`);
}
function assertReviewedLocalSeeds(catalog: ReviewedV5RecoveryCatalogCandidate) {
  const names = new Set<string>();
  for (const spec of catalog.tables) {
    ensure(!names.has(spec.name) && spec.local === (spec.classification === "local"), "table_classification");
    names.add(spec.name);
    const seed = catalog.seedTableRows[spec.name];
    ensure(seed && stableJson(seed.columns) === stableJson(spec.columns), `seed_columns:${spec.name}`);
    for (const row of seed.rows) {
      ensure(row.cells.length === spec.columns.length && (spec.withoutRowid ? row.rowid === null : isRecoveryInteger(row.rowid)), `seed_row:${spec.name}`);
      row.cells.forEach(validateSystemRecoveryCell);
    }
    if (!spec.local) continue;
    if (singletonLocalTables.has(spec.name)) {
      ensure(seed.rows.length === 1, `seed_singleton:${spec.name}`);
      exactCell(seed, "singleton", { type: "integer", value: "1" });
    } else ensure(seed.rows.length === 0, `seed_authority_nonempty:${spec.name}`);
  }
  for (const name of singletonLocalTables) ensure(catalog.tables.some(spec => spec.name === name && spec.local), `singleton_missing:${name}`);
  for (const name of requiredEmptyLocalTables) ensure(catalog.tables.some(spec => spec.name === name && spec.local)
    && catalog.seedTableRows[name]?.rows.length === 0, `authority_seed:${name}`);
  for (const name of ["file_authority_runtime_guard", "file_shadow_runtime_guard", "file_job_runtime_guard", "system_recovery_runtime"]) {
    const seed = catalog.seedTableRows[name];
    exactCell(seed, "enabled", { type: "integer", value: "0" });
    exactCell(seed, "incarnation", name === "system_recovery_runtime" ? { type: "text", value: "00000000000000000000000000000000" } : { type: "null" });
    if (name === "file_authority_runtime_guard" || name === "file_shadow_runtime_guard") exactCell(seed, "enabled_by", { type: "null" });
    else exactCell(seed, "last_heartbeat_at", { type: "null" });
  }
  const maintenance = catalog.seedTableRows.system_recovery_maintenance;
  exactCell(maintenance, "state", { type: "text", value: "open" });
  exactCell(maintenance, "generation", { type: "integer", value: "0" });
  for (const column of ["token", "requested_by", "backup_job_id", "checkpoint_sha256", "started_at", "fenced_at"]) exactCell(maintenance, column, { type: "null" });
  const collaboration = catalog.seedTableRows.collaboration_control;
  exactCell(collaboration, "schema_version", { type: "integer", value: "2" });
  exactCell(collaboration, "enforcement", { type: "text", value: "disabled" });
  exactCell(collaboration, "revision", { type: "integer", value: "1" });
}

/** Own deeply frozen copies; imports never mutate historical or V28 arrays,
 * seeds, catalogs, default readers or migration SQL. Target SQL is code-owned. */
export const V5_RECOVERY_CATALOG_CANDIDATE: ReviewedV5RecoveryCatalogCandidate = Object.freeze({
  imageVersion: 5 as const, recordsSchema: SYSTEM_BACKUP_RECORDS_SCHEMA_V5, checkpointId: PORTABLE_RUNTIME_CHECKPOINT_ID,
  schemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256,
  schemaStatements: Object.freeze(PORTABLE_RUNTIME_SCHEMA_STATEMENTS.map(statement => Object.freeze({ ...statement }))),
  tables: Object.freeze(PORTABLE_RUNTIME_RECOVERY_TABLES.map(spec => Object.freeze({ ...spec, columns: Object.freeze([...spec.columns]),
    ...(spec.primaryKeyColumns ? { primaryKeyColumns: Object.freeze([...spec.primaryKeyColumns]) } : {}) }))),
  seedTableRows: Object.freeze(Object.fromEntries(Object.entries(PORTABLE_RUNTIME_SEED_TABLE_ROWS).map(([name, table]) => [name, freezeTable(table)]))),
  migrations: Object.freeze(PORTABLE_RUNTIME_RECOVERY_MIGRATIONS.map(migration => Object.freeze({ ...migration }))),
});
assertReviewedLocalSeeds(V5_RECOVERY_CATALOG_CANDIDATE);

/** Closed dispatch only; this never accepts archive-provided DDL or catalogs.
 * The archive owner separately validates the complete V5 documents and ZIP. */
export function selectV5RecoveryCatalogCandidate(records: SystemBackupRecordsV5): ReviewedV5RecoveryCatalogCandidate {
  ensure(records && typeof records === "object" && !Array.isArray(records)
    && records.schema === SYSTEM_BACKUP_RECORDS_SCHEMA_V5 && records.image && typeof records.image === "object"
    && !Array.isArray(records.image) && records.image.version === 5 && records.image.kind === "system-recovery-image"
    && records.image.checkpointId === PORTABLE_RUNTIME_CHECKPOINT_ID
    && records.image.schemaSha256 === V5_RECOVERY_CATALOG_CANDIDATE.schemaSha256, "unsupported_tuple");
  return V5_RECOVERY_CATALOG_CANDIDATE;
}

/** Validate all typed tables/cells in an owned snapshot of the original V5
 * image. Signed int64 cells and rowids never become JavaScript numbers. */
export function validateV5RecoverySourceImageCandidate(records: SystemBackupRecordsV5): SystemRecoveryImageV5 {
  selectV5RecoveryCatalogCandidate(records);
  return validateSystemRecoveryImageV5(structuredClone(records.image));
}

function destinationIdentity(value: V5RecoveryDestinationIdentityCandidate): V5RecoveryDestinationIdentityCandidate {
  const fields = ["installationId", "incarnation", "clock"];
  ensure(value && typeof value === "object" && !Array.isArray(value)
    && Reflect.ownKeys(value).length === fields.length && fields.every(name => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
    }), "destination_identity_fields");
  const { installationId, incarnation, clock } = value;
  const identity = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{32}$/.test(id) && !/^0{32}$/.test(id);
  ensure(identity(installationId) && identity(incarnation) && installationId !== incarnation, "destination_identity");
  ensure(typeof clock === "string" && Number.isFinite(Date.parse(clock)) && new Date(clock).toISOString() === clock, "destination_clock");
  return { installationId, incarnation, clock };
}
function setSingletonCell(table: SystemRecoveryTable, column: string, value: SystemRecoveryCell) {
  cell(table, column); table.rows[0].cells[table.columns.indexOf(column)] = value;
}

/** Pure typed construction data, not a provider mapping or completed restore.
 * Every nonlocal row/cell/rowid remains exact except local_accounts.enabled=0.
 * research_package_source_identity remains canonical source provenance. Every
 * installation-local table comes exclusively from reviewed inert seeds; only
 * destination-local recovery identities and maintenance state/clock change.
 * The constructor owns target freshness, complete-document admission, identity
 * generation, target writes, D1 health checks and any later byte publication. */
export function destinationV5RecoveryTablesCandidate(records: SystemBackupRecordsV5,
  suppliedIdentity: V5RecoveryDestinationIdentityCandidate): Record<string, SystemRecoveryTable> {
  const identity = destinationIdentity(suppliedIdentity), image = validateV5RecoverySourceImageCandidate(records);
  const catalog = V5_RECOVERY_CATALOG_CANDIDATE;
  assertReviewedLocalSeeds(catalog);
  const destination: Record<string, SystemRecoveryTable> = {};
  for (const spec of catalog.tables) {
    const source = spec.local ? catalog.seedTableRows[spec.name] : image.tables[spec.name];
    ensure(source, `destination_table_missing:${spec.name}`);
    const table = cloneTable(source);
    if (spec.name === "local_accounts") {
      const enabled = spec.columns.indexOf("enabled");
      ensure(enabled >= 0, "account_enabled_column");
      for (const row of table.rows) row.cells[enabled] = { type: "integer", value: "0" };
    }
    if (spec.name === "system_recovery_runtime") {
      setSingletonCell(table, "installation_id", { type: "text", value: identity.installationId });
      setSingletonCell(table, "incarnation", { type: "text", value: identity.incarnation });
      setSingletonCell(table, "updated_at", { type: "text", value: identity.clock });
    }
    if (spec.name === "system_recovery_maintenance") {
      setSingletonCell(table, "state", { type: "text", value: "fenced" });
      setSingletonCell(table, "updated_at", { type: "text", value: identity.clock });
    }
    destination[spec.name] = table;
  }
  return destination;
}
