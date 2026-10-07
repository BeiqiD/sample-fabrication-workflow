import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import type { ExportSchemaObject, FullExportManifestV19, FullExportManifestV20 } from "../shared/contracts/export";
import { FILE_NATIVE_ADMISSION_SCHEMA_FINGERPRINT_SHA256 } from "../shared/contracts/export-file-native-admission";
import { fileShadowSchemaFingerprint } from "../shared/contracts/export-file-shadow";
import { contentExportSchemaObjects, SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES } from "../shared/contracts/storage-configuration-schema";
import { canonicalNativeS3Namespace } from "../shared/contracts/storage-profile-admission";
import { sha256Hex } from "../shared/domain/content-addressing";
import { validateFullExportV19, validateFullExportV20 } from "../shared/contracts/export-protocol";
import { buildFullExportArchiveV19, buildFullExportArchiveV20 } from "../src/lib/exportAll";
import { restoreExportToIsolatedDirectory } from "../scripts/lib/export-restore";
import { snapshotFullExportV19 } from "./export-v19-snapshot";
import { snapshotFullExportV20 } from "./export-v20-snapshot";
import { snapshotRoutes } from "./export-routes";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import { enableFutureFileAuthority } from "./files/authority-runtime-test-support";
import { acceptCommentUpload, uploadAcceptedCommentItem } from "./comment-acceptance-test-support";
import type { Env } from "./types";
import worker from "./index";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const nativeMigration = "0017_fp2_native_storage_profiles.sql";
const databases: DatabaseSync[] = [], directories: string[] = [];
const adapter = (sql: DatabaseSync) => new SqliteD1Database(sql) as unknown as D1Database;
function database(throughMigration = nativeMigration) { const sql = referenceTestDatabase({ throughMigration }); databases.push(sql); return sql; }
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach(sql => sql.close()); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const execution = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const schema = (sql: DatabaseSync) => sql.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name").all() as unknown as ExportSchemaObject[];

async function registerNativeProfile(sql: DatabaseSync) {
  const namespace = canonicalNativeS3Namespace({ kind: "aws-s3", partition: "aws", accountId: "123456789012", bucketName: "archive-admission", root: "originals" });
  const namespaceSha256 = await sha256Hex(namespace), profileId = `storage-profile:aws-s3:${namespaceSha256}`;
  const now = new Date().toISOString();
  sql.prepare("INSERT INTO storage_profiles VALUES(?,'s3',?,'system',NULL,1,'historical',?)").run(profileId, namespace, now);
  sql.prepare("INSERT INTO storage_profile_admissions VALUES(?,?,?,?,?,?,?,?,?,?)").run("00000000-0000-4000-8000-000000000011", profileId,
    "00000000-0000-4000-8000-000000000012", 1, 1, "00000000-0000-4000-8000-000000000013", "a".repeat(64), namespaceSha256, "archive-admin@example.test", now);
  return profileId;
}

async function fixture() {
  const sql = database("0013_fp1_r2_role_defaults.sql"), now = new Date().toISOString();
  const namespace = JSON.stringify({ kind: "local-r2", installationId: "4e5c6dd7-325b-4eae-8499-518eaa0fcb40", bucketName: "admission-archive" });
  sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('sample-upload','NATIVE-ARCHIVE','Native archive sample',?,?)").run(now, now);
  sql.prepare("INSERT INTO storage_profiles VALUES('profile-r2','r2',?,'bootstrap',NULL,1,'historical',?)").run(namespace, now);
  sql.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'fixture',? FROM file_shadow_control").run(now);
  sql.prepare("INSERT INTO file_shadow_profile_enablements VALUES('profile-r2',1,'fixture',?)").run(now);
  enableFutureFileAuthority(sql, now);
  vi.stubGlobal("FixedLengthStream", class extends TransformStream<Uint8Array, Uint8Array> { constructor(_byteSize: number) { super(); } });
  const stored = new Map<string, Uint8Array>();
  const put = vi.fn(async (key: string, body: BodyInit) => { stored.set(key, new Uint8Array(await new Response(body).arrayBuffer())); });
  const get = vi.fn(async (key: string) => { const value = stored.get(key); return value ? { body: new Blob([value.slice().buffer]).stream(), size: value.length, httpEtag: '"original"', writeHttpMetadata() {} } : null; });
  const env = { AUTH_MODE: "disabled", DB: adapter(sql), R2_BOOTSTRAP_NAMESPACE: namespace,
    ASSETS: { get, head: get, put, delete: async (key: string) => { stored.delete(key); } } as unknown as R2Bucket } as Env;
  const original = Uint8Array.of(4, 8, 15, 16, 23, 42);
  await acceptCommentUpload(sql, env, { kind: "attachment", bytes: original });
  await uploadAcceptedCommentItem(env, "submission-upload", "item-upload", "attachment", original);
  const finalize = await worker.fetch(new Request("https://app.test/api/comment-submissions/submission-upload/finalize", { method: "POST" }), env, execution);
  expect(finalize.status, await finalize.clone().text()).toBe(200);
  const before = await snapshotFullExportV19(env.DB);
  sql.exec(`BEGIN IMMEDIATE; ${await readFile(join(migrationsDirectory, nativeMigration), "utf8")} COMMIT;`);
  const profileId = await registerNativeProfile(sql);
  const manifest = await snapshotFullExportV20(env.DB);
  return { sql, env, original, put, get, before, manifest, profileId };
}
async function restore(manifest: FullExportManifestV19 | FullExportManifestV20, bytes = Uint8Array.of(1)) {
  const directory = await mkdtemp(join(tmpdir(), "native-admission-archive-")); directories.push(directory);
  const fetcher = vi.fn(async () => new Response(bytes.slice().buffer));
  const packaged = await (manifest.schemaVersion === 20 ? buildFullExportArchiveV20 : buildFullExportArchiveV19)(manifest, undefined, fetcher);
  const archivePath = join(directory, "archive.zip"); await writeFile(archivePath, Buffer.from(await packaged.archive.arrayBuffer()));
  // This fixture qualifies the frozen V19 -> V20 boundary. Current-generation
  // forward recovery has separate current-generation checks and must not redefine this source.
  const frozenMigrations = join(directory, "migrations-v20"); await mkdir(frozenMigrations);
  const names = (await readdir(migrationsDirectory)).filter(name => name.endsWith(".sql") && name <= nativeMigration).sort();
  expect(names).toHaveLength(17); expect(names.at(-1)).toBe(nativeMigration);
  for (const name of names) await writeFile(join(frozenMigrations, name), await readFile(join(migrationsDirectory, name)));
  const result = await restoreExportToIsolatedDirectory({ archivePath, destination: join(directory, "restored"), migrationsDirectory: frozenMigrations, targetCompatibilitySchema: "S2" });
  const sql = new DatabaseSync(join(result.restoredDirectory, "database.sqlite")); databases.push(sql); return { sql, result, packaged, fetcher };
}

describe("V20 portable, metadata-only native S3 admissions", () => {
  it("pins whole-file and Wrangler-split checkpoints while preserving frozen V19", async () => {
    const whole = database(), split = new DatabaseSync(":memory:"); databases.push(split);
    for (const name of (await readdir(migrationsDirectory)).filter(name => name.endsWith(".sql") && name <= nativeMigration).sort())
      for (const statement of splitSql(await readFile(join(migrationsDirectory, name), "utf8"))) split.exec(statement);
    for (const sql of [whole, split]) {
      expect(await fileShadowSchemaFingerprint(contentExportSchemaObjects(schema(sql)))).toBe(FILE_NATIVE_ADMISSION_SCHEMA_FINGERPRINT_SHA256);
      expect(sql.prepare("SELECT * FROM storage_profile_admissions").all()).toEqual([]);
      expect(sql.prepare("SELECT mode FROM file_authority_control").get()).toEqual({ mode: "legacy" });
    }
    await expect(snapshotFullExportV19(adapter(database("0013_fp1_r2_role_defaults.sql")))).resolves.toMatchObject({ schemaVersion: 19 });
  }, 30_000);

  it("round-trips active R2 bytes with S3 metadata and complete dependency history, then pauses recovery", async () => {
    const f = await fixture();
    expect(f.manifest.tables.storage_profiles).toHaveLength(2);
    expect(f.manifest.tables.storage_profile_admissions).toHaveLength(1);
    expect(f.manifest.blobs).toEqual(f.before.blobs);
    expect(f.manifest.blobs.length).toBeGreaterThan(0);
    expect(f.manifest.blobs.every(blob => blob.provider === "r2")).toBe(true);
    const { sql, result, packaged, fetcher } = await restore(f.manifest, f.original);
    expect((await snapshotFullExportV20(adapter(sql))).tables).toEqual(f.manifest.tables);
    expect(packaged.warnings).toEqual([]);
    expect(fetcher.mock.calls.length).toBe(f.manifest.blobs.filter(blob => blob.downloadUrl !== null).length);
    for (const name of SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES)
      expect(sql.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(name)).toBeUndefined();
    expect(JSON.stringify(f.manifest)).not.toMatch(/ciphertext|accessKeyId|secretAccessKey/);
    expect(sql.prepare("SELECT state,activated_at FROM storage_profile_runtime WHERE storage_profile_id=?").get(f.profileId)).toEqual({ state: "read_only", activated_at: null });
    expect(sql.prepare("SELECT enabled,incarnation FROM file_authority_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
    expect(result.report.authorityRecovery).toMatchObject({ providerIO: false, recordedAuthorityMode: "active", runtimeExecutionEnabled: false, installationAdmissionRequired: true });
    const io = vi.fn();
    const blocked = await worker.fetch(new Request("https://app.test/api/comment-submissions/submission-upload/items/item-upload/content", {
      method: "PUT", body: f.original.slice().buffer, headers: { "content-type": "application/octet-stream" },
    }), { ...f.env, DB: adapter(sql), ASSETS: { put: io, get: io, head: io } as unknown as R2Bucket }, execution);
    expect(blocked.status).toBe(503); expect(io).not.toHaveBeenCalled();
  }, 30_000);

  it.each(["missing-receipt", "duplicate-receipt", "owner", "namespace-digest", "credential", "runtime", "history", "location", "default", "acceptance", "secret-column"])("rejects forged %s before requesting any provider bytes", async kind => {
    const { manifest, profileId } = await fixture();
    const profile = manifest.tables.storage_profiles.find(row => row.id === profileId)!;
    const admission = manifest.tables.storage_profile_admissions[0];
    if (kind === "missing-receipt") manifest.tables.storage_profile_admissions.pop();
    if (kind === "duplicate-receipt") manifest.tables.storage_profile_admissions.push({ ...admission });
    if (kind === "owner") profile.namespace_identity = String(profile.namespace_identity).replace("123456789012", "999999999999");
    if (kind === "namespace-digest") admission.namespace_sha256 = "b".repeat(64);
    if (kind === "credential") profile.credential_reference = "system-secret-envelope";
    if (kind === "runtime") manifest.tables.storage_profile_runtime.find(row => row.storage_profile_id === profileId)!.state = "read_write";
    if (kind === "history") manifest.tables.file_shadow_dependency_versions = manifest.tables.file_shadow_dependency_versions.filter(row => row.dependency_key !== JSON.stringify([profileId]));
    if (kind === "location") manifest.tables.file_locations[0].storage_profile_id = profileId;
    if (kind === "default") manifest.tables.storage_role_defaults[0].storage_profile_id = profileId;
    if (kind === "acceptance") manifest.tables.comment_item_acceptances[0].storage_profile_id = profileId;
    if (kind === "secret-column") admission.ciphertext = "SECRET";
    const fetcher = vi.fn(); await expect(buildFullExportArchiveV20(manifest, undefined, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  }, 30_000);

  it("negotiates exact V19/V20 and fails closed on an incomplete V20 migration", async () => {
    const old = database("0013_fp1_r2_role_defaults.sql"), current = database();
    for (const [sql, version] of [[old, 19], [current, 20]] as const) for (const requested of [19, 20]) {
      expect((await snapshotRoutes.request(`/exports/all?archiveSchema=${requested}&archiveWriter=1`, {}, { DB: adapter(sql) } as Env)).status).toBe(requested === version ? 200 : 409);
    }
    await expect(validateFullExportV19(await snapshotFullExportV20(adapter(current)))).rejects.toThrow();
    await expect(validateFullExportV20(await snapshotFullExportV19(adapter(old)))).rejects.toThrow();
    current.exec("DROP TRIGGER file_native_storage_profiles_generation_complete");
    expect((await snapshotRoutes.request("/exports/all?archiveSchema=20&archiveWriter=1", {}, { DB: adapter(current) } as Env)).status).toBe(500);
  });

  it("forwards nonempty V19 records without admitting profiles or changing accepted destinations", async () => {
    const f = await fixture(), { sql, result } = await restore(f.before, f.original);
    const recovered = (await snapshotFullExportV20(adapter(sql))).tables;
    expect(recovered.storage_profile_admissions).toEqual([]);
    expect(Object.fromEntries(Object.keys(f.before.tables).map(name => [name, recovered[name]]))).toEqual(f.before.tables);
    expect(result.report.appliedForwardMigrations).toMatchObject([{ name: nativeMigration }]);
    expect(sql.prepare("SELECT enabled FROM file_authority_runtime_guard").get()).toEqual({ enabled: 0 });
  }, 30_000);
});
