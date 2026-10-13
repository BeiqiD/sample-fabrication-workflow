// Inactive paired V28 candidate only. No operational/live/offline default selects this module.
import type { DatabaseSync } from "node:sqlite";
import { buildFullExportV28FromSnapshot, nativeV28SnapshotSql, NATIVE_V28_SNAPSHOT_TABLE_NAMES } from "../../worker/export-v28-core.ts";
import { checkedNativeRetentionSnapshot } from "../../worker/export-native-retention-snapshot.ts";
import { createFullExportV28, checkedPortableApplicationSchemaV28, portableBusinessSchemaV28 } from "../../shared/contracts/export-portable-runtime-v28.ts";
import type { ExportSchemaObject } from "../../shared/contracts/export.ts";
import { NODE_PLATFORM_OBJECTS } from "../../shared/contracts/node-installation-schema.ts";
import { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, PORTABLE_RUNTIME_RECOVERY_TABLES } from "../../shared/contracts/portable-runtime-v28-recovery-catalog.ts";
import { recoveryTableSnapshotSql } from "../../shared/contracts/system-recovery-image.ts";
import { protectedIdentityPolicy, validateSystemBackupRecordsV5, validateNodeMigrationProvenanceV5, validateSystemRecoveryImageV5, type NodeSystemBackupRecordsV5 } from "../../shared/contracts/system-backup-v5.ts";
import { SYSTEM_BACKUP_MAX_RECORDS_BYTES } from "../../shared/contracts/system-backup.ts";
import { systemBackupProtectedConfigurationV5, collaborationRecoveryPolicyV28, protectedLocalHistoryFromV5Image } from "../../shared/contracts/system-backup-v5.ts";
import { validateSystemBackupContentImageV28 } from "../../shared/contracts/system-backup-v28-content.ts";
import { stableJson } from "../../shared/domain/content-addressing.ts";
import { createNodeExportSnapshotReader } from "../export-snapshot-sql.ts";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate.ts";
import { admitInstallationRecoverySource } from "../migrations.ts";
import { assertSqliteConnectionOwner, type SqliteCapability } from "../sqlite.ts";

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
    OR (SELECT count(*) FROM collaboration_control)<>1
  OR NOT EXISTS(SELECT 1 FROM collaboration_control WHERE singleton=1 AND schema_version=2 AND enforcement IN('disabled','enabled') AND typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991)
  THEN json('Current system backup snapshot budget or collaboration control rejected') ELSE 1 END`;
const ledgerSql = "SELECT ordinal,name,raw_sha256 AS rawSha256,checkpoint_id AS checkpointId,schema_sha256 AS schemaSha256,status,applied_at AS appliedAt FROM node_migrations ORDER BY ordinal";
const identitySql = "SELECT installation_id AS installationId,catalog_id AS catalogId,schema_checkpoint AS checkpointId,schema_sha256 AS schemaSha256,created_at AS createdAt FROM node_installation WHERE singleton=1";

/** The startup/maintenance owner must keep ALL application writers and byte
 * mutation/GC quiesced until the captured capsule's bytes are safely copied.
 * This read-only slice does not invent persistent hold/job/provider authority.
 * Schema, canonical rows, typed protected cells and ledger share ONE actual
 * synchronous SQLite batch; later asynchronous hashing uses only frozen rows. */
export async function captureQuiescedNodeSystemBackupV28Candidate(database: SqliteCapability, nativeDatabase: DatabaseSync,
  options: { backupId: string; createdAt?: string }): Promise<NodeSystemBackupRecordsV5> {
  assertSqliteConnectionOwner(database, nativeDatabase);
  const admission = admitInstallationRecoverySource(nativeDatabase, V28_NODE_INSTALLATION_CATALOG_CANDIDATE);
  const reader = createNodeExportSnapshotReader(database), contentSql = nativeV28SnapshotSql();
  const results = await reader.readBatch([PORTABLE_SYSTEM_BACKUP_BUDGET_SQL, ...contentSql,
    ...tables.map(recoveryTableSnapshotSql), ledgerSql, identitySql]);
  const imageOffset = contentSql.length + 1;
  if (results.length !== imageOffset + tables.length + 2 || results.some(result => !result.success || !Array.isArray(result.results)))
    throw new Error("Current system backup snapshot incomplete");
  const snapshotClock = checkedNativeRetentionSnapshot(results[1 + NATIVE_V28_SNAPSHOT_TABLE_NAMES.length + 5].results).snapshotClock;
  const image = validateSystemRecoveryImageV5({ version: 5, kind: "system-recovery-image", checkpointId: PORTABLE_RUNTIME_CHECKPOINT_ID,
    schemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, sourceSnapshotClock: snapshotClock,
    tables: Object.fromEntries(tables.map((table, index) => [table.name, { columns: [...table.columns],
      rows: (results[imageOffset + index].results as Array<{ rowid: string | null; cells: string }>).map(row => ({ rowid: row.rowid, cells: JSON.parse(row.cells) })) }])) });
  const protectedLocalHistory = protectedLocalHistoryFromV5Image(image);
  let applicationObjects: ExportSchemaObject[] | undefined;
  const business = await buildFullExportV28FromSnapshot(results.slice(1, imageOffset), {
    backupHoldOwner: null,
    protectedLocalHistory,
    async projectSchema(observed) {
      const platform = observed.filter(object => object.sql !== null && NODE_PLATFORM_OBJECTS.some(value => value.name === object.name));
      if (stableJson(platform) !== stableJson(NODE_PLATFORM_OBJECTS)) throw new Error("Current system backup platform schema changed");
      applicationObjects = await checkedPortableApplicationSchemaV28(observed.filter(object => !NODE_PLATFORM_OBJECTS.some(value => value.name === object.tableName)));
      return portableBusinessSchemaV28(applicationObjects);
    },
  });
  if (!applicationObjects) throw new Error("Current system backup application schema missing");
  const content = await createFullExportV28(business, applicationObjects, protectedLocalHistory);
  if (content.artifacts.sourceSchema.value.snapshotClock !== image.sourceSnapshotClock) throw new Error("Current system backup source clocks changed");
  await validateSystemBackupContentImageV28(content, image);
  const identity = results[imageOffset + tables.length + 1].results;
  if (identity.length !== 1) throw new Error("Current system backup installation identity missing");
  const sourceMigrationLedger = validateNodeMigrationProvenanceV5({ kind: "node-reviewed-migrations/1", ...identity[0] as Record<string, unknown>,
    entries: results[imageOffset + tables.length].results });
  if (sourceMigrationLedger.installationId !== admission.receipt.installationId || sourceMigrationLedger.schemaSha256 !== admission.receipt.schemaSha256)
    throw new Error("Current system backup installation changed during snapshot");
  const records: NodeSystemBackupRecordsV5 = { schema: "system-backup-records/5", backupId: options.backupId,
    createdAt: options.createdAt ?? new Date().toISOString(), content, image, sourceMigrationLedger,
    protectedConfiguration: systemBackupProtectedConfigurationV5(image), protectedIdentity: protectedIdentityPolicy(),
    collaborationPolicy: collaborationRecoveryPolicyV28(),
    origin: { format: "native", schemaVersion: 28, capturePolicy: "quiesced-writers-and-bytes/1" } };
  if (new TextEncoder().encode(stableJson(records)).byteLength > SYSTEM_BACKUP_MAX_RECORDS_BYTES) throw new Error("Current system backup records budget exceeded");
  await validateSystemBackupRecordsV5(records);
  return records;
}
