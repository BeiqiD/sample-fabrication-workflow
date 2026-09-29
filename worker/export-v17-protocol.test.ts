import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import type { ExportSchemaObject } from "../shared/contracts/export";
import { sha256Hex, stableJson } from "../shared/domain/content-addressing";
import { FILE_SHADOW_ADJUDICATION_SCHEMA_FINGERPRINT_SHA256 } from "../shared/contracts/export-file-shadow-adjudications";
import { FILE_SHADOW_ADJUDICATION_EXPORT_COLUMNS, shadowAdjudicationRequestSha256, type ShadowAdjudicationRequest } from "../shared/contracts/file-shadow-adjudication";
import { fileShadowSchemaFingerprint } from "../shared/contracts/export-file-shadow";
import { validateFullExportV17 } from "../shared/contracts/export-protocol";
import { buildFullExportArchiveV16, buildFullExportArchiveV17 } from "../src/lib/exportAll";
import { restoreExportToIsolatedDirectory } from "../scripts/lib/export-restore";
import { snapshotFullExportV16 } from "./export-v16-snapshot";
import { snapshotFullExportV18 } from "./export-v18-snapshot";
import { snapshotFullExportV17 } from "./export-v17-snapshot";
import { snapshotRoutes } from "./export-routes";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import { acceptShadowAdjudication, prepareShadowAdjudication, revokeShadowAdjudication, withdrawShadowAdjudication, type ShadowAdjudicationContext } from "./files/shadow-adjudication-service";
import { readShadowBaseline } from "./files/shadow-baseline";
import type { Env } from "./types";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const databases: DatabaseSync[] = [], directories: string[] = [];
const now = "2026-09-28T08:00:00.000Z", sha = "a".repeat(64);
const key = { consumerKind: "project_content_attachment" as const, consumerId: "attachment", consumerSubId: "", fileSlot: "primary" as const };
const adapter = (db: DatabaseSync) => new SqliteD1Database(db) as unknown as D1Database;
function database(throughMigration = "0010_fp1_shadow_adjudications.sql") { const db = referenceTestDatabase({ throughMigration }); databases.push(db); return db; }
afterEach(async () => {
  while (databases.length) databases.pop()!.close();
  while (directories.length) await rm(directories.pop()!, { recursive: true, force: true });
});
async function fixture(withOperation = false) {
  const sql = database(), db = adapter(sql);
  sql.prepare("INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at) VALUES('asset','historical/key','data.bin','application/octet-stream',23,'ready',?,?)").run(sha, now);
  sql.prepare("INSERT INTO projects(id,title,last_mutation_id,created_by,updated_by,created_at,updated_at) VALUES('project','Historical evidence','project-create','fixture','fixture',?,?)").run(now, now);
  sql.prepare("INSERT INTO project_contents(id,project_id,content_type,last_mutation_id,created_by,updated_by,created_at,updated_at) VALUES('attachment','project','attachment','content-create','fixture','fixture',?,?)").run(now, now);
  sql.prepare("INSERT INTO project_content_attachments(project_content_id,asset_id,original_name,mime_type,byte_size,created_by,created_at,creation_operation_id) VALUES('attachment','asset','data.bin','application/octet-stream',23,'fixture',?,'attachment-create')").run(now);
  sql.prepare("INSERT INTO storage_profiles VALUES('profile','r2','r2:fixture:bucket','bootstrap',NULL,1,'historical',?)").run(now);
  sql.prepare("INSERT INTO file_shadow_enablements(singleton,expected_epoch,enabled_by,enabled_at) SELECT 1,epoch,'fixture',? FROM file_shadow_control").run(now);
  if (withOperation) sql.prepare("INSERT INTO file_shadow_profile_enablements(storage_profile_id,configuration_revision,enabled_by,enabled_at) VALUES('profile',1,'fixture',?)").run(now);
  const context: ShadowAdjudicationContext = { db, actor: "fixture", assertProfile: vi.fn(async () => undefined), now: () => now };
  async function request(): Promise<ShadowAdjudicationRequest> {
    const review = await prepareShadowAdjudication(context, key);
    expect(review.eligible).toBe(true);
    return { requestId: crypto.randomUUID(), key, ...review.preconditions!, sourceProfile: { profileId: "profile", configurationRevision: 1 },
      purpose: "research_source", purposeStatement: "Retain as a research source, classified today.", namespaceStatement: "Fixture operator attests the historical binding.", evidenceReference: "fixture record" };
  }
  const first = await request(); await acceptShadowAdjudication(context, first);
  if (withOperation) {
    sql.prepare("UPDATE file_shadow_runtime_guard SET incarnation=?,enabled=1,enabled_by='fixture',updated_at=?").run(crypto.randomUUID(), now);
    const baseline = await readShadowBaseline(db, key);
    sql.prepare(`INSERT INTO file_shadow_operations(id,occurrence_id,captured_epoch,baseline_sha256,purpose,access_scope,
      source_store_kind,source_provider,source_object_key,source_profile_id,source_profile_revision,
      source_expected_byte_size,source_expected_sha256,destination_profile_id,destination_profile_revision,status,created_by,created_at)
      VALUES('cancelled-operation',?,?,?,'research_source','system','r2','r2','historical/key','profile',1,23,?,'profile',1,'pending','fixture',?)`)
      .run(baseline.head!.occurrence_id, baseline.epoch, baseline.baselineSha256, sha, now);
    sql.prepare("UPDATE file_shadow_operations SET status='cancelled',completed_at=? WHERE id='cancelled-operation'").run(now);
    sql.prepare("UPDATE file_shadow_runtime_guard SET enabled=0,updated_at=?").run(now);
  }
  const revoked = { requestId: crypto.randomUUID(), adjudicationId: first.requestId, adjudicationRequestSha256: await shadowAdjudicationRequestSha256(first), reason: "Correct the supporting reference." };
  await revokeShadowAdjudication(context, revoked);
  const corrected = await request(); corrected.evidenceReference = "corrected fixture record";
  await acceptShadowAdjudication(context, corrected);
  await withdrawShadowAdjudication(context, { ...first, requestId: crypto.randomUUID() });
  return { sql, db, context, first, corrected };
}
async function restore(manifest: Awaited<ReturnType<typeof snapshotFullExportV17>> | Awaited<ReturnType<typeof snapshotFullExportV16>>) {
  const directory = await mkdtemp(join(tmpdir(), "adjudication-archive-")); directories.push(directory);
  const fetcher = vi.fn(async () => new Response("", { status: 404 }));
  const packaged = await (manifest.schemaVersion === 17 ? buildFullExportArchiveV17 : buildFullExportArchiveV16)(manifest, undefined, fetcher as typeof fetch);
  const archivePath = join(directory, "archive.zip"); await writeFile(archivePath, Buffer.from(await packaged.archive.arrayBuffer()));
  const restored = await restoreExportToIsolatedDirectory({ archivePath, destination: join(directory, "restored"), migrationsDirectory, targetCompatibilitySchema: "S2" });
  const db = new DatabaseSync(join(restored.restoredDirectory, "database.sqlite")); databases.push(db); return { db, restored };
}

describe("V17 occurrence-scoped adjudication archive", () => {
  it("pins independent whole-file and Wrangler-split schema checkpoints", async () => {
    const whole = database(), split = new DatabaseSync(":memory:"); databases.push(split);
    for (const name of (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql") && name <= "0010_fp1_shadow_adjudications.sql").sort()) {
      for (const statement of splitSql(await readFile(join(migrationsDirectory, name), "utf8"))) split.exec(statement);
    }
    for (const db of [whole, split]) expect(await fileShadowSchemaFingerprint(db.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name").all() as unknown as ExportSchemaObject[])).toBe(FILE_SHADOW_ADJUDICATION_SCHEMA_FINGERPRINT_SHA256);
  }, 30_000);

  it.each(["current", "superseded", "deleted", "retired-profile", "bound-operation"])("round-trips corrected and revoked %s evidence, starts paused and reinstalls guards", async (state) => {
    const f = await fixture(state === "bound-operation");
    if (state === "superseded") f.sql.prepare("UPDATE projects SET title='Changed',revision=revision+1,last_mutation_id='change-title' WHERE id='project'").run();
    if (state === "deleted") f.sql.prepare("UPDATE project_contents SET revision=revision+1,deleted_at=?,deleted_by='fixture',deletion_operation_id='delete-fixture',last_mutation_id='delete-fixture' WHERE id='attachment'").run(now);
    if (state === "retired-profile") {
      // Recovery accepts historical profile retirement even though the current
      // deployment deliberately offers admission only. Preserve dependency
      // history and restore the identical schema before taking the snapshot.
      const guard = f.sql.prepare("SELECT sql FROM sqlite_schema WHERE name='storage_profile_runtime_legacy_update_guard'").get()!;
      f.sql.exec("DROP TRIGGER storage_profile_runtime_legacy_update_guard");
      f.sql.prepare("UPDATE storage_profile_runtime SET state='retired',retired_at=? WHERE storage_profile_id='profile'").run(now);
      f.sql.exec(String(guard.sql));
    }
    const manifest = await snapshotFullExportV17(f.db);
    expect(manifest.tables.file_shadow_adjudications).toHaveLength(2);
    expect(manifest.tables.file_shadow_adjudication_revocations).toHaveLength(1);
    expect(manifest.tables.file_shadow_adjudication_withdrawals).toHaveLength(1);
    const { db } = await restore(manifest);
    for (const name of Object.keys(FILE_SHADOW_ADJUDICATION_EXPORT_COLUMNS)) expect(db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all()).toEqual(manifest.tables[name]);
    expect(db.prepare("SELECT enabled,incarnation FROM file_shadow_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
    expect(() => db.exec("DELETE FROM file_shadow_adjudications")).toThrow();
    expect(() => db.exec("DELETE FROM file_shadow_adjudication_revocations")).toThrow();
    expect((await snapshotFullExportV18(adapter(db))).tables).toEqual(manifest.tables);
  }, 30_000);

  it.each(["request", "digest", "source", "baseline", "profile", "byte-expectation", "chain", "revocation", "withdrawal", "actor", "binding", "missing-binding", "rehashed-registry"])("rejects tampered %s before requesting bytes", async (kind) => {
    const f = await fixture(kind === "binding" || kind === "missing-binding"), manifest = await snapshotFullExportV17(f.db);
    const row = manifest.tables.file_shadow_adjudications.find((entry) => entry.id === f.corrected.requestId)!;
    if (kind === "request") row.request_json = JSON.stringify(JSON.parse(String(row.request_json)), null, 2);
    if (kind === "digest") row.request_sha256 = "b".repeat(64);
    if (kind === "source") row.source_json = "{}";
    if (kind === "baseline") { const baseline = JSON.parse(String(row.baseline_json)); baseline.epoch += 1; row.baseline_json = stableJson(baseline); }
    if (kind === "profile") { const request = JSON.parse(String(row.request_json)); request.sourceProfile.profileId = "missing"; row.request_json = stableJson(request); row.request_sha256 = await sha256Hex(String(row.request_json)); }
    if (kind === "byte-expectation") row.source_expected_sha256 = "b".repeat(64);
    if (kind === "chain") { const request = JSON.parse(String(row.request_json)); request.supersedesId = null; row.supersedes_id = null; row.request_json = stableJson(request); row.request_sha256 = await sha256Hex(String(row.request_json)); }
    if (kind === "revocation") manifest.tables.file_shadow_adjudication_revocations = [];
    if (kind === "withdrawal") manifest.tables.file_shadow_adjudication_withdrawals[0].request_id = f.first.requestId;
    if (kind === "actor") row.created_by = "";
    if (kind === "binding") {
      manifest.tables.file_shadow_operation_adjudications[0].adjudication_id = f.corrected.requestId;
      manifest.tables.file_shadow_operation_adjudications[0].adjudication_request_sha256 = row.request_sha256;
    }
    if (kind === "missing-binding") manifest.tables.file_shadow_operation_adjudications = [];
    if (kind === "rehashed-registry") {
      const baseline = JSON.parse(String(row.baseline_json)); baseline.record.registries[0].byte_size += 1;
      row.source_expected_byte_size = baseline.record.registries[0].byte_size;
      const { baselineSha256: _original, ...unsigned } = baseline;
      baseline.baselineSha256 = await sha256Hex(stableJson(unsigned)); row.baseline_json = stableJson(baseline);
      const request = JSON.parse(String(row.request_json)); request.expectedBaselineSha256 = baseline.baselineSha256;
      row.request_json = stableJson(request); row.request_sha256 = await sha256Hex(String(row.request_json));
    }
    const fetcher = vi.fn(); await expect(validateFullExportV17(manifest)).rejects.toThrow();
    await expect(buildFullExportArchiveV17(manifest, undefined, fetcher)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });

  it("negotiates exact V16/V17 and rejects incomplete or stale installations", async () => {
    const old = database("0009_fp1_shadow_withdrawals.sql"), current = database();
    for (const [db, version] of [[old, 16], [current, 17]] as const) {
      for (const requested of [15, 16, 17]) expect((await snapshotRoutes.request(`/exports/all?archiveSchema=${requested}&archiveWriter=1`, {}, { DB: adapter(db) } as Env)).status).toBe(requested === version ? 200 : 409);
    }
    await expect(snapshotFullExportV16(adapter(current))).rejects.toThrow();
    current.exec("DROP TRIGGER file_shadow_adjudication_generation_complete");
    expect((await snapshotRoutes.request("/exports/all?archiveSchema=17&archiveWriter=1", {}, { DB: adapter(current) } as Env)).status).toBe(500);
  });

  it("forwards V16 with empty adjudication ledgers and no fabricated decisions", async () => {
    const old = database("0009_fp1_shadow_withdrawals.sql"), manifest = await snapshotFullExportV16(adapter(old));
    const { db } = await restore(manifest);
    for (const name of Object.keys(FILE_SHADOW_ADJUDICATION_EXPORT_COLUMNS)) expect(db.prepare(`SELECT * FROM ${name}`).all()).toEqual([]);
    expect(db.prepare("SELECT enabled,incarnation FROM file_shadow_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
    expect((await snapshotFullExportV18(adapter(db))).schemaVersion).toBe(18);
  }, 30_000);
});
