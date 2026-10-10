import { createExportArtifact } from "../../shared/contracts/export-protocol";
import { validateLocalProfileHistoryV26 } from "../../shared/contracts/export-local-profiles-v26";
import type { ExportRow, ExportTables } from "../../shared/contracts/export";
import { canonicalLocalVolumeNamespace, localVolumeStorageProfileId } from "../../shared/contracts/local-volume-profile";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { V26_NODE_INSTALLATION_CATALOG } from "../installation-catalog-v26";
import { installReviewedSqliteCatalog, admitInstallationRecoverySource } from "../migrations";
import { createSqliteCapability } from "../sqlite";
import { shutdownQuiescedSqliteDatabase } from "../sqlite-backup";
import { captureQuiescedNodeSystemBackupV26 } from "./snapshot-v26";
import { disabledProtectedAccountTable } from "./restore";
import { createNodeExportSnapshotReader } from "../export-snapshot-sql";
import { buildFullExportV24FromSnapshot, nativeV24SnapshotSql } from "../../worker/export-v24-core";
import { validateFullExportV26 } from "../../shared/contracts/export-portable-runtime-v26";
import type { SystemBackupFile } from "../../shared/contracts/system-backup";
import { planSystemBackupSourcesV26 } from "../../shared/contracts/system-backup-v26-content";
import { validateSystemRecoveryImage, recoveryTableSnapshotSql } from "../../shared/contracts/system-recovery-image";
import { finishSystemBackupManifestV3, validateSystemBackupDocumentsV3, sourceBackupCheckpointV3, type NodeSystemBackupRecordsV3 } from "../../shared/contracts/system-backup-v3";
import { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, PORTABLE_RUNTIME_RECOVERY_TABLES } from "../../shared/contracts/portable-runtime-v26-recovery-catalog";
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
  directory = await mkdtemp(join(tmpdir(), "portable-v26-real-")); template = join(directory, "closed-template.sqlite");
  const database = new DatabaseSync(template, { allowExtension: false, enableForeignKeyConstraints: true });
  const core = createSqliteCapability(database);
  try {
    installReviewedSqliteCatalog(database, V26_NODE_INSTALLATION_CATALOG);
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
  try { return await captureQuiescedNodeSystemBackupV26(f.core, f.native, { backupId: `backup-${sequence}`, createdAt: at }); }
  finally { f.close(); }
}
async function capsule(input: NodeSystemBackupRecordsV3, partial = false) {
  const files: SystemBackupFile[] = planSystemBackupSourcesV26(input.content).map(source => ({ ...source,
    path: partial ? null : `files/${source.id}`, outcome: partial ? "missing" : "packaged", byteSize: partial ? null : payload.byteLength, sha256: partial ? null : sha(payload) }));
  const manifest = await finishSystemBackupManifestV3(input, files), metadata = await systemBackupArchiveMetadata(manifest, input, manifest);
  expect(metadata.contents.get("report/index.html")).toContain("Restored accounts are disabled");
  expect(metadata.contents.get("report/report.md")).not.toContain(verifier);
  const open = async () => new Response(payload.slice().buffer).body!;
  const measured = await measureSystemBackupArchive(metadata, open, NODE_RECOVERY_ARCHIVE_OPTIONS);
  const archive = new Uint8Array(await new Response(createSystemBackupArchiveStream(metadata, open, NODE_RECOVERY_ARCHIVE_OPTIONS)).arrayBuffer());
  expect(sha(archive)).toBe(measured.sha256);
  return { manifest, archive, payloadOffset: measured.entries.find(entry => entry.kind === "payload")?.dataOffset };
}
it("captures actual current business, protected typed cells and all24 receipts in ONE SQLite batch, excluding identity from research", async () => {
  const f = await fixture(), batches = vi.spyOn(f.core, "batch");
  try {
    const input = await captureQuiescedNodeSystemBackupV26(f.core, f.native, { backupId: "atomic-current", createdAt: at });
    expect(batches).toHaveBeenCalledTimes(1);
    expect(input.content.schemaVersion).toBe(26); expect(input.image.version).toBe(3); expect(input.image.checkpointId).toBe(PORTABLE_RUNTIME_CHECKPOINT_ID);
    expect(input.image.schemaSha256).toBe(PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256);
    expect(Object.keys(input.image.tables)).toHaveLength(103);
    expect(input.sourceMigrationLedger.entries).toHaveLength(24);
    expect(input.sourceMigrationLedger.entries.at(-1)?.name).toBe("0024_rt3_local_volume_profiles.sql");
    expect(input.image.tables.local_auth_events.rows[0].rowid).toBe("9007199254740993");
    const revision = input.image.tables.local_accounts.columns.indexOf("credential_revision");
    expect(input.image.tables.local_accounts.rows.some(row => row.cells[revision].type === "integer" && row.cells[revision].value === "9223372036854775807")).toBe(true);
    for (const name of ["local_identity_installation", "local_admin_grants", "local_sessions", "local_login_throttle", "node_installation", "node_migrations"])
      expect(Object.hasOwn(input.image.tables, name)).toBe(false);
    expect(JSON.stringify(input.content)).not.toContain(verifier);
    expect(Object.keys(input.content.tables).some(name => name.startsWith("local_") || name.startsWith("node_"))).toBe(false);
    expect(input.content.artifacts.sourceSchema.value.objects.some(object => object.tableName.startsWith("local_") || object.tableName.startsWith("node_"))).toBe(false);
    await expect(validateFullExportV26(input.content)).resolves.toMatchObject({ schemaVersion: 26 });
    expect(() => validateSystemRecoveryImage(input.image)).toThrow();
    await expect(buildFullExportV24FromSnapshot(await createNodeExportSnapshotReader(f.core).readBatch(nativeV24SnapshotSql()))).rejects.toThrow();
  } finally { f.close(); }
}, 20_000);
it("freezes protected source cells and detects a later current account change in the source checkpoint", async () => {
  const f = await fixture();
  try {
    const first = await captureQuiescedNodeSystemBackupV26(f.core, f.native, { backupId: "before", createdAt: at });
    const before = await sourceBackupCheckpointV3(first), image = stableJson(first.image);
    f.native.prepare("UPDATE local_accounts SET enabled=0 WHERE principal_id=?").run(principal);
    const after = await captureQuiescedNodeSystemBackupV26(f.core, f.native, { backupId: "after", createdAt: at });
    expect(await sourceBackupCheckpointV3(after)).not.toBe(before); expect(stableJson(first.image)).toBe(image);
  } finally { f.close(); }
}, 20_000);
it("recovers a non-empty V26/image3 capsule with exact int64 rows/bytes, disabled accounts, zero imported authority and a NEW restart-stable ledger identity", async () => {
  const input = await records(), zipped = await capsule(input), archivePath = join(directory, "current-valid.zip");
  await writeFile(archivePath, zipped.archive);
  const network = vi.fn(() => { throw new Error("Recovery must not activate providers"); }); vi.stubGlobal("fetch", network);
  const result = await restoreSystemBackupToIsolatedDirectory({ archivePath, destination: join(directory, "current-restored"), expectedSha256: sha(zipped.archive) });
  expect(result.report).toMatchObject({ providerIO: false, executionEnabled: false, maintenanceState: "fenced", sourceImageSchemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256,
    protectedIdentity: { accountsDisabled: true, principalIdsAndVerifiersPreserved: true, sessionsRestored: false, grantsRestored: false } });
  const native = new DatabaseSync(result.databasePath, { allowExtension: false, enableForeignKeyConstraints: true }), core = createSqliteCapability(native);
  let installationId: string;
  try {
    const current = admitInstallationRecoverySource(native, V26_NODE_INSTALLATION_CATALOG); installationId = current.receipt.installationId;
    expect(installationId).not.toBe(input.sourceMigrationLedger.installationId);
    for (const spec of PORTABLE_RUNTIME_RECOVERY_TABLES.filter(table => !table.local)) {
      const observed = native.prepare(recoveryTableSnapshotSql(spec)).all() as Array<{ rowid: string | null; cells: string }>;
      const expected = spec.name === "local_accounts" ? disabledProtectedAccountTable(input.image.tables[spec.name]) : input.image.tables[spec.name];
      expect(stableJson(observed.map(row => ({ rowid: row.rowid, cells: JSON.parse(row.cells) })).map(stableJson).sort()))
        .toBe(stableJson(expected.rows.map(stableJson).sort()));
    }
    expect(native.prepare("SELECT CAST(rowid AS TEXT) rowid,description FROM samples WHERE id='minimum'").get()).toEqual({ rowid: "-9223372036854775808", description: "Retained\0text中文" });
    expect(native.prepare("SELECT password_verifier,enabled FROM local_accounts WHERE principal_id=?").get(principal)).toEqual({ password_verifier: verifier, enabled: 0 });
    for (const name of ["local_identity_installation", "local_admin_grants", "local_sessions", "local_login_throttle", "local_storage_profile_checks", "local_storage_profile_admissions", "local_storage_profile_bindings"])
      expect(native.prepare(`SELECT count(*) count FROM ${name}`).get()?.count).toBe(0);
    expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(installReviewedSqliteCatalog(native, V26_NODE_INSTALLATION_CATALOG).installationId).toBe(installationId);
    shutdownQuiescedSqliteDatabase(native);
  } finally { core.close(); }
  const restarted = new DatabaseSync(result.databasePath), restartedCore = createSqliteCapability(restarted);
  try { expect(admitInstallationRecoverySource(restarted, V26_NODE_INSTALLATION_CATALOG).receipt.installationId).toBe(installationId!); }
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
  await expect(validateSystemBackupDocumentsV3(zipped.manifest, invalid)).resolves.toMatchObject({ records: { schema: "system-backup-records/3" } });
  await writeFile(archivePath, zipped.archive);
  await expect(restoreSystemBackupToIsolatedDirectory({ archivePath, destination })).rejects.toThrow("UNIQUE constraint failed");
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" }); expect(await readFile(archivePath)).toEqual(Buffer.from(zipped.archive));
}, 30_000);
it("refuses rehashed altered prefix/current ledger evidence, an imported session image or an invalid enabled state", async () => {
  const input = await records();
  for (const damage of [
    (value: NodeSystemBackupRecordsV3) => { value.sourceMigrationLedger.entries[0].schemaSha256 = "a".repeat(64); },
    (value: NodeSystemBackupRecordsV3) => { value.sourceMigrationLedger.schemaSha256 = "a".repeat(64); },
    (value: NodeSystemBackupRecordsV3) => { value.image.tables.local_sessions = { columns: [], rows: [] }; },
    (value: NodeSystemBackupRecordsV3) => { value.image.tables.local_accounts.rows[0].cells[value.image.tables.local_accounts.columns.indexOf("enabled")] = { type: "integer", value: "2" }; },
  ]) {
    const changed = structuredClone(input); damage(changed);
    const manifest = await finishSystemBackupManifestV3(changed, planSystemBackupSourcesV26(changed.content).map(source => ({ ...source,
      path: `files/${source.id}`, outcome: "packaged", byteSize: payload.byteLength, sha256: sha(payload) })));
    await expect(validateSystemBackupDocumentsV3(manifest, changed)).rejects.toThrow();
  }
}, 20_000);
it.each(["missing-ledger", "unknown-schema"])("refuses %s before any canonical/protected snapshot batch", async damage => {
  const f = await fixture(), batches = vi.spyOn(f.core, "batch");
  try {
    if (damage === "missing-ledger") f.native.exec("DROP TABLE node_migrations");
    else f.native.exec("CREATE TABLE sqliteX_unreviewed(secret TEXT)");
    await expect(captureQuiescedNodeSystemBackupV26(f.core, f.native, { backupId: "denied" })).rejects.toThrow();
    expect(batches).not.toHaveBeenCalled();
  } finally { f.close(); }
}, 20_000);
it("refuses an actual unsafe Number business cell rather than round an int64 value", async () => {
  const f = await fixture();
  try {
    f.native.prepare("UPDATE assets SET byte_size=? WHERE id='original'").run(9007199254740993n);
    await expect(captureQuiescedNodeSystemBackupV26(f.core, f.native, { backupId: "unsafe" })).rejects.toThrow("outside the exact JavaScript integer range");
  } finally { f.close(); }
}, 20_000);

/** Exact current SQL guard model. These check result flags are test provenance;
 * this fixture does not claim a physical probe/provider is composed. */
async function localProfileModel(native: DatabaseSync, mode: "read_write" | "retired") {
  const namespace = { kind: "local-volume", volumeId: "10000000-0000-4000-8000-000000000001", rootId: "20000000-0000-4000-8000-000000000002", namespaceRevision: 1 };
  const profileId = await localVolumeStorageProfileId(namespace), digest = profileId.slice("storage-profile:local:".length);
  const ids = { registration: "30000000-0000-4000-8000-000000000003", check: "50000000-0000-4000-8000-000000000005",
    admission: "60000000-0000-4000-8000-000000000006", binding: "70000000-0000-4000-8000-000000000007",
    installation: "80000000-0000-4000-8000-000000000008", rootBinding: "90000000-0000-4000-8000-000000000009",
    activation: "a0000000-0000-4000-8000-00000000000a", retirement: "b0000000-0000-4000-8000-00000000000b" };
  const later = (milliseconds: number) => new Date(Date.parse(at) + milliseconds).toISOString(), actor = "model@example.test", fingerprint = "d".repeat(64);
  native.exec("BEGIN IMMEDIATE");
  try {
    native.prepare("INSERT INTO storage_profiles(id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at) VALUES(?,'local',?,'installation',NULL,1,'historical',?)")
      .run(profileId, canonicalLocalVolumeNamespace(namespace), at);
    native.prepare("INSERT INTO local_storage_profile_registrations VALUES(?,?,?,?,?)").run(profileId, ids.registration, digest, actor, at);
    native.prepare(`INSERT INTO local_storage_profile_checks(id,storage_profile_id,configuration_revision,installation_id,root_binding_id,binding_id,binding_revision,
      namespace_sha256,binding_fingerprint_sha256,access,state,probe_object_key,probe_sha256,probe_byte_size,stat_verified,read_verified,write_verified,delete_verified,cleanup_complete,actor,created_at,completed_at)
      VALUES(?,?,1,?,?,?,1,?,?,'read_write','checking',?,?,4,0,0,0,0,0,?,?,NULL)`)
      .run(ids.check, profileId, ids.installation, ids.rootBinding, ids.binding, digest, fingerprint, `local-profile-check/${ids.check}`, "e".repeat(64), actor, later(1));
    native.prepare("UPDATE local_storage_profile_checks SET state='passed',stat_verified=1,read_verified=1,write_verified=1,delete_verified=1,cleanup_complete=1,completed_at=? WHERE id=?")
      .run(later(2), ids.check);
    native.prepare("INSERT INTO local_storage_profile_admissions VALUES(?,?,1,?,?,?,1,?,?,?,'read_write',?,?)")
      .run(ids.admission, profileId, ids.installation, ids.rootBinding, ids.binding, ids.check, digest, fingerprint, actor, later(2));
    native.prepare("INSERT INTO local_storage_profile_bindings VALUES(?,?,?,?,1,?,?,?,'read_write','available',?,?)")
      .run(profileId, ids.installation, ids.rootBinding, ids.binding, ids.admission, digest, fingerprint, later(2), later(2));
    native.prepare("INSERT INTO local_storage_profile_activations VALUES(?,?,1,'activate',?,1,?,?,?)").run(ids.activation, profileId, ids.admission, digest, actor, later(3));
    native.prepare("UPDATE storage_profile_runtime SET state='read_write',activated_at=? WHERE storage_profile_id=?").run(later(3), profileId);
    if (mode === "retired") {
      native.prepare("INSERT INTO local_storage_profile_activations VALUES(?,?,1,'retire',?,1,?,?,?)").run(ids.retirement, profileId, ids.admission, digest, actor, later(4));
      native.prepare("UPDATE storage_profile_runtime SET state='retired',retired_at=? WHERE storage_profile_id=?").run(later(4), profileId);
    }
    native.exec("COMMIT");
  } catch (error) { if (native.isTransaction) native.exec("ROLLBACK"); throw error; }
  return profileId;
}
it.each(["read_write", "retired"] as const)("archives/restores non-empty protected local history in %s mode but ZERO installation checks/admissions/bindings", async mode => {
  const f = await fixture();
  let input: NodeSystemBackupRecordsV3, profileId: string;
  try {
    profileId = await localProfileModel(f.native, mode);
    for (const name of ["local_storage_profile_checks", "local_storage_profile_admissions", "local_storage_profile_bindings"])
      expect(f.native.prepare(`SELECT count(*) AS count FROM ${name}`).get()?.count).toBe(1);
    input = await captureQuiescedNodeSystemBackupV26(f.core, f.native, { backupId: `local-${mode}`, createdAt: at });
    expect(input.image.tables.local_storage_profile_registrations.rows).toHaveLength(1);
    expect(input.image.tables.local_storage_profile_activations.rows).toHaveLength(mode === "retired" ? 2 : 1);
    expect(input.protectedConfiguration.tableNames).toContain("local_storage_profile_registrations");
    expect(input.protectedConfiguration.tableNames).toContain("local_storage_profile_activations");
    for (const name of ["local_storage_profile_registrations", "local_storage_profile_activations", "local_storage_profile_checks", "local_storage_profile_admissions", "local_storage_profile_bindings"])
      expect(Object.hasOwn(input.content.tables, name)).toBe(false);
  } finally { f.close(); }
  const zipped = await capsule(input), path = join(directory, `local-${mode}.zip`); await writeFile(path, zipped.archive);
  const result = await restoreSystemBackupToIsolatedDirectory({ archivePath: path, destination: join(directory, `local-${mode}-restored`) });
  const native = new DatabaseSync(result.databasePath, { enableForeignKeyConstraints: true });
  try {
    for (const name of ["local_storage_profile_checks", "local_storage_profile_admissions", "local_storage_profile_bindings"])
      expect(native.prepare(`SELECT count(*) AS count FROM ${name}`).get()?.count).toBe(0);
    for (const name of ["local_storage_profile_registrations", "local_storage_profile_activations"] as const) {
      const spec = PORTABLE_RUNTIME_RECOVERY_TABLES.find(table => table.name === name)!;
      const rows = native.prepare(recoveryTableSnapshotSql(spec)).all() as Array<{ rowid: string | null; cells: string }>;
      expect(stableJson(rows.map(row => ({ rowid: row.rowid, cells: JSON.parse(row.cells) })).map(stableJson).sort()))
        .toBe(stableJson(input.image.tables[name].rows.map(stableJson).sort()));
    }
    expect(native.prepare("SELECT state FROM storage_profile_runtime WHERE storage_profile_id=?").get(profileId)).toEqual({ state: mode });
    expect(native.prepare("SELECT state FROM system_recovery_maintenance WHERE singleton=1").get()?.state).toBe("fenced");
    expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(admitInstallationRecoverySource(native, V26_NODE_INSTALLATION_CATALOG).receipt.checkpointId).toBe("portable-runtime/v26");
    expect(() => native.prepare("UPDATE storage_profile_runtime SET state='read_write',retired_at=NULL WHERE storage_profile_id=?").run(profileId)).toThrow(/explicit current activation/);
  } finally { native.close(); }
}, 30_000);

it.each(["sourceSchema", "compatibilityColumns"] as const)("rejects rehashed undeclared %s payload inside genuine current research provenance", async field => {
  const input = await records(), content = structuredClone(input.content), source = content.artifacts.sourceSchema;
  const target = field === "sourceSchema" ? source.value : source.value.compatibilityColumns;
  Reflect.set(target, "undeclaredProtectedPayload", verifier);
  content.artifacts.sourceSchema = await createExportArtifact(source.path, source.value);
  await expect(validateFullExportV26(content)).rejects.toThrow("observed schema/clock");
}, 20_000);

it("admits retirement-only provenance and later fresh binding, but refuses reusing its excluded admission for a different binding", async () => {
  const f = await fixture();
  try {
    const profileId = await localProfileModel(f.native, "read_write");
    const input = await captureQuiescedNodeSystemBackupV26(f.core, f.native, { backupId: "provenance-model", createdAt: at });
    const tables: ExportTables = structuredClone(input.content.tables);
    for (const name of ["local_storage_profile_registrations", "local_storage_profile_activations"] as const) {
      const image = input.image.tables[name];
      tables[name] = image.rows.map(row => Object.fromEntries(image.columns.map((column, index) => {
        const cell = row.cells[index];
        if (cell.type === "integer") return [column, Number(cell.value)];
        if (cell.type === "text") return [column, cell.value];
        if (cell.type === "null") return [column, null];
        throw new Error("Unexpected protected local-history fixture cell");
      })) as ExportRow);
    }
    const first = tables.local_storage_profile_activations[0];
    const retiredAt = new Date(Date.parse(at) + 3).toISOString(), activatedAt = new Date(Date.parse(at) + 4).toISOString();
    tables.local_storage_profile_activations = [{ ...first, action: "retire", created_at: retiredAt },
      { ...first, operation_id: "b0000000-0000-4000-8000-00000000000b", action: "activate", binding_revision: 2,
        admission_operation_id: "c0000000-0000-4000-8000-00000000000c", created_at: activatedAt }];
    const versions = tables.file_shadow_dependency_versions.filter(row => row.dependency_kind === "storage_profile_runtime" && row.dependency_key === stableJson([profileId]));
    const initial: ExportRow = JSON.parse(String(versions[0].snapshot_json));
    const retired = { ...initial, state: "retired", retired_at: retiredAt };
    const active = { ...initial, state: "read_write", activated_at: activatedAt };
    tables.file_shadow_dependency_versions = tables.file_shadow_dependency_versions.filter(row => !versions.includes(row));
    tables.file_shadow_dependency_versions.push(versions[0], { ...versions[1], revision: 2, snapshot_json: JSON.stringify(retired) },
      { ...versions[1], revision: 3, snapshot_json: JSON.stringify(active) });
    tables.storage_profile_runtime = tables.storage_profile_runtime.map(row => row.storage_profile_id === profileId ? active : row);
    await expect(validateLocalProfileHistoryV26(tables)).resolves.toEqual(new Set([profileId]));
    tables.local_storage_profile_activations[1].admission_operation_id = first.admission_operation_id;
    await expect(validateLocalProfileHistoryV26(tables)).rejects.toThrow("new activation provenance");
  } finally { f.close(); }
}, 20_000);
