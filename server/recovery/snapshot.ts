import type { DatabaseSync } from "node:sqlite";
import { buildFullExportV24FromSnapshot, nativeV24SnapshotSql } from "../../worker/export-v24-core";
import { createFullExportV25, checkedPortableApplicationSchema, portableBusinessSchema } from "../../shared/contracts/export-portable-runtime";
import type { ExportSchemaObject } from "../../shared/contracts/export";
import { NODE_PLATFORM_OBJECTS } from "../../shared/contracts/node-installation-schema";
import { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, PORTABLE_RUNTIME_RECOVERY_TABLES } from "../../shared/contracts/portable-runtime-recovery-catalog";
import { recoveryTableSnapshotSql } from "../../shared/contracts/system-recovery-image";
import { protectedIdentityPolicy, validateNodeMigrationProvenance, validateSystemRecoveryImageV2, type NodeSystemBackupRecordsV2 } from "../../shared/contracts/system-backup-v2";
import { SYSTEM_BACKUP_MAX_RECORDS_BYTES, systemBackupProtectedConfiguration, validateSystemBackupContentImage } from "../../shared/contracts/system-backup";
import { stableJson } from "../../shared/domain/content-addressing";
import { createNodeExportSnapshotReader } from "../export-snapshot-sql";
import { CURRENT_NODE_INSTALLATION_CATALOG } from "../installation-catalog";
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
export async function captureQuiescedNodeSystemBackup(database: SqliteCapability, nativeDatabase: DatabaseSync,
  options: { backupId: string; createdAt?: string }): Promise<NodeSystemBackupRecordsV2> {
  assertSqliteConnectionOwner(database, nativeDatabase);
  const admission = admitInstallationRecoverySource(nativeDatabase, CURRENT_NODE_INSTALLATION_CATALOG);
  const reader = createNodeExportSnapshotReader(database), contentSql = nativeV24SnapshotSql();
  const results = await reader.readBatch([PORTABLE_SYSTEM_BACKUP_BUDGET_SQL, ...contentSql,
    ...tables.map(recoveryTableSnapshotSql), ledgerSql, identitySql]);
  const imageOffset = contentSql.length + 1;
  if (results.length !== imageOffset + tables.length + 2 || results.some(result => !result.success || !Array.isArray(result.results)))
    throw new Error("Current system backup snapshot incomplete");
  let applicationObjects: ExportSchemaObject[] | undefined;
  const business = await buildFullExportV24FromSnapshot(results.slice(1, imageOffset), {
    backupHoldOwner: null,
    async projectSchema(observed) {
      const platform = observed.filter(object => object.sql !== null && NODE_PLATFORM_OBJECTS.some(value => value.name === object.name));
      if (stableJson(platform) !== stableJson(NODE_PLATFORM_OBJECTS)) throw new Error("Current system backup platform schema changed");
      applicationObjects = await checkedPortableApplicationSchema(observed.filter(object => !NODE_PLATFORM_OBJECTS.some(value => value.name === object.tableName)));
      return portableBusinessSchema(applicationObjects);
    },
  });
  if (!applicationObjects) throw new Error("Current system backup application schema missing");
  const content = await createFullExportV25(business, applicationObjects);
  const image = validateSystemRecoveryImageV2({ version: 2, kind: "system-recovery-image", checkpointId: PORTABLE_RUNTIME_CHECKPOINT_ID,
    schemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, sourceSnapshotClock: content.artifacts.sourceSchema.value.snapshotClock,
    tables: Object.fromEntries(tables.map((table, index) => [table.name, { columns: [...table.columns],
      rows: (results[imageOffset + index].results as Array<{ rowid: string | null; cells: string }>).map(row => ({ rowid: row.rowid, cells: JSON.parse(row.cells) })) }])) });
  await validateSystemBackupContentImage(business, image);
  const identity = results[imageOffset + tables.length + 1].results;
  if (identity.length !== 1) throw new Error("Current system backup installation identity missing");
  const sourceMigrationLedger = validateNodeMigrationProvenance({ kind: "node-reviewed-migrations/1", ...identity[0] as Record<string, unknown>,
    entries: results[imageOffset + tables.length].results });
  if (sourceMigrationLedger.installationId !== admission.receipt.installationId || sourceMigrationLedger.schemaSha256 !== admission.receipt.schemaSha256)
    throw new Error("Current system backup installation changed during snapshot");
  const records: NodeSystemBackupRecordsV2 = { schema: "system-backup-records/2", backupId: options.backupId,
    createdAt: options.createdAt ?? new Date().toISOString(), content, image, sourceMigrationLedger,
    protectedConfiguration: systemBackupProtectedConfiguration(image), protectedIdentity: protectedIdentityPolicy(),
    origin: { format: "native", schemaVersion: 25, capturePolicy: "quiesced-writers-and-bytes/1" } };
  if (new TextEncoder().encode(stableJson(records)).byteLength > SYSTEM_BACKUP_MAX_RECORDS_BYTES) throw new Error("Current system backup records budget exceeded");
  return records;
}
