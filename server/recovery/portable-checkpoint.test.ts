import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { CURRENT_NODE_INSTALLATION_CATALOG } from "../installation-catalog";
import { installReviewedSqliteCatalog, admitInstallationRecoverySource } from "../migrations";
import { createSqliteCapability } from "../sqlite";
import { shutdownQuiescedSqliteDatabase } from "../sqlite-backup";
import { captureQuiescedNodeSystemBackup } from "./snapshot";
import { disabledProtectedAccountTable } from "./restore";
import { createNodeExportSnapshotReader } from "../export-snapshot-sql";
import { buildFullExportV24FromSnapshot, nativeV24SnapshotSql } from "../../worker/export-v24-core";
import { validateFullExportV25, portableBusinessManifestV24 } from "../../shared/contracts/export-portable-runtime";
import { planSystemBackupSources, type SystemBackupFile } from "../../shared/contracts/system-backup";
import { validateSystemRecoveryImage, recoveryTableSnapshotSql } from "../../shared/contracts/system-recovery-image";
import { finishSystemBackupManifestV2, validateSystemBackupDocumentsV2, sourceBackupCheckpointV2, type NodeSystemBackupRecordsV2 } from "../../shared/contracts/system-backup-v2";
import { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, PORTABLE_RUNTIME_RECOVERY_TABLES } from "../../shared/contracts/portable-runtime-recovery-catalog";
import { stableJson } from "../../shared/domain/content-addressing";
import { createSystemBackupArchiveStream, measureSystemBackupArchive, systemBackupArchiveMetadata } from "../../shared/domain/system-backup-archive";
import { restoreSystemBackupToIsolatedDirectory } from "../../scripts/lib/restore-system-backup";
import { NODE_RECOVERY_ARCHIVE_OPTIONS } from "../../scripts/lib/system-backup-node-io";

const payload = Uint8Array.of(0, 1, 255, 7), at = "2026-10-10T12:00:00.000Z";
const principal = "local_10000000-0000-4000-8000-000000000001", otherPrincipal = "local_10000000-0000-4000-8000-000000000002";
// An opaque syntactically valid protected verifier cell, with no known password.
// These tests qualify recovery cells; the real KDF/auth suite qualifies hashing.
const verifier = ["scrypt", 1, 131072, 8, 1, 32, Buffer.alloc(32, 17).toString("base64url"), Buffer.alloc(32, 29).toString("base64url")].join("$");
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
let directory: string, template: string, sequence = 0;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "portable-v25-real-")); template = join(directory, "closed-template.sqlite");
  const database = new DatabaseSync(template, { allowExtension: false, enableForeignKeyConstraints: true });
  const core = createSqliteCapability(database);
  try {
    installReviewedSqliteCatalog(database, CURRENT_NODE_INSTALLATION_CATALOG);
    database.prepare("INSERT INTO samples(rowid,id,code,title,description,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(-9223372036854775808n, "minimum", "MIN", "Retained sample", "Retained\0text中文", at, at);
    database.prepare("INSERT INTO samples(rowid,id,code,title,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(9223372036854775807n, "maximum", "MAX", "Retained maximum", at, at);
    database.prepare("INSERT INTO assets(rowid,id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at) VALUES(?,?,?,?,?,4,'ready',?,?)")
      .run(9007199254740993n, "original", "retained/original", "original.bin", "application/octet-stream", sha(payload), at);
    database.prepare("INSERT INTO local_accounts VALUES(?,?,?,3,1,0)").run(principal, "retained.admin", verifier);
    database.prepare("INSERT INTO local_accounts VALUES(?,?,?,9223372036854775807,0,0)").run(otherPrincipal, "retained.other", verifier);
    database.prepare("INSERT INTO local_identity_installation VALUES(1,?,'local-identity-v1',0)").run(principal);
    database.prepare("INSERT INTO local_admin_grants VALUES(?,0)").run(principal);
    database.prepare("INSERT INTO local_sessions VALUES(?,?,3,0,1000,0,NULL)").run("a".repeat(64), principal);
    database.prepare("INSERT INTO local_login_throttle VALUES(?,0,1)").run("b".repeat(64));
    database.prepare("INSERT INTO local_auth_events VALUES(?,?, 'bootstrap',0)").run(9007199254740993n, principal);
    shutdownQuiescedSqliteDatabase(database);
  } finally { core.close(); }
}, 20_000);
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const path = join(directory, `source-${++sequence}.sqlite`);
  // The template was actually checkpointed and CLOSED, so no live WAL is lost.
  await copyFile(template, path);
  const native = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true });
  const core = createSqliteCapability(native);
  return { path, native, core, close: () => core.close() };
}
async function records() {
  const f = await fixture();
  try { return await captureQuiescedNodeSystemBackup(f.core, f.native, { backupId: `backup-${sequence}`, createdAt: at }); }
  finally { f.close(); }
}
async function capsule(input: NodeSystemBackupRecordsV2, partial = false) {
  const files: SystemBackupFile[] = planSystemBackupSources(portableBusinessManifestV24(input.content)).map(source => ({ ...source,
    path: partial ? null : `files/${source.id}`, outcome: partial ? "missing" : "packaged", byteSize: partial ? null : payload.byteLength, sha256: partial ? null : sha(payload) }));
  const manifest = await finishSystemBackupManifestV2(input, files), metadata = await systemBackupArchiveMetadata(manifest, input, manifest);
  expect(metadata.contents.get("report/index.html")).toContain("Restored accounts are disabled");
  expect(metadata.contents.get("report/report.md")).not.toContain(verifier);
  const open = async () => new Response(payload.slice().buffer).body!;
  const measured = await measureSystemBackupArchive(metadata, open, NODE_RECOVERY_ARCHIVE_OPTIONS);
  const archive = new Uint8Array(await new Response(createSystemBackupArchiveStream(metadata, open, NODE_RECOVERY_ARCHIVE_OPTIONS)).arrayBuffer());
  expect(sha(archive)).toBe(measured.sha256);
  return { manifest, archive, payloadOffset: measured.entries.find(entry => entry.kind === "payload")?.dataOffset };
}
it("captures actual current business, protected typed cells and all23 receipts in ONE SQLite batch, excluding identity from research", async () => {
  const f = await fixture(), batches = vi.spyOn(f.core, "batch");
  try {
    const input = await captureQuiescedNodeSystemBackup(f.core, f.native, { backupId: "atomic-current", createdAt: at });
    expect(batches).toHaveBeenCalledTimes(1);
    expect(input.content.schemaVersion).toBe(25); expect(input.image.version).toBe(2); expect(input.image.checkpointId).toBe(PORTABLE_RUNTIME_CHECKPOINT_ID);
    expect(input.image.schemaSha256).toBe(PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256);
    expect(Object.keys(input.image.tables)).toHaveLength(101);
    expect(input.sourceMigrationLedger.entries).toHaveLength(23);
    expect(input.sourceMigrationLedger.entries.at(-1)?.name).toBe("0023_portable_local_identity.sql");
    expect(input.image.tables.local_auth_events.rows[0].rowid).toBe("9007199254740993");
    const revision = input.image.tables.local_accounts.columns.indexOf("credential_revision");
    expect(input.image.tables.local_accounts.rows.some(row => row.cells[revision].type === "integer" && row.cells[revision].value === "9223372036854775807")).toBe(true);
    for (const name of ["local_identity_installation", "local_admin_grants", "local_sessions", "local_login_throttle", "node_installation", "node_migrations"])
      expect(Object.hasOwn(input.image.tables, name)).toBe(false);
    expect(JSON.stringify(input.content)).not.toContain(verifier);
    expect(Object.keys(input.content.tables).some(name => name.startsWith("local_") || name.startsWith("node_"))).toBe(false);
    expect(input.content.artifacts.sourceSchema.value.objects.some(object => object.tableName.startsWith("local_") || object.tableName.startsWith("node_"))).toBe(false);
    await expect(validateFullExportV25(input.content)).resolves.toMatchObject({ schemaVersion: 25 });
    expect(() => validateSystemRecoveryImage(input.image)).toThrow();
    await expect(buildFullExportV24FromSnapshot(await createNodeExportSnapshotReader(f.core).readBatch(nativeV24SnapshotSql()))).rejects.toThrow();
  } finally { f.close(); }
}, 20_000);
it("freezes protected source cells and detects a later current account change in the source checkpoint", async () => {
  const f = await fixture();
  try {
    const first = await captureQuiescedNodeSystemBackup(f.core, f.native, { backupId: "before", createdAt: at });
    const before = await sourceBackupCheckpointV2(first), image = stableJson(first.image);
    f.native.prepare("UPDATE local_accounts SET enabled=0 WHERE principal_id=?").run(principal);
    const after = await captureQuiescedNodeSystemBackup(f.core, f.native, { backupId: "after", createdAt: at });
    expect(await sourceBackupCheckpointV2(after)).not.toBe(before); expect(stableJson(first.image)).toBe(image);
  } finally { f.close(); }
}, 20_000);
it("recovers a non-empty V25/image2 capsule with exact int64 rows/bytes, disabled accounts, zero imported authority and a NEW restart-stable ledger identity", async () => {
  const input = await records(), zipped = await capsule(input), archivePath = join(directory, "current-valid.zip");
  await writeFile(archivePath, zipped.archive);
  const network = vi.fn(() => { throw new Error("Recovery must not activate providers"); }); vi.stubGlobal("fetch", network);
  const result = await restoreSystemBackupToIsolatedDirectory({ archivePath, destination: join(directory, "current-restored"), expectedSha256: sha(zipped.archive) });
  expect(result.report).toMatchObject({ providerIO: false, executionEnabled: false, maintenanceState: "fenced", sourceImageSchemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256,
    protectedIdentity: { accountsDisabled: true, principalIdsAndVerifiersPreserved: true, sessionsRestored: false, grantsRestored: false } });
  const native = new DatabaseSync(result.databasePath, { allowExtension: false, enableForeignKeyConstraints: true }), core = createSqliteCapability(native);
  let installationId: string;
  try {
    const current = admitInstallationRecoverySource(native, CURRENT_NODE_INSTALLATION_CATALOG); installationId = current.receipt.installationId;
    expect(installationId).not.toBe(input.sourceMigrationLedger.installationId);
    for (const spec of PORTABLE_RUNTIME_RECOVERY_TABLES.filter(table => !table.local)) {
      const observed = native.prepare(recoveryTableSnapshotSql(spec)).all() as Array<{ rowid: string | null; cells: string }>;
      const expected = spec.name === "local_accounts" ? disabledProtectedAccountTable(input.image.tables[spec.name]) : input.image.tables[spec.name];
      expect(stableJson(observed.map(row => ({ rowid: row.rowid, cells: JSON.parse(row.cells) })).map(stableJson).sort()))
        .toBe(stableJson(expected.rows.map(stableJson).sort()));
    }
    expect(native.prepare("SELECT CAST(rowid AS TEXT) rowid,description FROM samples WHERE id='minimum'").get()).toEqual({ rowid: "-9223372036854775808", description: "Retained\0text中文" });
    expect(native.prepare("SELECT password_verifier,enabled FROM local_accounts WHERE principal_id=?").get(principal)).toEqual({ password_verifier: verifier, enabled: 0 });
    for (const name of ["local_identity_installation", "local_admin_grants", "local_sessions", "local_login_throttle"])
      expect(native.prepare(`SELECT count(*) count FROM ${name}`).get()?.count).toBe(0);
    expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(installReviewedSqliteCatalog(native, CURRENT_NODE_INSTALLATION_CATALOG).installationId).toBe(installationId);
    shutdownQuiescedSqliteDatabase(native);
  } finally { core.close(); }
  const restarted = new DatabaseSync(result.databasePath), restartedCore = createSqliteCapability(restarted);
  try { expect(admitInstallationRecoverySource(restarted, CURRENT_NODE_INSTALLATION_CATALOG).receipt.installationId).toBe(installationId!); }
  finally { restartedCore.close(); }
  expect(await readFile(join(result.destination, zipped.manifest.files[0].path!))).toEqual(Buffer.from(payload));
  expect(await readFile(join(result.destination, "metadata/records.json"), "utf8")).toBe(stableJson(input));
  expect(await readFile(archivePath)).toEqual(Buffer.from(zipped.archive)); expect(network).not.toHaveBeenCalled();
}, 30_000);
it("rejects a corrupt payload and a legitimate partial capsule without leaving any destination or changing the original", async () => {
  const input = await records(), zipped = await capsule(input), bad = zipped.archive.slice(); bad[zipped.payloadOffset!] ^= 1;
  const corruptPath = join(directory, "current-corrupt.zip"); await writeFile(corruptPath, bad);
  const corruptTarget = join(directory, "corrupt-target");
  await expect(restoreSystemBackupToIsolatedDirectory({ archivePath: corruptPath, destination: corruptTarget })).rejects.toThrow();
  await expect(stat(corruptTarget)).rejects.toMatchObject({ code: "ENOENT" });
  const partial = await capsule(input, true), partialPath = join(directory, "current-partial.zip"); await writeFile(partialPath, partial.archive);
  const partialTarget = join(directory, "partial-target");
  await expect(restoreSystemBackupToIsolatedDirectory({ archivePath: partialPath, destination: partialTarget })).rejects.toThrow("partial_backup_not_complete_recovery");
  await expect(stat(partialTarget)).rejects.toMatchObject({ code: "ENOENT" }); expect(await readFile(partialPath)).toEqual(Buffer.from(partial.archive));
}, 30_000);
it("rolls back a late protected-row uniqueness failure after accepting a structurally complete capsule", async () => {
  const input = await records(), invalid = structuredClone(input), accounts = invalid.image.tables.local_accounts;
  const username = accounts.columns.indexOf("username"); accounts.rows[1].cells[username] = structuredClone(accounts.rows[0].cells[username]);
  const zipped = await capsule(invalid), archivePath = join(directory, "duplicate-account.zip"), destination = join(directory, "late-failure-target");
  await expect(validateSystemBackupDocumentsV2(zipped.manifest, invalid)).resolves.toMatchObject({ records: { schema: "system-backup-records/2" } });
  await writeFile(archivePath, zipped.archive);
  await expect(restoreSystemBackupToIsolatedDirectory({ archivePath, destination })).rejects.toThrow("UNIQUE constraint failed");
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" }); expect(await readFile(archivePath)).toEqual(Buffer.from(zipped.archive));
}, 30_000);
it("refuses rehashed altered prefix/current ledger evidence, an imported session image or an invalid enabled state", async () => {
  const input = await records();
  for (const damage of [
    (value: NodeSystemBackupRecordsV2) => { value.sourceMigrationLedger.entries[0].schemaSha256 = "a".repeat(64); },
    (value: NodeSystemBackupRecordsV2) => { value.sourceMigrationLedger.schemaSha256 = "a".repeat(64); },
    (value: NodeSystemBackupRecordsV2) => { value.image.tables.local_sessions = { columns: [], rows: [] }; },
    (value: NodeSystemBackupRecordsV2) => { value.image.tables.local_accounts.rows[0].cells[value.image.tables.local_accounts.columns.indexOf("enabled")] = { type: "integer", value: "2" }; },
  ]) {
    const changed = structuredClone(input); damage(changed);
    const manifest = await finishSystemBackupManifestV2(changed, planSystemBackupSources(portableBusinessManifestV24(changed.content)).map(source => ({ ...source,
      path: `files/${source.id}`, outcome: "packaged", byteSize: payload.byteLength, sha256: sha(payload) })));
    await expect(validateSystemBackupDocumentsV2(manifest, changed)).rejects.toThrow();
  }
}, 20_000);
it.each(["missing-ledger", "unknown-schema"])("refuses %s before any canonical/protected snapshot batch", async damage => {
  const f = await fixture(), batches = vi.spyOn(f.core, "batch");
  try {
    if (damage === "missing-ledger") f.native.exec("DROP TABLE node_migrations");
    else f.native.exec("CREATE TABLE sqliteX_unreviewed(secret TEXT)");
    await expect(captureQuiescedNodeSystemBackup(f.core, f.native, { backupId: "denied" })).rejects.toThrow();
    expect(batches).not.toHaveBeenCalled();
  } finally { f.close(); }
}, 20_000);
it("refuses an actual unsafe Number business cell rather than round an int64 value", async () => {
  const f = await fixture();
  try {
    f.native.prepare("UPDATE assets SET byte_size=? WHERE id='original'").run(9007199254740993n);
    await expect(captureQuiescedNodeSystemBackup(f.core, f.native, { backupId: "unsafe" })).rejects.toThrow("outside the exact JavaScript integer range");
  } finally { f.close(); }
}, 20_000);
