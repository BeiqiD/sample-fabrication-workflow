import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { FILE_MIGRATION_SCHEMA_FINGERPRINT_SHA256 } from "../shared/contracts/export-file-migrations";
import { fileShadowSchemaFingerprint } from "../shared/contracts/export-file-shadow";
import { contentExportSchemaObjects } from "../shared/contracts/storage-configuration-schema";
import type { ExportSchemaObject } from "../shared/contracts/export";
import { buildFullExportArchiveV22 } from "../src/lib/exportAll";
import { restoreExportToIsolatedDirectory } from "../scripts/lib/export-restore";
import { validateFullExportV21, validateFullExportV22 } from "../shared/contracts/export-protocol";
import { nativeAcceptanceFixture } from "./uploads/native-acceptance-test-support";
import { acceptAndUploadR2Asset } from "./uploads/r2-upload-acceptance";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import { d1FileJobRepository } from "./files/jobs/d1-repository";
import { dispatchFileJobs, setFileJobExecution } from "./files/jobs/worker-runtime";
import { blobRoutes, snapshotRoutes } from "./export-routes";
import { snapshotFullExportV22 } from "./export-v22-snapshot";
import { snapshotFullExportV24 } from "./export-v24-snapshot";
import { SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS } from "../shared/contracts/export-system-recovery-evidence";
import type { Env } from "./types";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const databases: DatabaseSync[] = [], directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach(sql => sql.close());
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture(migrate = true, executor = migrate) {
  const f = await nativeAcceptanceFixture(); databases.push(f.sql);
  f.sql.exec(await readFile(join(migrationsDirectory, "0019_fp3_file_jobs.sql"), "utf8"));
  const bytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const uploaded = await acceptAndUploadR2Asset(f.env, { actorEmail: f.actor, requestId: crypto.randomUUID(),
    ingress: "ordinary_image", originalName: "migration.png", mimeType: "image/png", bytes: bytes.slice().buffer });
  expect(uploaded.state.status).toBe("ready");
  const original = f.sql.prepare("SELECT * FROM file_acceptance_candidates").get()!;
  const repository = d1FileJobRepository(f.env.DB);
  if (executor) await setFileJobExecution(f.env, true);
  const job = await repository.accept({ requestId: crypto.randomUUID(), fileIds: [String(original.result_file_id)],
    target: { profileId: "r2-profile", configurationRevision: 1 } }, f.actor);
  if (migrate) {
    const outcome = await dispatchFileJobs(f.env);
    expect(outcome, JSON.stringify(f.sql.prepare("SELECT state,reason FROM file_migration_jobs WHERE id=?").get(job.id)))
      .toMatchObject({ jobId: job.id, outcome: "moved" });
  }
  return { ...f, bytes, original, repository, job };
}

describe("V22 durable File migration archive", () => {
  it("pins equivalent whole-file and Wrangler-split migration schemas", async () => {
    const source = await readFile(join(migrationsDirectory, "0019_fp3_file_jobs.sql"), "utf8");
    const whole = referenceTestDatabase({ throughMigration: "0018_fp2_native_file_runtime.sql" }),
      split = referenceTestDatabase({ throughMigration: "0018_fp2_native_file_runtime.sql" });
    databases.push(whole, split);
    whole.exec(source); for (const statement of splitSql(source)) split.exec(statement);
    const observed = (sql: DatabaseSync) => contentExportSchemaObjects(sql.prepare(
      "SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name").all() as unknown as ExportSchemaObject[]);
    expect(observed(split)).toEqual(observed(whole));
    for (const sql of [whole, split]) {
      expect(await fileShadowSchemaFingerprint(observed(sql))).toBe(FILE_MIGRATION_SCHEMA_FINGERPRINT_SHA256);
      expect(sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }
  });

  it("preserves verified migration and original accepted provenance, packages both physical copies and pauses restored execution", async () => {
    const f = await fixture();
    const queued = await f.repository.accept({ requestId: crypto.randomUUID(), fileIds: [String(f.original.result_file_id)],
      target: { profileId: f.admission.nativeProfileId, configurationRevision: 1 } }, f.actor);
    const incarnation = String(f.sql.prepare("SELECT incarnation FROM file_job_runtime_guard").get()!.incarnation);
    const claim = await f.repository.claim(incarnation, crypto.randomUUID(), () => true); expect(claim?.id).toBe(queued.id);
    const item = await f.repository.nextItem(claim!); expect(item).not.toBeNull();
    const uncertain = await f.repository.stage(claim!, item!);
    await f.repository.startWrite(claim!, uncertain);
    await f.repository.fail(claim!, item!, uncertain, "lost provider acknowledgement");
    await f.repository.requestCleanup(f.job.id, f.actor);
    expect(f.sql.prepare("SELECT COUNT(*) AS count FROM file_job_cleanup_grants").get()).toEqual({ count: 1 });
    const manifest = await snapshotFullExportV22(f.env.DB);
    expect(manifest.tables.file_migration_attempts.some(row => row.state === "published")).toBe(true);
    expect(manifest.tables.file_publications[0].active_location_id).not.toBe(f.original.result_location_id);
    expect(manifest.tables.file_acceptance_candidates[0]).toEqual(f.original);
    expect(manifest.blobs.filter(row => row.byteAuthority === "file_location")).toHaveLength(3);
    expect(manifest.tables.file_migration_jobs.some(row => row.state === "running" && row.owner_token === claim!.owner_token)).toBe(true);
    expect(manifest.tables.file_migration_attempts.find(row => row.id === uncertain.id)).toMatchObject({ state: "unknown", io_settled_at: null });
    expect(manifest.blobs.find(row => row.locationId === uncertain.location_id)).toMatchObject({ initialOutcome: "metadata_not_ready", downloadUrl: null });
    expect(manifest.tables).not.toHaveProperty("file_job_runtime_guard");
    expect(manifest.tables).not.toHaveProperty("file_job_cleanup_grants");
    expect(manifest.tables).not.toHaveProperty("file_migration_live_verified_attempts");
    await expect(validateFullExportV21(manifest)).rejects.toThrow();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => blobRoutes.request(String(input).replace(/^\/api/, ""), {}, f.env));
    const packaged = await buildFullExportArchiveV22(manifest, undefined, fetcher);
    expect(packaged.warnings).toHaveLength(1);
    expect(packaged.warnings[0]).toMatchObject({ code: "metadata_not_ready", locationId: uncertain.location_id });
    const directory = await mkdtemp(join(tmpdir(), "file-job-archive-")); directories.push(directory);
    const archivePath = join(directory, "archive.zip"); await writeFile(archivePath, Buffer.from(await packaged.archive.arrayBuffer()));
    const result = await restoreExportToIsolatedDirectory({ archivePath, destination: join(directory, "restored"), migrationsDirectory,
      targetCompatibilitySchema: "S2" });
    const sql = new DatabaseSync(join(result.restoredDirectory, "database.sqlite")); databases.push(sql);
    const db = new SqliteD1Database(sql) as unknown as D1Database;
    const recovered = (await snapshotFullExportV24(db)).tables;
    expect(Object.fromEntries(Object.keys(manifest.tables).map(name => [name, recovered[name]]))).toEqual(manifest.tables);
    for (const [name, rows] of Object.entries(recovered)) if (name.startsWith("research_package_") && name !== "research_package_source_identity")
      expect(rows, `${name} forward history`).toEqual([]);
    expect(recovered.research_package_source_identity).toHaveLength(1);
    for (const name of Object.keys(SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS)) expect(recovered[name]).toEqual([]);
    expect(sql.prepare("SELECT enabled,incarnation,last_heartbeat_at FROM file_job_runtime_guard").get())
      .toEqual({ enabled: 0, incarnation: null, last_heartbeat_at: null });
    expect(sql.prepare("SELECT * FROM file_migration_live_verified_attempts").all()).toEqual([]);
    expect(sql.prepare("SELECT * FROM file_job_cleanup_grants").all()).toEqual([]);
    expect(result.report.jobRecovery).toMatchObject({ runtimeExecutionEnabled: false, unfinishedJobsResumed: false,
      explicitNewIncarnationRequired: true, administratorReauthorizationRequired: true, unfinishedJobsRequireExplicitResume: true,
      cleanupRequiresFreshLocalApproval: true });
    const io = vi.fn(), env = { ...f.env, DB: db, ASSETS: { get: io, put: io, head: io } as unknown as R2Bucket } as Env;
    expect(await dispatchFileJobs(env)).toMatchObject({ outcome: "disabled" }); expect(io).not.toHaveBeenCalled();
    expect(result.report.restoredBlobCount).toBe(2);
  }, 30_000);

  it("retains queued work and its source hold while negotiating the exact generation", async () => {
    const f = await fixture(false), manifest = await snapshotFullExportV22(f.env.DB);
    expect(manifest.tables.file_migration_jobs[0].state).toBe("queued");
    expect(manifest.tables.file_migration_items[0].state).toBe("pending");
    expect(manifest.tables.file_migration_attempts).toEqual([]);
    for (const requested of [21, 22]) expect((await snapshotRoutes.request(`/exports/all?archiveSchema=${requested}&archiveWriter=1`, {}, f.env)).status)
      .toBe(requested === 22 ? 200 : 409);
    f.sql.exec("DROP TRIGGER file_migration_cutover_fence");
    expect((await snapshotRoutes.request("/exports/all?archiveSchema=22&archiveWriter=1", {}, f.env)).status).toBe(500);
  });

  it("preserves a never-written cancellation with its released holds", async () => {
    const f = await fixture(false, true);
    const incarnation = String(f.sql.prepare("SELECT incarnation FROM file_job_runtime_guard").get()!.incarnation);
    const claim = await f.repository.claim(incarnation, crypto.randomUUID(), () => true);
    const item = await f.repository.nextItem(claim!); await f.repository.stage(claim!, item!);
    await f.repository.control(f.job.id, "cancel");
    const manifest = await snapshotFullExportV22(f.env.DB);
    expect(manifest.tables.file_migration_attempts[0]).toMatchObject({ state: "cancelled", write_started_at: null });
    expect(manifest.tables.file_location_holds.filter(row => row.operation_id === item!.hold_operation_id)
      .every(row => row.released_at !== null)).toBe(true);
  });

  it.each(["artifact", "source", "artifact-before-grace", "source-before-grace"])("rejects forged %s release for a settled failed PUT before byte retrieval", async kind => {
    const f = await fixture(false, true);
    const incarnation = String(f.sql.prepare("SELECT incarnation FROM file_job_runtime_guard").get()!.incarnation);
    const claim = await f.repository.claim(incarnation, crypto.randomUUID(), () => true);
    const item = await f.repository.nextItem(claim!), attempt = await f.repository.stage(claim!, item!);
    await f.repository.startWrite(claim!, attempt); await f.repository.observeSettled(attempt);
    await f.repository.fail(claim!, item!, attempt, "settled content verification failed");
    await f.repository.control(f.job.id, "cancel");
    const manifest = await snapshotFullExportV22(f.env.DB), recorded = manifest.tables.file_migration_items[0];
    const hold = manifest.tables.file_location_holds.find(row => row.operation_id === item!.hold_operation_id
      && row.hold_kind === (kind.startsWith("artifact") ? "transition_destination" : "transition_source"))!;
    hold.released_at = manifest.exportedAt;
    if (kind.startsWith("source")) recorded.cleanup_released_at = manifest.exportedAt;
    if (kind.endsWith("before-grace")) {
      recorded.cleanup_requested_at = manifest.exportedAt; recorded.cleanup_actor = f.actor;
      recorded.cleanup_not_before = new Date(Date.parse(manifest.exportedAt) + 86_400_000).toISOString();
    }
    const fetcher = vi.fn();
    await expect(buildFullExportArchiveV22(manifest, undefined, fetcher)).rejects.toThrow(/cleanup|grace/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["missing-attempt", "forged-hash", "wrong-source", "missing-hold", "forged-target", "wrong-accepted-location"])("rejects %s before byte retrieval", async kind => {
    const f = await fixture(), manifest = await snapshotFullExportV22(f.env.DB);
    if (kind === "missing-attempt") manifest.tables.file_migration_attempts = [];
    if (kind === "forged-hash") manifest.tables.file_migration_attempts[0].verified_sha256 = "a".repeat(64);
    if (kind === "wrong-source") manifest.tables.file_migration_items[0].source_location_id = manifest.tables.file_migration_attempts[0].location_id;
    if (kind === "missing-hold") manifest.tables.file_location_holds = manifest.tables.file_location_holds.filter(row => row.hold_kind !== "transition_source");
    if (kind === "forged-target") manifest.tables.file_migration_jobs[0].target_namespace = "another-namespace";
    if (kind === "wrong-accepted-location") manifest.tables.file_acceptance_candidates[0].result_location_id = manifest.tables.file_migration_attempts[0].location_id;
    const fetcher = vi.fn(); await expect(buildFullExportArchiveV22(manifest, undefined, fetcher)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
});
