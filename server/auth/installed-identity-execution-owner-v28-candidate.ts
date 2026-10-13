import type { DatabaseSync } from "node:sqlite";
import { Buffer } from "node:buffer";
import { assertInstalledLocalIdentityOwner, type IdentityPolicy } from "./identity.ts";
import type { InstallationReceipt, ReviewedInstallationAdmission } from "../migrations";
import { assertSqliteConnectionOwner, type SqliteCapability } from "../sqlite.ts";

import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate.ts";
import { NODE_PLATFORM_OBJECTS } from "../../shared/contracts/node-installation-schema.ts";

// Only this code-owned frozen V28 catalog selects the complete ledger length.
// A checkpoint version is not a migration count or a caller-provided catalog.
const CATALOG = V28_NODE_INSTALLATION_CATALOG_CANDIDATE;
const LEDGER_ROWS = CATALOG.migrations.length;
function unavailable(): never { throw new Error("Captured installed identity execution owner is unavailable"); }

/** A trusted immutable-schema execution captures full reviewed installation
 * admission once. Dispatch checks the exact live connection, schema cookies,
 * the exact live schema, installation and every code-owned V28 ledger row;
 * it never caches a permission or query result. Close and discard this owner before recovery, upgrade or native close.
 * This is not a replacement for full recovery/schema/integrity admission. */
export function captureInstalledIdentityExecutionOwnerV28Candidate(identity: object, database: SqliteCapability,
  nativeDatabase: DatabaseSync, admission: ReviewedInstallationAdmission): Readonly<{
    policy: Readonly<IdentityPolicy>; installation: Readonly<InstallationReceipt>; assertCurrent(): void;
  }> {
  // Prepare a bounded snapshot only on the actual same-core/native connection.
  // The private identity registry must fully validate it before an owner issues.
  assertSqliteConnectionOwner(database, nativeDatabase);
  const installation = Object.freeze({ ...admission.receipt });
  const checkpoint = CATALOG.migrations.at(-1)?.checkpoint;
  if (!checkpoint || checkpoint.id !== "portable-runtime/v28" || installation.checkpointId !== checkpoint.id
    || installation.catalogId !== CATALOG.id || installation.schemaSha256 !== checkpoint.schemaSha256
    || installation.appliedMigrations !== LEDGER_ROWS) unavailable();
  // Compare every current schema cell inside Native SQLite against only the
  // fixed code-owned catalog. Return one live scalar instead of repeatedly
  // copying the large schema/trigger texts into JS. The observed schema and a
  // successful result are never cached: even writable_schema edits which keep
  // the schema cookie unchanged must fail this exact check on the next call.
  const expectedSchema = [...checkpoint.applicationObjects, ...NODE_PLATFORM_OBJECTS];
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  // SQLite BINARY uses UTF-8 byte order. Balance the fixed name comparisons
  // rather than repeating a linear CASE over the whole catalog for every row.
  // Every observed row is still checked; no schema/result success is reused.
  const orderedSchema = [...expectedSchema].sort((left, right) =>
    Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")));
  function schemaLookup(values: typeof orderedSchema): string {
    if (!values.length) return "0";
    const middle = Math.floor(values.length / 2), value = values[middle]!, name = literal(value.name);
    const exact = `(type COLLATE BINARY=${literal(value.type)} AND tbl_name COLLATE BINARY=${literal(value.tableName)}
      AND sql COLLATE BINARY=${literal(value.sql)})`;
    return `(CASE WHEN name COLLATE BINARY < ${name} THEN ${schemaLookup(values.slice(0, middle))}
      WHEN name COLLATE BINARY = ${name} THEN ${exact}
      ELSE ${schemaLookup(values.slice(middle + 1))} END)`;
  }
  const exactSchema = nativeDatabase.prepare(`SELECT 1 AS admitted WHERE
    (SELECT count(*)=${expectedSchema.length} AND count(DISTINCT name COLLATE BINARY)=${expectedSchema.length}
      FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*')
    AND NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*'
      AND ${schemaLookup(orderedSchema)} IS NOT 1)`);
  const version = nativeDatabase.prepare("PRAGMA main.schema_version"); version.setReadBigInts(true);
  const tempVersion = nativeDatabase.prepare("PRAGMA temp.schema_version"); tempVersion.setReadBigInts(true);
  const foreignKeys = nativeDatabase.prepare("PRAGMA foreign_keys");
  const journal = nativeDatabase.prepare("PRAGMA journal_mode");
  const namespaces = nativeDatabase.prepare("PRAGMA database_list");
  const temporary = nativeDatabase.prepare("SELECT 1 FROM sqlite_temp_schema LIMIT 1");
  const sentinel = nativeDatabase.prepare(`SELECT singleton,installation_id,catalog_id,schema_checkpoint,schema_sha256,created_at
    FROM node_installation ORDER BY singleton LIMIT 2`); sentinel.setReadBigInts(true);
  const ledger = nativeDatabase.prepare(`SELECT ordinal,name,raw_sha256,checkpoint_id,schema_sha256,status,applied_at
    FROM node_migrations ORDER BY ordinal LIMIT ${LEDGER_ROWS + 1}`); ledger.setReadBigInts(true);
  const cookie = version.get()?.schema_version, temporaryCookie = tempVersion.get()?.schema_version;
  if (typeof cookie !== "bigint" || cookie < 0n || typeof temporaryCookie !== "bigint" || temporaryCookie < 0n) unavailable();
  const initialNamespaces = namespaces.all();
  const main = initialNamespaces.filter(row => row.name === "main");
  if (main.length !== 1 || typeof main[0]!.file !== "string" || !main[0]!.file) unavailable();
  const mainFile = main[0]!.file;
  function readLedger() {
    const rows = ledger.all();
    if (rows.length !== LEDGER_ROWS) unavailable();
    return rows.map((row, index) => {
      if (row.ordinal !== BigInt(index + 1) || typeof row.name !== "string" || typeof row.raw_sha256 !== "string"
        || typeof row.checkpoint_id !== "string" || typeof row.schema_sha256 !== "string"
        || row.status !== "applied" || typeof row.applied_at !== "string") unavailable();
      return Object.freeze({ ordinal: row.ordinal, name: row.name, rawSha256: row.raw_sha256,
        checkpointId: row.checkpoint_id, schemaSha256: row.schema_sha256, status: row.status, appliedAt: row.applied_at });
    });
  }
  const capturedLedger = Object.freeze(readLedger());
  function assertCurrent(): void {
    assertSqliteConnectionOwner(database, nativeDatabase);
    if (nativeDatabase.isTransaction || version.get()?.schema_version !== cookie
      || tempVersion.get()?.schema_version !== temporaryCookie || foreignKeys.get()?.foreign_keys !== 1
      || journal.get()?.journal_mode !== "wal" || temporary.get() || !exactSchema.get()) unavailable();
    const currentNamespaces = namespaces.all(), actualMain = currentNamespaces.filter(row => row.name === "main");
    if (actualMain.length !== 1 || actualMain[0]!.file !== mainFile
      || currentNamespaces.some(row => row.name !== "main" && row.name !== "temp")) unavailable();
    const rows = sentinel.all(), row = rows[0];
    if (rows.length !== 1 || !row || row.singleton !== 1n || row.installation_id !== installation.installationId
      || row.catalog_id !== installation.catalogId || row.schema_checkpoint !== installation.checkpointId
      || row.schema_sha256 !== installation.schemaSha256 || row.created_at !== installation.createdAt) unavailable();
    const currentLedger = readLedger();
    for (const [index, actual] of currentLedger.entries()) {
      const expected = capturedLedger[index]!;
      if (actual.ordinal !== expected.ordinal || actual.name !== expected.name || actual.rawSha256 !== expected.rawSha256
        || actual.checkpointId !== expected.checkpointId || actual.schemaSha256 !== expected.schemaSha256
        || actual.status !== expected.status || actual.appliedAt !== expected.appliedAt) unavailable();
    }
  }
  // Bracket the complete validation with the exact pre-captured snapshot. A
  // real other native writer after validation COMMIT cannot redefine the
  // expected cookie/ledger/installation as an unreviewed new baseline.
  assertCurrent();
  const policy = assertInstalledLocalIdentityOwner(identity, database, nativeDatabase, admission);
  assertCurrent();
  return Object.freeze({ policy, installation, assertCurrent });
}
