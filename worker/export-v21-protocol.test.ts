import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import type { ExportSchemaObject } from "../shared/contracts/export";
import { FILE_NATIVE_RUNTIME_SCHEMA_FINGERPRINT_SHA256 } from "../shared/contracts/export-file-native-runtime";
import { fileShadowSchemaFingerprint } from "../shared/contracts/export-file-shadow";
import { contentExportSchemaObjects, SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES } from "../shared/contracts/storage-configuration-schema";
import { canonicalNativeS3Namespace } from "../shared/contracts/storage-profile-admission";
import { sha256Hex } from "../shared/domain/content-addressing";
import { validateFullExportV20, validateFullExportV21 } from "../shared/contracts/export-protocol";
import { buildFullExportArchiveV21 } from "../src/lib/exportAll";
import { contentNativeRuntimeMigrationSql, restoreExportToIsolatedDirectory } from "../scripts/lib/export-restore";
import { snapshotFullExportV20 } from "./export-v20-snapshot";
import { snapshotFullExportV21 } from "./export-v21-snapshot";
import { blobRoutes, snapshotRoutes } from "./export-routes";
import { nativeAcceptanceFixture } from "./uploads/native-acceptance-test-support";
import { acceptAndUploadR2Asset } from "./uploads/r2-upload-acceptance";
import { setStorageRoleDefaults } from "./storage/storage-role-policy";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const generation = "0018_fp2_native_file_runtime.sql";
const now = "2026-10-02T12:00:00.000Z";
const databases: DatabaseSync[] = [], directories: string[] = [];
const adapter = (sql: DatabaseSync) => new SqliteD1Database(sql) as unknown as D1Database;
function database(throughMigration = generation) {
  const sql = referenceTestDatabase({ throughMigration }); databases.push(sql); return sql;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const sql of databases.splice(0)) sql.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

let baselineDirectory = "";
let preparedProfileId = "";
// Build both real migration generations once. Each test gets its own physical
// copy and fresh snapshot; the whole-file/split migration test below still
// replays the actual migration chain independently.
beforeAll(async () => {
  baselineDirectory = await mkdtemp(join(tmpdir(), "v21-pristine-baseline-"));
  const sql = referenceTestDatabase({ throughMigration: "0017_fp2_native_storage_profiles.sql" });
  try {
    const namespace = canonicalNativeS3Namespace({ kind: "aws-s3", partition: "aws", accountId: "123456789012", bucketName: "runtime-archive", root: "originals" });
    const digest = await sha256Hex(namespace), profileId = `storage-profile:aws-s3:${digest}`;
    sql.prepare("INSERT INTO storage_profiles VALUES(?,'s3',?,'system',NULL,1,'historical',?)").run(profileId, namespace, now);
    sql.prepare("INSERT INTO storage_profile_admissions VALUES(?,?,?,?,?,?,?,?,?,?)").run("00000000-0000-4000-8000-000000000011", profileId,
      "00000000-0000-4000-8000-000000000012", 1, 1, "00000000-0000-4000-8000-000000000013", "a".repeat(64), digest, "archive-admin@example.test", now);
    sql.prepare("INSERT INTO samples(rowid,id,code,title,created_at,updated_at) VALUES(?,'source-sample','V21-ARCHIVE','Native archive source',?,?)")
      .run(9007199254740993n, now, now);
    sql.prepare("INSERT INTO recipe_families(id,name,template_type,created_at) VALUES('source-family','Source','module',?)").run(now);
    sql.prepare("INSERT INTO template_versions(rowid,id,recipe_family_id,name,template_type,version,manifest_hash,content_json,created_at,template_kind) VALUES(?,'source-template','source-family','Source','module',1,'manifest','{}',?,'metrology')")
      .run(9007199254740993n, now);
    preparedProfileId = profileId;
    await backup(sql, join(baselineDirectory, "v20.sqlite"));
    sql.exec(await readFile(join(migrationsDirectory, generation), "utf8"));
    await backup(sql, join(baselineDirectory, "v21.sqlite"));
  } finally { sql.close(); }
});
afterAll(async () => {
  if (baselineDirectory) await rm(baselineDirectory, { recursive: true, force: true });
});

async function fixture(previousGeneration = false) {
  const directory = await mkdtemp(join(tmpdir(), "v21-case-")); directories.push(directory);
  const path = join(directory, "database.sqlite");
  await copyFile(join(baselineDirectory, previousGeneration ? "v20.sqlite" : "v21.sqlite"), path);
  const sql = new DatabaseSync(path); databases.push(sql);
  const before = previousGeneration ? await snapshotFullExportV20(adapter(sql)) : undefined;
  if (previousGeneration) sql.exec(await readFile(join(migrationsDirectory, generation), "utf8"));
  const manifest = await snapshotFullExportV21(adapter(sql));
  return { sql, profileId: preparedProfileId, before, manifest };
}

async function migrationPrefix(directory: string) {
  const target = join(directory, "migrations");
  const { mkdir } = await import("node:fs/promises"); await mkdir(target);
  for (const name of (await readdir(migrationsDirectory)).filter(name => name.endsWith(".sql") && name <= generation).sort())
    await writeFile(join(target, name), await readFile(join(migrationsDirectory, name)));
  return target;
}

describe("V21 native File archive generation", () => {
  it("pins equivalent whole-file/split content schemas without changing V20", async () => {
    const whole = database(), split = database("0017_fp2_native_storage_profiles.sql");
    // Earlier generations have their own frozen split qualifications. Exercise
    // the new mixed portable/local migration against that exact predecessor.
    for (const statement of splitSql(await readFile(join(migrationsDirectory, generation), "utf8"))) split.exec(statement);
    for (const sql of [whole, split]) {
      const schema = sql.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name").all() as unknown as ExportSchemaObject[];
      expect(await fileShadowSchemaFingerprint(contentExportSchemaObjects(schema))).toBe(FILE_NATIVE_RUNTIME_SCHEMA_FINGERPRINT_SHA256);
      expect(sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }
  });

  it("keeps frozen V20 admission snapshots distinct from the successor", async () => {
    const f = await fixture(true);
    await expect(validateFullExportV20(f.before)).resolves.toMatchObject({ schemaVersion: 20 });
    await expect(validateFullExportV21(f.manifest)).resolves.toMatchObject({ schemaVersion: 21 });
    await expect(validateFullExportV20(f.manifest)).rejects.toThrow();
    expect(f.manifest.blobs).toEqual(f.before!.blobs);
  });

  it("isolates prepared native fixtures from earlier source mutations", async () => {
    const first = await fixture();
    first.sql.prepare("UPDATE samples SET title='Changed only in the first fixture' WHERE id='source-sample'").run();
    const second = await fixture();
    expect(second.sql.prepare("SELECT title FROM samples WHERE id='source-sample'").get()).toEqual({ title: "Native archive source" });
    expect(second.sql.prepare("SELECT CAST(rowid AS TEXT) AS rowid FROM template_versions WHERE id='source-template'").get())
      .toEqual({ rowid: "9007199254740993" });
    expect(second.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(second.sql.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("restores original registration and exact source rowids with no local credentials or execution", async () => {
    const f = await fixture(), directory = await mkdtemp(join(tmpdir(), "native-runtime-archive-")); directories.push(directory);
    const fetcher = vi.fn();
    const packaged = await buildFullExportArchiveV21(f.manifest, undefined, fetcher);
    const archivePath = join(directory, "archive.zip"); await writeFile(archivePath, Buffer.from(await packaged.archive.arrayBuffer()));
    const result = await restoreExportToIsolatedDirectory({ archivePath, destination: join(directory, "restored"),
      migrationsDirectory: await migrationPrefix(directory), targetCompatibilitySchema: "S2" });
    const sql = new DatabaseSync(join(result.restoredDirectory, "database.sqlite")); databases.push(sql);
    expect((await snapshotFullExportV21(adapter(sql))).tables).toEqual(f.manifest.tables);
    expect(sql.prepare("SELECT CAST(rowid AS TEXT) AS rowid FROM template_versions WHERE id='source-template'").get()).toEqual({ rowid: "9007199254740993" });
    for (const name of SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES)
      expect(sql.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(name)).toBeUndefined();
    expect(sql.prepare("SELECT enabled,incarnation FROM file_authority_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
    expect(sql.prepare("SELECT state FROM storage_profile_runtime WHERE storage_profile_id=?").get(f.profileId)).toEqual({ state: "read_only" });
    expect(result.report.authorityRecovery).toMatchObject({ providerIO: false, runtimeExecutionEnabled: false, installationAdmissionRequired: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("omits only local binding-owned DDL and preserves portable credential-access guards", async () => {
    const sql = await contentNativeRuntimeMigrationSql(await readFile(join(migrationsDirectory, generation), "utf8"));
    expect(sql).not.toMatch(/CREATE TABLE system_storage_native_bindings\b/);
    expect(sql).not.toMatch(/CREATE TRIGGER system_storage_native_bindings_(insert|update|delete)_guard\b/);
    expect(sql).toMatch(/CREATE TABLE storage_profile_activations\b/);
    expect(sql).toMatch(/CREATE TRIGGER storage_profile_runtime_native_admission_guard\b/);
    expect(sql).toMatch(/system_storage_native_bindings/);
  });

  it("packages real native accepted bytes after defaults change and recovers their exact physical provenance while paused", async () => {
    const f = await nativeAcceptanceFixture(); databases.push(f.sql);
    const bytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
    const uploaded = await acceptAndUploadR2Asset(f.env, { actorEmail: f.actor, requestId: crypto.randomUUID(),
      ingress: "ordinary_image", originalName: "native.png", mimeType: "image/png", bytes: bytes.slice().buffer });
    expect(uploaded.state.status).toBe("ready");
    // Historical SQLite timestamps have no explicit offset. This expired
    // physical read hold stays canonical, while its root is absent in every TZ.
    f.sql.exec(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at,expires_at)
      SELECT 'raw-sqlite-read-hold',result_location_id,'read','raw-sqlite-read','Historic read',
        datetime('now','-1 second'),datetime('now') FROM file_acceptance_candidates`);
    await setStorageRoleDefaults(f.env, { operationId: crypto.randomUUID(), expectedPolicyRevision: 3,
      internalProfileId: "r2-profile", originalsProfileId: "r2-profile" }, f.actor);
    const manifest = await snapshotFullExportV21(f.env.DB);
    const native = manifest.blobs.filter(row => row.provider === "s3");
    expect(native).toHaveLength(1);
    expect(native[0]).toMatchObject({ storeKind: "file", byteAuthority: "file_location",
      storageProfileId: f.admission.nativeProfileId, storageProfileRevision: 1, expectedByteSize: bytes.length,
      downloadUrl: expect.any(String), initialOutcome: null });
    expect(JSON.stringify(manifest)).not.toMatch(/ciphertext|accessKeyId|secretAccessKey|fixture-comment-secret/);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => blobRoutes.request(String(input).replace(/^\/api/, ""), {}, f.env));
    const packaged = await buildFullExportArchiveV21(manifest, undefined, fetcher);
    expect(packaged.warnings).toEqual([]); expect(fetcher).toHaveBeenCalledTimes(1);
    const directory = await mkdtemp(join(tmpdir(), "native-byte-archive-")); directories.push(directory);
    const archivePath = join(directory, "archive.zip"); await writeFile(archivePath, Buffer.from(await packaged.archive.arrayBuffer()));
    const result = await restoreExportToIsolatedDirectory({ archivePath, destination: join(directory, "restored"),
      migrationsDirectory: await migrationPrefix(directory), targetCompatibilitySchema: "S2" });
    const recovered = new DatabaseSync(join(result.restoredDirectory, "database.sqlite")); databases.push(recovered);
    expect((await snapshotFullExportV21(adapter(recovered))).tables).toEqual(manifest.tables);
    expect(result.report.restoredBlobCount).toBe(1);
    expect(result.report.authorityRecovery).toMatchObject({ runtimeExecutionEnabled: false, installationAdmissionRequired: true });
    expect(recovered.prepare("SELECT name FROM sqlite_schema WHERE name='system_storage_native_bindings'").get()).toBeUndefined();
    const entries = JSON.parse(await readFile(join(result.restoredDirectory, "provider-manifest.json"), "utf8"));
    expect(entries[0]).toMatchObject({ storeKind: "file", provider: "s3", storageProfileId: f.admission.nativeProfileId,
      locationId: native[0].locationId, outcome: "packaged" });
    expect(await readFile(join(result.restoredDirectory, entries[0].path))).toEqual(Buffer.from(bytes));
  }, 30_000);

  it.each(["registration", "runtime", "orphan-activation", "orphan-target"])("rejects forged %s before provider bytes", async kind => {
    const { manifest, profileId } = await fixture();
    if (kind === "registration") manifest.tables.storage_profile_admissions[0].namespace_sha256 = "b".repeat(64);
    if (kind === "runtime") manifest.tables.storage_profile_runtime.find(row => row.storage_profile_id === profileId)!.state = "read_write";
    if (kind === "orphan-activation") manifest.tables.storage_profile_activations.push({ operation_id: "forged", storage_profile_id: "absent", configuration_revision: 1,
      action: "activate", candidate_profile_id: "candidate", candidate_revision: 1, envelope_revision: 1, check_id: "probe", configuration_sha256: "c".repeat(64),
      namespace_sha256: "d".repeat(64), binding_revision: 1, actor: "admin@example.test", created_at: now });
    if (kind === "orphan-target") manifest.tables.import_file_acceptances.push({ import_id: "absent", item_id: "workbook", purpose: "provenance", storage_profile_id: profileId,
      storage_profile_revision: 1, role_policy_revision: 3, expected_sha256: "e".repeat(64), expected_byte_size: 1, candidate_asset_id: "candidate", candidate_object_key: "key",
      status: "pending", result_file_id: null, result_location_id: null, created_at: now, completed_at: null });
    const fetcher = vi.fn(); await expect(buildFullExportArchiveV21(manifest, undefined, fetcher)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });

  it("negotiates exactly V20/V21 and rejects incomplete native generations", async () => {
    for (const [generationName, version] of [["0017_fp2_native_storage_profiles.sql", 20], [generation, 21]] as const) {
      const sql = database(generationName);
      for (const requested of [20, 21]) expect((await snapshotRoutes.request(`/exports/all?archiveSchema=${requested}&archiveWriter=1`, {}, { DB: adapter(sql) } as Env)).status)
        .toBe(requested === version ? 200 : 409);
    }
    const sql = database(); sql.exec("DROP TRIGGER file_native_runtime_generation_complete");
    expect((await snapshotRoutes.request("/exports/all?archiveSchema=21&archiveWriter=1", {}, { DB: adapter(sql) } as Env)).status).toBe(500);
  });
});
