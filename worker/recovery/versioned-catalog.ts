import type { SystemBackupManifestV1, SystemBackupRecordsV1 } from "../../shared/contracts/system-backup";
import { SYSTEM_BACKUP_MAX_RECORDS_BYTES, SYSTEM_BACKUP_RECORDS_SCHEMA } from "../../shared/contracts/system-backup";
import type { SystemBackupManifestV2, SystemBackupRecordsV2, SystemRecoveryImageV2 } from "../../shared/contracts/system-backup-v2";
import { SYSTEM_BACKUP_RECORDS_SCHEMA_V2, validateSystemRecoveryImageV2 } from "../../shared/contracts/system-backup-v2";
import type { RecoveryTableSpec, SystemRecoveryImageV1, SystemRecoveryTable } from "../../shared/contracts/system-recovery-image";
import { validateSystemRecoveryImage } from "../../shared/contracts/system-recovery-image";
import { RECOVERY_MIGRATIONS, RECOVERY_SCHEMA_SHA256, RECOVERY_SCHEMA_STATEMENTS, RECOVERY_SEED_TABLE_ROWS, RECOVERY_TABLES } from "./trusted-schema";
import { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_RECOVERY_MIGRATIONS, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256,
  PORTABLE_RUNTIME_RECOVERY_TABLES, PORTABLE_RUNTIME_SCHEMA_STATEMENTS, PORTABLE_RUNTIME_SEED_TABLE_ROWS } from "./portable-runtime-trusted-schema";

export type VersionedRecoveryRecords = SystemBackupRecordsV1 | SystemBackupRecordsV2;
export type VersionedRecoveryManifest = SystemBackupManifestV1 | SystemBackupManifestV2;
export type VersionedRecoveryImage = SystemRecoveryImageV1 | SystemRecoveryImageV2;
export type ReviewedRecoveryTableSpec = RecoveryTableSpec & {
  classification: "content" | "protected_configuration" | "protected_identity" | "local";
};
export interface ReviewedRecoverySchemaStatement {
  readonly type: "table" | "index" | "view" | "trigger";
  readonly name: string; readonly tableName: string; readonly sql: string;
}
export interface ReviewedRecoveryMigration {
  readonly name: string; readonly sha256: string; readonly appliedToFreshSchema: boolean;
}
export interface ReviewedRecoveryCatalog {
  readonly imageVersion: 1 | 2;
  readonly recordsSchema: typeof SYSTEM_BACKUP_RECORDS_SCHEMA | typeof SYSTEM_BACKUP_RECORDS_SCHEMA_V2;
  readonly checkpointId: typeof PORTABLE_RUNTIME_CHECKPOINT_ID | null;
  readonly schemaSha256: string;
  readonly schemaStatements: readonly Readonly<ReviewedRecoverySchemaStatement>[];
  readonly tables: readonly Readonly<ReviewedRecoveryTableSpec>[];
  readonly seedTableRows: Readonly<Record<string, SystemRecoveryTable>>;
  readonly migrations: readonly Readonly<ReviewedRecoveryMigration>[];
}
function fail(reason: string): never { throw new Error(`versioned_recovery_${reason}`); }
function cloneTable(table: SystemRecoveryTable): SystemRecoveryTable {
  return { columns: [...table.columns], rows: table.rows.map(row => ({ rowid: row.rowid, cells: row.cells.map(cell => ({ ...cell })) })) };
}
function freezeTable(table: SystemRecoveryTable): SystemRecoveryTable {
  const copy = cloneTable(table);
  for (const row of copy.rows) { row.cells.forEach(cell => Object.freeze(cell)); Object.freeze(row.cells); Object.freeze(row); }
  Object.freeze(copy.columns); Object.freeze(copy.rows); return Object.freeze(copy);
}
function ownCatalog(value: ReviewedRecoveryCatalog): ReviewedRecoveryCatalog {
  return Object.freeze({ ...value,
    schemaStatements: Object.freeze(value.schemaStatements.map(statement => Object.freeze({ ...statement }))),
    tables: Object.freeze(value.tables.map(spec => Object.freeze({ ...spec, columns: Object.freeze([...spec.columns]),
      ...(spec.primaryKeyColumns ? { primaryKeyColumns: Object.freeze([...spec.primaryKeyColumns]) } : {}) }))),
    seedTableRows: Object.freeze(Object.fromEntries(Object.entries(value.seedTableRows).map(([name, table]) => [name, freezeTable(table)]))),
    migrations: Object.freeze(value.migrations.map(migration => Object.freeze({ ...migration }))),
  });
}
// Own frozen copies; importing this module never mutates the historical arrays,
// SQL, seeds, default readers or their original version-1 admission rules.
const historical = ownCatalog({ imageVersion: 1, recordsSchema: SYSTEM_BACKUP_RECORDS_SCHEMA, checkpointId: null,
  schemaSha256: RECOVERY_SCHEMA_SHA256, schemaStatements: RECOVERY_SCHEMA_STATEMENTS, tables: RECOVERY_TABLES,
  seedTableRows: RECOVERY_SEED_TABLE_ROWS, migrations: RECOVERY_MIGRATIONS });
const current = ownCatalog({ imageVersion: 2, recordsSchema: SYSTEM_BACKUP_RECORDS_SCHEMA_V2, checkpointId: PORTABLE_RUNTIME_CHECKPOINT_ID,
  schemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, schemaStatements: PORTABLE_RUNTIME_SCHEMA_STATEMENTS,
  tables: PORTABLE_RUNTIME_RECOVERY_TABLES, seedTableRows: PORTABLE_RUNTIME_SEED_TABLE_ROWS, migrations: PORTABLE_RUNTIME_RECOVERY_MIGRATIONS });
const identityLocalTables = new Set(["local_identity_installation", "local_admin_grants", "local_sessions", "local_login_throttle"]);

/** Cheap closed dispatch only. The caller still admits the complete backup
 * documents/provenance and calls validateRecoverySourceImage once at entry.
 * Observed schema SQL or an archive-supplied catalog is never a parameter. */
export function selectReviewedRecoveryCatalog(records: VersionedRecoveryRecords): ReviewedRecoveryCatalog {
  if (!records || typeof records !== "object" || Array.isArray(records)
    || !records.image || typeof records.image !== "object" || Array.isArray(records.image)) return fail("catalog_unsupported");
  const image = records.image;
  if (records.schema === SYSTEM_BACKUP_RECORDS_SCHEMA && image.version === 1 && image.kind === "system-recovery-image"
    && image.schemaSha256 === historical.schemaSha256 && !Object.hasOwn(image, "checkpointId")) return historical;
  if (records.schema === SYSTEM_BACKUP_RECORDS_SCHEMA_V2 && image.version === 2 && image.kind === "system-recovery-image"
    && image.checkpointId === current.checkpointId && image.schemaSha256 === current.schemaSha256) return current;
  return fail("catalog_unsupported");
}

/** Full closed typed image validation for the selected code-owned version.
 * Historical validation uses precisely its existing records metadata budget. */
export function validateRecoverySourceImage(records: VersionedRecoveryRecords): VersionedRecoveryImage {
  const catalog = selectReviewedRecoveryCatalog(records);
  return catalog.imageVersion === 1 ? validateSystemRecoveryImage(records.image, {
    schemaSha256: catalog.schemaSha256, tables: catalog.tables, maxMetadataBytes: SYSTEM_BACKUP_MAX_RECORDS_BYTES,
  }) : validateSystemRecoveryImageV2(records.image);
}

/** A bounded per-table validation/copy after full image admission at entry.
 * Local rows always come from reviewed seeds, never the source. Current account
 * identity/verifier/revision/rowids and protected audit remain exact; only the
 * enabled cell becomes integer zero. No destination principal or grant is
 * created here, and imported bootstrap claims never become authority. */
export function recoveryDestinationTable(records: VersionedRecoveryRecords, name: string): SystemRecoveryTable {
  const catalog = selectReviewedRecoveryCatalog(records), spec = catalog.tables.find(table => table.name === name);
  if (!spec) return fail("table_unreviewed");
  if (spec.local) {
    const seed = catalog.seedTableRows[name];
    if (!seed || catalog.imageVersion === 2 && identityLocalTables.has(name) && seed.rows.length !== 0) return fail("local_seed_unreviewed");
    return cloneTable(seed);
  }
  const image = records.image;
  const checked = validateSystemRecoveryImage({ version: 1, kind: "system-recovery-image", schemaSha256: catalog.schemaSha256,
    sourceSnapshotClock: image.sourceSnapshotClock, tables: { [name]: image.tables?.[name] } }, {
    schemaSha256: catalog.schemaSha256, tables: [spec], maxMetadataBytes: SYSTEM_BACKUP_MAX_RECORDS_BYTES,
  });
  const destination = cloneTable(checked.tables[name]);
  if (catalog.imageVersion === 2 && name === "local_accounts") {
    const enabled = spec.columns.indexOf("enabled"), principal = spec.columns.indexOf("principal_id"), username = spec.columns.indexOf("username");
    for (const row of destination.rows) {
      const state = row.cells[enabled], id = row.cells[principal], user = row.cells[username];
      if (state?.type !== "integer" || !["0", "1"].includes(state.value)
        || id?.type !== "text" || !/^local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id.value)
        || user?.type !== "text" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(user.value)) return fail("protected_account_state");
      row.cells[enabled] = { type: "integer", value: "0" };
    }
  }
  return destination;
}
