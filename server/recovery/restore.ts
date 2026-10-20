import { randomBytes } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PORTABLE_RUNTIME_SCHEMA_STATEMENTS, PORTABLE_RUNTIME_RECOVERY_TABLES, PORTABLE_RUNTIME_SEED_TABLE_ROWS,
  PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, PORTABLE_RUNTIME_RECOVERY_MIGRATIONS } from "../../worker/recovery/portable-runtime-trusted-schema";
import { validateSystemBackupDocumentsV2, type SystemBackupManifestV2, type SystemBackupRecordsV2 } from "../../shared/contracts/system-backup-v2";
import { recoveryCellBinding, recoveryTableSnapshotSql, type RecoveryTableSpec, type SystemRecoveryRow, type SystemRecoveryTable } from "../../shared/contracts/system-recovery-image";
import { stableJson } from "../../shared/domain/content-addressing";
import { nodeRecoveryFileSha256, recoverySqlIdentifier as quote } from "../../scripts/lib/system-backup-node-io";
import { CURRENT_NODE_INSTALLATION_CATALOG } from "../installation-catalog";
import { installReviewedSqliteCatalog, admitInstallationRecoverySource } from "../migrations";
import { createSqliteCapability } from "../sqlite";
import { shutdownQuiescedSqliteDatabase } from "../sqlite-backup";

function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error(`Current offline system recovery rejected: ${reason}`); }
function insert(database: DatabaseSync, spec: RecoveryTableSpec, row: SystemRecoveryRow) {
  const columns = [...spec.columns], values = row.cells.map(recoveryCellBinding);
  if (!spec.withoutRowid) { columns.unshift("rowid"); values.unshift({ expression: "CAST(? AS INTEGER)", value: row.rowid }); }
  database.prepare(`INSERT INTO ${quote(spec.name)} (${columns.map(quote).join(",")}) VALUES (${values.map(value => value.expression).join(",")})`)
    .run(...values.map(value => value.value));
}
function read(database: DatabaseSync, spec: RecoveryTableSpec): SystemRecoveryTable {
  const rows = database.prepare(recoveryTableSnapshotSql(spec)).all() as Array<{ rowid: string | null; cells: string }>;
  return { columns: [...spec.columns], rows: rows.map(row => ({ rowid: row.rowid, cells: JSON.parse(row.cells) })) };
}
function equal(left: SystemRecoveryTable, right: SystemRecoveryTable) {
  return stableJson(left.columns) === stableJson(right.columns)
    && stableJson(left.rows.map(stableJson).sort()) === stableJson(right.rows.map(stableJson).sort());
}
export function disabledProtectedAccountTable(table: SystemRecoveryTable): SystemRecoveryTable {
  const index = table.columns.indexOf("enabled");
  ensure(index >= 0, "protected account columns");
  const result = structuredClone(table);
  for (const row of result.rows) row.cells[index] = { type: "integer", value: "0" };
  return result;
}
function assertInert(database: DatabaseSync) {
  ensure(database.prepare("SELECT state FROM system_recovery_maintenance WHERE singleton=1").get()?.state === "fenced", "maintenance not fenced");
  for (const name of ["file_shadow_runtime_guard", "file_authority_runtime_guard", "file_job_runtime_guard", "system_recovery_runtime"])
    ensure(database.prepare(`SELECT enabled FROM ${quote(name)}`).get()?.enabled === 0, `execution enabled:${name}`);
  for (const name of ["system_storage_native_bindings", "file_job_cleanup_grants", "system_research_package_cleanup_grants", "file_shadow_runtime_incarnations",
    "system_recovery_jobs", "system_recovery_write_leases", "system_recovery_target_claim", "system_recovery_target_files",
    "local_identity_installation", "local_admin_grants", "local_sessions", "local_login_throttle"])
    ensure(database.prepare(`SELECT count(*) AS count FROM ${quote(name)}`).get()?.count === 0, `authority restored:${name}`);
  ensure(database.prepare("SELECT count(*) AS count FROM local_accounts WHERE enabled<>0").get()?.count === 0, "protected account enabled");
}

/** The outer archive restorer exclusively creates and owns this private 0700
 * directory, freezes/validates the complete archive and extracts only admitted
 * entries. No requests/jobs/providers are mounted here. Source SQL is evidence;
 * target DDL and installation receipts are always this reviewed code catalog. */
export async function restorePortableSystemBackupIntoDirectory(options: {
  directory: string; archiveSha256: string; manifest: SystemBackupManifestV2; records: SystemBackupRecordsV2;
}) {
  const { manifest, records } = await validateSystemBackupDocumentsV2(options.manifest, options.records);
  ensure(manifest.completeness === "complete", "partial_backup_not_complete_recovery");
  const directory = options.directory;
  const owned = await lstat(directory); ensure(owned.isDirectory() && !owned.isSymbolicLink(), "private directory required");
  for (const file of manifest.files) {
    ensure(file.outcome === "packaged" && file.path === `files/${file.id}`, "complete file inventory");
    const path = join(directory, file.path), stat = await lstat(path);
    ensure(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "private regular payload required");
    const checked = await nodeRecoveryFileSha256(path);
    ensure(checked.byteSize === file.byteSize && checked.sha256 === file.sha256, "extracted payload changed");
  }
  const databasePath = join(directory, "database.sqlite");
  await writeFile(databasePath, new Uint8Array(), { flag: "wx", mode: 0o600 });
  const database = new DatabaseSync(databasePath, { allowExtension: false, enableForeignKeyConstraints: true });
  const capability = createSqliteCapability(database);
  let recoveredRows = 0, statements = 0;
  try {
    const installation = installReviewedSqliteCatalog(database, CURRENT_NODE_INSTALLATION_CATALOG);
    // Final DDL/data replacement is confined to this fresh isolated target.
    // FK checks run before COMMIT, while triggers are installed only after all
    // recorded historical rows are present. Source migration cleanup is never
    // replayed against recovered rows; its raw receipt was installed while empty.
    database.exec("PRAGMA foreign_keys=OFF; BEGIN EXCLUSIVE;");
    try {
      for (const type of ["trigger", "view", "index", "table"] as const) {
        for (const object of PORTABLE_RUNTIME_SCHEMA_STATEMENTS.filter(object => object.type === type)) {
          database.exec(`DROP ${type.toUpperCase()} ${quote(object.name)}`); statements++;
        }
      }
      for (const object of PORTABLE_RUNTIME_SCHEMA_STATEMENTS.filter(object => object.type === "table")) { database.exec(object.sql); statements++; }
      for (const spec of PORTABLE_RUNTIME_RECOVERY_TABLES) {
        let table = spec.local ? PORTABLE_RUNTIME_SEED_TABLE_ROWS[spec.name] : records.image.tables[spec.name];
        ensure(table, `missing typed table:${spec.name}`);
        if (spec.name === "local_accounts") table = disabledProtectedAccountTable(table);
        for (const recorded of table.rows) {
          const row = structuredClone(recorded);
          if (spec.name === "system_recovery_runtime") {
            for (const name of ["installation_id", "incarnation"]) row.cells[spec.columns.indexOf(name)] = { type: "text", value: randomBytes(16).toString("hex") };
            row.cells[spec.columns.indexOf("updated_at")] = { type: "text", value: new Date().toISOString() };
          }
          if (spec.name === "system_recovery_maintenance") {
            row.cells[spec.columns.indexOf("state")] = { type: "text", value: "fenced" };
            row.cells[spec.columns.indexOf("updated_at")] = { type: "text", value: new Date().toISOString() };
          }
          insert(database, spec, row); statements++; if (!spec.local) recoveredRows++;
        }
      }
      for (const type of ["index", "view", "trigger"] as const)
        for (const object of PORTABLE_RUNTIME_SCHEMA_STATEMENTS.filter(object => object.type === type)) { database.exec(object.sql); statements++; }
      ensure(database.prepare("PRAGMA foreign_key_check").all().length === 0, "foreign keys");
      ensure(database.prepare("PRAGMA integrity_check").all().every(row => Object.values(row)[0] === "ok"), "integrity");
      const observed = database.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND tbl_name NOT IN('node_installation','node_migrations') ORDER BY type,name").all();
      ensure(stableJson(observed) === stableJson(PORTABLE_RUNTIME_SCHEMA_STATEMENTS), "exact current schema");
      for (const spec of PORTABLE_RUNTIME_RECOVERY_TABLES.filter(spec => !spec.local)) {
        const expected = spec.name === "local_accounts" ? disabledProtectedAccountTable(records.image.tables[spec.name]) : records.image.tables[spec.name];
        ensure(equal(read(database, spec), expected), `exact typed rows:${spec.name}`);
      }
      assertInert(database); database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK"); throw error;
    } finally { database.exec("PRAGMA foreign_keys=ON"); }
    const admitted = admitInstallationRecoverySource(database, CURRENT_NODE_INSTALLATION_CATALOG);
    ensure(admitted.receipt.installationId === installation.installationId && (records.sourceMigrationLedger.kind !== "node-reviewed-migrations/1"
      || admitted.receipt.installationId !== records.sourceMigrationLedger.installationId),
      "destination installation identity");
    shutdownQuiescedSqliteDatabase(database);
    await writeFile(join(directory, "source-byte-inventory.json"), stableJson({ schema: "offline-system-recovery-bytes/1", backupId: records.backupId,
      sourceArchiveSha256: options.archiveSha256, files: manifest.files.map(file => ({ ...file, localPath: file.path })) }), { flag: "wx", mode: 0o600 });
    await writeFile(join(directory, "metadata/reviewed-target-migrations.json"), stableJson({ sourceLedgerUntouched: true, migrations: PORTABLE_RUNTIME_RECOVERY_MIGRATIONS }), { flag: "wx", mode: 0o600 });
    const report = { kind: "offline-system-backup-recovery", backupId: records.backupId, sourceArchiveSha256: options.archiveSha256,
      sourceImageSchemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, databasePath: "database.sqlite", originalArchivePath: "original-archive.zip",
      sourceByteInventoryPath: "source-byte-inventory.json", exactSourceRecordsPath: "metadata/records.json", tables: PORTABLE_RUNTIME_RECOVERY_TABLES.filter(table => !table.local).length,
      rows: recoveredRows, localAtomicStatements: statements, payloads: manifest.counts.packagedFiles, payloadBytes: manifest.counts.bytes,
      verification: { exactTypedRows: true, exactRowids: true, foreignKeys: true, integrity: "ok", reviewedSchema: true },
      protectedConfiguration: { status: records.protectedConfiguration.status, encryptedCellsPreserved: true, rootKeysIncluded: false },
      protectedIdentity: { principalIdsAndVerifiersPreserved: true, accountsDisabled: true, auditProvenancePreserved: true,
        sessionsRestored: false, grantsRestored: false, destinationBootstrap: "explicit-offline-exact-principal" },
      destinationInstallationId: admitted.receipt.installationId, destinationCheckpoint: admitted.receipt.checkpointId,
      applicationContentBounds: "ordinary V25 valid business cells; unsafe canonical integers rejected; protected integers exact",
      addresses: "original source addresses retained inert; verified local bytes mapped separately", providerIO: false,
      nativeBindingsRestored: false, executionEnabled: false, maintenanceState: "fenced", deploymentChanged: false, sourceMigrationLedger: "observed-inert" };
    await writeFile(join(directory, "recovery-report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
    return { destination: directory, databasePath, report };
  } finally {
    if (database.isOpen && database.isTransaction) database.exec("ROLLBACK");
    capability.close();
    // Only the outer exclusive directory owner removes an unsuccessful target.
    // A committed isolated DB is never activated by this helper.
  }
}
