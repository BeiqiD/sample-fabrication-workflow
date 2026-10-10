import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateVersionedSystemBackupArchive } from "../../shared/contracts/system-backup-versioned-admission";
import { restorePortableSystemBackupIntoDirectory } from "../../server/recovery/restore";
import { SYSTEM_BACKUP_MAX_ARCHIVE_BYTES } from "../../shared/contracts/system-backup";
import { recoveryCellBinding, recoveryTableSnapshotSql, type RecoveryTableSpec, type SystemRecoveryRow, type SystemRecoveryTable } from "../../shared/contracts/system-recovery-image";
import { stableJson } from "../../shared/domain/content-addressing";
import { openStoreArchiveEntry } from "../../shared/domain/research-archive";
import { RECOVERY_SCHEMA_SHA256, RECOVERY_SCHEMA_STATEMENTS, RECOVERY_TABLES, RECOVERY_SEED_TABLE_ROWS, RECOVERY_MIGRATIONS } from "../../worker/recovery/trusted-schema";
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource, nodeRecoveryFileSha256, recoverySqlIdentifier as quote, writePrivateRecoveryStream } from "./system-backup-node-io";

export interface RestoreSystemBackupOptions { archivePath: string; destination: string; expectedSha256?: string }
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error(`Offline system recovery rejected: ${reason}`); }
function insertRow(database: DatabaseSync, spec: RecoveryTableSpec, row: SystemRecoveryRow) {
  const values = row.cells.map(recoveryCellBinding), columns = [...spec.columns];
  if (!spec.withoutRowid) { columns.unshift("rowid"); values.unshift({ expression: "CAST(? AS INTEGER)", value: row.rowid }); }
  database.prepare(`INSERT INTO ${quote(spec.name)} (${columns.map(quote).join(",")}) VALUES (${values.map(value => value.expression).join(",")})`)
    .run(...values.map(value => value.value));
}
function rowsEqual(left: SystemRecoveryTable, right: SystemRecoveryTable) {
  return stableJson(left.columns) === stableJson(right.columns)
    && stableJson(left.rows.map(stableJson).sort()) === stableJson(right.rows.map(stableJson).sort());
}
function readTable(database: DatabaseSync, spec: RecoveryTableSpec): SystemRecoveryTable {
  const rows = database.prepare(recoveryTableSnapshotSql(spec)).all() as { rowid: string | null; cells: string }[];
  return { columns: [...spec.columns], rows: rows.map(row => ({ rowid: row.rowid, cells: JSON.parse(row.cells) })) };
}
function assertInert(database: DatabaseSync) {
  ensure(database.prepare("SELECT state FROM system_recovery_maintenance WHERE singleton=1").get()?.state === "fenced", "maintenance_not_fenced");
  for (const table of ["file_shadow_runtime_guard", "file_authority_runtime_guard", "file_job_runtime_guard", "system_recovery_runtime"])
    ensure(database.prepare(`SELECT enabled FROM ${quote(table)}`).get()?.enabled === 0, `execution_guard:${table}`);
  for (const table of ["system_storage_native_bindings", "file_job_cleanup_grants", "system_research_package_cleanup_grants",
    "file_shadow_runtime_incarnations", "system_recovery_jobs", "system_recovery_write_leases", "system_recovery_target_claim", "system_recovery_target_files"])
    ensure(database.prepare(`SELECT count(*) AS count FROM ${quote(table)}`).get()?.count === 0, `installation_capability:${table}`);
}

/** A bounded capsule can be recovered in one private local SQLite transaction
 * without the website's atomic D1 command-count limit. Addresses and historical
 * jobs stay exact and inert; this creates neither provider access nor deployment. */
export async function restoreSystemBackupToIsolatedDirectory(options: RestoreSystemBackupOptions) {
  const destination = resolve(options.destination), inputSource = await nodeRecoveryArchiveSource(resolve(options.archivePath));
  ensure(inputSource.byteSize <= SYSTEM_BACKUP_MAX_ARCHIVE_BYTES, "archive_budget");
  await mkdir(destination, { mode: 0o700 });
  let database: DatabaseSync | undefined, completed = false;
  try {
    // Freeze bounded input bytes before parsing or extracting. Every later
    // range read uses this private copy, never a reopened mutable input path.
    const originalArchivePath = join(destination, "original-archive.zip");
    await writePrivateRecoveryStream(originalArchivePath, await inputSource.open!(0, inputSource.byteSize));
    const source = await nodeRecoveryArchiveSource(originalArchivePath), sourceHash = await nodeRecoveryFileSha256(originalArchivePath);
    ensure(sourceHash.byteSize === inputSource.byteSize && (!options.expectedSha256 || options.expectedSha256 === sourceHash.sha256), "archive_sha256");
    const admitted = await validateVersionedSystemBackupArchive(source, { ...NODE_RECOVERY_ARCHIVE_OPTIONS, expectedSha256: sourceHash.sha256 });
    ensure(admitted.manifest.completeness === "complete", "partial_backup_not_complete_recovery");
    const byteDirectory = join(destination, "files"), metadataDirectory = join(destination, "metadata");
    await mkdir(byteDirectory, { mode: 0o700 }); await mkdir(metadataDirectory, { mode: 0o700 }); await mkdir(join(destination, "report"), { mode: 0o700 });
    for (const entry of admitted.entries) {
      const path = join(destination, entry.kind === "metadata" ? `metadata/${entry.path}` : entry.path);
      await writePrivateRecoveryStream(path, await openStoreArchiveEntry(source, entry, NODE_RECOVERY_ARCHIVE_OPTIONS));
    }
    ensure((await nodeRecoveryFileSha256(originalArchivePath)).sha256 === admitted.sha256, "retained_original_archive_changed");
    if (admitted.format === "v2") {
      const result = await restorePortableSystemBackupIntoDirectory({ directory: destination, archiveSha256: admitted.sha256,
        manifest: admitted.manifest, records: admitted.records });
      completed = true; return result;
    }
    const databasePath = join(destination, "database.sqlite"); await writeFile(databasePath, new Uint8Array(), { flag: "wx", mode: 0o600 });
    database = new DatabaseSync(databasePath); database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;");
    let statements = 0, recoveredRows = 0;
    try {
      // ONLY reviewed code-owned final DDL is installed. No SQL string read
      // from the archive contributes to this sequence, including provenance.
      for (const object of RECOVERY_SCHEMA_STATEMENTS.filter(object => object.type === "table")) { database.exec(object.sql); statements++; }
      for (const spec of RECOVERY_TABLES) {
        const table = spec.local ? RECOVERY_SEED_TABLE_ROWS[spec.name] : admitted.records.image.tables[spec.name];
        for (const recorded of table.rows) {
          const row = structuredClone(recorded);
          if (spec.name === "system_recovery_runtime") {
            for (const name of ["installation_id", "incarnation"]) {
              const index = spec.columns.indexOf(name); if (index >= 0) row.cells[index] = { type: "text", value: randomBytes(16).toString("hex") };
            }
            row.cells[spec.columns.indexOf("updated_at")] = { type: "text", value: new Date().toISOString() };
          }
          if (spec.name === "system_recovery_maintenance") {
            row.cells[spec.columns.indexOf("state")] = { type: "text", value: "fenced" };
            row.cells[spec.columns.indexOf("updated_at")] = { type: "text", value: new Date().toISOString() };
          }
          insertRow(database, spec, row); statements++; if (!spec.local) recoveredRows++;
        }
      }
      for (const type of ["index", "view", "trigger"]) for (const object of RECOVERY_SCHEMA_STATEMENTS.filter(object => object.type === type)) { database.exec(object.sql); statements++; }
      ensure(database.prepare("PRAGMA foreign_key_check").all().length === 0, "foreign_key_check");
      ensure(database.prepare("PRAGMA integrity_check").all().every(row => Object.values(row)[0] === "ok"), "integrity_check");
      const schema = database.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
      ensure(stableJson(schema) === stableJson(RECOVERY_SCHEMA_STATEMENTS), "reviewed_schema_changed");
      for (const spec of RECOVERY_TABLES.filter(spec => !spec.local)) ensure(rowsEqual(readTable(database, spec), admitted.records.image.tables[spec.name]), `exact_typed_rows:${spec.name}`);
      assertInert(database); database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    database.close(); database = undefined;
    const inventory = admitted.manifest.files.map(file => ({ ...file, localPath: file.path }));
    await writeFile(join(destination, "source-byte-inventory.json"), stableJson({ schema: "offline-system-recovery-bytes/1", backupId: admitted.records.backupId,
      sourceArchiveSha256: admitted.sha256, files: inventory }), { flag: "wx", mode: 0o600 });
    await writeFile(join(metadataDirectory, "reviewed-target-migrations.json"), stableJson({ sourceLedgerUntouched: true, migrations: RECOVERY_MIGRATIONS }), { flag: "wx", mode: 0o600 });
    const report = { kind: "offline-system-backup-recovery", backupId: admitted.records.backupId, sourceArchiveSha256: admitted.sha256,
      sourceImageSchemaSha256: RECOVERY_SCHEMA_SHA256, databasePath: "database.sqlite", originalArchivePath: "original-archive.zip",
      sourceByteInventoryPath: "source-byte-inventory.json", exactSourceRecordsPath: "metadata/records.json", tables: RECOVERY_TABLES.filter(spec => !spec.local).length,
      rows: recoveredRows, localAtomicStatements: statements, payloads: admitted.manifest.counts.packagedFiles,
      payloadBytes: admitted.manifest.counts.bytes, verification: { exactTypedRows: true, exactRowids: true, foreignKeys: true, integrity: "ok", reviewedSchema: true },
      protectedConfiguration: { status: admitted.records.protectedConfiguration.status, encryptedCellsPreserved: true, rootKeysIncluded: false },
      applicationContentBounds: "ordinary V24 valid cells; unsafe canonical integers rejected", addresses: "original source addresses retained inert; verified local bytes mapped separately",
      providerIO: false, nativeBindingsRestored: false, executionEnabled: false, maintenanceState: "fenced", deploymentChanged: false, sourceMigrationLedger: admitted.records.sourceMigrationLedger.status };
    await writeFile(join(destination, "recovery-report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
    completed = true; return { destination, databasePath, report };
  } finally { try { database?.close(); } finally { if (!completed) await rm(destination, { recursive: true, force: true }); } }
}
