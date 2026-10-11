// Fixed, inactive V28 recovery destination only. Never upgrades an existing DB.
import { randomUUID } from "node:crypto";
import { constants, type DatabaseSync } from "node:sqlite";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE as catalog } from "../installation-catalog-v28-candidate";
import { installationSchemaDigest, installationSqlDigest, admitInstallationRecoverySource,
  type InstallationReceipt } from "../migrations";
import { NODE_PLATFORM_OBJECTS, type InstallationSchemaObject } from "../../shared/contracts/node-installation-schema";
import { PORTABLE_RUNTIME_SCHEMA_STATEMENTS as schema, PORTABLE_RUNTIME_RECOVERY_TABLES as tables,
  PORTABLE_RUNTIME_SEED_TABLE_ROWS as seeds } from "../../worker/recovery/portable-runtime-v28-trusted-schema";
import { PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256 } from "../../shared/contracts/portable-runtime-v28-recovery-catalog";
import { recoveryCellBinding } from "../../shared/contracts/system-recovery-image";
import { stableJson } from "../../shared/domain/content-addressing";

const checkpointId = "portable-runtime/v28";
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error(`v28_empty_recovery_target_${reason}`); }
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function reviewedLineage() {
  ensure(catalog.id === "sample-fabrication-workflow/sqlite-v1" && catalog.migrations.length === 26, "catalog");
  const names = new Set<string>(), checkpoints = new Set<string>(); let bytes = 0;
  for (const value of [catalog.emptyCheckpoint, ...catalog.migrations.map(migration => migration.checkpoint)]) {
    ensure(!checkpoints.has(value.id) && /^[A-Za-z0-9._/-]{1,160}$/.test(value.id), "checkpoint"); checkpoints.add(value.id);
    ensure(value.applicationObjects.every(object => !object.name.startsWith("sqlite_")
      && !NODE_PLATFORM_OBJECTS.some(platform => object.name === platform.name || object.tableName === platform.name)), "platform_collision");
    const digest = installationSchemaDigest([...value.applicationObjects, ...NODE_PLATFORM_OBJECTS]);
    ensure(value.schemaSha256 === digest && value.recoveryAdmission.kind === "node-installation-recovery-admission/1"
      && value.recoveryAdmission.checkpointId === value.id && value.recoveryAdmission.schemaSha256 === digest
      && stableJson(value.recoveryAdmission.platformObjects) === stableJson(NODE_PLATFORM_OBJECTS), "checkpoint_pair");
  }
  ensure(catalog.emptyCheckpoint.applicationObjects.length === 0, "empty_checkpoint");
  for (const migration of catalog.migrations) {
    ensure(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,159}$/.test(migration.name) && !names.has(migration.name)
      && migration.rawSha256 === installationSqlDigest(migration.sql), "raw_lineage"); names.add(migration.name);
    bytes += Buffer.byteLength(migration.sql); ensure(bytes <= 16 * 1024 * 1024, "lineage_budget");
  }
  const final = catalog.migrations.at(-1)!.checkpoint;
  ensure(final.id === checkpointId && final.schemaSha256 === PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256[checkpointId]
    && stableJson(final.applicationObjects) === stableJson(schema), "final_schema_pair");
  return final;
}
function empty(database: DatabaseSync) {
  ensure(database.prepare("SELECT name FROM sqlite_schema").all().length === 0, "nonempty_main");
  ensure(database.prepare("SELECT name FROM sqlite_temp_schema").all().length === 0, "nonempty_temp");
  ensure(database.prepare("PRAGMA database_list").all().every(value => value.name === "main" || value.name === "temp"), "attached_namespace");
}
type Authorizer = (action: number, first: string | null, second: string | null, schema: string | null, trigger: string | null) => number;
type AuthorizedNative = DatabaseSync & { setAuthorizer(policy: Authorizer | null): void };

/** The closed schema/lineage fields represent the implemented reviewed target
 * checkpoint, NOT historical SQL execution. This receipt is persisted by the
 * destination owner, separate from the untouched source migration provenance.
 * No archived SQL, cells, callbacks or destination catalog are accepted here. */
export function constructEmptyV28RecoveryTargetCandidate(database: DatabaseSync): {
  installation: InstallationReceipt;
  construction: {
    kind: "reviewed-empty-recovery-checkpoint-construction/v28";
    constructionProvenance: "reviewed-final-schema";
    rawMigrationExecution: false;
    nativeLedgerMeaning: "implemented-reviewed-checkpoint-lineage";
    destinationInstallationId: string; checkpointId: string; schemaSha256: string;
    reviewedLineage: readonly { ordinal: number; name: string; rawSha256: string; checkpointId: string; schemaSha256: string }[];
  };
} {
  const final = reviewedLineage();
  ensure(database.isOpen && !database.isTransaction, "connection_not_quiesced");
  ensure(database.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal"
    && database.prepare("PRAGMA foreign_keys").get()?.foreign_keys === 1, "owned_wal_and_fk_required");
  empty(database);
  const native = database as AuthorizedNative, action = constants as unknown as Record<string, number>;
  ensure(typeof native.setAuthorizer === "function" && ["SQLITE_OK", "SQLITE_DENY", "SQLITE_TRANSACTION", "SQLITE_SAVEPOINT", "SQLITE_ATTACH", "SQLITE_DETACH", "SQLITE_PRAGMA"]
    .every(name => Number.isSafeInteger(action[name])), "native_authorizer_required");
  const policy: Authorizer = (code, _first, _second, namespace) => namespace !== null && namespace !== "main"
    || [action.SQLITE_TRANSACTION, action.SQLITE_SAVEPOINT, action.SQLITE_ATTACH, action.SQLITE_DETACH, action.SQLITE_PRAGMA].includes(code)
    ? action.SQLITE_DENY! : action.SQLITE_OK!;
  let clearAttempted = false, clearFailed = false, clearFailure: unknown;
  function clearOriginal() {
    if (clearAttempted) { if (clearFailed) throw clearFailure; return; }
    clearAttempted = true;
    try { native.setAuthorizer(null); }
    catch (error) { clearFailed = true; clearFailure = error; throw error; }
  }
  database.enableLoadExtension(false); database.exec("PRAGMA busy_timeout=5000");
  const installationId = randomUUID(), clock = new Date().toISOString();
  // Closed typed seeds follow table-name order, not foreign-key dependency
  // order. As in the actual image restorer, validate the complete graph before
  // COMMIT and restore FK enforcement even after a failed construction.
  database.exec("PRAGMA foreign_keys=OFF");
  let failed = false, failure: unknown;
  try {
    database.exec("BEGIN EXCLUSIVE");
    empty(database);
    let workFailed = false, workFailure: unknown;
    try {
      native.setAuthorizer(policy);
      for (const object of NODE_PLATFORM_OBJECTS) database.exec(object.sql);
      for (const object of schema.filter(object => object.type === "table")) database.exec(object.sql);
      for (const spec of tables) {
        const seed = seeds[spec.name]; ensure(seed && stableJson(seed.columns) === stableJson(spec.columns), `seed:${spec.name}`);
        for (const row of seed.rows) {
          const columns = [...spec.columns], values = row.cells.map(recoveryCellBinding);
          if (!spec.withoutRowid) { columns.unshift("rowid"); values.unshift({ expression: "CAST(? AS INTEGER)", value: row.rowid }); }
          database.prepare(`INSERT INTO ${quote(spec.name)} (${columns.map(quote).join(",")}) VALUES (${values.map(value => value.expression).join(",")})`).run(...values.map(value => value.value));
        }
      }
      for (const type of ["index", "view", "trigger"] as const)
        for (const object of schema.filter(object => object.type === type)) database.exec(object.sql);
      database.prepare("INSERT INTO node_installation VALUES(1,?,?,?,?,?)")
        .run(installationId, catalog.id, final.id, final.schemaSha256, clock);
      for (const [index, migration] of catalog.migrations.entries()) database.prepare("INSERT INTO node_migrations VALUES(?,?,?,?,?,'applied',?)")
        .run(index + 1, migration.name, migration.rawSha256, migration.checkpoint.id, migration.checkpoint.schemaSha256, clock);
    } catch (error) { workFailed = true; workFailure = error; throw error; }
    finally {
      try { clearOriginal(); }
      catch (error) {
        throw workFailed ? new AggregateError([workFailure, error], "Empty target construction and original authorizer clear failed") : error;
      }
    }
    ensure(database.isTransaction, "transaction_escaped");
    const observed = database.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name").all();
    const observedObjects = observed.map((object): InstallationSchemaObject => {
      ensure((object.type === "table" || object.type === "index" || object.type === "view" || object.type === "trigger")
        && typeof object.name === "string" && typeof object.tableName === "string" && typeof object.sql === "string", "native_schema_object");
      return { type: object.type, name: object.name, tableName: object.tableName, sql: object.sql };
    });
    ensure(installationSchemaDigest(observedObjects) === final.schemaSha256, "native_schema");
    ensure(database.prepare("PRAGMA foreign_key_check").all().length === 0
      && database.prepare("PRAGMA integrity_check").all().every(value => value.integrity_check === "ok"), "native_health");
    database.exec("COMMIT");
  } catch (error) {
    failed = true; failure = error;
    if (database.isTransaction) {
      try { database.exec("ROLLBACK"); }
      catch (rollbackError) { failure = new AggregateError([error, rollbackError], "Empty recovery target construction and rollback failed"); }
    }
    throw failure;
  } finally {
    // The first clear outcome remains cached. Its already collected rejection
    // must not mask construction/rollback or skip the independent FK attempt.
    const cleanupErrors: unknown[] = [];
    const clearAlreadyReported = clearAttempted && clearFailed;
    try { clearOriginal(); }
    catch (error) { if (!failed || !clearAlreadyReported) cleanupErrors.push(error); }
    try { database.exec("PRAGMA foreign_keys=ON"); }
    catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors,
      "Empty recovery target construction and original cleanup failed");
  }
  const installation = admitInstallationRecoverySource(database, catalog).receipt;
  return { installation, construction: { kind: "reviewed-empty-recovery-checkpoint-construction/v28",
    constructionProvenance: "reviewed-final-schema", rawMigrationExecution: false,
    nativeLedgerMeaning: "implemented-reviewed-checkpoint-lineage", destinationInstallationId: installationId,
    checkpointId: final.id, schemaSha256: final.schemaSha256,
    reviewedLineage: catalog.migrations.map((migration, index) => ({ ordinal: index + 1, name: migration.name,
      rawSha256: migration.rawSha256, checkpointId: migration.checkpoint.id, schemaSha256: migration.checkpoint.schemaSha256 })) } };
}
