import { normalizeSchema } from "./d1-migration-plan.mjs";

// All identifiers come from SQLite itself and enter table-valued PRAGMAs as
// values. No observed name is interpolated into executable SQL.
const SCHEMA_SQL = `
WITH objects AS (
  SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
)
SELECT json_object(
  'objects', json((SELECT json_group_array(json_object(
    'type', type, 'name', name, 'tableName', tableName, 'sql', sql
  )) FROM objects)),
  'relations', json((SELECT json_group_array(json_object(
    'name', o.name,
    'columns', json((SELECT json_group_array(json_object(
      'cid', c.cid, 'name', c.name, 'type', c.type, 'notnull', c."notnull",
      'dflt_value', c.dflt_value, 'pk', c.pk, 'hidden', c.hidden
    )) FROM pragma_table_xinfo(o.name) c)),
    'foreignKeys', json((SELECT json_group_array(json_object(
      'id', f.id, 'seq', f.seq, 'table', f."table", 'from', f."from", 'to', f."to",
      'on_update', f.on_update, 'on_delete', f.on_delete, 'match', f.match
    )) FROM pragma_foreign_key_list(o.name) f)),
    'indexes', json((SELECT json_group_array(json_object(
      'name', i.name, 'unique', i."unique", 'origin', i.origin, 'partial', i.partial,
      'columns', json((SELECT json_group_array(json_object(
        'seqno', x.seqno, 'cid', x.cid, 'name', x.name, 'desc', x."desc",
        'coll', x.coll, 'key', x.key
      )) FROM pragma_index_xinfo(i.name) x))
    )) FROM pragma_index_list(o.name) i))
  )) FROM objects o WHERE o.type IN ('table', 'view')
    AND o.name NOT IN ('_cf_KV', '_cf_METADATA')))
) AS schema_json`;

const LEDGER_PROBE_SQL = "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations') AS ledger_exists";
const LEDGER_SQL = "SELECT id, name, applied_at FROM d1_migrations ORDER BY id";

// Fixed statements shared with the remote transport. These are not query
// templates: neither callers nor observed identifiers can supply SQL fragments.
export const D1_MIGRATION_OBSERVATION_SQL = Object.freeze({
  schema: SCHEMA_SQL, ledgerProbe: LEDGER_PROBE_SQL, ledger: LEDGER_SQL,
  // The REST transport cannot assume a multi-query REST batch has the binding's
  // transaction guarantee. Read both values in a single SQLite SELECT instead.
  schemaAndLedger: `SELECT (${SCHEMA_SQL}) AS schema_json,
    (SELECT json_group_array(json_object('id', id, 'name', name, 'applied_at', applied_at))
      FROM (${LEDGER_SQL})) AS ledger_json`,
});

function reject(message) {
  throw new Error(`D1 migration observation rejected: ${message}`);
}

function rows(result, label) {
  if (!result || result.success !== true || !Array.isArray(result.results)) reject(`${label} failed or has missing results`);
  if (result.results.some((row) => !row || typeof row !== "object" || Array.isArray(row))) reject(`${label} contains a malformed row`);
  return result.results;
}

/**
 * Observe a supplied D1 binding using SELECTs only. The preliminary existence
 * probe chooses whether referencing the ledger is legal; it is NOT part of the
 * returned observation. Schema and ledger rows come from one D1 batch. A ledger
 * existence change invalidates the attempt instead of producing a partial input.
 * This adapter never creates the ledger, runs migrations, or authorizes execution.
 */
export async function observeD1Migrations(database) {
  if (!database || typeof database.prepare !== "function" || typeof database.batch !== "function") reject("a D1 binding is required");
  const probe = rows(await database.prepare(LEDGER_PROBE_SQL).all(), "ledger probe");
  if (probe.length !== 1 || ![0, 1].includes(probe[0].ledger_exists)) reject("invalid ledger existence probe");
  const expectedLedger = probe[0].ledger_exists === 1;
  const statements = [database.prepare(SCHEMA_SQL)];
  if (expectedLedger) statements.push(database.prepare(LEDGER_SQL));
  const batch = await database.batch(statements);
  if (!Array.isArray(batch) || batch.length !== statements.length) reject("incomplete snapshot batch");
  const snapshot = rows(batch[0], "schema snapshot");
  if (snapshot.length !== 1 || typeof snapshot[0].schema_json !== "string") reject("missing schema snapshot");
  let schema;
  try {
    schema = JSON.parse(snapshot[0].schema_json);
    normalizeSchema(schema);
  } catch (error) {
    reject(`invalid schema snapshot: ${error instanceof Error ? error.message : "invalid metadata"}`);
  }
  const ledgerObject = schema.objects.find(({ name }) => name === "d1_migrations");
  if (ledgerObject && ledgerObject.type !== "table") reject("ledger name is not a table");
  const ledgerExists = Boolean(ledgerObject);
  if (ledgerExists !== expectedLedger) reject("ledger existence changed during observation");
  const ledgerRows = expectedLedger ? rows(batch[1], "ledger snapshot") : [];
  let previousId = 0;
  const names = new Set();
  for (const row of ledgerRows) {
    if (!Number.isSafeInteger(row.id) || row.id <= previousId
      || typeof row.name !== "string" || !row.name || row.name.includes("\0") || names.has(row.name)
      || typeof row.applied_at !== "string" || !row.applied_at || row.applied_at.includes("\0")) reject("invalid ledger row or order");
    previousId = row.id;
    names.add(row.name);
  }
  return { schema, ledger: { exists: ledgerExists, rows: ledgerRows } };
}
