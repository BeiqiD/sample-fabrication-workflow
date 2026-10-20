import { createHash } from "node:crypto";

const PLATFORM_TABLES = new Set(["d1_migrations", "_cf_KV", "_cf_METADATA"]);
// Exact workerd-owned definitions, confirmed in the installed engine. D1 denies
// their PRAGMA metadata; a matching name alone must not hide an application table.
const PROTECTED_PLATFORM_SQL = {
  _cf_KV: "CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID",
  _cf_METADATA: "CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB)",
};
const OBJECT_TYPES = new Set(["table", "view", "index", "trigger"]);
const SOURCE_KINDS = new Set(["historical", "baseline", "incremental"]);

function reject(message) {
  throw new Error(`Migration plan rejected: ${message}`);
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(`${label} must be an object`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) reject(`${label} must be an array`);
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) reject(`${label} must be a nonempty string`);
  return value;
}

function integer(value, label, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) reject(`${label} must be an integer >= ${min}`);
  return value;
}

function nullableString(value, label) {
  return value === null ? null : string(value, label);
}

function unique(values, label) {
  if (new Set(values).size !== values.length) reject(`duplicate ${label}`);
}

const sorted = (values, key) => [...values].sort((a, b) => {
  const left = key(a), right = key(b);
  return left < right ? -1 : left > right ? 1 : 0;
});

export function migrationSqlHash(sql) {
  if (typeof sql !== "string") reject("migration SQL must be a string");
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

// Token normalization is deliberately conservative. Quoted strings/identifiers
// remain byte-for-byte intact; this is not a SQL parser or proof of equivalence.
export function normalizeSchemaSql(sql) {
  string(sql, "schema SQL");
  const tokens = [];
  let offset = 0;
  while (offset < sql.length) {
    const rest = sql.slice(offset);
    // SQLite treats non-ASCII characters, including NBSP, as identifier
    // characters. JavaScript's broader \s would erase meaningful adjacency.
    const whitespace = /^[\t\n\f\r ]+/.exec(rest);
    if (whitespace) { offset += whitespace[0].length; continue; }
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", offset + 2);
      offset = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = sql.indexOf("*/", offset + 2);
      if (end < 0) reject("unterminated SQL comment");
      offset = end + 2;
      continue;
    }
    // SQLite recognizes the adjacent X'...' form as one blob literal. Splitting
    // it would collide with an identifier followed by a quoted alias: x '00'.
    if (/^[xX]'/.test(rest)) {
      const blob = /^[xX]'(?:[a-fA-F0-9]{2})*'/.exec(rest)?.[0];
      if (!blob) reject("invalid SQL blob literal");
      tokens.push(blob);
      offset += blob.length;
      continue;
    }
    const opener = sql[offset];
    if (["'", '"', "`", "["].includes(opener)) {
      const closer = opener === "[" ? "]" : opener;
      const start = offset++;
      let closed = false;
      while (offset < sql.length) {
        if (sql[offset++] !== closer) continue;
        if (opener !== "[" && sql[offset] === closer) { offset++; continue; }
        closed = true;
        break;
      }
      if (!closed) reject("unterminated SQL quote");
      tokens.push(sql.slice(start, offset));
      continue;
    }
    // Keep the entire SQLite identifier token together. Unicode punctuation,
    // combining marks and emoji can be part of an unquoted identifier too.
    const token = /^(?:->>|->|\|\||<<|>>|<=|>=|==|!=|<>|[A-Za-z0-9_$\u0080-\u{10FFFF}]+|.)/u.exec(rest)?.[0];
    if (!token) reject("unrecognized SQL token");
    tokens.push(token);
    offset += token.length;
  }
  while (tokens.at(-1) === ";") tokens.pop();
  return tokens;
}

function platformObject(object) {
  // Application triggers on platform tables are intentionally NOT hidden.
  return object.name === "sqlite_sequence" || /^sqlite_stat[1-4]$/.test(object.name)
    || ((object.type === "table" || object.type === "index") && PLATFORM_TABLES.has(object.tableName));
}

/**
 * Normalize a complete read-only SQLite observation. The caller supplies all
 * sqlite_schema objects and table_xinfo/foreign_key_list/index_list/index_xinfo
 * rows. No database, file, subprocess, or remote operation is performed here.
 */
export function normalizeSchema(observation) {
  record(observation, "schema observation");
  const allObjects = array(observation.objects, "schema objects").map((input) => {
    const object = record(input, "schema object");
    if (!OBJECT_TYPES.has(object.type)) reject("unknown schema object type");
    const name = string(object.name, "object name");
    const tableName = string(object.tableName, "object table name");
    if (object.sql === null && object.type !== "index") reject(`missing SQL for ${name}`);
    const sql = object.sql === null ? null : normalizeSchemaSql(object.sql);
    return { type: object.type, name, tableName, sql };
  });
  unique(allObjects.map(({ type, name }) => `${type}:${name}`), "schema objects");
  for (const [name, expectedSql] of Object.entries(PROTECTED_PLATFORM_SQL)) {
    const object = allObjects.find((entry) => entry.name === name);
    if (object && (object.type !== "table" || object.tableName !== name
      || JSON.stringify(object.sql) !== JSON.stringify(normalizeSchemaSql(expectedSql)))) reject(`unexpected protected platform table: ${name}`);
    if (allObjects.some((entry) => entry.type === "index" && entry.tableName === name)) reject(`unexpected protected platform index: ${name}`);
  }
  const objects = allObjects.filter((object) => !platformObject(object));
  const relations = array(observation.relations, "schema relations").map((input) => {
    const relation = record(input, "schema relation");
    const name = string(relation.name, "relation name");
    const matching = allObjects.find((object) => object.name === name && ["table", "view"].includes(object.type));
    if (!matching) reject(`orphan relation metadata: ${name}`);
    const columns = array(relation.columns, `${name} columns`).map((column) => ({
      cid: integer(column.cid, "column cid"),
      name: string(column.name, "column name"),
      type: typeof column.type === "string" ? column.type : reject("column type must be a string"),
      notnull: integer(column.notnull, "column notnull"),
      dflt_value: column.dflt_value === null ? null : normalizeSchemaSql(column.dflt_value),
      pk: integer(column.pk, "column pk"),
      hidden: integer(column.hidden, "column hidden"),
    }));
    if (!columns.length) reject(`missing columns: ${name}`);
    unique(columns.map(({ cid }) => cid), `${name} column positions`);
    unique(columns.map(({ name: columnName }) => columnName), `${name} columns`);
    const foreignKeys = array(relation.foreignKeys, `${name} foreign keys`).map((fk) => ({
      id: integer(fk.id, "foreign key id"),
      seq: integer(fk.seq, "foreign key seq"),
      table: string(fk.table, "foreign key table"),
      from: string(fk.from, "foreign key source"),
      to: nullableString(fk.to, "foreign key target"),
      on_update: string(fk.on_update, "foreign key on_update"),
      on_delete: string(fk.on_delete, "foreign key on_delete"),
      match: string(fk.match, "foreign key match"),
    }));
    unique(foreignKeys.map(({ id, seq }) => `${id}:${seq}`), `${name} foreign key entries`);
    const indexes = array(relation.indexes, `${name} indexes`).map((index) => {
      const indexName = string(index.name, "index name");
      const object = allObjects.find((entry) => entry.type === "index" && entry.name === indexName && entry.tableName === name);
      // WITHOUT ROWID primary keys can be present only in index_list, without a
      // separate sqlite_schema object. Their complete index_xinfo is retained.
      if (!object && index.origin !== "pk") reject(`missing index SQL object: ${indexName}`);
      const indexColumns = array(index.columns, `${indexName} index columns`).map((column) => ({
        seqno: integer(column.seqno, "index column seqno"),
        cid: integer(column.cid, "index column cid", -2),
        name: nullableString(column.name, "index column name"),
        desc: integer(column.desc, "index column desc"),
        coll: nullableString(column.coll, "index column collation"),
        key: integer(column.key, "index column key"),
      }));
      if (!indexColumns.length) reject(`missing index columns: ${indexName}`);
      unique(indexColumns.map(({ seqno }) => seqno), `${indexName} index column positions`);
      return {
        name: indexName,
        unique: integer(index.unique, "index unique"),
        origin: string(index.origin, "index origin"),
        partial: integer(index.partial, "index partial"),
        columns: sorted(indexColumns, ({ seqno }) => seqno),
      };
    });
    unique(indexes.map(({ name: indexName }) => indexName), `${name} indexes`);
    for (const object of allObjects.filter((entry) => entry.type === "index" && entry.tableName === name)) {
      if (!indexes.some((index) => index.name === object.name)) reject(`missing index metadata: ${object.name}`);
    }
    return {
      name,
      columns: sorted(columns, ({ cid }) => cid),
      foreignKeys: sorted(foreignKeys, ({ id, seq }) => `${id}:${seq}`),
      indexes: sorted(indexes, ({ name: indexName }) => indexName),
    };
  });
  unique(relations.map(({ name }) => name), "schema relation metadata");
  for (const object of allObjects.filter(({ type }) => ["table", "view"].includes(type))) {
    // Only these exact, shape-checked engine tables may lack protected metadata.
    // Ledger and every application table/view still require complete PRAGMAs.
    if (!Object.hasOwn(PROTECTED_PLATFORM_SQL, object.name)
      && !relations.some(({ name }) => name === object.name)) reject(`missing relation metadata: ${object.name}`);
  }
  const applicationNames = new Set(objects.filter(({ type }) => ["table", "view"].includes(type)).map(({ name }) => name));
  return {
    objects: sorted(objects, ({ type, name }) => `${type}:${name}`),
    relations: sorted(relations.filter(({ name }) => applicationNames.has(name)), ({ name }) => name),
  };
}

export function schemaFingerprint(observation) {
  return migrationSqlHash(JSON.stringify(normalizeSchema(observation)));
}

function validateCatalog(catalog, sourceFiles) {
  record(catalog, "catalog");
  if (catalog.version !== 1) reject("unsupported catalog version");
  const files = array(sourceFiles, "source files");
  const names = files.map((file) => string(file.filename, "source filename"));
  unique(names, "source files");
  const sources = array(catalog.sources, "catalog sources").map((source) => {
    record(source, "catalog source");
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(source.filename)) reject("unsafe migration filename");
    if (!/^[a-f0-9]{64}$/.test(source.sha256)) reject(`invalid source hash: ${source.filename}`);
    if (!SOURCE_KINDS.has(source.kind)) reject(`unknown source kind: ${source.filename}`);
    const file = files.find(({ filename }) => filename === source.filename);
    if (!file || migrationSqlHash(file.sql) !== source.sha256) reject(`source hash mismatch or missing file: ${source.filename}`);
    return { filename: source.filename, sha256: source.sha256, kind: source.kind };
  });
  unique(sources.map(({ filename }) => filename), "catalog sources");
  if (files.length !== sources.length) reject("uncatalogued source file");
  const lineages = array(catalog.lineages, "catalog lineages").map((lineage) => {
    record(lineage, "lineage");
    const id = string(lineage.id, "lineage id");
    if (!["legacy", "baseline"].includes(lineage.kind)) reject(`unknown lineage kind: ${id}`);
    const migrations = array(lineage.migrations, `${id} migrations`).map((filename) => {
      const source = sources.find((entry) => entry.filename === filename);
      if (!source) reject(`unknown lineage source: ${filename}`);
      return source;
    });
    if (!migrations.length) reject(`empty lineage: ${id}`);
    unique(migrations.map(({ filename }) => filename), `${id} migrations`);
    if (lineage.kind === "legacy" && migrations.some(({ kind }) => kind === "baseline")) reject("legacy lineage contains baseline SQL");
    if (lineage.kind === "baseline" && (migrations[0].kind !== "baseline" || migrations.slice(1).some(({ kind }) => kind !== "incremental"))) {
      reject("baseline lineage must contain one baseline followed by incremental SQL");
    }
    const states = array(lineage.supportedStates, `${id} supported states`).map((state) => {
      const appliedCount = integer(state.appliedCount, "supported prefix", 1);
      if (appliedCount > migrations.length) reject(`prefix exceeds lineage: ${id}`);
      return { appliedCount, schemaHash: schemaFingerprint(state.schema) };
    });
    unique(states.map(({ appliedCount }) => appliedCount), `${id} supported prefixes`);
    if (!states.some(({ appliedCount }) => appliedCount === migrations.length)) reject(`missing final schema: ${id}`);
    // Every migration boundary reachable from an admitted prefix must have an
    // expected schema, so a partial application can be classified on retry.
    const first = lineage.kind === "baseline" ? 1 : Math.min(...states.map(({ appliedCount }) => appliedCount));
    for (let count = first; count <= migrations.length; count++) {
      if (!states.some(({ appliedCount }) => appliedCount === count)) reject(`missing resumable prefix ${count}: ${id}`);
    }
    return { id, kind: lineage.kind, migrations, states };
  });
  unique(lineages.map(({ id }) => id), "lineage ids");
  const fresh = lineages.find(({ id }) => id === catalog.freshLineage);
  if (!fresh || fresh.kind !== "baseline") reject("fresh lineage must name a known baseline lineage");
  return { sources, lineages, fresh };
}

/**
 * Return a read-only proposal, never authority to execute or deploy. Catalog
 * schemas/hashes must come from a reviewed source, not the target observation.
 */
export function planD1Migrations({ catalog, sourceFiles, target }) {
  const validated = validateCatalog(catalog, sourceFiles);
  record(target, "target");
  const normalized = normalizeSchema(target.schema);
  const observedSchemaHash = migrationSqlHash(JSON.stringify(normalized));
  const ledger = record(target.ledger, "target ledger");
  if (typeof ledger.exists !== "boolean") reject("ledger existence must be explicit");
  const ledgerTable = target.schema.objects.some(({ type, name }) => type === "table" && name === "d1_migrations");
  if (ledgerTable !== ledger.exists) reject("ledger existence disagrees with observed schema");
  const rows = array(ledger.rows, "ledger rows");
  if (!ledger.exists && rows.length) reject("ledger rows without ledger");
  let previousId = 0;
  for (const row of rows) {
    const id = integer(row.id, "ledger id", 1);
    if (id <= previousId) reject("ledger order or duplicate id");
    previousId = id;
    string(row.name, "ledger name");
  }
  const appliedNames = rows.map(({ name }) => name);
  unique(appliedNames, "ledger migration names");
  let lineage;
  let classification;
  if (rows.length === 0) {
    if (normalized.objects.length || normalized.relations.length) reject("empty ledger with application schema");
    lineage = validated.fresh;
    classification = "empty";
  } else {
    const matches = validated.lineages.filter((entry) => entry.migrations.length >= appliedNames.length
      && appliedNames.every((name, index) => entry.migrations[index].filename === name));
    if (matches.length !== 1) reject("unknown, mixed, incomplete, or ambiguous ledger lineage");
    lineage = matches[0];
    const state = lineage.states.find(({ appliedCount }) => appliedCount === appliedNames.length);
    if (!state) reject("unsupported ledger prefix");
    if (state.schemaHash !== observedSchemaHash) reject("schema drift from supported ledger state");
    classification = lineage.kind;
  }
  return {
    kind: "read-only-migration-proposal",
    classification,
    lineage: lineage.id,
    observedSchemaHash,
    appliedNames: [...appliedNames],
    migrations: lineage.migrations.slice(appliedNames.length).map(({ filename, sha256 }) => ({ filename, sha256 })),
    expectedFinalSchemaHash: lineage.states.find(({ appliedCount }) => appliedCount === lineage.migrations.length).schemaHash,
    executionAuthorized: false,
  };
}
