import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExportSchemaObject } from "../../shared/contracts/export";
import { createExportArtifact } from "../../shared/contracts/export-protocol";
import { checkedPortableApplicationSchemaV26, fullExportSourceSchemaV26, validateFullExportV26 } from "../../shared/contracts/export-portable-runtime-v26";
import { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_RECOVERY_MIGRATIONS, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256,
  V26_BUSINESS_SCHEMA_FINGERPRINT_SHA256 } from "../../shared/contracts/portable-runtime-v26-recovery-catalog";
import { WORKER_SCHEDULER_MIGRATION_NAME, WORKER_SCHEDULER_MIGRATION_SHA256, WORKER_SCHEDULER_RUNTIME_GUARD_DDL,
  WORKER_SCHEDULER_SOURCE_CHECKPOINT_ID, WORKER_SCHEDULER_APPLICATION_SCHEMA_SHA256 } from "../../shared/contracts/worker-scheduler-schema-extension";
import { validateSystemBackupRecordsV3, validateCloudflareMigrationProvenanceV3 } from "../../shared/contracts/system-backup-v3";
import { createSystemBackupArchiveStream } from "../../shared/domain/system-backup-archive";
import { sourceFromBlob } from "../../shared/domain/research-archive";
import { sha256Hex } from "../../shared/domain/content-addressing";
import { buildFullExportArchiveV26 } from "../../src/lib/exportAll";
import { restoreExportToIsolatedDirectory } from "../../scripts/lib/export-restore";
import { SqliteD1Database } from "../reference-test-support";
import { snapshotFullExportV26 } from "../export-v26-snapshot";
import type { Env } from "../types";
import { captureVersionedSystemBackupSnapshot } from "./portable-backup-snapshot";
import { prepareSystemBackupArchive, validateSystemBackupArchive } from "./backup-archive";
import { createRecoveryTargetEngine, type RecoveryTargetInput } from "./target-import";
import { RECOVERY_MIGRATION_LEDGER_SQL } from "./target-migrations";

const migrationDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
const at = "2026-10-20T10:00:00.000Z";
const opened: DatabaseSync[] = [], directories: string[] = [];
function adapter(native: DatabaseSync): D1Database { return new SqliteD1Database(native) as unknown as D1Database; }
function database(split = false, extension = true) {
  const native = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true }); opened.push(native);
  const names = readdirSync(migrationDirectory).filter(name => name.endsWith(".sql") && (extension || name <= "0024_rt3_local_volume_profiles.sql")).sort();
  expect(names).toEqual([...PORTABLE_RUNTIME_RECOVERY_MIGRATIONS.map(receipt => receipt.name), ...(extension ? [WORKER_SCHEDULER_MIGRATION_NAME] : [])]);
  for (const name of names) {
    const sql = readFileSync(join(migrationDirectory, name), "utf8");
    if (split) for (const statement of splitSql(sql)) native.exec(statement); else native.exec(sql);
  }
  native.exec(RECOVERY_MIGRATION_LEDGER_SQL);
  for (const [index, name] of names.entries()) native.prepare("INSERT INTO d1_migrations(id,name,applied_at) VALUES(?,?,?)").run(index + 1, name, at);
  return native;
}
function schema(native: DatabaseSync): ExportSchemaObject[] {
  return native.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE tbl_name<>'d1_migrations' AND tbl_name<>'sqlite_sequence' ORDER BY type,name").all() as unknown as ExportSchemaObject[];
}
function populate(native: DatabaseSync) {
  native.prepare("INSERT INTO samples(rowid,id,code,title,description,created_at,updated_at) VALUES(?,'scheduler-kept','KEPT','Retained current25',?,?,?)")
    .run(-9223372036854775808n, "研究\0preserved", at, at);
  native.prepare("UPDATE file_job_runtime_guard SET next_queue='migration' WHERE singleton=1").run();
}
afterEach(async () => {
  for (const native of opened.splice(0)) if (native.isOpen) native.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("closed Worker current25 scheduler source extension", () => {
  // Includes all migrations, optional statement splitting, snapshotting and V26 validation.
  it.each([false, true])("preserves exact observed DDL and the new tuple after whole/split25 upgrade (split=%s)", async split => {
    const native = database(split); populate(native);
    expect(createHash("sha256").update(readFileSync(join(migrationDirectory, WORKER_SCHEDULER_MIGRATION_NAME))).digest("hex"))
      .toBe(WORKER_SCHEDULER_MIGRATION_SHA256);
    expect(native.prepare("SELECT sql FROM sqlite_schema WHERE name='file_job_runtime_guard'").get()?.sql).toBe(WORKER_SCHEDULER_RUNTIME_GUARD_DDL);
    expect(await fullExportSourceSchemaV26(schema(native))).toEqual({ checkpointId: WORKER_SCHEDULER_SOURCE_CHECKPOINT_ID,
      applicationSchemaSha256: WORKER_SCHEDULER_APPLICATION_SCHEMA_SHA256 });
    const content = await snapshotFullExportV26(adapter(native));
    expect(content.artifacts.portableCheckpoint.value).toMatchObject({ checkpointId: WORKER_SCHEDULER_SOURCE_CHECKPOINT_ID,
      applicationSchemaSha256: WORKER_SCHEDULER_APPLICATION_SCHEMA_SHA256 });
    expect(content.artifacts.sourceSchema.value.objects.find(object => object.name === "file_job_runtime_guard")?.sql)
      .toBe(WORKER_SCHEDULER_RUNTIME_GUARD_DDL);
    expect(Object.hasOwn(content.tables, "file_job_runtime_guard")).toBe(false);
    await expect(validateFullExportV26(content)).resolves.toMatchObject({ schemaVersion: 26 });
    expect(content.tables.samples[0].id).toBe("scheduler-kept");
  }, 15_000);

  it("keeps original24 source pins, catalog receipts and observed source scope intact", async () => {
    const native = database(false, false);
    expect(await fullExportSourceSchemaV26(schema(native))).toEqual({ checkpointId: PORTABLE_RUNTIME_CHECKPOINT_ID,
      applicationSchemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256 });
    expect(PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256).toBe("3b8440d1559919aadce3097c5964d0549a0aff22055b5e0281e8b9deaa1da5ed");
    expect(V26_BUSINESS_SCHEMA_FINGERPRINT_SHA256).toBe("5d66a66b49b15d3a30e71a2e4079be9c3ff1d87deb2eb49c1c7bb4b6e27e6ba0");
    expect(PORTABLE_RUNTIME_RECOVERY_MIGRATIONS).toHaveLength(24);
    expect((await snapshotFullExportV26(adapter(native))).artifacts.portableCheckpoint.value.checkpointId).toBe(PORTABLE_RUNTIME_CHECKPOINT_ID);
  });

  it("rejects unknown DDL, changed cursor constraints and forged old/new checkpoint pairings", async () => {
    const native = database();
    const original = schema(native);
    for (const sql of [WORKER_SCHEDULER_RUNTIME_GUARD_DDL.replace("'package'", "'Package'"),
      WORKER_SCHEDULER_RUNTIME_GUARD_DDL.replace("next_queue TEXT", "next_queue BLOB"),
      WORKER_SCHEDULER_RUNTIME_GUARD_DDL.replace("'migration'", "'unreviewed'")]) {
      const changed = original.map(object => object.name === "file_job_runtime_guard" ? { ...object, sql } : object);
      await expect(checkedPortableApplicationSchemaV26(changed)).rejects.toThrow("current application schema");
    }
    await expect(checkedPortableApplicationSchemaV26([...original,
      { type: "table", name: "unreviewed", tableName: "unreviewed", sql: "CREATE TABLE unreviewed(id INTEGER)" }])).rejects.toThrow();
    const content = await snapshotFullExportV26(adapter(native));
    const changed = structuredClone(content), value = changed.artifacts.portableCheckpoint.value;
    value.checkpointId = PORTABLE_RUNTIME_CHECKPOINT_ID;
    value.applicationSchemaSha256 = PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256;
    changed.artifacts.portableCheckpoint = await createExportArtifact(changed.artifacts.portableCheckpoint.path, value);
    await expect(validateFullExportV26(changed)).rejects.toThrow("source checkpoint schema");
  });

  it("round-trips a current25 V26 content ZIP into the reviewed inert research target without executing source SQL", async () => {
    const native = database(true); populate(native);
    const content = await snapshotFullExportV26(adapter(native)), fetcher = vi.fn<typeof fetch>();
    expect(Object.hasOwn(content.artifacts.sourceRowids.value.tables, "samples")).toBe(false);
    const built = await buildFullExportArchiveV26(content, undefined, fetcher);
    expect(fetcher).not.toHaveBeenCalled(); expect(built.warnings).toEqual([]);
    const zip = await JSZip.loadAsync(await built.archive.arrayBuffer());
    expect(await zip.file("provenance/source-schema.json")!.async("string")).toContain("next_queue");
    const directory = await mkdtemp(join(tmpdir(), "claims-scheduler-compat-")); directories.push(directory);
    const archivePath = join(directory, "content.zip"); await writeFile(archivePath, Buffer.from(await built.archive.arrayBuffer()));
    const restored = await restoreExportToIsolatedDirectory({ archivePath, destination: join(directory, "restored"),
      migrationsDirectory: migrationDirectory, targetCompatibilitySchema: "S2" });
    const target = new DatabaseSync(join(restored.restoredDirectory, "database.sqlite")); opened.push(target);
    // Research content retains logical sample cells; complete physical rowids
    // are separately promised by the protected V3 image below.
    expect(target.prepare("SELECT id,title,description FROM samples WHERE id='scheduler-kept'").get())
      .toEqual({ id: "scheduler-kept", title: "Retained current25", description: "研究\0preserved" });
    expect(target.prepare("SELECT enabled,incarnation FROM file_job_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
    expect(target.prepare("SELECT name FROM pragma_table_xinfo('file_job_runtime_guard') WHERE name='next_queue'").get()).toBeUndefined();
    expect(await readFile(join(restored.restoredDirectory, "provenance/source-schema.json"), "utf8")).toContain("next_queue");
  }, 30_000);

  it("captures and validates actual25 V3 backup, restores original cells with old inert local seeds, and requires migration25 before fairness", async () => {
    const source = database(true); populate(source);
    const captured = await captureVersionedSystemBackupSnapshot(adapter(source), { backupId: "current25-backup", createdAt: at, acquireHolds: false });
    expect(captured.schema).toBe("system-backup-records/3");
    if (captured.schema !== "system-backup-records/3") throw new Error("Expected V3 current25 capture");
    expect(captured.content.artifacts.portableCheckpoint.value.checkpointId).toBe(WORKER_SCHEDULER_SOURCE_CHECKPOINT_ID);
    expect(captured.image.checkpointId).toBe(PORTABLE_RUNTIME_CHECKPOINT_ID);
    expect(Object.hasOwn(captured.image.tables, "file_job_runtime_guard")).toBe(false);
    expect(captured.sourceMigrationLedger.entries.at(-1)).toMatchObject({ name: WORKER_SCHEDULER_MIGRATION_NAME, rawSha256: WORKER_SCHEDULER_MIGRATION_SHA256 });
    const metadata = await prepareSystemBackupArchive(captured, []);
    const bytes = await new Response(createSystemBackupArchiveStream(metadata, async () => { throw new Error("No payload expected"); })).arrayBuffer();
    const admitted = await validateSystemBackupArchive(sourceFromBlob(new Blob([bytes])), { expectedSha256: await sha256Hex(bytes) });
    expect(admitted.format).toBe("v3");
    const target = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true }); opened.push(target);
    const provider = vi.fn(() => { throw new Error("No provider expected"); });
    const env = { DB: adapter(source), RECOVERY_DB: adapter(target), RECOVERY_TARGET_ID: "current25-isolated",
      AUTH_MODE: "disabled", ASSETS: { get: provider, head: provider, put: provider } } as unknown as Env;
    const command: RecoveryTargetInput = { jobId: crypto.randomUUID(), incarnation: crypto.randomUUID().replaceAll("-", ""),
      ownerToken: crypto.randomUUID(), generation: 1, expectedTargetId: "current25-isolated", records: admitted.records,
      manifest: admitted.manifest, mapping: [], mode: "historical", current: async () => true,
      openPayload: async () => { throw new Error("No payload expected"); } };
    const engine = createRecoveryTargetEngine(env);
    expect(await engine.preview(command)).toMatchObject({ available: true });
    let completed = false;
    for (let step = 0; step < 180; step++) {
      command.generation++; command.ownerToken = crypto.randomUUID();
      const result = await engine.step(command);
      if (result.done) { completed = true; expect(result.report?.verified).toBe(true); break; }
    }
    expect(completed).toBe(true);
    expect(target.prepare("SELECT CAST(rowid AS TEXT) rowid,id,title,description FROM samples WHERE id='scheduler-kept'").get())
      .toEqual({ rowid: "-9223372036854775808", id: "scheduler-kept", title: "Retained current25", description: "研究\0preserved" });
    expect(target.prepare("SELECT enabled,incarnation FROM file_job_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
    expect(target.prepare("SELECT name FROM pragma_table_xinfo('file_job_runtime_guard') WHERE name='next_queue'").get()).toBeUndefined();
    expect(target.prepare("SELECT name FROM d1_migrations ORDER BY id").all()).toHaveLength(24);
    target.exec(readFileSync(join(migrationDirectory, WORKER_SCHEDULER_MIGRATION_NAME), "utf8"));
    expect(target.prepare("SELECT next_queue,enabled,incarnation FROM file_job_runtime_guard").get()).toEqual({ next_queue: "package", enabled: 0, incarnation: null });
    expect(source.prepare("SELECT next_queue FROM file_job_runtime_guard").get()?.next_queue).toBe("migration");
    expect(provider).not.toHaveBeenCalled();

    const forged = structuredClone(captured);
    forged.origin.capturePolicy = "quiesced-writers-and-bytes/1"; forged.content.backupHoldOwner = null;
    await expect(validateSystemBackupRecordsV3(forged)).rejects.toThrow("Worker scheduler source requires Cloudflare provenance");
    const ledger = structuredClone(captured.sourceMigrationLedger);
    if (ledger.kind !== "cloudflare-observed-migrations/1") throw new Error("Expected observed Cloudflare ledger");
    ledger.entries.at(-1)!.rawSha256 = "0".repeat(64);
    expect(() => validateCloudflareMigrationProvenanceV3(ledger)).toThrow("cloudflare raw migration digest");
  }, 40_000);
});
