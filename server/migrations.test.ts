import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitInstallationRecoverySource, assertInstallationAdmission, installReviewedSqliteCatalog,
  installationSchemaDigest, installationSqlDigest, NODE_PLATFORM_OBJECTS,
  type InstallationSchemaObject, type ReviewedInstallationCatalog, type ReviewedInstallationCheckpoint,
} from "./migrations";

const recordDdl = "CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT NOT NULL)";
const labelDdl = "CREATE TABLE labels(record_id INTEGER NOT NULL REFERENCES records(id),label TEXT NOT NULL)";
const triggerDdl = "CREATE TRIGGER labels_touch AFTER INSERT ON labels BEGIN UPDATE records SET value=value||';COMMIT' WHERE id=NEW.record_id; END";
const recordObject: InstallationSchemaObject = { type: "table", name: "records", tableName: "records", sql: recordDdl };
const labelObject: InstallationSchemaObject = { type: "table", name: "labels", tableName: "labels", sql: labelDdl };
const triggerObject: InstallationSchemaObject = { type: "trigger", name: "labels_touch", tableName: "labels", sql: triggerDdl };
function checkpoint(id: string, applicationObjects: InstallationSchemaObject[]): ReviewedInstallationCheckpoint {
  const schemaSha256 = installationSchemaDigest([...applicationObjects, ...NODE_PLATFORM_OBJECTS]);
  return { id, applicationObjects, schemaSha256, recoveryAdmission: {
    kind: "node-installation-recovery-admission/1", checkpointId: id, schemaSha256, platformObjects: NODE_PLATFORM_OBJECTS,
  } };
}
function catalog(count = 2): ReviewedInstallationCatalog {
  const sql = [recordDdl, `${labelDdl};${triggerDdl}`];
  const checkpoints = [checkpoint("fixture/1", [recordObject]), checkpoint("fixture/2", [recordObject, labelObject, triggerObject])];
  return { id: "reviewed-installer-fixture/1", emptyCheckpoint: checkpoint("fixture/empty", []),
    migrations: sql.slice(0, count).map((value, index) => ({ name: `fixture_${index + 1}.sql`, sql: value,
      rawSha256: installationSqlDigest(value), checkpoint: checkpoints[index]! })) };
}
function withLastSql(value: ReviewedInstallationCatalog, sql: string): ReviewedInstallationCatalog {
  const migrations = [...value.migrations], last = migrations.at(-1)!;
  migrations[migrations.length - 1] = { ...last, sql, rawSha256: installationSqlDigest(sql) };
  return { ...value, migrations };
}
const fixtures: Array<{ directory: string; connections: DatabaseSync[] }> = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "node-installation-fixture-"));
  const connections: DatabaseSync[] = [], path = join(directory, "database.sqlite");
  const open = () => {
    const database = new DatabaseSync(path, { enableForeignKeyConstraints: true, allowExtension: false });
    database.exec("PRAGMA journal_mode=WAL;PRAGMA busy_timeout=100"); connections.push(database); return database;
  };
  fixtures.push({ directory, connections }); return { directory, path, open, database: open() };
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    for (const database of fixture.connections) if (database.isOpen) { if (database.isTransaction) database.exec("ROLLBACK"); database.close(); }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
const schema = (database: DatabaseSync) => database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name").all();
const ledger = (database: DatabaseSync) => database.prepare("SELECT * FROM node_migrations ORDER BY ordinal").all();

describe("reviewed identified Node installation", () => {
  it("atomically installs a fresh catalog with raw digests, exact checkpoints and paired current admission", () => {
    const { database } = fixture(), definition = catalog();
    const receipt = installReviewedSqliteCatalog(database, definition);
    expect(receipt.appliedMigrations).toBe(2);
    expect(receipt.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.checkpointId).toBe("fixture/2");
    expect(ledger(database)).toMatchObject(definition.migrations.map((value, index) => ({ ordinal: index + 1,
      name: value.name, raw_sha256: value.rawSha256, status: "applied", checkpoint_id: value.checkpoint.id })));
    const admitted = admitInstallationRecoverySource(database, definition);
    expect(admitted.receipt).toEqual(receipt);
    expect(admitted.applicationObjects.map(value => value.name)).toEqual(["labels", "records", "labels_touch"]);
    expect(admitted.platformObjects.map(value => value.name)).toEqual(["node_installation", "node_migrations"]);
    expect(admitted.platformPolicy).toBe("installation-local-recreate-on-destination");
    expect(database.isTransaction).toBe(false);
  });

  it("reopens and upgrades populated prior state while retaining installation ID, timestamps and rows", () => {
    const f = fixture(), first = installReviewedSqliteCatalog(f.database, catalog(1));
    f.database.prepare("INSERT INTO records VALUES(1,'persisted')").run(); f.database.close();
    const reopened = f.open(), upgraded = installReviewedSqliteCatalog(reopened, catalog());
    expect(upgraded.installationId).toBe(first.installationId); expect(upgraded.createdAt).toBe(first.createdAt);
    expect(reopened.prepare("SELECT * FROM records").all()).toEqual([{ id: 1, value: "persisted" }]);
    reopened.prepare("INSERT INTO labels VALUES(1,'nonempty')").run();
    expect(reopened.prepare("SELECT value FROM records").get()?.value).toBe("persisted;COMMIT");
    expect(() => reopened.prepare("INSERT INTO labels VALUES(99,'foreign')").run()).toThrow(/FOREIGN KEY/);
    expect(installReviewedSqliteCatalog(reopened, catalog())).toEqual(upgraded);
  });

  it("requires explicit exact platform recovery pairing before any ledger DDL", () => {
    const { database } = fixture(), definition = catalog();
    const bad = { ...definition, emptyCheckpoint: { ...definition.emptyCheckpoint,
      recoveryAdmission: { ...definition.emptyCheckpoint.recoveryAdmission, platformObjects: [] } } };
    expect(() => installReviewedSqliteCatalog(database, bad)).toThrow(/checkpoint_recovery_pair_not_reviewed/);
    expect(schema(database)).toEqual([]); expect(database.isTransaction).toBe(false);
  });

  it("rejects a changed raw migration digest before installing anything", () => {
    const { database } = fixture(), definition = catalog();
    const bad = { ...definition, migrations: definition.migrations.map((value, index) => index === 0 ? { ...value, sql: value.sql + "-- edited" } : value) };
    expect(() => installReviewedSqliteCatalog(database, bad)).toThrow(/migration_digest/); expect(schema(database)).toEqual([]);
  });

  it("refuses rewritten applied SQL even when a caller supplies its new matching raw digest", () => {
    const { database } = fixture(); installReviewedSqliteCatalog(database, catalog(1));
    const before = ledger(database), changed = withLastSql(catalog(1), recordDdl + ";-- revised applied bytes\n");
    expect(() => installReviewedSqliteCatalog(database, changed)).toThrow(/migration_ledger_mismatch/);
    expect(ledger(database)).toEqual(before);
  });

  it("refuses unknown populated databases without silently creating an installation ledger", () => {
    const { database } = fixture(); database.exec(recordDdl); database.prepare("INSERT INTO records VALUES(1,'existing')").run();
    const before = schema(database);
    expect(() => installReviewedSqliteCatalog(database, catalog())).toThrow(/missing_installation_ledger/);
    expect(schema(database)).toEqual(before); expect(database.prepare("SELECT * FROM records").all()).toEqual([{ id: 1, value: "existing" }]);
  });

  it.each(["node_installation", "node_migrations"])("refuses missing platform table %s", table => {
    const { database } = fixture(); installReviewedSqliteCatalog(database, catalog(1)); database.exec(`DROP TABLE ${table}`);
    const before = schema(database); expect(() => installReviewedSqliteCatalog(database, catalog())).toThrow(/partial_installation_ledger/);
    expect(schema(database)).toEqual(before);
  });

  it.each(["DELETE FROM node_migrations WHERE ordinal=1", "DELETE FROM node_migrations WHERE ordinal=2"])("refuses missing/gapped receipt without repairing it: %s", sql => {
    const { database } = fixture(); installReviewedSqliteCatalog(database, catalog()); database.exec(sql); const before = ledger(database);
    expect(() => installReviewedSqliteCatalog(database, catalog())).toThrow(/ledger_mismatch|schema_checkpoint_mismatch/);
    expect(ledger(database)).toEqual(before);
  });

  it("refuses partially applied recorded status", () => {
    const { database } = fixture(); installReviewedSqliteCatalog(database, catalog(1));
    database.exec("PRAGMA ignore_check_constraints=ON;UPDATE node_migrations SET status='applying';PRAGMA ignore_check_constraints=OFF");
    expect(() => installReviewedSqliteCatalog(database, catalog())).toThrow(/migration_ledger_mismatch_or_partial/);
    expect(ledger(database)[0]?.status).toBe("applying");
  });

  it("refuses a newer installed schema and never performs a downgrade", () => {
    const { database } = fixture(), current = installReviewedSqliteCatalog(database, catalog()); const before = schema(database);
    expect(() => installReviewedSqliteCatalog(database, catalog(1))).toThrow(/newer_schema_unsupported/);
    expect(schema(database)).toEqual(before); expect(admitInstallationRecoverySource(database, catalog()).receipt).toEqual(current);
  });

  it.each(["CREATE TABLE node_unreviewed(value)", "CREATE TRIGGER ledger_extra AFTER INSERT ON node_migrations BEGIN SELECT 1; END"])("rejects unreviewed schema instead of hiding a prefix or attached object: %s", sql => {
    const { database } = fixture(); installReviewedSqliteCatalog(database, catalog(1)); database.exec(sql); const before = schema(database);
    expect(() => installReviewedSqliteCatalog(database, catalog())).toThrow(/schema_checkpoint_mismatch/);
    expect(() => admitInstallationRecoverySource(database, catalog(1))).toThrow(/schema_checkpoint_mismatch/);
    expect(schema(database)).toEqual(before);
  });

  it.each([
    ["catalog_id", "other-family"], ["installation_id", "x".repeat(36)],
    ["created_at", "not-a-time"], ["schema_checkpoint", "fixture/missing"],
  ])("refuses invalid installation sentinel %s without rotating or repairing it", (column, value) => {
    const { database } = fixture(); installReviewedSqliteCatalog(database, catalog(1));
    database.prepare(`UPDATE node_installation SET ${column}=?`).run(value); const before = database.prepare("SELECT * FROM node_installation").get();
    expect(() => installReviewedSqliteCatalog(database, catalog())).toThrow(/identity_or_checkpoint_mismatch/);
    expect(database.prepare("SELECT * FROM node_installation").get()).toEqual(before);
  });

  it("rolls back late upgrade DDL, trigger writes, rows and receipt together", () => {
    const { database } = fixture(), old = catalog(1); const receipt = installReviewedSqliteCatalog(database, old);
    database.prepare("INSERT INTO records VALUES(1,'accepted')").run(); const before = schema(database), receipts = ledger(database);
    const upgrade = withLastSql(catalog(), `${labelDdl};${triggerDdl};INSERT INTO labels VALUES(1,'attempt');INSERT INTO records VALUES(1,'duplicate')`);
    expect(() => installReviewedSqliteCatalog(database, upgrade)).toThrow(/UNIQUE/);
    expect(schema(database)).toEqual(before); expect(ledger(database)).toEqual(receipts);
    expect(database.prepare("SELECT * FROM records").all()).toEqual([{ id: 1, value: "accepted" }]);
    expect(admitInstallationRecoverySource(database, old).receipt).toEqual(receipt);
  });

  it("rolls back every fresh migration and both platform tables after a later failure", () => {
    const { database } = fixture();
    const bad = withLastSql(catalog(), `${labelDdl};${triggerDdl};INSERT INTO labels VALUES(99,'foreign')`);
    expect(() => installReviewedSqliteCatalog(database, bad)).toThrow(/FOREIGN KEY/);
    expect(schema(database)).toEqual([]); expect(database.isTransaction).toBe(false);
    expect(installReviewedSqliteCatalog(database, catalog()).appliedMigrations).toBe(2);
  });

  it.each(["COMMIT", "ROLLBACK", "SAVEPOINT hidden", "PRAGMA foreign_keys=OFF", "DELETE FROM node_migrations", "ATTACH DATABASE ':memory:' AS extra"])("native authorization prevents transaction/policy/ledger escape: %s", sql => {
    const { database } = fixture(), bad = withLastSql(catalog(1), `${recordDdl};${sql}`);
    expect(() => installReviewedSqliteCatalog(database, bad)).toThrow(/authorized|authorization/i);
    expect(schema(database)).toEqual([]); expect(database.isTransaction).toBe(false);
  });

  it("restores reviewed connection pragma changes after success and after migration failure", () => {
    const { database } = fixture(), original = database.prepare("PRAGMA legacy_alter_table").get();
    const admitted = withLastSql(catalog(1), `${recordDdl};PRAGMA legacy_alter_table=ON`);
    installReviewedSqliteCatalog(database, admitted);
    expect(database.prepare("PRAGMA legacy_alter_table").get()).toEqual(original);
    const upgrade = { ...catalog(), migrations: [admitted.migrations[0]!, catalog().migrations[1]!] };
    const bad = withLastSql(upgrade, `${labelDdl};${triggerDdl};PRAGMA legacy_alter_table=ON;INSERT INTO labels VALUES(99,'foreign')`);
    expect(() => installReviewedSqliteCatalog(database, bad)).toThrow(/FOREIGN KEY/);
    expect(database.prepare("PRAGMA legacy_alter_table").get()).toEqual(original);
  });

  it("keeps a competing writer wait finite and preserves the admitted older state", () => {
    const f = fixture(), old = installReviewedSqliteCatalog(f.database, catalog(1));
    const writer = f.open(); writer.exec("BEGIN IMMEDIATE"); const started = performance.now();
    expect(() => installReviewedSqliteCatalog(f.database, catalog(), { busyTimeoutMs: 100 })).toThrow(/locked|busy/i);
    expect(performance.now() - started).toBeGreaterThanOrEqual(50); expect(performance.now() - started).toBeLessThan(2000);
    expect(f.database.isTransaction).toBe(false); writer.exec("COMMIT");
    expect(admitInstallationRecoverySource(f.database, catalog(1)).receipt).toEqual(old);
    expect(installReviewedSqliteCatalog(f.database, catalog()).appliedMigrations).toBe(2);
  });

  it("refuses a prior checkpoint for recovery until its supported upgrade is installed", () => {
    const { database } = fixture(); installReviewedSqliteCatalog(database, catalog(1));
    expect(() => admitInstallationRecoverySource(database, catalog())).toThrow(/recovery_requires_current_checkpoint/);
    expect(database.isTransaction).toBe(false);
  });

  it("issues a frozen connection-bound admission and rejects a forged or wrong-connection token", () => {
    const f = fixture(); installReviewedSqliteCatalog(f.database, catalog());
    const admission = admitInstallationRecoverySource(f.database, catalog());
    expect(assertInstallationAdmission(f.database, admission)).toEqual(admission.receipt);
    expect(Object.isFrozen(admission)).toBe(true); expect(Object.isFrozen(admission.receipt)).toBe(true);
    expect(Object.isFrozen(admission.applicationObjects)).toBe(true);
    expect(() => assertInstallationAdmission(f.database, { ...admission })).toThrow(/admission_not_issued/);
    expect(() => assertInstallationAdmission(f.open(), admission)).toThrow(/admission_not_issued/);
  });

  it("rejects a previously issued admission after unreviewed schema appears", () => {
    const { database } = fixture(); installReviewedSqliteCatalog(database, catalog());
    const admission = admitInstallationRecoverySource(database, catalog()); database.exec("CREATE TABLE sqliteX_unreviewed(value)");
    expect(() => assertInstallationAdmission(database, admission)).toThrow(/schema_checkpoint_mismatch/);
  });

  it("rejects a previously issued admission after a different valid installation ID is written", () => {
    const { database } = fixture(); installReviewedSqliteCatalog(database, catalog());
    const admission = admitInstallationRecoverySource(database, catalog());
    database.prepare("UPDATE node_installation SET installation_id='11111111-1111-4111-8111-111111111111'").run();
    expect(() => assertInstallationAdmission(database, admission)).toThrow(/admission_identity_or_checkpoint_changed/);
  });
});
