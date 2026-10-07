import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = fileURLToPath(new URL("../", import.meta.url));
const localNames = new Set([
  "file_shadow_runtime_guard", "file_shadow_runtime_incarnations", "file_authority_runtime_guard",
  "file_job_runtime_guard", "file_job_cleanup_grants", "system_research_package_cleanup_grants",
  "system_storage_native_bindings",
]);
const protectedNames = new Set([
  "system_storage_profiles", "system_storage_credential_descriptors", "system_storage_credential_payloads",
  "system_storage_configuration_revisions", "system_storage_configuration_audit",
  "system_storage_candidate_checks", "system_storage_candidate_check_audit", "system_storage_credential_reenvelopes",
]);
const quote = name => `"${name.replaceAll('"', '""')}"`;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const database = new DatabaseSync(":memory:"), clock = new DatabaseSync(":memory:");
const migrationNames = (await readdir(join(root, "migrations"))).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort();
const migrations = [];
try {
  const classifications = await readFile(join(root, "shared/contracts/storage-configuration-schema.ts"), "utf8");
  const reviewedLocalInventory = classifications.match(/SYSTEM_RECOVERY_LOCAL_TABLE_NAMES = \[([\s\S]*?)\] as const/);
  if (!reviewedLocalInventory) throw new Error("Missing reviewed FP5 installation-local inventory");
  for (const match of reviewedLocalInventory[1].matchAll(/"([^"]+)"/g)) localNames.add(match[1]);
  // The generated seed template is deterministic. Real target initialization
  // replaces installation identity and seed timestamps with its own values.
  database.function("randomblob", length => new Uint8Array(Number(length)));
  for (const name of ["datetime", "date", "time", "strftime", "julianday", "unixepoch"]) {
    database.function(name, { varargs: true }, (...values) => {
      const args = values.length ? values.map((value, index) => value === "now" && (name !== "strftime" || index > 0)
        ? "2026-01-01T00:00:00.000Z" : value) : ["2026-01-01T00:00:00.000Z"];
      return Object.values(clock.prepare(`SELECT ${name}(${args.map(() => "?").join(",")})`).get(...args))[0];
    });
  }
  for (const name of migrationNames) {
    const sql = await readFile(join(root, "migrations", name), "utf8");
    const installationCleanup = name === "0011_fp1_retire_legacy_test_projects.sql";
    migrations.push({ name, sha256: hash(sql), appliedToFreshSchema: !installationCleanup });
    // This retired exact-identity QA cleanup is not a schema migration and must
    // never erase rows recovered from a historical source.
    if (!installationCleanup) database.exec(sql);
  }
  const objects = database.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const schemaSha256 = hash(JSON.stringify(objects));
  const tables = objects.filter(object => object.type === "table").map(object => {
    const columns = database.prepare(`PRAGMA table_xinfo(${quote(object.name)})`).all();
    if (object.name.startsWith("system_recovery_") && !localNames.has(object.name)) throw new Error(`Unclassified FP5 recovery table: ${object.name}`);
    const local = localNames.has(object.name);
    return { name: object.name, columns: columns.filter(column => column.hidden === 0).map(column => column.name),
      withoutRowid: /\bWITHOUT\s+ROWID\b/i.test(object.sql), local,
      classification: local ? "local" : protectedNames.has(object.name) ? "protected_configuration" : "content",
      primaryKeyColumns: columns.filter(column => column.pk > 0).sort((left, right) => left.pk - right.pk).map(column => column.name) };
  });
  for (const name of [...localNames, ...protectedNames]) {
    if (!tables.some(table => table.name === name)) throw new Error(`Missing classified recovery table: ${name}`);
  }
  const seedRows = Object.fromEntries(tables.map(table => {
    const cells = table.columns.map(column => {
      const value = quote(column);
      return `CASE typeof(${value}) WHEN 'null' THEN json_object('type','null') WHEN 'integer' THEN json_object('type','integer','value',CAST(${value} AS TEXT)) WHEN 'real' THEN json_object('type','real','value',printf('%!.17g',${value})) WHEN 'text' THEN json_object('type','text','value',${value}) WHEN 'blob' THEN json_object('type','blob','value',hex(${value})) END`;
    });
    const rows = database.prepare(`SELECT ${table.withoutRowid ? "NULL" : "CAST(rowid AS TEXT)"} AS rowid,json_array(${cells.join(",")}) AS cells FROM ${quote(table.name)}${table.withoutRowid ? "" : " ORDER BY rowid"}`).all()
      .map(row => ({ rowid: row.rowid, cells: JSON.parse(row.cells) }));
    return [table.name, { columns: table.columns, rows }];
  }));
  const header = "// Generated by scripts/generate-system-recovery-schema.mjs from reviewed repository migrations.\n// Uploaded archive SQL never supplies target DDL.\n";
  const catalog = `${header}import type { RecoveryTableSpec } from "./system-recovery-image";\nexport const RECOVERY_SCHEMA_SHA256 = ${JSON.stringify(schemaSha256)};\nexport const RECOVERY_TABLES: readonly (RecoveryTableSpec & { classification: \"content\" | \"protected_configuration\" | \"local\" })[] = ${JSON.stringify(tables, null, 2)};\nexport const RECOVERY_MIGRATIONS = ${JSON.stringify(migrations, null, 2)} as const;\n`;
  const schema = `${header}import type { SystemRecoveryTable } from "../../shared/contracts/system-recovery-image";\nexport { RECOVERY_SCHEMA_SHA256, RECOVERY_TABLES, RECOVERY_MIGRATIONS } from "../../shared/contracts/system-recovery-catalog";\nexport const RECOVERY_SCHEMA_STATEMENTS: readonly { type: \"table\" | \"index\" | \"view\" | \"trigger\"; name: string; tableName: string; sql: string }[] = ${JSON.stringify(objects, null, 2)};\nexport const RECOVERY_SEED_TABLE_ROWS: Readonly<Record<string, SystemRecoveryTable>> = ${JSON.stringify(seedRows, null, 2)};\n`;
  await writeFile(join(root, "shared/contracts/system-recovery-catalog.ts"), catalog);
  await writeFile(join(root, "worker/recovery/trusted-schema.ts"), schema);
  process.stdout.write(`${JSON.stringify({ schemaSha256, migrations: migrationNames.length, tables: tables.length, imageTables: tables.filter(table => !table.local).length, statements: objects.length })}\n`);
} finally { database.close(); clock.close(); }
