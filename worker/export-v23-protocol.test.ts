import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256 } from "../shared/contracts/export-research-packages";
import { fileShadowSchemaFingerprint } from "../shared/contracts/export-file-shadow";
import { contentExportSchemaObjects } from "../shared/contracts/storage-configuration-schema";
import type { ExportSchemaObject } from "../shared/contracts/export";
import { validateFullExportV22, validateFullExportV23 } from "../shared/contracts/export-protocol";
import { buildFullExportArchiveV23 } from "../src/lib/exportAll";
import { restoreExportToIsolatedDirectory } from "../scripts/lib/export-restore";
import { nativeAcceptanceFixture } from "./uploads/native-acceptance-test-support";
import { acceptAndUploadR2Asset } from "./uploads/r2-upload-acceptance";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import { snapshotRoutes } from "./export-routes";
import { snapshotFullExportV23 } from "./export-v23-snapshot";
import { snapshotFullExportV24 } from "./export-v24-snapshot";
import { SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS } from "../shared/contracts/export-system-recovery-evidence";
import { buildPackageSnapshotStatements } from "./packages/snapshot";
import { d1FileJobDatabase } from "./files/jobs/d1-repository";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const databases: DatabaseSync[] = [], directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals(); databases.splice(0).forEach(database => database.close());
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
describe("V23 research-package history and matched offline recovery", () => {
  it("qualifies identical whole-file and Wrangler-split successor schemas without admitting execution", async () => {
    const source = await readFile(join(migrationsDirectory, "0020_fp4_research_packages.sql"), "utf8");
    const whole = referenceTestDatabase({ throughMigration: "0019_fp3_file_jobs.sql" });
    const split = referenceTestDatabase({ throughMigration: "0019_fp3_file_jobs.sql" }); databases.push(whole, split);
    whole.exec(source); for (const statement of splitSql(source)) split.exec(statement);
    const observed = (sql: DatabaseSync) => contentExportSchemaObjects(sql.prepare(
      "SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name").all() as unknown as ExportSchemaObject[]);
    expect(observed(split)).toEqual(observed(whole));
    for (const sql of [whole, split]) {
      expect(await fileShadowSchemaFingerprint(observed(sql))).toBe(RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256);
      expect(sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(sql.prepare("SELECT enabled,incarnation FROM file_job_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
      expect(sql.prepare("SELECT * FROM system_research_package_cleanup_grants").all()).toEqual([]);
      expect(sql.prepare("SELECT * FROM research_package_live_verified_attempts").all()).toEqual([]);
    }
  });
  it("preserves nonempty native File bytes, queued research history and source identity while restoring local execution disabled", async () => {
    const f = await nativeAcceptanceFixture(true, { throughMigration: "0019_fp3_file_jobs.sql" }); databases.push(f.sql);
    f.sql.exec(await readFile(join(migrationsDirectory, "0020_fp4_research_packages.sql"), "utf8"));
    const bytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
    expect((await acceptAndUploadR2Asset(f.env, { actorEmail: f.actor, requestId: crypto.randomUUID(),
      ingress: "ordinary_image", originalName: "fp4.png", mimeType: "image/png", bytes: bytes.slice().buffer })).state.status).toBe("ready");
    const input = JSON.stringify({ requestId: "queued-research-request", kind: "report", roots: [{ kind: "sample", id: "sample-native" }] });
    const installationId = String(f.sql.prepare("SELECT installation_id FROM research_package_source_identity").get()!.installation_id);
    const capture = d1FileJobDatabase(f.env.DB);
    await capture.batch([
      capture.prepare(`INSERT INTO research_package_jobs(id,request_id,actor,kind,input_json,package_id,source_installation_id,
        accepted_at,target_policy_json,state,phase,updated_at) VALUES('queued-research','queued-research-request',?,'report',?,'package',?,?,'{}','queued','snapshot',?)`)
        .bind(f.actor, input, installationId, f.now, f.now),
      capture.prepare("INSERT INTO research_package_requests VALUES(?, 'queued-research-request', ?, 'queued-research', ?, 0)").bind(f.actor, input, f.now),
      ...buildPackageSnapshotStatements(capture, { jobId: "queued-research", actor: f.actor, packageId: "package",
        sourceInstallationId: installationId, createdAt: f.now, roots: [{ kind: "sample", id: "sample-native" }], kind: "report" }),
    ]);
    const manifest = await snapshotFullExportV23(f.env.DB);
    expect(manifest.tables.research_package_jobs[0].state).toBe("queued");
    expect(manifest.tables.system_research_package_cleanup_grants).toBeUndefined();
    expect(manifest.excludedOutputs).toEqual([]);
    expect(manifest.blobs.some(blob => blob.provider === "s3")).toBe(true);
    const packaged = await buildFullExportArchiveV23(manifest, undefined, async input => {
      const url = new URL(String(input), "https://archive.test");
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const location = manifest.tables.file_locations.find(row => row.id === id);
      if (!location) return new Response("missing", { status: 404 });
      const key = [...f.objects.keys()].find(value => new URL(value).pathname.endsWith(String(location.object_key)));
      return new Response(key ? f.objects.get(key)!.slice(0) : null, { status: key ? 200 : 404 });
    });
    expect(packaged.warnings).toEqual([]);
    const directory = await mkdtemp(join(tmpdir(), "fp4-full-archive-")); directories.push(directory);
    const archivePath = join(directory, "archive.zip"); await writeFile(archivePath, Buffer.from(await packaged.archive.arrayBuffer()));
    const restored = await restoreExportToIsolatedDirectory({ archivePath, destination: join(directory, "restored"), migrationsDirectory, targetCompatibilitySchema: "S2" });
    const sql = new DatabaseSync(join(restored.restoredDirectory, "database.sqlite")); databases.push(sql);
    const recovered = await snapshotFullExportV24(new SqliteD1Database(sql) as unknown as D1Database);
    expect(recovered.schemaVersion).toBe(24);
    expect(Object.fromEntries(Object.keys(manifest.tables).map(name => [name, recovered.tables[name]]))).toEqual(manifest.tables);
    for (const name of Object.keys(SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS)) expect(recovered.tables[name]).toEqual([]);
    expect(sql.prepare("SELECT installation_id FROM research_package_source_identity").get()?.installation_id).toBe(installationId);
    expect(sql.prepare("SELECT enabled,incarnation FROM file_job_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
    expect(sql.prepare("SELECT * FROM system_research_package_cleanup_grants").all()).toEqual([]);
    expect(sql.prepare("SELECT * FROM research_package_live_verified_attempts").all()).toEqual([]);
  }, 30_000);
  it("negotiates the actual successor and rejects a historical writer or a forged output exclusion", async () => {
    const sql = referenceTestDatabase({ throughMigration: "0020_fp4_research_packages.sql" }); databases.push(sql);
    const env = { DB: new SqliteD1Database(sql) as unknown as D1Database };
    expect((await snapshotRoutes.request("/exports/all?archiveSchema=22&archiveWriter=1", {}, env)).status).toBe(409);
    expect((await snapshotRoutes.request("/exports/all?archiveSchema=23&archiveWriter=1", {}, env)).status).toBe(200);
    const manifest = await snapshotFullExportV23(env.DB);
    await expect(validateFullExportV22(manifest)).rejects.toThrow();
    await expect(validateFullExportV23({ ...manifest, excludedOutputs: [{ locationId: "fake", fileId: "fake", jobId: "fake", reason: "disposable_job_output" }] }))
      .rejects.toThrow("explicit disposable output inventory");
  });
});
