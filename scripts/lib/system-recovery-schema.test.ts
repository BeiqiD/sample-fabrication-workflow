import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { referenceTestDatabase } from "../../worker/reference-test-support";
import { RECOVERY_MIGRATIONS, RECOVERY_SCHEMA_SHA256, RECOVERY_SCHEMA_STATEMENTS, RECOVERY_TABLES } from "../../worker/recovery/trusted-schema";
import { readFileSync } from "node:fs";
import { contentExportSchemaObjects, SYSTEM_RECOVERY_LOCAL_TABLE_NAMES } from "../../shared/contracts/storage-configuration-schema";
import { fileShadowSchemaFingerprint } from "../../shared/contracts/export-file-shadow";
import { RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256 } from "../../shared/contracts/export-research-packages";
import type { ExportSchemaObject } from "../../shared/contracts/export";

it("pins target DDL and column/storage-class catalog to every reviewed migration, with cleanup explicitly non-schema and execution grants excluded", () => {
  const database = referenceTestDatabase();
  try {
    const objects = database.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    expect(objects).toEqual(RECOVERY_SCHEMA_STATEMENTS);
    expect(createHash("sha256").update(JSON.stringify(objects)).digest("hex")).toBe(RECOVERY_SCHEMA_SHA256);
    for (const migration of RECOVERY_MIGRATIONS) expect(createHash("sha256").update(readFileSync(new URL(`../../migrations/${migration.name}`, import.meta.url))).digest("hex")).toBe(migration.sha256);
    expect(RECOVERY_MIGRATIONS.find(migration => migration.name === "0011_fp1_retire_legacy_test_projects.sql")?.appliedToFreshSchema).toBe(false);
    for (const table of RECOVERY_TABLES) {
      expect(database.prepare(`PRAGMA table_xinfo("${table.name}")`).all().filter(column => column.hidden === 0).map(column => column.name)).toEqual(table.columns);
      if (table.name.startsWith("system_recovery_") || ["system_storage_native_bindings", "file_job_cleanup_grants", "file_authority_runtime_guard"].includes(table.name)) expect(table.local).toBe(true);
    }
    expect(RECOVERY_TABLES.find(table => table.name === "system_storage_credential_payloads")).toMatchObject({ local: false, classification: "protected_configuration" });
  } finally { database.close(); }
});

it("keeps the frozen V23 content fingerprint and refuses prefix-based omission of unknown recovery objects", async () => {
  const database = referenceTestDatabase({ throughMigration: "0021_fp5_system_recovery.sql" });
  try {
    const observed = database.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name").all() as unknown as ExportSchemaObject[];
    const declared = observed.filter(object => object.type === "table" && object.name.startsWith("system_recovery_")).map(object => object.name).sort();
    expect(declared).toEqual([...SYSTEM_RECOVERY_LOCAL_TABLE_NAMES].sort());
    expect(await fileShadowSchemaFingerprint(contentExportSchemaObjects(observed))).toBe(RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256);
    const unknown: ExportSchemaObject = { type: "table", name: "system_recovery_unclassified", tableName: "system_recovery_unclassified", sql: "CREATE TABLE system_recovery_unclassified(id TEXT)" };
    expect(contentExportSchemaObjects([...observed, unknown])).toContain(unknown);
  } finally { database.close(); }
});
