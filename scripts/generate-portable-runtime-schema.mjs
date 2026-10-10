import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { normalizeSchemaSql } from "./d1-migration-plan.mjs";

// This versioned generator deliberately does not refresh the frozen V1/V19–V24
// readers. A new migration, classification, or SQLite DDL spelling requires a
// reviewed checkpoint update, rather than being admitted by a naming convention.
const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
const checkpointId = "portable-runtime/v25";
const catalogId = "sample-fabrication-workflow/sqlite-v1";
const frozenCatalogSha256 = "30c7a20c875abee5dc65771f2bbd4d44f5f8eb1b41975450c3bff910745a574c";
const platformObjectsSha256 = "735420514cf33dcf89178f684b551bfee176870538938a9c519ce91a88e4fbec";
// Preserve every raw SQLite/Node checkpoint pin. Cloudflare migration splitting
// removes comments; its current observation has a separate conservative lexical
// pin over the same code-owned object inventory, with quoted bytes retained.
const reviewedLexicalApplicationSha256 = "5288070fe00db3d7ea6b5b04f235e1a0ed2b716a51ae87b155fd609d60249907";
const newMigration = {
  name: "0023_portable_local_identity.sql",
  sha256: "7d16acea4506c080397bf57ba3f103cb128a5e4fdfca333a321e99f881dfc245",
  appliedToFreshSchema: true,
};
// Every application prefix is pinned independently of the platform ledger.
const reviewedApplicationSha256 = [
  "12bf506a6d3170786fd2e506de933440c0d54e02a5c36e596cac27e0e0f5b87f",
  "d8499e45bdc311dd026f097efdd2496b435f27f9a97f55f8d54d7430350ec48d",
  "da9dfdee2623819bcbf4a3f31a2fb71d6128ae27e8951b957585c2b7177da3fd",
  "8f49f3acbd44623b1d54214ad701c839d19799de28eb7e3413e90a105e752fa0",
  "44c65b2e411ed2f1339d373f09779af8db321e7dbe6c1e7ce50eb21cf816e987",
  "e7e623e37b60863d8f8a0abe6d30ac0394fa537436e9f8ab2629f0e10159d54f",
  "7ee90a0116447d330d5200097ed6e9acb7da3406c15eed07ce1b039c8608ec8a",
  "0f1aace8db5f2866ff18e1bc6ddeca842d34a267ee95e2942821862bda7627aa",
  "7829265c594b1932c4d7ac9ed330124eea482d4a58f82269e50831c51ac36081",
  "a7739375366b87124a10ac8eb7f5d350436b3ffd3df33f4326876d1cdabe900f",
  "a7739375366b87124a10ac8eb7f5d350436b3ffd3df33f4326876d1cdabe900f",
  "1d69843a9269c884ab1a6ed8c48aab68210db827f72ea33522a968657da263e1",
  "5c4842e20b3813783110995b78046455fe6d6edc215f1480e07d8dfb9eb72937",
  "90463722df3d953b3f5b61ae3f387cfabf480005c8cb07a5aa49fa2c186a02af",
  "31d27349a7c535fa9723e7551dbc6ac068cf5fc7dfd39800f328bb0890a73194",
  "f28dc7560a42e0d402792c95655e051afeb51fb01216fa726e35d7229b1953ea",
  "cd06f72034b840d98b49a4e1588e0fdfc3e9f5ad79b5b41e77645df3612af911",
  "6c7eb41e68684e6824ebf632d5056cd7772b39f2f5f50f0f6013f08f267aa098",
  "0b2c533762b6726a432adaf2616e8ddf7c1856d0981bf08a30e5c8a6d288d20b",
  "2bdd695ab28630c6763deee38acd31f16f3d7a761a8746139148c940ab9fb360",
  "db953bc5109e6900af66ab3ec2e460bbad610c554c413841e0766711fbb63e77",
  "7783c42f0259f6b9b857a0e2860d4c754638faaa8e13500a4cd9ab953555f3d8",
  "f325f0ce87b8ce0e700853f17fd3e05401d476c1e6468fa32b3a73f867906ad3",
];
const quote = value => `"${value.replaceAll('"', '""')}"`;
const hash = value => createHash("sha256").update(value).digest("hex");
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sortedObjects = values => values.map(({ type, name, tableName, sql }) => ({ type, name, tableName, sql }))
  .sort((a, b) => compare(a.type, b.type) || compare(a.name, b.name));
const schemaDigest = values => hash(JSON.stringify(sortedObjects(values)));
// GLOB treats '_' literally: sqliteX_unreviewed must remain visible.
const observedObjects = database => sortedObjects(database.prepare(
  "SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name",
).all());
// The current canonical digest excludes SQLite-owned objects. Historical
// business fingerprints nevertheless include sql-null autoindexes by owning
// application table. Preserve their exact native inventory for that projection.
const observedInternalObjects = database => sortedObjects(database.prepare(
  "SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NULL OR name GLOB 'sqlite_*' ORDER BY type,name",
).all());
function ensure(value, reason) { if (!value) throw new Error(`Portable runtime schema generation rejected: ${reason}`); }
function healthy(database) {
  ensure(database.prepare("PRAGMA foreign_keys").get().foreign_keys === 1, "foreign keys disabled");
  ensure(database.prepare("PRAGMA foreign_key_check").all().length === 0, "foreign-key violation");
  ensure(database.prepare("PRAGMA quick_check").all().every(row => row.quick_check === "ok"), "SQLite integrity failure");
}
function installDeterministicSeedFunctions(database, clock) {
  database.function("randomblob", length => new Uint8Array(Number(length)));
  for (const name of ["datetime", "date", "time", "strftime", "julianday", "unixepoch"]) {
    database.function(name, { varargs: true }, (...values) => {
      const args = values.length ? values.map((value, index) => value === "now" && (name !== "strftime" || index > 0)
        ? "2026-01-01T00:00:00.000Z" : value) : ["2026-01-01T00:00:00.000Z"];
      return Object.values(clock.prepare(`SELECT ${name}(${args.map(() => "?").join(",")})`).get(...args))[0];
    });
  }
}
function seedRows(database, tables) {
  return Object.fromEntries(tables.map(table => {
    const cells = table.columns.map(column => {
      const value = quote(column);
      return `CASE typeof(${value}) WHEN 'null' THEN json_object('type','null') WHEN 'integer' THEN json_object('type','integer','value',CAST(${value} AS TEXT)) WHEN 'real' THEN json_object('type','real','value',printf('%!.17g',${value})) WHEN 'text' THEN json_object('type','text','value',${value}) WHEN 'blob' THEN json_object('type','blob','value',hex(${value})) END`;
    });
    const order = table.withoutRowid ? table.primaryKeyColumns.map(quote).join(",") : "rowid";
    const rows = database.prepare(`SELECT ${table.withoutRowid ? "NULL" : "CAST(rowid AS TEXT)"} AS rowid,json_array(${cells.join(",")}) AS cells FROM ${quote(table.name)} ORDER BY ${order}`).all()
      .map(row => ({ rowid: row.rowid, cells: JSON.parse(row.cells) }));
    return [table.name, { columns: table.columns, rows }];
  }));
}
const outputPaths = ["shared/contracts/portable-runtime-recovery-catalog.ts", "worker/recovery/portable-runtime-trusted-schema.ts", "server/installation-catalog.ts"];

/** Uses only repository-owned, hash-pinned SQL. It never opens an installation
 * or reads an uploaded archive. Callers can inspect outputs before publication. */
export async function generatePortableRuntimeSchema(root = defaultRoot, { check = false } = {}) {
  const frozenPath = join(root, "shared/contracts/system-recovery-catalog.ts");
  ensure(hash(await readFile(frozenPath)) === frozenCatalogSha256, "frozen V1 catalog changed");
  const frozen = await import(pathToFileURL(frozenPath).href);
  const platform = await import(pathToFileURL(join(root, "shared/contracts/node-installation-schema.ts")).href);
  ensure(schemaDigest(platform.NODE_PLATFORM_OBJECTS) === platformObjectsSha256, "unreviewed Node platform objects");
  ensure(frozen.RECOVERY_MIGRATIONS.length === 22 && frozen.RECOVERY_SCHEMA_SHA256 === reviewedApplicationSha256[21], "unreviewed historical checkpoint");
  const reviewedMigrations = [...frozen.RECOVERY_MIGRATIONS, newMigration];
  const entries = await readdir(join(root, "migrations"), { withFileTypes: true });
  // README.md is documentation, never an executable migration input.
  ensure(entries.every(entry => entry.isFile()) && JSON.stringify(entries.filter(entry => entry.name !== "README.md").map(entry => entry.name).sort())
    === JSON.stringify(reviewedMigrations.map(value => value.name)), "unknown, missing, or non-file migration inventory");
  const migrations = [];
  for (const reviewed of reviewedMigrations) {
    const bytes = await readFile(join(root, "migrations", reviewed.name));
    ensure(hash(bytes) === reviewed.sha256, `raw migration digest changed: ${reviewed.name}`);
    migrations.push({ ...reviewed, sql: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
  }
  const classifications = new Map(frozen.RECOVERY_TABLES.map(table => [table.name, table.classification]));
  ensure(classifications.size === frozen.RECOVERY_TABLES.length, "duplicate historical classification");
  for (const name of ["local_accounts", "local_auth_events"]) classifications.set(name, "protected_identity");
  for (const name of ["local_identity_installation", "local_admin_grants", "local_sessions", "local_login_throttle"]) classifications.set(name, "local");
  const application = new DatabaseSync(":memory:"), seed = new DatabaseSync(":memory:"), clock = new DatabaseSync(":memory:");
  try {
    installDeterministicSeedFunctions(seed, clock);
    application.exec("BEGIN IMMEDIATE");
    seed.exec("BEGIN IMMEDIATE");
    const checkpoints = [];
    function checkpoint(id, objects) {
      const schemaSha256 = schemaDigest([...objects, ...platform.NODE_PLATFORM_OBJECTS]);
      return { id, applicationObjects: objects, schemaSha256,
        recoveryAdmission: { kind: "node-installation-recovery-admission/1", checkpointId: id, schemaSha256, platformObjects: platform.NODE_PLATFORM_OBJECTS } };
    }
    const emptyCheckpoint = checkpoint("installation/empty", []);
    for (const [index, migration] of migrations.entries()) {
      application.exec(migration.sql);
      const objects = observedObjects(application);
      ensure(schemaDigest(objects) === reviewedApplicationSha256[index], `unreviewed application prefix: ${migration.name}`);
      healthy(application);
      checkpoints.push(checkpoint(index === migrations.length - 1 ? checkpointId : `migration/${migration.name}`, objects));
      // This exact reviewed, data-only cleanup is executed by the Node installer
      // but cannot delete recovered content when rebuilding a destination.
      if (migration.appliedToFreshSchema) seed.exec(migration.sql);
      else ensure(migration.name === "0011_fp1_retire_legacy_test_projects.sql", "unknown recovery cleanup exclusion");
    }
    application.exec("COMMIT");
    seed.exec("COMMIT");
    healthy(application); healthy(seed);
    const objects = observedObjects(seed);
    ensure(JSON.stringify(objects) === JSON.stringify(checkpoints.at(-1).applicationObjects), "cleanup changed the recovery target schema");
    const internalObjects = observedInternalObjects(application);
    ensure(JSON.stringify(internalObjects) === JSON.stringify(observedInternalObjects(seed)), "cleanup changed the internal SQLite inventory");
    ensure(!internalObjects.some(value => platform.NODE_PLATFORM_OBJECTS.some(local => value.tableName === local.name)), "platform objects entered internal application inventory");
    ensure(!objects.some(value => platform.NODE_PLATFORM_OBJECTS.some(local => value.name === local.name || value.tableName === local.name)), "platform objects entered canonical application schema");
    const tables = objects.filter(object => object.type === "table").map(object => {
      const columns = seed.prepare(`PRAGMA table_xinfo(${quote(object.name)})`).all();
      const classification = classifications.get(object.name);
      ensure(["content", "protected_configuration", "protected_identity", "local"].includes(classification), `unclassified application table: ${object.name}`);
      return { name: object.name, columns: columns.filter(column => column.hidden === 0).map(column => column.name),
        withoutRowid: /\bWITHOUT\s+ROWID\b/i.test(object.sql), local: classification === "local", classification,
        primaryKeyColumns: columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name) };
    });
    ensure(tables.length === classifications.size && tables.every(table => classifications.has(table.name)), "missing classified application table");
    const rows = seedRows(seed, tables);
    const schemaSha256 = schemaDigest(objects);
    const lexicalSchemaSha256 = schemaDigest(objects.map(object => ({ ...object, sql: normalizeSchemaSql(object.sql) })));
    ensure(lexicalSchemaSha256 === reviewedLexicalApplicationSha256, "unreviewed current lexical schema");
    const nodeCheckpointDigests = Object.fromEntries([emptyCheckpoint, ...checkpoints].map(value => [value.id, value.schemaSha256]));
    const header = "// Generated by scripts/generate-portable-runtime-schema.mjs from reviewed, hash-pinned migrations.\n// Current checkpoint only; frozen V1/V19–V24 catalogs are unchanged. Uploaded SQL never supplies target DDL.\n";
    const catalog = `${header}import type { RecoveryTableSpec } from "./system-recovery-image";\nimport type { ExportSchemaObject } from "./export";\nexport const PORTABLE_RUNTIME_CHECKPOINT_ID = ${JSON.stringify(checkpointId)};\nexport const PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256 = ${JSON.stringify(schemaSha256)};\n// Separate conservative lexical comparison for actual split-migration observations; raw catalog pins above stay unchanged.\nexport const PORTABLE_RUNTIME_RECOVERY_LEXICAL_SCHEMA_SHA256 = ${JSON.stringify(lexicalSchemaSha256)};\nexport const PORTABLE_RUNTIME_RECOVERY_TABLES: readonly (RecoveryTableSpec & { classification: "content" | "protected_configuration" | "protected_identity" | "local" })[] = ${JSON.stringify(tables, null, 2)};\nexport const PORTABLE_RUNTIME_RECOVERY_MIGRATIONS = ${JSON.stringify(migrations.map(({ sql: _sql, ...receipt }) => receipt), null, 2)} as const;\n// Exact native SQLite-owned application inventory, retained for historical business fingerprint projection.\n// It contributes to neither the canonical application nor paired Node checkpoint digest.\nexport const PORTABLE_RUNTIME_INTERNAL_SCHEMA_OBJECTS: readonly ExportSchemaObject[] = ${JSON.stringify(internalObjects, null, 2)};\n// These paired Node digests include exactly the separately admitted platform ledgers.\nexport const PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify(nodeCheckpointDigests, null, 2)});\n`;
    const trusted = `${header}import type { SystemRecoveryTable } from "../../shared/contracts/system-recovery-image";\nimport type { InstallationSchemaObject } from "../../shared/contracts/node-installation-schema";\nexport { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, PORTABLE_RUNTIME_RECOVERY_TABLES, PORTABLE_RUNTIME_RECOVERY_MIGRATIONS, PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256 } from "../../shared/contracts/portable-runtime-recovery-catalog";\nexport const PORTABLE_RUNTIME_SCHEMA_STATEMENTS: readonly InstallationSchemaObject[] = ${JSON.stringify(objects, null, 2)};\nexport const PORTABLE_RUNTIME_SEED_TABLE_ROWS: Readonly<Record<string, SystemRecoveryTable>> = ${JSON.stringify(rows, null, 2)};\n`;
    // Deduplicate exact prefix objects without depending on runtime files, SQL
    // execution, or a caller's supplied catalog. Freeze every published record.
    const uniqueObjects = [], objectIndexes = new Map();
    for (const current of checkpoints) for (const object of current.applicationObjects) {
      const key = JSON.stringify(object);
      if (!objectIndexes.has(key)) { objectIndexes.set(key, uniqueObjects.length); uniqueObjects.push(object); }
    }
    const checkpointSource = current => `Object.freeze({ id: ${JSON.stringify(current.id)}, applicationObjects: Object.freeze([${current.applicationObjects.map(object => `schemaObjects[${objectIndexes.get(JSON.stringify(object))}]!`).join(",")}]), schemaSha256: ${JSON.stringify(current.schemaSha256)}, recoveryAdmission: Object.freeze({ kind: "node-installation-recovery-admission/1" as const, checkpointId: ${JSON.stringify(current.id)}, schemaSha256: ${JSON.stringify(current.schemaSha256)}, platformObjects: NODE_PLATFORM_OBJECTS }) })`;
    const installation = `${header}import { NODE_PLATFORM_OBJECTS, type InstallationSchemaObject } from "../shared/contracts/node-installation-schema";\nimport type { ReviewedInstallationCatalog } from "./migrations";\nconst schemaObjects: readonly InstallationSchemaObject[] = Object.freeze([\n${uniqueObjects.map(object => `  Object.freeze<InstallationSchemaObject>(${JSON.stringify(object)}),`).join("\n")}\n]);\n// Includes 0011 as its reviewed raw SQL/data-only receipt; recovery seed construction skips it.\nexport const CURRENT_NODE_INSTALLATION_CATALOG: ReviewedInstallationCatalog = Object.freeze({\n  id: ${JSON.stringify(catalogId)},\n  emptyCheckpoint: ${checkpointSource(emptyCheckpoint)},\n  migrations: Object.freeze([\n${migrations.map((migration, index) => `    Object.freeze({ name: ${JSON.stringify(migration.name)}, sql: ${JSON.stringify(migration.sql)}, rawSha256: ${JSON.stringify(migration.sha256)}, checkpoint: ${checkpointSource(checkpoints[index])} }),`).join("\n")}\n  ]),\n});\n`;
    const outputs = [catalog, trusted, installation];
    // All SQL, schema, and classification validation finishes before any write.
    for (const [index, path] of outputPaths.entries()) {
      if (check) ensure(await readFile(join(root, path), "utf8") === outputs[index], `generated output differs: ${path}`);
      else await writeFile(join(root, path), outputs[index]);
    }
    return { checkpointId, schemaSha256, nodeSchemaSha256: checkpoints.at(-1).schemaSha256,
      migrations: migrations.length, tables: tables.length, imageTables: tables.filter(table => !table.local).length,
      statements: objects.length, internalStatements: internalObjects.length, nodeCheckpoints: checkpoints.length + 1, paths: outputPaths };
  } finally { application.close(); seed.close(); clock.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensure(process.argv.slice(2).every(value => value === "--check") && process.argv.length <= 3, "unknown generator argument");
  process.stdout.write(`${JSON.stringify(await generatePortableRuntimeSchema(defaultRoot, { check: process.argv.includes("--check") }))}\n`);
}
