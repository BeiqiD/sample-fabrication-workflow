import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrationSqlHash, normalizeSchema, normalizeSchemaSql, schemaFingerprint } from "../d1-migration-plan.mjs";

export const compatibilityDirectory = "scripts/fixtures/backend-schema";
export const compatibilityStages = ["s1-compatibility-bridge.sql", "s2-final-schema.sql"];
export const baselineFilename = "s2-baseline.sql";
export const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
const quoteText = (value) => `'${value.replaceAll("'", "''")}'`;

export function readSchemaSources(root) {
  const historical = readdirSync(resolve(root, "migrations-history/s0")).filter((name) => name.endsWith(".sql")).sort()
    .map((filename) => ({ filename: `migrations/${filename}`, sql: readFileSync(resolve(root, "migrations-history/s0", filename), "utf8") }));
  assert.equal(historical.length, 37, "Re-inventory a changed historical chain before regenerating the candidate");
  const stages = compatibilityStages.map((filename) => ({ filename: `${compatibilityDirectory}/${filename}`,
    sql: readFileSync(resolve(root, compatibilityDirectory, filename), "utf8") }));
  return { historical, stages };
}

export function applyHostTransaction(database, sql) {
  database.exec("BEGIN");
  try { database.exec(sql); database.exec("COMMIT"); }
  catch (error) { database.exec("ROLLBACK"); throw error; }
}

// Independent host observation uses ordinary PRAGMAs; the actual D1 tests use
// the production read-only observer's single schema/ledger batch instead.
export function observeHostSchema(database) {
  const objects = database.prepare("SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema ORDER BY rowid").all();
  return { objects, relations: objects.filter(({ type }) => ["table", "view"].includes(type)).map(({ name }) => ({
    name,
    columns: database.prepare(`PRAGMA table_xinfo(${quoteText(name)})`).all(),
    foreignKeys: database.prepare(`PRAGMA foreign_key_list(${quoteText(name)})`).all(),
    indexes: database.prepare(`PRAGMA index_list(${quoteText(name)})`).all().map((index) => ({
      ...index, columns: database.prepare(`PRAGMA index_xinfo(${quoteText(index.name)})`).all(),
    })),
  })) };
}

export function readHostTables(database) {
  return Object.fromEntries(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(({ name }) => [name, database.prepare(`SELECT * FROM ${quoteIdentifier(name)}`).all()
      .map((row) => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"))]));
}

export function assertHealthyHost(database) {
  assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1, "Foreign-key enforcement must stay enabled");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
}

function sqlValue(value) {
  if (value === null) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string" && !value.includes("\0")) return quoteText(value);
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  throw new Error("Unsupported baseline seed value; do not silently normalize seed data");
}

// Wrangler's installed SQL splitter recognizes END followed by whitespace or a
// semicolon, but misses END, / END) and CASE immediately after "(". In a combined
// baseline that can join CREATE statements into a D1-overlimit request or split
// a trigger prematurely. Add only those lexical compound-keyword spaces;
// quoted SQL and comments stay byte-for-byte intact. The token assertion below
// rejects any accidental semantic formatting change.
export function formatSqlForWrangler(sql) {
  const token = /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*|[\s\S]/g;
  let formatted = "";
  for (const match of sql.matchAll(token)) {
    const compoundStart = ["BEGIN", "CASE"].includes(match[0]);
    const compoundEnd = match[0] === "END";
    if ((compoundStart || compoundEnd) && formatted && !/[\t\n\f\r ]$/.test(formatted)) formatted += " ";
    formatted += match[0];
    const next = sql[match.index + match[0].length];
    if (next && ((compoundStart && !/[\t\n\f\r ]/.test(next))
      || (compoundEnd && !/[;\t\n\f\r ]/.test(next)))) formatted += " ";
  }
  assert.deepEqual(normalizeSchemaSql(formatted), normalizeSchemaSql(sql));
  return formatted;
}

/** Build a candidate for a NEW EMPTY database. Never accepts an existing DB. */
export function generateS2Baseline(root) {
  const { historical, stages } = readSchemaSources(root);
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const source of [...historical, ...stages]) applyHostTransaction(database, source.sql);
    assertHealthyHost(database);
    const schema = observeHostSchema(database);
    const normalized = normalizeSchema(schema);
    const tables = readHostTables(database);
    const objects = schema.objects.filter(({ sql }) => sql !== null);
    const tableObjects = objects.filter(({ type }) => type === "table").sort((a, b) => a.name.localeCompare(b.name, "en"));
    const relationByName = new Map(schema.relations.map((relation) => [relation.name, relation]));
    // Seed only the exact post-chain seed rows. Parent-first ordering keeps FK
    // enforcement enabled. Cycles containing seed data require explicit review.
    const remaining = tableObjects.filter(({ name }) => tables[name].length);
    const seedOrder = [];
    while (remaining.length) {
      const index = remaining.findIndex(({ name }) => relationByName.get(name).foreignKeys
        .every(({ table }) => table === name || !remaining.some((entry) => entry.name === table)));
      assert.notEqual(index, -1, "Cyclic baseline seed dependencies need an explicit implementation");
      seedOrder.push(...remaining.splice(index, 1));
    }
    const lines = [
      "-- INACTIVE S2 baseline candidate: new EMPTY databases only.",
      "-- Generated from the historical chain plus inactive S1/S2 rehearsals.",
      "-- Not selected by Wrangler. No migration ledger is created or rewritten.",
      "-- Remote activation remains subject to the deployment/retirement gates.",
      `-- Normalized application schema SHA-256: ${schemaFingerprint(schema)}`,
      ...[...historical, ...stages].map(({ filename, sql }) => `-- Source ${filename} sha256=${migrationSqlHash(sql)}`),
      "", "PRAGMA foreign_keys = ON;", "",
      ...tableObjects.flatMap(({ sql }) => [sql + ";", ""]),
      "-- Exact built-in seed rows, before installing guards (none are disabled).",
    ];
    for (const { name } of seedOrder) {
      const columns = relationByName.get(name).columns.filter(({ hidden }) => hidden === 0).map(({ name: column }) => column);
      for (const row of tables[name]) lines.push(`INSERT INTO ${quoteIdentifier(name)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map((column) => sqlValue(row[column])).join(", ")});`);
    }
    for (const type of ["index", "view", "trigger"]) {
      lines.push("", `-- Final ${type} definitions, retaining creation order and normalized SQL.`);
      for (const object of objects.filter((entry) => entry.type === type)) lines.push(formatSqlForWrangler(object.sql) + ";", "");
    }
    return { sql: lines.join("\n"), schema, normalized, tables,
      sourceHashes: [...historical, ...stages].map(({ filename, sql }) => ({ filename, sha256: migrationSqlHash(sql) })) };
  } finally { database.close(); }
}
