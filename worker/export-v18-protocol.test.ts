import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import type { ExportSchemaObject } from "../shared/contracts/export";
import { FILE_AUTHORITY_RUNTIME_SCHEMA_FINGERPRINT_SHA256 } from "../shared/contracts/export-file-runtime";
import { fileShadowSchemaFingerprint } from "../shared/contracts/export-file-shadow";
import { validateFullExportV18 } from "../shared/contracts/export-protocol";
import { buildFullExportArchiveV17, buildFullExportArchiveV18 } from "../src/lib/exportAll";
import { restoreExportToIsolatedDirectory } from "../scripts/lib/export-restore";
import { snapshotFullExportV17 } from "./export-v17-snapshot";
import { snapshotFullExportV19 } from "./export-v19-snapshot";
import { snapshotFullExportV18 } from "./export-v18-snapshot";
import { snapshotRoutes } from "./export-routes";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import { enableFutureFileAuthority } from "./files/authority-runtime-test-support";
import { acceptAndUploadR2Asset } from "./uploads/r2-upload-acceptance";
import { acceptAndUploadMetrologyReference } from "./uploads/metrology-reference-acceptance";
import type { Env } from "./types";
import worker from "./index";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const databases: DatabaseSync[] = [], directories: string[] = [];
const namespace = JSON.stringify({ kind: "local-r2", installationId: "4e5c6dd7-325b-4eae-8499-518eaa0fcb40", bucketName: "runtime-archive" });
const bytes = Uint8Array.of(137, 80, 78, 71, 1, 2, 3, 4);
const adapter = (db: DatabaseSync) => new SqliteD1Database(db) as unknown as D1Database;
function database(throughMigration = "0012_fp1_file_authority_runtime.sql") { const sql = referenceTestDatabase({ throughMigration }); databases.push(sql); return sql; }
afterEach(async () => { databases.splice(0).forEach(db => db.close()); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
function fixture(active = true) {
  const sql = database(), db = adapter(sql), now = new Date().toISOString();
  sql.prepare("INSERT INTO storage_profiles VALUES('profile','r2',?,'bootstrap',NULL,1,'historical',?)").run(namespace, now);
  sql.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'fixture',? FROM file_shadow_control").run(now);
  sql.prepare("INSERT INTO file_shadow_profile_enablements VALUES('profile',1,'fixture',?)").run(now);
  if (active) enableFutureFileAuthority(sql, now);
  sql.prepare("INSERT INTO recipe_families(id,name,template_type,created_at) VALUES('family','Family','module',?)").run(now);
  sql.prepare(`INSERT INTO template_versions(id,recipe_family_id,name,template_type,version,manifest_hash,content_json,created_at,template_kind)
    VALUES('template','family','Metrology','module',1,'manifest','{}',?,'metrology')`).run(now);
  const stored = new Map<string, Uint8Array>();
  const put = vi.fn(async (key: string, value: ArrayBuffer) => { stored.set(key, new Uint8Array(value.slice(0))); });
  const get = vi.fn(async (key: string) => { const value = stored.get(key); return value ? { body: new Blob([value]).stream(), size: value.length, httpEtag: '"file"', writeHttpMetadata() {} } : null; });
  const env = { DB: db, R2_BOOTSTRAP_NAMESPACE: namespace, ASSETS: { get, head: get, put } as unknown as R2Bucket } satisfies Env;
  const input = { actorEmail: "archive@example.test", originalName: "image.png", mimeType: "image/png", bytes: bytes.buffer };
  const r2 = () => acceptAndUploadR2Asset(env, { ...input, ingress: "project_attachment", requestId: crypto.randomUUID() });
  const metrology = () => acceptAndUploadMetrologyReference(env, { ...input, templateId: "template", requestId: crypto.randomUUID() });
  return { sql, db, r2, metrology, get, put };
}
async function acceptedFixture() {
  const f = fixture();
  expect((await f.metrology()).state.status).toBe("ready");
  expect((await f.r2()).state.status).toBe("ready");
  const manifest = await snapshotFullExportV18(f.db);
  expect(manifest.tables.file_acceptance_candidates).toHaveLength(2);
  expect(manifest.tables.file_publications).toHaveLength(1);
  expect(manifest.tables.file_location_publications).toHaveLength(2);
  return { ...f, manifest };
}
async function restore(manifest: Awaited<ReturnType<typeof snapshotFullExportV18>> | Awaited<ReturnType<typeof snapshotFullExportV17>>) {
  const directory = await mkdtemp(join(tmpdir(), "runtime-archive-")); directories.push(directory);
  const fetcher = vi.fn(async () => new Response(bytes));
  const packaged = await (manifest.schemaVersion === 18 ? buildFullExportArchiveV18 : buildFullExportArchiveV17)(manifest, undefined, fetcher as typeof fetch);
  const archivePath = join(directory, "archive.zip"); await writeFile(archivePath, Buffer.from(await packaged.archive.arrayBuffer()));
  const result = await restoreExportToIsolatedDirectory({ archivePath, destination: join(directory, "restored"), migrationsDirectory, targetCompatibilitySchema: "S2" });
  const sql = new DatabaseSync(join(result.restoredDirectory, "database.sqlite")); databases.push(sql); return { sql, result };
}

describe("V18 accepted File runtime archive", () => {
  it("pins whole-file and Wrangler-split schema without activating authority", async () => {
    const whole = database(), split = new DatabaseSync(":memory:"); databases.push(split);
    for (const name of (await readdir(migrationsDirectory)).filter(name => name.endsWith(".sql") && name <= "0012_fp1_file_authority_runtime.sql").sort()) {
      for (const statement of splitSql(await readFile(join(migrationsDirectory, name), "utf8"))) split.exec(statement);
    }
    for (const sql of [whole, split]) {
      expect(await fileShadowSchemaFingerprint(sql.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name").all() as unknown as ExportSchemaObject[])).toBe(FILE_AUTHORITY_RUNTIME_SCHEMA_FINGERPRINT_SHA256);
      expect(sql.prepare("SELECT mode,revision FROM file_authority_control").get()).toEqual({ mode: "legacy", revision: 1 });
    }
  }, 30_000);

  it("round-trips active records with local execution suspended and rejects recovered writes before provider I/O", async () => {
    const f = await acceptedFixture(), io = [f.get.mock.calls.length, f.put.mock.calls.length];
    expect(f.sql.prepare("SELECT enabled FROM file_authority_runtime_guard").get()!.enabled).toBe(1);
    expect(f.manifest.tables).not.toHaveProperty("file_authority_runtime_guard");
    const { sql, result } = await restore(f.manifest);
    const recovered = (await snapshotFullExportV19(adapter(sql))).tables;
    expect(recovered.storage_role_defaults).toEqual([]);
    expect(Object.fromEntries(Object.keys(f.manifest.tables).map(name => [name, recovered[name]]))).toEqual(f.manifest.tables);
    expect(sql.prepare("SELECT mode FROM file_authority_control").get()!.mode).toBe("active");
    expect(sql.prepare("SELECT enabled,incarnation FROM file_shadow_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
    expect(sql.prepare("SELECT enabled,incarnation FROM file_authority_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
    expect(result.report.authorityRecovery).toMatchObject({ runtimeExecutionEnabled: false, installationAdmissionRequired: true, recordedAuthorityMode: "active" });
    const provider = vi.fn();
    const response = await worker.fetch(new Request("https://app.test/api/assets", {
      method: "POST", body: bytes,
      headers: { "content-type": "image/png", "x-upload-request-id": crypto.randomUUID(), "x-filename": "recovered.png" },
    }), {
      AUTH_MODE: "disabled", DB: adapter(sql), R2_BOOTSTRAP_NAMESPACE: namespace,
      ASSETS: { get: provider, head: provider, put: provider, delete: provider } as unknown as R2Bucket,
    }, { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext);
    expect(response.status).toBe(503);
    expect(provider).not.toHaveBeenCalled();
    expect([f.get.mock.calls.length, f.put.mock.calls.length]).toEqual(io);
    expect(() => sql.exec("UPDATE file_acceptance_candidates SET state='cancelled'")).toThrow();
    expect(() => sql.exec("DELETE FROM file_authority_control")).toThrow();
  }, 30_000);

  it.each(["receipt", "operation", "locator", "result", "purpose", "candidate-owner", "mode"])("rejects forged %s provenance before requesting bytes", async kind => {
    const { manifest } = await acceptedFixture(), candidate = manifest.tables.file_acceptance_candidates[0];
    if (kind === "receipt") candidate.acceptance_id = crypto.randomUUID();
    if (kind === "operation") manifest.tables.file_location_publications[0].verification_operation_id = crypto.randomUUID();
    if (kind === "locator") candidate.candidate_object_key = "different/key";
    if (kind === "result") candidate.result_location_id = "missing";
    if (kind === "purpose") candidate.purpose = "embedded_content";
    if (kind === "candidate-owner") manifest.tables.file_acceptance_candidates = [];
    if (kind === "mode") manifest.tables.file_authority_control[0].mode = "overlap";
    const fetcher = vi.fn();
    await expect(validateFullExportV18(manifest)).rejects.toThrow();
    await expect(buildFullExportArchiveV18(manifest, undefined, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("negotiates exact V17/V18 and rejects a missing terminal runtime marker", async () => {
    const old = database("0010_fp1_shadow_adjudications.sql"), current = database();
    for (const [sql, version] of [[old, 17], [current, 18]] as const) for (const requested of [16, 17, 18]) {
      expect((await snapshotRoutes.request(`/exports/all?archiveSchema=${requested}&archiveWriter=1`, {}, { DB: adapter(sql) } as Env)).status).toBe(requested === version ? 200 : 409);
    }
    current.exec("DROP TRIGGER file_authority_runtime_generation_complete");
    expect((await snapshotRoutes.request("/exports/all?archiveSchema=17&archiveWriter=1", {}, { DB: adapter(current) } as Env)).status).toBe(500);
  });

  it("forwards V17 overlap history without inventing candidates or activating runtime", async () => {
    const old = database("0010_fp1_shadow_adjudications.sql");
    old.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'fixture',? FROM file_shadow_control").run(new Date().toISOString());
    const manifest = await snapshotFullExportV17(adapter(old)), { sql } = await restore(manifest);
    const recovered = (await snapshotFullExportV19(adapter(sql))).tables;
    expect(recovered.storage_role_defaults).toEqual([]);
    expect(Object.fromEntries(Object.keys(manifest.tables).map(name => [name, recovered[name]]))).toEqual(manifest.tables);
    expect(sql.prepare("SELECT mode FROM file_authority_control").get()!.mode).toBe("overlap");
    expect(sql.prepare("SELECT * FROM file_acceptance_candidates").all()).toEqual([]);
    expect(sql.prepare("SELECT enabled,incarnation FROM file_shadow_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
    expect(sql.prepare("SELECT enabled,incarnation FROM file_authority_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
  }, 30_000);
});
