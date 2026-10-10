import { createHash, randomUUID } from "node:crypto";
import { constants, type DatabaseSync } from "node:sqlite";

import { NODE_INSTALLATION_DDL, NODE_MIGRATIONS_DDL, NODE_PLATFORM_OBJECTS, type InstallationSchemaObject } from "../shared/contracts/node-installation-schema";
export { NODE_INSTALLATION_DDL, NODE_MIGRATIONS_DDL, NODE_PLATFORM_OBJECTS, type InstallationSchemaObject } from "../shared/contracts/node-installation-schema";

export interface ReviewedInstallationCheckpoint {
  id: string;
  applicationObjects: readonly InstallationSchemaObject[];
  /** Digest of application objects AND the exact local platform objects. */
  schemaSha256: string;
  recoveryAdmission: {
    kind: "node-installation-recovery-admission/1";
    checkpointId: string;
    schemaSha256: string;
    platformObjects: readonly InstallationSchemaObject[];
  };
}
export interface ReviewedInstallationMigration {
  name: string;
  sql: string;
  rawSha256: string;
  checkpoint: ReviewedInstallationCheckpoint;
}
export interface ReviewedInstallationCatalog {
  /** Stable catalog family identity, retained through supported upgrades. */
  id: string;
  emptyCheckpoint: ReviewedInstallationCheckpoint;
  migrations: readonly ReviewedInstallationMigration[];
}
export interface InstallationReceipt {
  installationId: string;
  catalogId: string;
  checkpointId: string;
  schemaSha256: string;
  appliedMigrations: number;
  createdAt: string;
}
export interface ReviewedInstallationAdmission {
  readonly kind: "node-installation-recovery-admission/1";
  readonly receipt: Readonly<InstallationReceipt>;
  readonly applicationObjects: readonly Readonly<InstallationSchemaObject>[];
  readonly platformObjects: readonly Readonly<InstallationSchemaObject>[];
  readonly platformPolicy: "installation-local-recreate-on-destination";
}
const issuedAdmissions = new WeakMap<ReviewedInstallationAdmission, {
  database: DatabaseSync; catalog: ReviewedInstallationCatalog; receipt: Readonly<InstallationReceipt>;
}>();
export const installationSqlDigest = (sql: string) => createHash("sha256").update(sql, "utf8").digest("hex");
function fail(message: string): never { throw new Error(`node_installation_${message}`); }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function objects(values: readonly InstallationSchemaObject[]): InstallationSchemaObject[] {
  if (!Array.isArray(values)) fail("schema_not_reviewed");
  const names = new Set<string>();
  return values.map(value => {
    if (!value || !["table", "index", "view", "trigger"].includes(value.type)
      || typeof value.name !== "string" || !value.name || names.has(value.name)
      || typeof value.tableName !== "string" || !value.tableName || typeof value.sql !== "string" || !value.sql) fail("schema_not_reviewed");
    names.add(value.name);
    return { type: value.type, name: value.name, tableName: value.tableName, sql: value.sql };
  }).sort((a, b) => compare(a.type, b.type) || compare(a.name, b.name));
}
export function installationSchemaDigest(values: readonly InstallationSchemaObject[]): string {
  return installationSqlDigest(JSON.stringify(objects(values)));
}
function fullSchema(checkpoint: ReviewedInstallationCheckpoint) {
  return objects([...checkpoint.applicationObjects, ...NODE_PLATFORM_OBJECTS]);
}
function validateCheckpoint(checkpoint: ReviewedInstallationCheckpoint) {
  if (!checkpoint || typeof checkpoint.id !== "string" || !/^[A-Za-z0-9._/-]{1,160}$/.test(checkpoint.id)) fail("checkpoint_not_reviewed");
  const application = objects(checkpoint.applicationObjects);
  if (application.some(value => value.name.startsWith("sqlite_") || NODE_PLATFORM_OBJECTS.some(platform => value.name === platform.name || value.tableName === platform.name))) fail("platform_schema_collision");
  const schemaSha256 = installationSchemaDigest(fullSchema(checkpoint));
  const admission = checkpoint.recoveryAdmission;
  if (checkpoint.schemaSha256 !== schemaSha256 || !admission
    || admission.kind !== "node-installation-recovery-admission/1" || admission.checkpointId !== checkpoint.id
    || admission.schemaSha256 !== schemaSha256 || JSON.stringify(objects(admission.platformObjects)) !== JSON.stringify(objects(NODE_PLATFORM_OBJECTS))) fail("checkpoint_recovery_pair_not_reviewed");
}
function validateCatalog(catalog: ReviewedInstallationCatalog) {
  if (!catalog || typeof catalog.id !== "string" || !/^[A-Za-z0-9._/-]{1,160}$/.test(catalog.id)
    || !Array.isArray(catalog.migrations) || catalog.migrations.length > 256) fail("catalog_not_reviewed");
  validateCheckpoint(catalog.emptyCheckpoint);
  if (catalog.emptyCheckpoint.applicationObjects.length) fail("empty_checkpoint_not_empty");
  const names = new Set<string>(), checkpoints = new Set([catalog.emptyCheckpoint.id]);
  let bytes = 0;
  for (const migration of catalog.migrations) {
    if (!migration || typeof migration.name !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,159}$/.test(migration.name)
      || names.has(migration.name) || typeof migration.sql !== "string" || !migration.sql
      || migration.rawSha256 !== installationSqlDigest(migration.sql)) fail("migration_digest_or_name_not_reviewed");
    names.add(migration.name); bytes += Buffer.byteLength(migration.sql);
    if (bytes > 16 * 1024 * 1024) fail("migration_budget_exceeded");
    validateCheckpoint(migration.checkpoint);
    if (checkpoints.has(migration.checkpoint.id)) fail("duplicate_checkpoint");
    checkpoints.add(migration.checkpoint.id);
  }
}
function observedSchema(database: DatabaseSync): InstallationSchemaObject[] {
  return objects(database.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name").all() as unknown as InstallationSchemaObject[]);
}
function checkpointAt(catalog: ReviewedInstallationCatalog, applied: number) {
  return applied === 0 ? catalog.emptyCheckpoint : catalog.migrations[applied - 1]!.checkpoint;
}
function validClock(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function assertConnection(database: DatabaseSync) {
  if (!database.isOpen || database.isTransaction) fail("connection_not_quiesced");
  if (database.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") fail("file_backed_wal_required");
  if (database.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1) fail("foreign_keys_required");
  if (database.prepare("PRAGMA database_list").all().some(value => value.name !== "main" && value.name !== "temp")
    || database.prepare("SELECT 1 FROM sqlite_temp_schema LIMIT 1").get()) fail("connection_namespace_not_owned");
}
function healthy(database: DatabaseSync) {
  if (database.prepare("PRAGMA foreign_key_check").all().length
    || database.prepare("PRAGMA quick_check").all().some(value => value.quick_check !== "ok")) fail("integrity_failed");
}
function inspect(database: DatabaseSync, catalog: ReviewedInstallationCatalog): InstallationReceipt {
  const native = database.prepare("SELECT ordinal,name,raw_sha256,checkpoint_id,schema_sha256,status,applied_at FROM node_migrations ORDER BY ordinal");
  native.setReadBigInts(true);
  const ledger = native.all();
  if (ledger.length > catalog.migrations.length) fail("newer_schema_unsupported");
  for (const [index, row] of ledger.entries()) {
    const migration = catalog.migrations[index]!;
    if (row.ordinal !== BigInt(index + 1) || row.name !== migration.name || row.raw_sha256 !== migration.rawSha256
      || row.checkpoint_id !== migration.checkpoint.id || row.schema_sha256 !== migration.checkpoint.schemaSha256
      || row.status !== "applied" || !validClock(row.applied_at)) fail("migration_ledger_mismatch_or_partial");
  }
  const checkpoint = checkpointAt(catalog, ledger.length);
  if (JSON.stringify(observedSchema(database)) !== JSON.stringify(fullSchema(checkpoint))) fail("schema_checkpoint_mismatch");
  const rows = database.prepare("SELECT * FROM node_installation").all(), row = rows[0];
  if (rows.length !== 1 || !row || row.singleton !== 1 || row.catalog_id !== catalog.id
    || row.schema_checkpoint !== checkpoint.id || row.schema_sha256 !== checkpoint.schemaSha256
    || typeof row.installation_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.installation_id)
    || !validClock(row.created_at)) fail("identity_or_checkpoint_mismatch");
  return { installationId: row.installation_id, catalogId: catalog.id, checkpointId: checkpoint.id,
    schemaSha256: checkpoint.schemaSha256, appliedMigrations: ledger.length, createdAt: row.created_at };
}

// Node 24.19 exposes SQLite's native authorizer; the repository's older Node
// declarations omit it. Require the actual API rather than emulate SQL parsing.
type Authorizer = (action: number, first: string | null, second: string | null, database: string | null, trigger: string | null) => number;
type AuthorizableDatabase = DatabaseSync & { setAuthorizer(callback: Authorizer | null): void };
function migrationAuthorizer(database: DatabaseSync) {
  const native = database as AuthorizableDatabase;
  if (typeof native.setAuthorizer !== "function") fail("native_authorizer_required");
  const action = constants as unknown as Record<string, number>;
  const required = ["SQLITE_OK", "SQLITE_DENY", "SQLITE_TRANSACTION", "SQLITE_SAVEPOINT", "SQLITE_ATTACH", "SQLITE_DETACH", "SQLITE_PRAGMA", "SQLITE_READ", "SQLITE_UPDATE"];
  if (required.some(name => !Number.isSafeInteger(action[name]))) fail("native_authorizer_required");
  const policy: Authorizer = (code, first, second, schema) => {
    // Native ALTER TABLE inspects/rewrites these engine-owned metadata cells
    // even when the prechecked temp schema contains no user object. This does
    // not admit CREATE TEMP, attached namespaces or writable_schema policy.
    const nativeAlterMetadata = schema === "temp" && first === "sqlite_temp_master"
      && (code === action.SQLITE_READ && ["type", "name", "sql", "tbl_name"].includes(second ?? "")
        || code === action.SQLITE_UPDATE && ["sql", "tbl_name"].includes(second ?? ""));
    if ([action.SQLITE_TRANSACTION, action.SQLITE_SAVEPOINT, action.SQLITE_ATTACH, action.SQLITE_DETACH].includes(code)
      || schema !== null && schema !== "main" && !nativeAlterMetadata
      || NODE_PLATFORM_OBJECTS.some(value => first === value.name || second === value.name)) return action.SQLITE_DENY!;
    if (code === action.SQLITE_PRAGMA) {
      const pragma = first?.toLowerCase(), value = second?.toLowerCase();
      if (["quick_check", "foreign_key_check"].includes(pragma ?? "")
        || pragma === "foreign_keys" && value === "on"
        || ["defer_foreign_keys", "legacy_alter_table"].includes(pragma ?? "") && ["on", "off"].includes(value ?? "")) return action.SQLITE_OK!;
      return action.SQLITE_DENY!;
    }
    return action.SQLITE_OK!;
  };
  return { native, policy };
}

/** Sole trusted startup composer owns this WAL connection, registers no UDFs
 * or previous authorizer, and quiesces every application writer before entry.
 * BEGIN EXCLUSIVE serializes writers; WAL readers are not forcibly evicted.
 * No current V24/application catalog is supplied or enabled by this module. */
export function installReviewedSqliteCatalog(database: DatabaseSync, catalog: ReviewedInstallationCatalog,
  options: { busyTimeoutMs?: number } = {}): InstallationReceipt {
  validateCatalog(catalog); assertConnection(database);
  const timeout = options.busyTimeoutMs ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 5000) fail("bounded_busy_timeout_required");
  const authorizer = migrationAuthorizer(database);
  database.enableLoadExtension(false); database.exec(`PRAGMA busy_timeout=${timeout}`);
  const pragmas = database.prepare("PRAGMA legacy_alter_table").get()?.legacy_alter_table;
  database.exec("BEGIN EXCLUSIVE");
  try {
    const existing = observedSchema(database), platformNames = NODE_PLATFORM_OBJECTS.map(value => value.name);
    const present = existing.filter(value => platformNames.includes(value.name));
    if (!present.length) {
      if (existing.length) fail("missing_installation_ledger");
      database.exec(`${NODE_INSTALLATION_DDL};${NODE_MIGRATIONS_DDL}`);
      database.prepare("INSERT INTO node_installation VALUES(1,?,?,?,?,?)")
        .run(randomUUID(), catalog.id, catalog.emptyCheckpoint.id, catalog.emptyCheckpoint.schemaSha256, new Date().toISOString());
    } else if (present.length !== NODE_PLATFORM_OBJECTS.length) fail("partial_installation_ledger");
    const before = inspect(database, catalog);
    for (let index = before.appliedMigrations; index < catalog.migrations.length; index++) {
      const migration = catalog.migrations[index]!;
      authorizer.native.setAuthorizer(authorizer.policy);
      try { database.exec(migration.sql); }
      finally { authorizer.native.setAuthorizer(null); }
      if (!database.isTransaction) fail("migration_escaped_transaction");
      if (JSON.stringify(observedSchema(database)) !== JSON.stringify(fullSchema(migration.checkpoint))) fail("migration_schema_not_reviewed");
      healthy(database);
      const now = new Date().toISOString();
      database.prepare("INSERT INTO node_migrations VALUES(?,?,?,?,?,'applied',?)")
        .run(index + 1, migration.name, migration.rawSha256, migration.checkpoint.id, migration.checkpoint.schemaSha256, now);
      database.prepare("UPDATE node_installation SET schema_checkpoint=?,schema_sha256=? WHERE singleton=1")
        .run(migration.checkpoint.id, migration.checkpoint.schemaSha256);
    }
    healthy(database);
    const receipt = inspect(database, catalog);
    database.exec("COMMIT"); return receipt;
  } catch (error) {
    if (database.isTransaction) {
      try { database.exec("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "Installation migration and rollback failed"); }
    }
    throw error;
  } finally {
    authorizer.native.setAuthorizer(null);
    database.exec(`PRAGMA legacy_alter_table=${pragmas === 1 ? "ON" : "OFF"}`);
  }
}

/** Paired current admission checks the whole identified SQLite snapshot first.
 * Only then are the two exact installation-local objects separated from its
 * application schema. Historical Worker/V24 readers are unchanged and cannot
 * silently ignore this ledger. Destination installers create their own ID. */
export function admitInstallationRecoverySource(database: DatabaseSync, catalog: ReviewedInstallationCatalog): ReviewedInstallationAdmission {
  validateCatalog(catalog); assertConnection(database);
  database.exec("BEGIN");
  try {
    const receipt = inspect(database, catalog);
    if (receipt.appliedMigrations !== catalog.migrations.length) fail("recovery_requires_current_checkpoint");
    healthy(database);
    const checkpoint = checkpointAt(catalog, receipt.appliedMigrations);
    const result = Object.freeze({ kind: "node-installation-recovery-admission/1" as const, receipt: Object.freeze(receipt),
      applicationObjects: Object.freeze(objects(checkpoint.applicationObjects).map(value => Object.freeze(value))),
      platformObjects: Object.freeze(objects(NODE_PLATFORM_OBJECTS).map(value => Object.freeze(value))),
      platformPolicy: "installation-local-recreate-on-destination" as const });
    database.exec("COMMIT");
    issuedAdmissions.set(result, { database, catalog, receipt: result.receipt });
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

/** An explicit full-application consumer receives a token minted by this
 * inspector, bound to this native connection. Fresh inspection fences schema,
 * ledger, installation identity and upgrades after issuance. */
export function assertInstallationAdmission(database: DatabaseSync, admission: ReviewedInstallationAdmission): Readonly<InstallationReceipt> {
  const issued = issuedAdmissions.get(admission);
  if (!issued || issued.database !== database) fail("admission_not_issued_for_connection");
  const current = admitInstallationRecoverySource(database, issued.catalog).receipt;
  if (JSON.stringify(current) !== JSON.stringify(issued.receipt)) fail("admission_identity_or_checkpoint_changed");
  return current;
}
