import { copyFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ExportSchemaObject } from "../shared/contracts/export";
import { FILE_NATIVE_ADMISSION_SCHEMA_FINGERPRINT_SHA256 } from "../shared/contracts/export-file-native-admission";
import { SYSTEM_RECOVERY_EVIDENCE_SCHEMA_FINGERPRINT_SHA256 } from "../shared/contracts/export-system-recovery-evidence";
import { fileShadowSchemaFingerprint } from "../shared/contracts/export-file-shadow";
import { contentExportSchemaObjects, SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES } from "../shared/contracts/storage-configuration-schema";
import { buildFullExportArchiveV24 } from "../src/lib/exportAll";
import { restoreExportToIsolatedDirectory } from "../scripts/lib/export-restore";
import { snapshotFullExportV24 } from "./export-v24-snapshot";
import { snapshotRoutes } from "./export-routes";
import { readShadowBaseline } from "./files/shadow-baseline";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const databases: DatabaseSync[] = [], directories: string[] = [];
const adapter = (database: DatabaseSync) => new SqliteD1Database(database) as unknown as D1Database;
const pristinePaths = new Map<string, string>();
let fixtureDirectory: string | undefined;
let nextFixture = 0;
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

function fixtureImage(database: DatabaseSync) {
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
    .all() as { name: string }[];
  const withoutRowid = new Set((database.prepare("PRAGMA table_list").all() as { name: string; wr: number }[])
    .filter((table) => table.wr === 1).map((table) => table.name));
  return { schema, tables: Object.fromEntries(tables.map(({ name }) => {
    const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as { name: string; pk: number }[];
    const primaryKey = columns.filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk).map((column) => quoteIdentifier(column.name));
    const storageTypes = columns.map((column, index) =>
      `typeof(${quoteIdentifier(column.name)}) AS ${quoteIdentifier(`_fixture_type_${index}`)}`).join(",");
    const rows = database.prepare(withoutRowid.has(name)
      ? `SELECT *,${storageTypes} FROM ${quoteIdentifier(name)} ORDER BY ${primaryKey.join(",")}`
      : `SELECT rowid AS _fixture_rowid,*,${storageTypes} FROM ${quoteIdentifier(name)} ORDER BY rowid`);
    rows.setReadBigInts(true);
    return [name, rows.all()];
  })) };
}

beforeAll(async () => {
  // Run the actual migration chain once for each existing fixture generation,
  // including all 22 current migrations. Scenarios get separate physical
  // copies; no installation identity is compared across scenarios.
  fixtureDirectory = await mkdtemp(join(tmpdir(), "fp5-storage-configuration-"));
  for (const throughMigration of [undefined, "0017_fp2_native_storage_profiles.sql"]) {
    const database = referenceTestDatabase({ throughMigration });
    const path = join(fixtureDirectory, `pristine-${throughMigration ?? "current"}.sqlite`);
    try {
      expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
      const expected = fixtureImage(database);
      database.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
      const cloned = new DatabaseSync(path, { readOnly: true });
      try {
        expect(fixtureImage(cloned)).toEqual(expected);
        expect(cloned.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        cloned.close();
      }
      pristinePaths.set(throughMigration ?? "current", path);
    } finally {
      database.close();
    }
  }
});

function fixture(throughMigration?: string) {
  const pristinePath = pristinePaths.get(throughMigration ?? "current");
  if (!fixtureDirectory || !pristinePath) throw new Error("The canonical storage configuration fixture has not been initialized");
  const path = join(fixtureDirectory, `scenario-${nextFixture++}.sqlite`);
  copyFileSync(pristinePath, path);
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON");
  databases.push(database);
  const now = "2026-10-01T00:00:00.000Z";
  const namespace = JSON.stringify({ kind: "s3", endpoint: "https://PRIVATE_ENDPOINT.example.test", bucket: "private-bucket", region: "eu-test", root: "private-root", forcePathStyle: true });
  database.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('sample','PORTABLE','Portable sample',?,?)").run(now, now);
  database.prepare("INSERT INTO system_storage_profiles VALUES('private-profile','s3',?,?,0,?)").run(namespace, "a".repeat(64), now);
  database.prepare("INSERT INTO system_storage_credential_descriptors VALUES('PRIVATE_CREDENTIAL_REFERENCE','private-profile',1,?,?)").run("a".repeat(64), now);
  database.prepare("INSERT INTO system_storage_credential_payloads VALUES('PRIVATE_CREDENTIAL_REFERENCE',1,1,'private-key','abcdefghijklmnop',?)").run("PRIVATE_CIPHERTEXT_PAYLOAD_SENTINEL");
  database.prepare("INSERT INTO system_storage_configuration_revisions VALUES('private-profile',1,'PRIVATE_CANDIDATE_LABEL',?,'PRIVATE_CREDENTIAL_REFERENCE',?,'private-admin@example.test')").run(namespace, now);
  database.prepare("INSERT INTO system_storage_configuration_audit VALUES('private-audit','private-profile',1,'private-admin@example.test','candidate_create','saved',?)").run(now);
  database.prepare(`INSERT INTO system_storage_candidate_checks
    (id,profile_id,configuration_revision,credential_ref,envelope_revision,namespace_json,namespace_sha256,configuration_sha256,envelope_version,key_id,nonce,ciphertext,
      probe_key,payload_sha256,payload_size,requested_by,created_at,execution_kind,execution_token,execution_deadline,execution_actor,status,
      write_outcome,read_outcome,metadata_outcome,delete_outcome,cleanup_outcome,result_code,updated_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'check',?,?,?,'running','pending','pending','pending','pending','pending',NULL,?,NULL)`)
    .run("00000000-0000-4000-8000-000000000001", "private-profile", 1, "PRIVATE_CREDENTIAL_REFERENCE", 1, namespace, "a".repeat(64), "b".repeat(64),
      1, "private-key", "abcdefghijklmnop", "PRIVATE_CIPHERTEXT_PAYLOAD_SENTINEL", "__fp2_checks/00000000-0000-4000-8000-000000000001/PRIVATE_PROBE_KEY",
      "c".repeat(64), 32, "private-admin@example.test", now, "PRIVATE_EXECUTION_TOKEN", "2026-10-01T00:00:30.000Z", "private-admin@example.test", now);
  database.prepare("INSERT INTO system_storage_credential_reenvelopes VALUES('00000000-0000-4000-8000-000000000002','private-profile',1,'PRIVATE_CREDENTIAL_REFERENCE',1,1,'already_current','private-key','private-key',?,'PRIVATE_REENVELOPE_ADMIN@example.test')").run(now);
  return database;
}
afterEach(async () => {
  databases.splice(0).forEach(database => { if (database.isOpen) database.close(); });
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
afterAll(async () => {
  databases.splice(0).forEach(database => { if (database.isOpen) database.close(); });
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

describe("installation configuration and current V24 content archives", () => {
  it("keeps populated system configuration outside content rows and schema provenance", async () => {
    const database = fixture(), db = adapter(database);
    const installed = database.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name").all() as unknown as ExportSchemaObject[];
    expect(installed.filter(object => object.type === "table" && SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES.includes(object.name as typeof SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES[number]))).toHaveLength(9);
    expect(await fileShadowSchemaFingerprint(installed)).not.toBe(SYSTEM_RECOVERY_EVIDENCE_SCHEMA_FINGERPRINT_SHA256);
    expect(await fileShadowSchemaFingerprint(contentExportSchemaObjects(installed))).toBe(SYSTEM_RECOVERY_EVIDENCE_SCHEMA_FINGERPRINT_SHA256);
    const response = await snapshotRoutes.request("/exports/all?archiveSchema=24&archiveWriter=1", {}, { DB: db } as Env);
    expect(response.status, await response.clone().text()).toBe(200);
    const manifest = await snapshotFullExportV24(db), serialized = JSON.stringify(manifest);
    expect(manifest.schemaVersion).toBe(24);
    expect(manifest.tables.samples).toHaveLength(1);
    for (const name of SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES) {
      expect(manifest.tables).not.toHaveProperty(name);
      expect(manifest.artifacts.sourceSchema.value.objects.some(object => object.tableName === name)).toBe(false);
      // Current portable activation/default guards retain references to their
      // local binding gate. Its rows and owned DDL remain excluded; the eight
      // historical system configuration names still never enter this archive.
      if (name !== "system_storage_native_bindings") expect(serialized.includes(name), `${name} omitted`).toBe(false);
    }
    const bindingReferences = manifest.artifacts.sourceSchema.value.objects.filter(object => object.sql?.includes("system_storage_native_bindings"));
    expect(bindingReferences.length).toBeGreaterThan(0);
    expect(bindingReferences.every(object => object.type === "trigger" && Object.hasOwn(manifest.tables, object.tableName))).toBe(true);
    for (const value of ["PRIVATE_CREDENTIAL_REFERENCE", "PRIVATE_CIPHERTEXT_PAYLOAD_SENTINEL", "PRIVATE_CANDIDATE_LABEL", "private-admin@example.test", "PRIVATE_ENDPOINT", "PRIVATE_PROBE_KEY", "PRIVATE_EXECUTION_TOKEN", "PRIVATE_REENVELOPE_ADMIN@example.test"])
      expect(serialized.includes(value), "private installation value omitted").toBe(false);
    // Current shadow inspection uses the content generation; candidate changes
    // neither invalidate existing source evidence nor expose system metadata.
    const baseline = await readShadowBaseline(new SqliteD1Database(database), { consumerKind: "", consumerId: "", consumerSubId: "", fileSlot: "" });
    expect(baseline.schemaSha256).toBe(SYSTEM_RECOVERY_EVIDENCE_SCHEMA_FINGERPRINT_SHA256);
    expect(baseline.status).toBe("absent");
    const historical = await readShadowBaseline(new SqliteD1Database(fixture("0017_fp2_native_storage_profiles.sql")), { consumerKind: "", consumerId: "", consumerSubId: "", fileSlot: "" });
    expect(historical.schemaSha256).toBe(FILE_NATIVE_ADMISSION_SCHEMA_FINGERPRINT_SHA256);
    expect(historical.status).toBe("absent");
  });

  it("restores content without installing candidate, descriptor, audit or payload tables", async () => {
    const database = fixture(), manifest = await snapshotFullExportV24(adapter(database));
    const packaged = await buildFullExportArchiveV24(manifest);
    const directory = await mkdtemp(join(tmpdir(), "fp2-content-recovery-")); directories.push(directory);
    const archivePath = join(directory, "content.zip");
    await writeFile(archivePath, Buffer.from(await packaged.archive.arrayBuffer()));
    const result = await restoreExportToIsolatedDirectory({ archivePath, destination: join(directory, "restored"),
      migrationsDirectory: fileURLToPath(new URL("../migrations/", import.meta.url)), targetCompatibilitySchema: "S2" });
    const restored = new DatabaseSync(join(result.restoredDirectory, "database.sqlite")); databases.push(restored);
    for (const name of SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES)
      expect(restored.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(name)).toBeUndefined();
    expect((await snapshotFullExportV24(adapter(restored))).tables).toEqual(manifest.tables);
    expect(restored.prepare("SELECT enabled,incarnation FROM file_authority_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
    expect(restored.prepare("SELECT enabled,incarnation FROM file_job_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
    expect(restored.prepare("SELECT * FROM file_migration_live_verified_attempts").all()).toEqual([]);
  }, 30_000);

  it("continues rejecting unclassified application schema additions", async () => {
    const database = fixture();
    database.exec("CREATE TABLE system_storage_unreviewed_extension(id TEXT PRIMARY KEY)");
    await expect(snapshotFullExportV24(adapter(database))).rejects.toThrow("table inventory differs from observed source schema");
  });
});
