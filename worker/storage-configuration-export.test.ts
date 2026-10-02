import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ExportSchemaObject } from "../shared/contracts/export";
import { FILE_R2_ROLE_DEFAULTS_SCHEMA_FINGERPRINT_SHA256 } from "../shared/contracts/export-file-role-policy";
import { fileShadowSchemaFingerprint } from "../shared/contracts/export-file-shadow";
import { contentExportSchemaObjects, SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES } from "../shared/contracts/storage-configuration-schema";
import { buildFullExportArchiveV19 } from "../src/lib/exportAll";
import { restoreExportToIsolatedDirectory } from "../scripts/lib/export-restore";
import { snapshotFullExportV19 } from "./export-v19-snapshot";
import { snapshotRoutes } from "./export-routes";
import { readShadowBaseline } from "./files/shadow-baseline";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const databases: DatabaseSync[] = [], directories: string[] = [];
const adapter = (database: DatabaseSync) => new SqliteD1Database(database) as unknown as D1Database;
function fixture() {
  const database = referenceTestDatabase(); databases.push(database);
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
  databases.splice(0).forEach(database => database.close());
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("FP2 installation configuration and frozen V19 content archives", () => {
  it("keeps populated system configuration outside content rows and schema provenance", async () => {
    const database = fixture(), db = adapter(database);
    const installed = database.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name").all() as unknown as ExportSchemaObject[];
    expect(installed.filter(object => object.type === "table" && SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES.includes(object.name as typeof SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES[number]))).toHaveLength(8);
    expect(await fileShadowSchemaFingerprint(installed)).not.toBe(FILE_R2_ROLE_DEFAULTS_SCHEMA_FINGERPRINT_SHA256);
    expect(await fileShadowSchemaFingerprint(contentExportSchemaObjects(installed))).toBe(FILE_R2_ROLE_DEFAULTS_SCHEMA_FINGERPRINT_SHA256);
    const response = await snapshotRoutes.request("/exports/all?archiveSchema=19&archiveWriter=1", {}, { DB: db } as Env);
    expect(response.status, await response.clone().text()).toBe(200);
    const manifest = await snapshotFullExportV19(db), serialized = JSON.stringify(manifest);
    expect(manifest.tables.samples).toHaveLength(1);
    for (const name of SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES) {
      expect(manifest.tables).not.toHaveProperty(name);
      expect(manifest.artifacts.sourceSchema.value.objects.some(object => object.tableName === name)).toBe(false);
      expect(serialized).not.toContain(name);
    }
    for (const value of ["PRIVATE_CREDENTIAL_REFERENCE", "PRIVATE_CIPHERTEXT_PAYLOAD_SENTINEL", "PRIVATE_CANDIDATE_LABEL", "private-admin@example.test", "PRIVATE_ENDPOINT", "PRIVATE_PROBE_KEY", "PRIVATE_EXECUTION_TOKEN", "PRIVATE_REENVELOPE_ADMIN@example.test"])
      expect(serialized).not.toContain(value);
    // Current shadow inspection uses the content generation; candidate changes
    // neither invalidate existing source evidence nor expose system metadata.
    const baseline = await readShadowBaseline(new SqliteD1Database(database), { consumerKind: "", consumerId: "", consumerSubId: "", fileSlot: "" });
    expect(baseline.schemaSha256).toBe(FILE_R2_ROLE_DEFAULTS_SCHEMA_FINGERPRINT_SHA256);
    expect(baseline.status).toBe("absent");
  });

  it("restores content without installing candidate, descriptor, audit or payload tables", async () => {
    const database = fixture(), manifest = await snapshotFullExportV19(adapter(database));
    const packaged = await buildFullExportArchiveV19(manifest);
    const directory = await mkdtemp(join(tmpdir(), "fp2-content-recovery-")); directories.push(directory);
    const archivePath = join(directory, "content.zip");
    await writeFile(archivePath, Buffer.from(await packaged.archive.arrayBuffer()));
    const result = await restoreExportToIsolatedDirectory({ archivePath, destination: join(directory, "restored"),
      migrationsDirectory: fileURLToPath(new URL("../migrations/", import.meta.url)), targetCompatibilitySchema: "S2" });
    const restored = new DatabaseSync(join(result.restoredDirectory, "database.sqlite")); databases.push(restored);
    for (const name of SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES)
      expect(restored.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(name)).toBeUndefined();
    expect((await snapshotFullExportV19(adapter(restored))).tables).toEqual(manifest.tables);
    expect(restored.prepare("SELECT enabled,incarnation FROM file_authority_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
  }, 30_000);

  it("continues rejecting unclassified application schema additions", async () => {
    const database = fixture();
    database.exec("CREATE TABLE system_storage_unreviewed_extension(id TEXT PRIMARY KEY)");
    await expect(snapshotFullExportV19(adapter(database))).rejects.toThrow("table inventory differs from observed source schema");
  });
});
