import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_NODE_INSTALLATION_CATALOG } from "./installation-catalog";
import { admitInstallationRecoverySource, assertInstallationAdmission, installReviewedSqliteCatalog,
  installationSchemaDigest, installationSqlDigest, type InstallationSchemaObject } from "./migrations";
import { NODE_PLATFORM_OBJECTS } from "../shared/contracts/node-installation-schema";
import { PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256, PORTABLE_RUNTIME_CHECKPOINT_ID,
  PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, PORTABLE_RUNTIME_RECOVERY_MIGRATIONS,
  PORTABLE_RUNTIME_RECOVERY_TABLES } from "../shared/contracts/portable-runtime-recovery-catalog";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalog = CURRENT_NODE_INSTALLATION_CATALOG;
const paths: string[] = [], connections: DatabaseSync[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "portable-current-catalog-")); paths.push(directory);
  const path = join(directory, "installation.sqlite");
  const open = () => {
    const database = new DatabaseSync(path, { enableForeignKeyConstraints: true, allowExtension: false });
    database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=100"); connections.push(database); return database;
  };
  return { path, open, database: open() };
}
afterEach(() => {
  for (const database of connections.splice(0)) if (database.isOpen) {
    if (database.isTransaction) database.exec("ROLLBACK"); database.close();
  }
  for (const path of paths.splice(0)) rmSync(path, { force: true, recursive: true });
});
const observed = (database: DatabaseSync) => database.prepare(
  "SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name",
).all() as unknown as InstallationSchemaObject[];
const ledger = (database: DatabaseSync) => database.prepare("SELECT * FROM node_migrations ORDER BY ordinal").all();
function copiedGeneratorRoot() {
  const directory = mkdtempSync(join(tmpdir(), "portable-generator-inventory-")); paths.push(directory);
  const files = ["scripts/generate-portable-runtime-schema.mjs", "scripts/d1-migration-plan.mjs", "shared/contracts/system-recovery-catalog.ts",
    "shared/contracts/node-installation-schema.ts", "shared/contracts/portable-runtime-recovery-catalog.ts",
    "worker/recovery/portable-runtime-trusted-schema.ts", "server/installation-catalog.ts",
    ...catalog.migrations.map(migration => `migrations/${migration.name}`)];
  for (const path of files) { mkdirSync(dirname(join(directory, path)), { recursive: true }); cpSync(join(root, path), join(directory, path)); }
  return directory;
}
function generator(directory: string, args: string[] = ["--check"]) {
  return spawnSync(process.execPath, [join(directory, "scripts/generate-portable-runtime-schema.mjs"), ...args],
    { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
}

describe("actual current portable Node installation catalog", () => {
  it("installs all 23 raw migrations on disk with exact ledger pairs and inert identity state", () => {
    const f = fixture(), receipt = installReviewedSqliteCatalog(f.database, catalog);
    expect(receipt).toMatchObject({ catalogId: "sample-fabrication-workflow/sqlite-v1",
      checkpointId: PORTABLE_RUNTIME_CHECKPOINT_ID, appliedMigrations: 23,
      schemaSha256: PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256[PORTABLE_RUNTIME_CHECKPOINT_ID] });
    expect(ledger(f.database)).toEqual(catalog.migrations.map((migration, index) => expect.objectContaining({
      ordinal: index + 1, name: migration.name, raw_sha256: installationSqlDigest(migration.sql),
      checkpoint_id: migration.checkpoint.id, schema_sha256: PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256[migration.checkpoint.id], status: "applied",
    })));
    const admitted = admitInstallationRecoverySource(f.database, catalog);
    expect(admitted.receipt).toEqual(receipt);
    expect(installationSchemaDigest(admitted.applicationObjects)).toBe(PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256);
    expect(installationSchemaDigest(observed(f.database))).toBe(receipt.schemaSha256);
    expect(admitted.platformObjects).toEqual(NODE_PLATFORM_OBJECTS);
    expect(assertInstallationAdmission(f.database, admitted)).toEqual(receipt);
    for (const name of ["local_identity_installation", "local_accounts", "local_admin_grants", "local_sessions", "local_login_throttle", "local_auth_events"]) {
      expect(f.database.prepare(`SELECT COUNT(*) n FROM ${name}`).get()?.n).toBe(0);
    }
    f.database.prepare("INSERT INTO local_auth_events(kind,happened_at) VALUES('destination_bootstrap',1)").run();
    expect(f.database.prepare("SELECT kind FROM local_auth_events").get()?.kind).toBe("destination_bootstrap");
    expect(f.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(f.database.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
  }, 30000);

  it("upgrades real populated prefix 22 and reopens idempotently without changing UUID, prior receipts or signed row identity", () => {
    const f = fixture(), prefix = { ...catalog, migrations: catalog.migrations.slice(0, 22) };
    const first = installReviewedSqliteCatalog(f.database, prefix), beforeLedger = ledger(f.database);
    const sourceRowid = -9223372036854775807n, text = "Retained\u0000UTF-8 内容", now = "2026-10-10T00:00:00.000Z";
    f.database.prepare("INSERT INTO samples(rowid,id,code,title,description,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(sourceRowid, "prefix-sample", "PREFIX-22", "Persisted sample", text, now, now);
    f.database.close();
    const reopened = f.open(), upgraded = installReviewedSqliteCatalog(reopened, catalog);
    expect(upgraded.installationId).toBe(first.installationId); expect(upgraded.createdAt).toBe(first.createdAt);
    expect(ledger(reopened).slice(0, 22)).toEqual(beforeLedger);
    const read = reopened.prepare("SELECT rowid,description FROM samples WHERE id='prefix-sample'"); read.setReadBigInts(true);
    expect(read.get()).toEqual({ rowid: sourceRowid, description: text });
    const finalLedger = ledger(reopened); reopened.close();
    const restarted = f.open();
    expect(installReviewedSqliteCatalog(restarted, catalog)).toEqual(upgraded);
    expect(ledger(restarted)).toEqual(finalLedger);
    expect(admitInstallationRecoverySource(restarted, catalog).receipt).toEqual(upgraded);
  }, 30000);

  it.each(["node_installation", "node_migrations"])("refuses missing platform table %s without recreating a partial installation", table => {
    const f = fixture(); installReviewedSqliteCatalog(f.database, catalog); f.database.exec(`DROP TABLE ${table}`);
    const before = observed(f.database);
    expect(() => installReviewedSqliteCatalog(f.database, catalog)).toThrow("partial_installation_ledger");
    expect(observed(f.database)).toEqual(before); expect(f.database.isTransaction).toBe(false);
  }, 30000);

  it("refuses gapped, changed raw digest, unknown current checkpoint and extra sqliteX schema while preserving damaged evidence", () => {
    const f = fixture(); installReviewedSqliteCatalog(f.database, catalog);
    f.database.prepare("UPDATE node_migrations SET ordinal=100 WHERE ordinal=5").run();
    const gapped = ledger(f.database);
    expect(() => installReviewedSqliteCatalog(f.database, catalog)).toThrow("migration_ledger_mismatch");
    expect(ledger(f.database)).toEqual(gapped); f.database.prepare("UPDATE node_migrations SET ordinal=5 WHERE ordinal=100").run();
    f.database.prepare("UPDATE node_migrations SET raw_sha256=? WHERE ordinal=23").run("0".repeat(64));
    const changed = ledger(f.database);
    expect(() => admitInstallationRecoverySource(f.database, catalog)).toThrow("migration_ledger_mismatch");
    expect(ledger(f.database)).toEqual(changed);
    f.database.prepare("UPDATE node_migrations SET raw_sha256=? WHERE ordinal=23").run(catalog.migrations[22]!.rawSha256);
    f.database.prepare("UPDATE node_installation SET schema_checkpoint='portable-runtime/unreviewed'").run();
    expect(() => installReviewedSqliteCatalog(f.database, catalog)).toThrow("identity_or_checkpoint_mismatch");
    f.database.prepare("UPDATE node_installation SET schema_checkpoint=?").run(PORTABLE_RUNTIME_CHECKPOINT_ID);
    f.database.exec("CREATE TABLE sqliteX_unreviewed(id INTEGER)");
    const extra = observed(f.database);
    expect(() => admitInstallationRecoverySource(f.database, catalog)).toThrow("schema_checkpoint_mismatch");
    expect(observed(f.database)).toEqual(extra); expect(f.database.isTransaction).toBe(false);
  }, 30000);

  it("keeps recovery cleanup receipt, closed classifications and separate application/platform hashes", () => {
    expect(PORTABLE_RUNTIME_RECOVERY_MIGRATIONS).toHaveLength(23);
    expect(PORTABLE_RUNTIME_RECOVERY_MIGRATIONS[10]).toMatchObject({ name: "0011_fp1_retire_legacy_test_projects.sql", appliedToFreshSchema: false });
    expect(catalog.migrations[10]!.sql).toContain("DELETE FROM projects");
    expect(Object.keys(PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256)).toHaveLength(24);
    expect(PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256[PORTABLE_RUNTIME_CHECKPOINT_ID]).not.toBe(PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256);
    for (const name of ["local_accounts", "local_auth_events"]) expect(PORTABLE_RUNTIME_RECOVERY_TABLES.find(table => table.name === name)).toMatchObject({ local: false, classification: "protected_identity" });
    for (const name of ["local_identity_installation", "local_admin_grants", "local_sessions", "local_login_throttle"]) expect(PORTABLE_RUNTIME_RECOVERY_TABLES.find(table => table.name === name)).toMatchObject({ local: true, classification: "local" });
    expect(PORTABLE_RUNTIME_RECOVERY_TABLES.some(table => table.name === "node_installation" || table.name === "node_migrations")).toBe(false);
    expect(Object.isFrozen(catalog)).toBe(true); expect(Object.isFrozen(catalog.migrations)).toBe(true);
    expect(Object.isFrozen(catalog.migrations[22]!.checkpoint.applicationObjects[0])).toBe(true);
  });

  it.each(["CREATE TEMP TABLE escaped_auth(id INTEGER)", "PRAGMA writable_schema=ON"])("keeps native ALTER metadata admission bounded and rolls back %s", unsafeSql => {
    const f = fixture(), prefix = { ...catalog, migrations: catalog.migrations.slice(0, 22) };
    const before = installReviewedSqliteCatalog(f.database, prefix), beforeSchema = observed(f.database), beforeLedger = ledger(f.database);
    const last = catalog.migrations[22]!, sql = `${last.sql}\n${unsafeSql};`;
    const unsafe = { ...catalog, migrations: [...catalog.migrations.slice(0, 22), { ...last, sql, rawSha256: installationSqlDigest(sql) }] };
    expect(() => installReviewedSqliteCatalog(f.database, unsafe)).toThrow("not authorized");
    expect(observed(f.database)).toEqual(beforeSchema); expect(ledger(f.database)).toEqual(beforeLedger);
    expect(f.database.prepare("SELECT installation_id FROM node_installation").get()?.installation_id).toBe(before.installationId);
    expect(f.database.prepare("SELECT name FROM sqlite_temp_schema").all()).toEqual([]);
    expect(f.database.prepare("PRAGMA writable_schema").get()?.writable_schema).toBe(0);
    expect(f.database.isTransaction).toBe(false);
  }, 30000);
});

describe("versioned portable runtime schema generator", () => {
  it("reproduces all reviewed outputs in a minimal copied source tree", () => {
    const directory = copiedGeneratorRoot(), result = generator(directory);
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ migrations: 23, tables: 125, imageTables: 101, nodeCheckpoints: 24,
      schemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256 });
  }, 30000);

  it("refuses an unknown migration inventory before writing outputs", () => {
    const directory = copiedGeneratorRoot(), path = join(directory, "server/installation-catalog.ts"), before = readFileSync(path);
    writeFileSync(join(directory, "migrations/0024_unreviewed.sql"), "CREATE TABLE unreviewed(id INTEGER);");
    const result = generator(directory, []);
    expect(result.status).toBe(1); expect(result.stderr).toContain("unknown, missing, or non-file migration inventory");
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("refuses changed reviewed raw SQL and frozen classification source before writes", () => {
    const directory = copiedGeneratorRoot(), path = join(directory, "migrations/0023_portable_local_identity.sql"), original = readFileSync(path);
    writeFileSync(path, Buffer.concat([original, Buffer.from("\n-- unreviewed bytes\n")]));
    let result = generator(directory, []);
    expect(result.status).toBe(1); expect(result.stderr).toContain("raw migration digest changed: 0023");
    writeFileSync(path, original);
    const historical = join(directory, "shared/contracts/system-recovery-catalog.ts");
    writeFileSync(historical, readFileSync(historical, "utf8").replace('"classification": "content"', '"classification": "local"'));
    result = generator(directory, []);
    expect(result.status).toBe(1); expect(result.stderr).toContain("frozen V1 catalog changed");
  });

  it("detects a tampered generated output in check mode and leaves it untouched", () => {
    const directory = copiedGeneratorRoot(), path = join(directory, "shared/contracts/portable-runtime-recovery-catalog.ts");
    writeFileSync(path, "// reviewed output replaced\n");
    const before = createHash("sha256").update(readFileSync(path)).digest("hex"), result = generator(directory);
    expect(result.status).toBe(1); expect(result.stderr).toContain("generated output differs");
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(before);
  }, 30000);
});
