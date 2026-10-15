import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../../worker/reference-test-support";
import { saveStorageCandidate } from "../../worker/storage/configuration-registry";
import { captureSystemBackupSnapshot } from "../../worker/recovery/backup-snapshot";
import { RECOVERY_SCHEMA_SHA256, RECOVERY_TABLES } from "../../worker/recovery/trusted-schema";
import { finishSystemBackupManifest, planSystemBackupSources, type SystemBackupRecordsV1, type SystemBackupFile } from "../../shared/contracts/system-backup";
import { systemBackupArchiveMetadata, createSystemBackupArchiveStream, measureSystemBackupArchive } from "../../shared/domain/system-backup-archive";
import { recoveryTableSnapshotSql } from "../../shared/contracts/system-recovery-image";
import { stableJson } from "../../shared/domain/content-addressing";
import { NODE_RECOVERY_ARCHIVE_OPTIONS } from "./system-backup-node-io";
import { restoreSystemBackupToIsolatedDirectory } from "./restore-system-backup";
import type { Env } from "../../worker/types";

const directories: string[] = [], bytes = Uint8Array.of(0, 1, 255, 7), at = "2026-10-06T12:00:00.000Z";
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
afterEach(async () => { vi.unstubAllGlobals(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function sourceRecords(large = false) {
  const source = referenceTestDatabase();
  try {
    source.prepare("INSERT INTO samples(rowid,id,code,title,description,created_at,updated_at) VALUES(CAST(? AS INTEGER),'minimum','MIN','Minimum source',?,?,?)")
      .run("-9223372036854775808", "Retained\0text中文", at, at);
    source.prepare("INSERT INTO samples(rowid,id,code,title,created_at,updated_at) VALUES(CAST(? AS INTEGER),'maximum','MAX','Maximum source',?,?)")
      .run("9223372036854775807", at, at);
    if (large) for (let index = 0; index < 160; index++) source.prepare("INSERT INTO samples(rowid,id,code,title,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(index + 1, `sample-${index}`, `SAMPLE-${index}`, `Source row ${index}`, at, at);
    source.prepare("INSERT INTO assets(rowid,id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at) VALUES(CAST(? AS INTEGER),'source-asset','offline-original-key','source.bin','application/octet-stream',4,'ready',?,?)")
      .run("9007199254740993", sha(bytes), at);
    const env = { DB: new SqliteD1Database(source) as unknown as D1Database, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "offline-admin@example.test",
      STORAGE_CREDENTIAL_KEYRING: JSON.stringify({ version: 1, currentKeyId: "offline-key", keys: { "offline-key": btoa(String.fromCharCode(...new Uint8Array(32).fill(19))) } }) } as Env;
    const saved = await saveStorageCandidate(env, { expectedRevision: null, label: "Encrypted inert history",
      namespace: { kind: "webdav", endpoint: "https://inactive.invalid/dav", root: "retained" },
      credentials: { mode: "replace", value: { username: "encrypted-only-user", password: "encrypted-only-password" } } }, "offline-admin@example.test");
    const originalGuard = String(source.prepare("SELECT sql FROM sqlite_schema WHERE name='system_storage_credential_payloads_update_guard'").get()!.sql);
    source.exec("DROP TRIGGER system_storage_credential_payloads_update_guard");
    source.prepare("UPDATE system_storage_credential_payloads SET envelope_revision=CAST(? AS INTEGER),nonce=CAST(nonce AS BLOB),ciphertext=CAST(ciphertext AS BLOB) WHERE credential_ref=?")
      .run("9223372036854775807", saved.credentials.ref);
    source.exec(originalGuard);
    return await captureSystemBackupSnapshot(env.DB, { backupId: crypto.randomUUID(), acquireHolds: false });
  } finally { source.close(); }
}
async function capsule(records: SystemBackupRecordsV1, partial = false) {
  const files: SystemBackupFile[] = planSystemBackupSources(records.content).map(source => ({ ...source,
    path: partial ? null : `files/${source.id}`, outcome: partial ? "missing" : "packaged", byteSize: partial ? null : bytes.length, sha256: partial ? null : sha(bytes) }));
  const manifest = await finishSystemBackupManifest(records, files), metadata = await systemBackupArchiveMetadata(manifest, records, manifest);
  const open = async () => new Response(bytes.slice().buffer).body!;
  const measured = await measureSystemBackupArchive(metadata, open, NODE_RECOVERY_ARCHIVE_OPTIONS);
  const archive = new Uint8Array(await new Response(createSystemBackupArchiveStream(metadata, open, NODE_RECOVERY_ARCHIVE_OPTIONS)).arrayBuffer());
  expect(sha(archive)).toBe(measured.sha256); return { archive, manifest, payloadOffset: measured.entries.find(entry => entry.kind === "payload")?.dataOffset };
}
function sameRows(left: unknown, right: unknown) { expect(stableJson(left)).toBe(stableJson(right)); }

it("recovers a complete capsule through one local transaction with >128 typed inserts, exact rowids/encrypted SQLite classes, original bytes/provenance and disabled capabilities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "offline-system-exact-")); directories.push(directory);
  const records = await sourceRecords(true), input = await capsule(records), archivePath = join(directory, "source.zip");
  await writeFile(archivePath, input.archive);
  const io = vi.fn(() => { throw new Error("Offline recovery must never contact providers"); }); vi.stubGlobal("fetch", io);
  const result = await restoreSystemBackupToIsolatedDirectory({ archivePath, destination: join(directory, "restored"), expectedSha256: sha(input.archive) });
  expect(result.report).toMatchObject({ tables: 99, providerIO: false, executionEnabled: false, nativeBindingsRestored: false, deploymentChanged: false });
  expect(result.report.maintenanceState).toBe("fenced");
  expect(result.report.rows).toBeGreaterThan(128); expect(result.report.localAtomicStatements).toBeGreaterThan(128);
  expect(result.report.sourceImageSchemaSha256).toBe(RECOVERY_SCHEMA_SHA256);
  const database = new DatabaseSync(result.databasePath);
  try {
    for (const spec of RECOVERY_TABLES.filter(spec => !spec.local)) {
      const observed = database.prepare(recoveryTableSnapshotSql(spec)).all() as { rowid: string | null; cells: string }[];
      sameRows(observed.map(row => ({ rowid: row.rowid, cells: JSON.parse(row.cells) })).map(stableJson).sort(), records.image.tables[spec.name].rows.map(stableJson).sort());
    }
    expect(database.prepare("SELECT CAST(rowid AS TEXT) rowid,description FROM samples WHERE id='minimum'").get()).toEqual({ rowid: "-9223372036854775808", description: "Retained\0text中文" });
    expect(database.prepare("SELECT CAST(envelope_revision AS TEXT) revision,typeof(nonce) nonce,typeof(ciphertext) ciphertext FROM system_storage_credential_payloads").get())
      .toEqual({ revision: "9223372036854775807", nonce: "blob", ciphertext: "blob" });
    for (const name of ["file_shadow_runtime_guard", "file_authority_runtime_guard", "file_job_runtime_guard", "system_recovery_runtime"])
      expect(database.prepare(`SELECT enabled FROM ${name}`).get()!.enabled).toBe(0);
    for (const name of ["system_storage_native_bindings", "file_job_cleanup_grants", "system_research_package_cleanup_grants"])
      expect(database.prepare(`SELECT count(*) count FROM ${name}`).get()!.count).toBe(0);
    expect(database.prepare("SELECT state FROM system_recovery_maintenance WHERE singleton=1").get()).toEqual({ state: "fenced" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { database.close(); }
  const member = input.manifest.files[0]; expect(await readFile(join(result.destination, member.path!))).toEqual(Buffer.from(bytes));
  const retained = JSON.parse(await readFile(join(result.destination, "metadata/records.json"), "utf8")); sameRows(retained, records);
  expect(await readFile(join(result.destination, "original-archive.zip"))).toEqual(Buffer.from(input.archive));
  expect(await readFile(archivePath)).toEqual(Buffer.from(input.archive)); expect((await stat(result.destination)).mode & 0o777).toBe(0o700);
  for (const name of ["database.sqlite", "original-archive.zip", "metadata/records.json", "report/index.html", member.path!]) expect((await stat(join(result.destination, name))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(result.destination, "report/index.html"), "utf8")).toContain(`../${member.path}`);
  expect(io).not.toHaveBeenCalled(); expect(JSON.stringify(retained)).not.toContain("encrypted-only-password");
}, 30_000);

it("rejects altered payload CRC/SHA, incomplete backups and existing destinations without publishing partial state or changing source files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "offline-system-refusal-")); directories.push(directory);
  const records = await sourceRecords(), input = await capsule(records), archivePath = join(directory, "valid.zip"); await writeFile(archivePath, input.archive);
  const altered = input.archive.slice(); altered[input.payloadOffset!] ^= 1;
  const badArchive = join(directory, "altered.zip"); await writeFile(badArchive, altered);
  const failed = join(directory, "failed");
  await expect(restoreSystemBackupToIsolatedDirectory({ archivePath: badArchive, destination: failed })).rejects.toThrow();
  await expect(stat(failed)).rejects.toMatchObject({ code: "ENOENT" });
  const partial = await capsule(records, true), partialPath = join(directory, "partial.zip"); await writeFile(partialPath, partial.archive);
  const incomplete = join(directory, "incomplete");
  await expect(restoreSystemBackupToIsolatedDirectory({ archivePath: partialPath, destination: incomplete })).rejects.toThrow("partial_backup_not_complete_recovery");
  await expect(stat(incomplete)).rejects.toMatchObject({ code: "ENOENT" });
  const occupied = join(directory, "occupied"); await writeFile(occupied, "Existing operator file");
  await expect(restoreSystemBackupToIsolatedDirectory({ archivePath, destination: occupied })).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(occupied, "utf8")).toBe("Existing operator file"); expect(await readFile(archivePath)).toEqual(Buffer.from(input.archive));
}, 30_000);
