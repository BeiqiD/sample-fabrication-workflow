import type { DatabaseSync } from "node:sqlite";
import { buildFullExportV26FromSnapshot, nativeV26SnapshotSql } from "../../worker/export-v26-core";
import { createFullExportV26, checkedPortableApplicationSchemaV26, portableBusinessSchemaV26 } from "../../shared/contracts/export-portable-runtime-v26";
import type { ExportSchemaObject } from "../../shared/contracts/export";
import { NODE_PLATFORM_OBJECTS } from "../../shared/contracts/node-installation-schema";
import { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, PORTABLE_RUNTIME_RECOVERY_TABLES } from "../../shared/contracts/portable-runtime-v26-recovery-catalog";
import { recoveryTableSnapshotSql } from "../../shared/contracts/system-recovery-image";
import { protectedIdentityPolicy, validateSystemBackupRecordsV3, validateNodeMigrationProvenanceV3, validateSystemRecoveryImageV3, type NodeSystemBackupRecordsV3 } from "../../shared/contracts/system-backup-v3";
import { SYSTEM_BACKUP_MAX_RECORDS_BYTES } from "../../shared/contracts/system-backup";
import { systemBackupProtectedConfigurationV3 } from "../../shared/contracts/system-backup-v3";
import { validateSystemBackupContentImageV26 } from "../../shared/contracts/system-backup-v26-content";
import { stableJson } from "../../shared/domain/content-addressing";
import { createNodeExportSnapshotReader } from "../export-snapshot-sql";
import { V26_NODE_INSTALLATION_CATALOG } from "../installation-catalog-v26";
import { admitInstallationRecoverySource } from "../migrations";
import { assertSqliteConnectionOwner, type SqliteCapability } from "../sqlite";

const tables = PORTABLE_RUNTIME_RECOVERY_TABLES.filter(table => !table.local);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function sum(values: string[]): string {
  if (values.length === 1) return values[0];
  const index = Math.floor(values.length / 2);
  return `(${sum(values.slice(0, index))}+${sum(values.slice(index))})`;
}
const count = sum(tables.map(table => `(SELECT count(*) FROM ${quote(table.name)})`));
const bytes = sum(tables.map(table => `(SELECT coalesce(sum(${sum([String(512 + table.columns.length * 80),
  ...table.columns.map(column => `coalesce(length(CAST(${quote(column)} AS BLOB)),0)*6`)])}),0) FROM ${quote(table.name)})`));
export const PORTABLE_SYSTEM_BACKUP_BUDGET_SQL = `SELECT CASE WHEN ${count}>16384 OR ${bytes}>${SYSTEM_BACKUP_MAX_RECORDS_BYTES}
  THEN json('Current system backup snapshot budget exceeded') ELSE 1 END`;
const ledgerSql = "SELECT ordinal,name,raw_sha256 AS rawSha256,checkpoint_id AS checkpointId,schema_sha256 AS schemaSha256,status,applied_at AS appliedAt FROM node_migrations ORDER BY ordinal";
const identitySql = "SELECT installation_id AS installationId,catalog_id AS catalogId,schema_checkpoint AS checkpointId,schema_sha256 AS schemaSha256,created_at AS createdAt FROM node_installation WHERE singleton=1";

/** The startup/maintenance owner must keep ALL application writers and byte
 * mutation/GC quiesced until the captured capsule's bytes are safely copied.
 * This read-only slice does not invent persistent hold/job/provider authority.
 * Schema, canonical rows, typed protected cells and ledger share ONE actual
 * synchronous SQLite batch; later asynchronous hashing uses only frozen rows. */
export async function captureQuiescedNodeSystemBackupV26(database: SqliteCapability, nativeDatabase: DatabaseSync,
  options: { backupId: string; createdAt?: string }): Promise<NodeSystemBackupRecordsV3> {
  assertSqliteConnectionOwner(database, nativeDatabase);
  const admission = admitInstallationRecoverySource(nativeDatabase, V26_NODE_INSTALLATION_CATALOG);
  const reader = createNodeExportSnapshotReader(database), contentSql = nativeV26SnapshotSql();
  const results = await reader.readBatch([PORTABLE_SYSTEM_BACKUP_BUDGET_SQL, ...contentSql,
    ...tables.map(recoveryTableSnapshotSql), ledgerSql, identitySql]);
  const imageOffset = contentSql.length + 1;
  if (results.length !== imageOffset + tables.length + 2 || results.some(result => !result.success || !Array.isArray(result.results)))
    throw new Error("Current system backup snapshot incomplete");
  let applicationObjects: ExportSchemaObject[] | undefined;
  const business = await buildFullExportV26FromSnapshot(results.slice(1, imageOffset), {
    backupHoldOwner: null,
    async projectSchema(observed) {
      const platform = observed.filter(object => object.sql !== null && NODE_PLATFORM_OBJECTS.some(value => value.name === object.name));
      if (stableJson(platform) !== stableJson(NODE_PLATFORM_OBJECTS)) throw new Error("Current system backup platform schema changed");
      applicationObjects = await checkedPortableApplicationSchemaV26(observed.filter(object => !NODE_PLATFORM_OBJECTS.some(value => value.name === object.tableName)));
      return portableBusinessSchemaV26(applicationObjects);
    },
  });
  if (!applicationObjects) throw new Error("Current system backup application schema missing");
  const content = await createFullExportV26(business, applicationObjects);
  const image = validateSystemRecoveryImageV3({ version: 3, kind: "system-recovery-image", checkpointId: PORTABLE_RUNTIME_CHECKPOINT_ID,
    schemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, sourceSnapshotClock: content.artifacts.sourceSchema.value.snapshotClock,
    tables: Object.fromEntries(tables.map((table, index) => [table.name, { columns: [...table.columns],
      rows: (results[imageOffset + index].results as Array<{ rowid: string | null; cells: string }>).map(row => ({ rowid: row.rowid, cells: JSON.parse(row.cells) })) }])) });
  await validateSystemBackupContentImageV26(content, image);
  const identity = results[imageOffset + tables.length + 1].results;
  if (identity.length !== 1) throw new Error("Current system backup installation identity missing");
  const sourceMigrationLedger = validateNodeMigrationProvenanceV3({ kind: "node-reviewed-migrations/1", ...identity[0] as Record<string, unknown>,
    entries: results[imageOffset + tables.length].results });
  if (sourceMigrationLedger.installationId !== admission.receipt.installationId || sourceMigrationLedger.schemaSha256 !== admission.receipt.schemaSha256)
    throw new Error("Current system backup installation changed during snapshot");
  const records: NodeSystemBackupRecordsV3 = { schema: "system-backup-records/3", backupId: options.backupId,
    createdAt: options.createdAt ?? new Date().toISOString(), content, image, sourceMigrationLedger,
    protectedConfiguration: systemBackupProtectedConfigurationV3(image), protectedIdentity: protectedIdentityPolicy(),
    origin: { format: "native", schemaVersion: 26, capturePolicy: "quiesced-writers-and-bytes/1" } };
  if (new TextEncoder().encode(stableJson(records)).byteLength > SYSTEM_BACKUP_MAX_RECORDS_BYTES) throw new Error("Current system backup records budget exceeded");
  await validateSystemBackupRecordsV3(records);
  return records;
}
