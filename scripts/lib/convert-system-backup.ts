import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { restoreExportToIsolatedDirectory } from "./export-restore";
import { snapshotFullExportV24 } from "../../worker/export-v24-snapshot";
import { RECOVERY_MIGRATIONS, RECOVERY_SCHEMA_SHA256, RECOVERY_TABLES, RECOVERY_SCHEMA_STATEMENTS, RECOVERY_SEED_TABLE_ROWS } from "../../worker/recovery/trusted-schema";
import { recoveryCellBinding, recoveryTableSnapshotSql, validateSystemRecoveryImage, type SystemRecoveryImageV1 } from "../../shared/contracts/system-recovery-image";
import { finishSystemBackupManifest, planSystemBackupSources, SYSTEM_BACKUP_RECORDS_SCHEMA, systemBackupProtectedConfiguration, validateSystemBackupDocuments, type SystemBackupFile, type SystemBackupRecordsV1, type SystemBackupOutcome } from "../../shared/contracts/system-backup";
import { createSystemBackupArchiveStream, measureSystemBackupArchive, systemBackupArchiveMetadata } from "../../shared/domain/system-backup-archive";
import type { OpenArchiveEntry } from "../../shared/domain/research-archive";
import { recoverySqlIdentifier as quote, nodeRecoverySha256 as hash, NODE_RECOVERY_ARCHIVE_OPTIONS,
  nodeRecoveryFileSha256, writePrivateRecoveryStream } from "./system-backup-node-io";

/** Production Node adapter for the one-batch current content projection.
 * The adapter never installs archive SQL and never contacts a provider. */
class LocalSnapshotStatement {
  constructor(readonly sql: string) {}
}
class LocalSnapshotDatabase {
  constructor(private readonly database: DatabaseSync) {}
  prepare(sql: string) { return new LocalSnapshotStatement(sql); }
  async batch(statements: LocalSnapshotStatement[]) {
    this.database.exec("BEGIN");
    try {
      const result = statements.map(statement => ({ success: true, results: this.database.prepare(statement.sql).all(), meta: {} }));
      this.database.exec("COMMIT"); return result;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}

function installMissingReviewedLocalSchema(database: DatabaseSync) {
  const observed = new Set((database.prepare("SELECT type||':'||name AS id FROM sqlite_schema").all() as { id: string }[]).map(row => row.id));
  const missing = RECOVERY_SCHEMA_STATEMENTS.filter(statement => !observed.has(`${statement.type}:${statement.name}`));
  // Existing content migration verification already qualified every portable
  // object. Only code-owned absent configuration and local-control DDL is added.
  for (const statement of missing.filter(statement => statement.type === "table")) {
    const spec = RECOVERY_TABLES.find(table => table.name === statement.name)!;
    if (!spec.local && spec.classification !== "protected_configuration") throw new Error(`Missing canonical table after legacy restore: ${spec.name}`);
    database.exec(statement.sql);
    const seed = RECOVERY_SEED_TABLE_ROWS[spec.name];
    for (const row of seed.rows) {
      const bindings = row.cells.map(recoveryCellBinding);
      const columns = spec.withoutRowid ? spec.columns : ["rowid", ...spec.columns];
      const expressions = spec.withoutRowid ? bindings.map(binding => binding.expression) : ["CAST(? AS INTEGER)", ...bindings.map(binding => binding.expression)];
      database.prepare(`INSERT INTO ${quote(spec.name)} (${columns.map(quote).join(",")}) VALUES (${expressions.join(",")})`)
        .run(...(spec.withoutRowid ? [] : [row.rowid]), ...bindings.map(binding => binding.value));
    }
  }
  for (const statement of missing.filter(statement => statement.type !== "table")) database.exec(statement.sql);
  if (database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Converted legacy image failed its foreign-key check");
}

export interface ConvertLegacySystemBackupOptions {
  archivePath: string; destination: string; migrationsDirectory: string;
}

/** Historical 256 MiB isolated-reader bounds remain unchanged. The resulting
 * website capsule independently satisfies the 100/96/4 MiB and 100-file limits. */
export async function convertLegacySystemBackup(options: ConvertLegacySystemBackupOptions) {
  const destination = resolve(options.destination);
  await mkdir(destination, { mode: 0o700 });
  let database: DatabaseSync | undefined, completed = false;
  try {
    const contentMigrations = join(destination, "reviewed-content-migrations");
    await mkdir(contentMigrations, { mode: 0o700 });
    // 0021 is installation local and never joins the content forward chain.
    // Portable 0022 is the reviewed V24 successor; earlier migration bytes and
    // profile validators retain their exact historical behavior.
    for (const migration of RECOVERY_MIGRATIONS.filter(migration => migration.name !== "0021_fp5_system_recovery.sql")) {
      const bytes = await readFile(join(options.migrationsDirectory, migration.name));
      if (hash(bytes) !== migration.sha256) throw new Error(`Reviewed migration differs: ${migration.name}`);
      await writeFile(join(contentMigrations, migration.name), bytes, { flag: "wx", mode: 0o600 });
    }
    const restored = await restoreExportToIsolatedDirectory({ archivePath: resolve(options.archivePath),
      destination: join(destination, "legacy"), migrationsDirectory: contentMigrations, targetCompatibilitySchema: "S2" });
    database = new DatabaseSync(join(restored.restoredDirectory, "database.sqlite"));
    installMissingReviewedLocalSchema(database);
    const content = await snapshotFullExportV24(new LocalSnapshotDatabase(database) as unknown as D1Database);
    const image: SystemRecoveryImageV1 = { version: 1, kind: "system-recovery-image", schemaSha256: RECOVERY_SCHEMA_SHA256,
      sourceSnapshotClock: content.artifacts.sourceSchema.value.snapshotClock, tables: {} };
    for (const spec of RECOVERY_TABLES.filter(table => !table.local)) {
      const rows = database.prepare(recoveryTableSnapshotSql(spec)).all() as { rowid: string | null; cells: string }[];
      image.tables[spec.name] = { columns: [...spec.columns], rows: rows.map(row => ({ rowid: row.rowid, cells: JSON.parse(row.cells) })) };
    }
    validateSystemRecoveryImage(image);
    const originalArchive = join(restored.restoredDirectory, "original-archive.zip");
    const artifacts: Record<string, unknown> = {};
    for (const artifactPath of restored.report.retainedArtifactPaths) {
      const bytes = await readFile(join(restored.restoredDirectory, artifactPath));
      artifacts[artifactPath] = { path: artifactPath, byteSize: bytes.length, sha256: hash(bytes), retainedOffline: true,
        ...(artifactPath.endsWith("retired-fields.json") ? { value: JSON.parse(bytes.toString("utf8")), originalText: bytes.toString("utf8") } : {}) };
    }
    const records: SystemBackupRecordsV1 = { schema: SYSTEM_BACKUP_RECORDS_SCHEMA, backupId: crypto.randomUUID(), createdAt: new Date().toISOString(), content, image,
      protectedConfiguration: systemBackupProtectedConfiguration(image, "excluded_legacy_content"),
      sourceMigrationLedger: { status: "unavailable", entries: [] },
      origin: { format: "legacy-converted", schemaVersion: restored.report.schemaVersion, archiveSha256: restored.report.archiveSha256,
        legacyArtifacts: { sourceSchemaEvidence: restored.report.sourceSchemaEvidence, artifacts }, migrationEvidence: restored.report.migrations } };
    const providerManifest = JSON.parse(await readFile(join(restored.restoredDirectory, "provider-manifest.json"), "utf8")) as Array<{ locatorId: string; path: string | null; sha256: string | null; outcome: string }>;
    const byLocator = new Map(providerManifest.map(entry => [entry.locatorId, entry]));
    const paths = new Map<string, string>();
    const files: SystemBackupFile[] = [];
    for (const source of planSystemBackupSources(content)) {
      const original = byLocator.get(source.source.locatorId);
      if (!original) throw new Error(`Current recovery source absent from the historical byte inventory: ${source.source.locatorId}`);
      if (original.outcome === "packaged" && original.path && original.sha256) {
        const path = `files/${source.id}`, localPath = join(restored.restoredDirectory, original.path);
        paths.set(path, localPath);
        files.push({ ...source, path, outcome: "packaged", byteSize: (await stat(localPath)).size, sha256: original.sha256 });
      } else {
        const outcome = original.outcome === "metadata_not_ready" ? "metadata_unavailable" : original.outcome;
        files.push({ ...source, path: null, outcome: outcome as SystemBackupOutcome, byteSize: null, sha256: null });
      }
    }
    const manifest = await finishSystemBackupManifest(records, files);
    await validateSystemBackupDocuments(manifest, records, { schemaSha256: RECOVERY_SCHEMA_SHA256, tables: RECOVERY_TABLES });
    const metadata = await systemBackupArchiveMetadata(manifest, records, manifest);
    const openPayload: OpenArchiveEntry = async (entry, signal) => {
      const path = paths.get(entry.path); if (!path) throw new Error("Converted payload is not in its verified inventory");
      return Readable.toWeb(createReadStream(path, { highWaterMark: 64 * 1024, signal })) as ReadableStream<Uint8Array>;
    };
    const archiveOptions = NODE_RECOVERY_ARCHIVE_OPTIONS;
    const measurement = await measureSystemBackupArchive(metadata, openPayload, archiveOptions);
    const convertedArchivePath = join(destination, "system-backup.zip");
    await writePrivateRecoveryStream(convertedArchivePath, createSystemBackupArchiveStream(metadata, openPayload, archiveOptions));
    const emitted = await nodeRecoveryFileSha256(convertedArchivePath);
    if (emitted.byteSize !== measurement.byteSize || emitted.sha256 !== measurement.sha256) throw new Error("Converted archive differs from its qualified measurement");
    const report = { kind: "legacy-system-backup-conversion", sourceSchemaVersion: restored.report.schemaVersion, sourceArchiveSha256: restored.report.archiveSha256,
      sourceSchemaEvidence: restored.report.sourceSchemaEvidence, archivePath: "system-backup.zip", archiveByteSize: measurement.byteSize, archiveSha256: measurement.sha256,
      originalArchivePath: originalArchive.slice(destination.length + 1), retainedArtifacts: records.origin.legacyArtifacts,
      completeness: manifest.completeness, counts: manifest.counts, protectedSettings: "excluded_legacy_content",
      exactRecordedRowids: restored.report.schemaVersion >= 15,
      sourceRowidEvidence: restored.report.schemaVersion >= 15 ? "recorded-file-consumer-rowids" : "unavailable-in-source-archive",
      unrecordedHistoricalRowids: "assigned-by-reviewed-isolated-restore", providerIO: false,
      executionResumed: false, nativeBindingsRestored: false, verification: restored.report.verification };
    await writeFile(join(destination, "conversion-report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
    database.close(); database = undefined; completed = true;
    return { destination, archivePath: convertedArchivePath, report };
  } finally {
    try { database?.close(); } finally { if (!completed) await rm(destination, { recursive: true, force: true }); }
  }
}
