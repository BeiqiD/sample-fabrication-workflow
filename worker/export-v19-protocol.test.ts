import { snapshotFullExportV20 } from "./export-v20-snapshot";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import type { ExportSchemaObject, FullExportManifestV19 } from "../shared/contracts/export";
import { FILE_R2_ROLE_DEFAULTS_SCHEMA_FINGERPRINT_SHA256 } from "../shared/contracts/export-file-role-policy";
import { fileShadowSchemaFingerprint } from "../shared/contracts/export-file-shadow";
import { validateFullExportV18, validateFullExportV19 } from "../shared/contracts/export-protocol";
import { buildFullExportArchiveV18, buildFullExportArchiveV19 } from "../src/lib/exportAll";
import { restoreExportToIsolatedDirectory } from "../scripts/lib/export-restore";
import { snapshotFullExportV18 } from "./export-v18-snapshot";
import { snapshotFullExportV19 } from "./export-v19-snapshot";
import { snapshotRoutes } from "./export-routes";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import { enableFutureFileAuthority } from "./files/authority-runtime-test-support";
import { acceptCommentUpload, uploadAcceptedCommentItem } from "./comment-acceptance-test-support";
import type { Env } from "./types";
import worker from "./index";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const databases: DatabaseSync[] = [], directories: string[] = [];
const namespace = JSON.stringify({ kind: "local-r2", installationId: "4e5c6dd7-325b-4eae-8499-518eaa0fcb40", bucketName: "role-archive" });
const adapter = (db: DatabaseSync) => new SqliteD1Database(db) as unknown as D1Database;
function database(throughMigration?: string) { const sql = referenceTestDatabase({ throughMigration }); databases.push(sql); return sql; }
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach(db => db.close()); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const execution = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

async function mixedFixture(originalSize = 8) {
  // Keep an earlier accepted SWITCHdrive destination, then add the new role policy.
  const sql = database("0012_fp1_file_authority_runtime.sql"), now = new Date().toISOString();
  sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('sample-upload','ARCHIVE','Archive sample',?,?)").run(now, now);
  sql.prepare("INSERT INTO storage_profiles VALUES('profile-r2','r2',?,'bootstrap',NULL,1,'historical',?)").run(namespace, now);
  sql.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'fixture',? FROM file_shadow_control").run(now);
  sql.prepare("INSERT INTO file_shadow_profile_enablements VALUES('profile-r2',1,'fixture',?)").run(now);
  vi.stubGlobal("FixedLengthStream", class extends TransformStream<Uint8Array, Uint8Array> {
    constructor(_byteSize: number) { super(); }
  });
  const stored = new Map<string, Uint8Array>();
  const put = vi.fn(async (key: string, body: BodyInit) => { stored.set(key, new Uint8Array(await new Response(body).arrayBuffer())); });
  const get = vi.fn(async (key: string) => { const value = stored.get(key); return value ? { body: new Blob([value.slice().buffer]).stream(), size: value.length, httpEtag: '"original"', writeHttpMetadata() {} } : null; });
  const env = { AUTH_MODE: "disabled", DB: adapter(sql), R2_BOOTSTRAP_NAMESPACE: namespace,
    MANAGED_STORAGE_PROVIDER: "switchdrive", SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/archive%40example.test",
    SWITCHDRIVE_USERNAME: "archive@example.test", SWITCHDRIVE_APP_PASSWORD: "test-password",
    ASSETS: { get, head: get, put } as unknown as R2Bucket } as Env;
  const oldBytes = Uint8Array.of(1, 2, 3, 4);
  await acceptCommentUpload(sql, env, { kind: "attachment", bytes: oldBytes, submissionId: "legacy-submission", itemId: "legacy-original" });
  const previous = sql.prepare("SELECT * FROM comment_item_acceptances WHERE item_id='legacy-original'").get();
  sql.exec(await readFile(join(migrationsDirectory, "0013_fp1_r2_role_defaults.sql"), "utf8"));
  enableFutureFileAuthority(sql, now);
  const original = new Uint8Array(originalSize).fill(97);
  await acceptCommentUpload(sql, env, { kind: "attachment", bytes: original, filename: "original.dat" });
  await uploadAcceptedCommentItem(env, "submission-upload", "item-upload", "attachment", original);
  const finalize = await worker.fetch(new Request("https://app.test/api/comment-submissions/submission-upload/finalize", { method: "POST" }), env, execution);
  expect(finalize.status, await finalize.clone().text()).toBe(200);
  expect(sql.prepare("SELECT * FROM comment_item_acceptances WHERE item_id='legacy-original'").get()).toEqual(previous);
  expect(sql.prepare("SELECT storage_role_policy_revision FROM comment_submission_acceptances ORDER BY submission_id").all()).toEqual([
    { storage_role_policy_revision: 1 }, { storage_role_policy_revision: 2 },
  ]);
  const manifest = await snapshotFullExportV19(env.DB);
  return { sql, env, stored, get, put, manifest, original };
}
async function restore(manifest: FullExportManifestV19 | Awaited<ReturnType<typeof snapshotFullExportV18>>, bytes: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), "role-archive-")); directories.push(directory);
  const packaged = await (manifest.schemaVersion === 19 ? buildFullExportArchiveV19 : buildFullExportArchiveV18)(manifest, undefined, async () => new Response(bytes.slice().buffer));
  const archivePath = join(directory, "archive.zip"); await writeFile(archivePath, Buffer.from(await packaged.archive.arrayBuffer()));
  const result = await restoreExportToIsolatedDirectory({ archivePath, destination: join(directory, "restored"), migrationsDirectory, targetCompatibilitySchema: "S2" });
  const sql = new DatabaseSync(join(result.restoredDirectory, "database.sqlite")); databases.push(sql); return { sql, result };
}

describe("V19 immutable R2 role policy archive", () => {
  it("pins whole-file and Wrangler-split schema while leaving role defaults uninitialized", async () => {
    const whole = database("0013_fp1_r2_role_defaults.sql"), split = new DatabaseSync(":memory:"); databases.push(split);
    for (const name of (await readdir(migrationsDirectory)).filter(name => name.endsWith(".sql") && name <= "0013_fp1_r2_role_defaults.sql").sort()) {
      for (const statement of splitSql(await readFile(join(migrationsDirectory, name), "utf8"))) split.exec(statement);
    }
    for (const sql of [whole, split]) {
      expect(await fileShadowSchemaFingerprint(sql.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name").all() as unknown as ExportSchemaObject[])).toBe(FILE_R2_ROLE_DEFAULTS_SCHEMA_FINGERPRINT_SHA256);
      expect(sql.prepare("SELECT * FROM storage_role_defaults").all()).toEqual([]);
      expect(sql.prepare("SELECT mode FROM file_authority_control").get()).toEqual({ mode: "legacy" });
    }
  }, 30_000);

  it("round-trips a new R2 original above 5 MiB alongside its frozen historical SWITCHdrive receipt", async () => {
    const f = await mixedFixture(6 * 1024 * 1024 + 1);
    expect(f.manifest.tables.storage_role_defaults.map(row => row.role)).toEqual(["internal", "originals"]);
    const receipt = f.manifest.tables.comment_item_acceptances.find(row => row.item_id === "item-upload")!;
    expect(JSON.parse(String(receipt.accepted_result_json))).toMatchObject({ provider: "r2", storeKind: "r2", byteSize: f.original.length });
    expect(f.put).toHaveBeenCalledTimes(1);
    const { sql, result } = await restore(f.manifest, f.original);
    const recovered = (await snapshotFullExportV20(adapter(sql))).tables;
    expect(recovered.storage_profile_admissions).toEqual([]);
    expect(Object.fromEntries(Object.keys(f.manifest.tables).map(name => [name, recovered[name]]))).toEqual(f.manifest.tables);
    expect(sql.prepare("SELECT enabled,incarnation FROM file_authority_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
    expect(result.report.authorityRecovery).toMatchObject({ recordedAuthorityMode: "active", runtimeExecutionEnabled: false, installationAdmissionRequired: true });
    const io = vi.fn();
    const blocked = await worker.fetch(new Request("https://app.test/api/comment-submissions/submission-upload/items/item-upload/content", {
      method: "PUT", body: f.original.slice().buffer, headers: { "content-type": "application/octet-stream" },
    }), { ...f.env, DB: adapter(sql), ASSETS: { put: io, get: io, head: io } as unknown as R2Bucket }, execution);
    expect(blocked.status).toBe(503); expect(io).not.toHaveBeenCalled();
  }, 30_000);

  it.each(["incomplete-role", "frozen-policy", "item-profile"])("rejects forged %s before any download", async kind => {
    const { manifest } = await mixedFixture();
    if (kind === "incomplete-role") manifest.tables.storage_role_defaults.pop();
    if (kind === "frozen-policy") manifest.tables.comment_submission_acceptances.find(row => row.submission_id === "submission-upload")!.storage_role_policy_revision = 1;
    if (kind === "item-profile") manifest.tables.comment_item_acceptances.find(row => row.item_id === "item-upload")!.storage_profile_id = manifest.tables.comment_item_acceptances.find(row => row.item_id === "legacy-original")!.storage_profile_id;
    const fetcher = vi.fn();
    await expect(buildFullExportArchiveV19(manifest, undefined, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  }, 30_000);

  it("negotiates exact V18/V19 and rejects a missing terminal role-policy marker", async () => {
    const old = database("0012_fp1_file_authority_runtime.sql"), current = database("0013_fp1_r2_role_defaults.sql");
    for (const [sql, version] of [[old, 18], [current, 19]] as const) for (const requested of [18, 19]) {
      expect((await snapshotRoutes.request(`/exports/all?archiveSchema=${requested}&archiveWriter=1`, {}, { DB: adapter(sql) } as Env)).status).toBe(requested === version ? 200 : 409);
    }
    const oldManifest = await snapshotFullExportV18(adapter(old)), currentManifest = await snapshotFullExportV19(adapter(current));
    await expect(validateFullExportV18(currentManifest)).rejects.toThrow();
    await expect(validateFullExportV19(oldManifest)).rejects.toThrow();
    current.exec("DROP TRIGGER file_r2_role_defaults_generation_complete");
    expect((await snapshotRoutes.request("/exports/all?archiveSchema=19&archiveWriter=1", {}, { DB: adapter(current) } as Env)).status).toBe(500);
  });

  it("forwards V18 records without initializing defaults or authorizing recovered execution", async () => {
    const old = database("0012_fp1_file_authority_runtime.sql"), oldManifest = await snapshotFullExportV18(adapter(old));
    const { sql, result } = await restore(oldManifest, Uint8Array.of(1));
    const recovered = await snapshotFullExportV20(adapter(sql));
    expect(recovered.tables.storage_role_defaults).toEqual([]);
    expect(Object.fromEntries(Object.keys(oldManifest.tables).map(name => [name, recovered.tables[name]]))).toEqual(oldManifest.tables);
    expect(result.report.appliedForwardMigrations).toMatchObject([{ name: "0013_fp1_r2_role_defaults.sql" }, { name: "0017_fp2_native_storage_profiles.sql" }]);
    expect(sql.prepare("SELECT enabled FROM file_authority_runtime_guard").get()).toEqual({ enabled: 0 });
  }, 30_000);
});
