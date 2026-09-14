import type { ExportRow, ExportSchemaObject, ExportTables } from "./export";
import { validateLegacyOverlap } from "./export-file-foundation";
import { sqliteTableColumns } from "../domain/sqlite-table-columns";
import { sha256Hex, stableJson } from "../domain/content-addressing";

export const FILE_AUTHORITY_CONTROL_TABLE = "file_authority_control" as const;

export const FILE_AUTHORITY_EXPORT_COLUMNS = {
  file_authority_control: ["singleton", "mode", "revision", "updated_at", "activated_at"],
  storage_profile_runtime: ["storage_profile_id", "state", "registered_at", "activated_at", "retired_at"],
  file_location_publications: ["location_id", "file_id", "storage_profile_id", "object_key", "verified_byte_size", "verified_sha256", "verification_method", "verification_operation_id", "verified_at", "published_at"],
  file_publications: ["file_id", "purpose", "access_scope", "verified_byte_size", "verified_sha256", "active_location_id", "state", "published_at", "retired_at"],
  file_derivations: ["id", "source_file_id", "derived_file_id", "generator", "generator_version", "parameters_sha256", "trust_state", "source_verified_sha256", "derived_verified_sha256", "verification_operation_id", "evidence_json", "created_at"],
  file_holds: ["id", "file_id", "hold_kind", "operation_id", "reason", "acquired_at", "expires_at", "released_at"],
  file_location_holds: ["id", "location_id", "hold_kind", "operation_id", "reason", "acquired_at", "expires_at", "released_at"],
  file_location_gc_ledger: ["location_id", "state", "operation_id", "orphaned_at", "deletion_started_at", "deleted_at", "attempt_count", "last_error", "updated_at"],
  file_location_integrity_quarantine: ["location_id", "reason", "expected_byte_size", "observed_byte_size", "expected_sha256", "observed_sha256", "operation_id", "detected_at", "last_checked_at"],
  file_consumer_migration_decisions: ["id", "consumer_kind", "consumer_id", "consumer_sub_id", "file_slot", "decision", "file_id", "reason", "source_row_sha256", "legacy_store_kind", "legacy_provider", "legacy_object_key", "legacy_location_id", "operation_id", "evidence_json", "decided_by", "decided_at"],
  file_acceptance_candidates: ["acceptance_kind", "acceptance_id", "item_id", "purpose", "access_scope", "storage_profile_id", "expected_byte_size", "expected_sha256", "candidate_file_id", "candidate_location_id", "candidate_object_key", "state", "result_file_id", "result_location_id", "created_at", "completed_at"],
} as const;

export const FILE_AUTHORITY_CONSUMER_COLUMNS = {
  state_representation_assets: ["file_id"],
  run_step_assets: ["file_id"],
  metrology_template_references: ["file_id"],
  run_step_comments: ["file_id"],
  state_verifications: ["evidence_file_id"],
  comment_submission_items: ["file_id"],
  project_content_attachments: ["file_id"],
  attachment_derivatives: ["derived_file_id"],
  events: ["asset_file_id", "thumbnail_file_id"],
  imports: ["workbook_file_id", "manifest_file_id"],
  template_versions: ["source_file_id"],
} as const;

export const FILE_AUTHORITY_SCHEMA_V14_TABLE_NAMES = [
  "storage_profiles",
  "files",
  "file_locations",
  "legacy_file_mappings",
  "file_authority_control",
  "storage_profile_runtime",
  "file_location_publications",
  "file_publications",
  "file_derivations",
  "file_holds",
  "file_location_holds",
  "file_location_gc_ledger",
  "file_location_integrity_quarantine",
  "file_consumer_migration_decisions",
  "file_acceptance_candidates",
  "state_representation_assets",
  "run_step_assets",
  "metrology_template_references",
  "run_step_comments",
  "state_verifications",
  "comment_submission_items",
  "project_content_attachments",
  "attachment_derivatives",
  "events",
  "imports",
  "template_versions",
] as const;

export const FILE_AUTHORITY_SCHEMA_V14_VIEW_NAMES = [
  "attachment_derivative_browser_safe_assets",
  "blob_retention_edges",
  "blob_retention_edges_attachment_derivatives",
  "blob_retention_edges_comment_items",
  "blob_retention_edges_direct_keys",
  "blob_retention_edges_project_attachments",
  "blob_retention_edges_r2_occurrences",
  "file_consumer_content_projection",
  "file_consumer_direct_projection",
  "file_consumer_projection",
  "file_consumer_relational_projection",
  "file_content_retention_edges",
  "file_direct_retention_edges",
  "file_location_availability",
  "file_location_retention_edges",
  "file_relational_retention_edges",
  "file_retention_edges",
  "file_usable_publications",
] as const;

// This constant authenticates the exact transition-relevant sqlite_schema
// checkpoint installed by migrations 0001..0007. Recompute it only when that
// reviewed migration chain intentionally changes.
export const FILE_AUTHORITY_SCHEMA_FINGERPRINT_ALGORITHM = "file-authority-sqlite-schema/v1" as const;
export const FILE_AUTHORITY_SCHEMA_FINGERPRINT_SHA256 = "7ceede1dfbd921e6a5b082cf7a6b92cefb01f42354979368560845e7a2a8c775";

const FILE_AUTHORITY_SCHEMA_TABLES = new Set<string>(FILE_AUTHORITY_SCHEMA_V14_TABLE_NAMES);
const FILE_AUTHORITY_SCHEMA_VIEWS = new Set<string>(FILE_AUTHORITY_SCHEMA_V14_VIEW_NAMES);

function fileAuthoritySchemaView(name: string) {
  return FILE_AUTHORITY_SCHEMA_VIEWS.has(name);
}

// D1's migration splitter removes standalone comments inside some DDL while
// node:sqlite stores the same comments when it executes a migration as one
// string. Authenticate SQLite lexical tokens instead of presentation-only
// comments and ASCII whitespace. Quoted strings and identifiers stay byte for
// byte intact, including comment-looking text; adjacent X'..' is one literal.
export function canonicalFileAuthoritySchemaSql(sql: string) {
  const tokens: string[] = [];
  let offset = 0;
  const whitespace = (code: number) => code === 0x09 || code === 0x0a || code === 0x0c
    || code === 0x0d || code === 0x20;
  const identifier = (code: number) => code >= 0x80
    || code >= 0x30 && code <= 0x39
    || code >= 0x41 && code <= 0x5a
    || code >= 0x61 && code <= 0x7a
    || code === 0x24 || code === 0x5f;

  while (offset < sql.length) {
    const code = sql.charCodeAt(offset);
    if (whitespace(code)) {
      offset += 1;
      continue;
    }
    if (sql.startsWith("--", offset)) {
      const end = sql.indexOf("\n", offset + 2);
      offset = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", offset)) {
      const end = sql.indexOf("*/", offset + 2);
      if (end < 0) throw new Error("Invalid File authority schema SQL: unterminated comment");
      offset = end + 2;
      continue;
    }
    if ((sql[offset] === "x" || sql[offset] === "X") && sql[offset + 1] === "'") {
      let end = offset + 2;
      while (end < sql.length && sql[end] !== "'") end += 1;
      const value = sql.slice(offset + 2, end);
      if (end === sql.length || value.length % 2 !== 0 || !/^[a-fA-F0-9]*$/.test(value)) {
        throw new Error("Invalid File authority schema SQL: invalid blob literal");
      }
      tokens.push(sql.slice(offset, end + 1));
      offset = end + 1;
      continue;
    }
    const opener = sql[offset];
    if (opener === "'" || opener === '"' || opener === "`" || opener === "[") {
      const closer = opener === "[" ? "]" : opener;
      const start = offset;
      offset += 1;
      let closed = false;
      while (offset < sql.length) {
        if (sql[offset] !== closer) {
          offset += 1;
          continue;
        }
        offset += 1;
        if (opener !== "[" && sql[offset] === closer) {
          offset += 1;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) throw new Error("Invalid File authority schema SQL: unterminated quote");
      tokens.push(sql.slice(start, offset));
      continue;
    }
    const operator = ["->>", "->", "||", "<<", ">>", "<=", ">=", "==", "!=", "<>"]
      .find((candidate) => sql.startsWith(candidate, offset));
    if (operator) {
      tokens.push(operator);
      offset += operator.length;
      continue;
    }
    const point = sql.codePointAt(offset)!;
    if (identifier(point)) {
      const start = offset;
      offset += point > 0xffff ? 2 : 1;
      while (offset < sql.length) {
        const next = sql.codePointAt(offset)!;
        if (!identifier(next)) break;
        offset += next > 0xffff ? 2 : 1;
      }
      tokens.push(sql.slice(start, offset));
      continue;
    }
    tokens.push(sql[offset]);
    offset += 1;
  }
  while (tokens.at(-1) === ";") tokens.pop();
  return tokens;
}

function comparedSchemaObject(entry: ExportSchemaObject) {
  return {
    type: entry.type,
    name: entry.name,
    tableName: entry.tableName,
    sql: entry.sql === null ? null : canonicalFileAuthoritySchemaSql(entry.sql),
  };
}

export function fileAuthoritySchemaSlice(objects: ExportSchemaObject[]) {
  return objects.filter((entry) => (
    entry.type === "table" && FILE_AUTHORITY_SCHEMA_TABLES.has(entry.name)
    || (entry.type === "index" || entry.type === "trigger")
      && (FILE_AUTHORITY_SCHEMA_TABLES.has(entry.tableName) || fileAuthoritySchemaView(entry.tableName))
    || entry.type === "view" && fileAuthoritySchemaView(entry.name)
  )).map(comparedSchemaObject).sort((left, right) => {
    const leftKey = `${left.type}\0${left.name}\0${left.tableName}`;
    const rightKey = `${right.type}\0${right.name}\0${right.tableName}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

export async function fileAuthoritySchemaFingerprint(objects: ExportSchemaObject[]) {
  const tuples = fileAuthoritySchemaSlice(objects).map((entry) => [
    entry.type, entry.name, entry.tableName, entry.sql,
  ]);
  return await sha256Hex(JSON.stringify([FILE_AUTHORITY_SCHEMA_FINGERPRINT_ALGORITHM, tuples]));
}

export const EMPTY_FILE_AUTHORITY_TABLES = [
  "file_location_publications",
  "file_publications",
  "file_derivations",
  "file_holds",
  "file_location_holds",
  "file_location_gc_ledger",
  "file_location_integrity_quarantine",
  "file_consumer_migration_decisions",
  "file_acceptance_candidates",
] as const;

export const FILE_AUTHORITY_EXPORTED_VIEWS = [
  "file_consumer_relational_projection",
  "file_consumer_content_projection",
  "file_consumer_direct_projection",
  "file_consumer_projection",
  "file_relational_retention_edges",
  "file_content_retention_edges",
  "file_direct_retention_edges",
  "file_retention_edges",
  "file_location_retention_edges",
  "file_location_availability",
] as const;

export const FILE_AUTHORITY_EXPORT_VIEW_COLUMNS = {
  file_consumer_relational_projection: ["consumer_kind", "consumer_id", "consumer_sub_id", "file_slot", "file_id", "expected_purpose", "legacy_r2_object_key", "legacy_managed_provider", "legacy_managed_object_key", "resolution_state", "decision_id"],
  file_consumer_content_projection: ["consumer_kind", "consumer_id", "consumer_sub_id", "file_slot", "file_id", "expected_purpose", "legacy_r2_object_key", "legacy_managed_provider", "legacy_managed_object_key", "resolution_state", "decision_id"],
  file_consumer_direct_projection: ["consumer_kind", "consumer_id", "consumer_sub_id", "file_slot", "file_id", "expected_purpose", "legacy_r2_object_key", "legacy_managed_provider", "legacy_managed_object_key", "resolution_state", "decision_id"],
  file_consumer_projection: ["consumer_kind", "consumer_id", "consumer_sub_id", "file_slot", "file_id", "expected_purpose", "legacy_r2_object_key", "legacy_managed_provider", "legacy_managed_object_key", "resolution_state", "decision_id"],
  file_relational_retention_edges: ["file_id", "source_type", "source_id", "occurrence_type", "occurrence_id", "retention_reason", "retain_until"],
  file_content_retention_edges: ["file_id", "source_type", "source_id", "occurrence_type", "occurrence_id", "retention_reason", "retain_until"],
  file_direct_retention_edges: ["file_id", "source_type", "source_id", "occurrence_type", "occurrence_id", "retention_reason", "retain_until"],
  file_retention_edges: ["file_id", "source_type", "source_id", "occurrence_type", "occurrence_id", "retention_reason", "retain_until"],
  file_location_retention_edges: ["location_id", "file_id", "source_type", "source_id", "occurrence_type", "occurrence_id", "retention_reason", "retain_until"],
  file_location_availability: ["location_id", "file_id", "storage_profile_id", "object_key", "verified_byte_size", "verified_sha256", "availability", "is_active_location"],
} as const;

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Full export rejected: invalid File authority transition ${message}`);
}

function rows(tables: ExportTables, name: string) {
  ensure(Array.isArray(tables[name]), `${name} inventory`);
  return tables[name];
}

function projectedRow(input: {
  consumerKind: string;
  consumerId: ExportRow[string];
  consumerSubId?: ExportRow[string];
  fileSlot: string;
  fileId: ExportRow[string];
  expectedPurpose: string | null;
  r2Key?: ExportRow[string];
  managedProvider?: ExportRow[string];
  managedKey?: ExportRow[string];
}): ExportRow {
  return {
    consumer_kind: input.consumerKind,
    consumer_id: input.consumerId,
    consumer_sub_id: input.consumerSubId ?? "",
    file_slot: input.fileSlot,
    file_id: input.fileId,
    expected_purpose: input.expectedPurpose,
    legacy_r2_object_key: input.r2Key ?? null,
    legacy_managed_provider: input.managedProvider ?? null,
    legacy_managed_object_key: input.managedKey ?? null,
    resolution_state: "legacy_pending",
    decision_id: null,
  };
}

function sqlTextPresent(value: ExportRow[string]) {
  return value !== null && String(value).replace(/^ +| +$/g, "") !== "";
}

// JSON.parse agrees with SQLite's strict json_valid() grammar, but it keeps
// the last duplicate object member and accepts nesting deeper than JSON1.
// Walk the already-validated text to reproduce the first top-level member and
// JSON1's 1000-container limit for the one legacy path used by this schema.
function sqliteJsonThumbnailKey(value: ExportRow[string]) {
  if (typeof value !== "string") return null;
  try { JSON.parse(value); } catch { return null; }
  let cursor = 0;
  let thumbnailSeen = false;
  let thumbnail: string | null = null;

  const whitespace = (code: number) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
  const skipWhitespace = () => {
    while (cursor < value.length && whitespace(value.charCodeAt(cursor))) cursor += 1;
  };
  const sqliteText = (decoded: string) => {
    let result = "";
    for (let index = 0; index < decoded.length; index += 1) {
      const code = decoded.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff
        && index + 1 < decoded.length
        && decoded.charCodeAt(index + 1) >= 0xdc00
        && decoded.charCodeAt(index + 1) <= 0xdfff) {
        result += decoded[index] + decoded[index + 1];
        index += 1;
      } else if (code >= 0xd800 && code <= 0xdfff) {
        // JSON1 emits the UTF-8 bytes for an unpaired escaped surrogate; D1's
        // UTF-8 result decoder exposes one replacement character per byte.
        result += "\ufffd\ufffd\ufffd";
      } else result += decoded[index];
    }
    return result;
  };
  const parseString = () => {
    const start = cursor;
    if (value[cursor] !== '"') throw new Error("string expected");
    cursor += 1;
    while (cursor < value.length) {
      if (value[cursor] === '"') {
        cursor += 1;
        const decoded = JSON.parse(value.slice(start, cursor));
        if (typeof decoded !== "string") throw new Error("invalid string");
        return decoded;
      }
      if (value[cursor] === "\\") cursor += 1;
      cursor += 1;
    }
    throw new Error("unterminated string");
  };

  type ParsedValue = { kind: "string"; value: string } | { kind: "other" };
  const parseValue = (depth: number, captureRoot: boolean): ParsedValue => {
    skipWhitespace();
    if (value[cursor] === '"') return { kind: "string", value: parseString() };
    if (value[cursor] === "{") {
      parseObject(depth + 1, captureRoot);
      return { kind: "other" };
    }
    if (value[cursor] === "[") {
      parseArray(depth + 1);
      return { kind: "other" };
    }
    while (cursor < value.length && !whitespace(value.charCodeAt(cursor))
      && ![",", "]", "}"].includes(value[cursor])) cursor += 1;
    return { kind: "other" };
  };
  const parseObject = (depth: number, capture: boolean) => {
    if (depth > 1000) throw new Error("JSON1 nesting limit");
    cursor += 1;
    skipWhitespace();
    if (value[cursor] === "}") { cursor += 1; return; }
    while (cursor < value.length) {
      const key = parseString();
      skipWhitespace();
      if (value[cursor] !== ":") throw new Error("colon expected");
      cursor += 1;
      const capturesThumbnail = capture && !thumbnailSeen && key === "thumbnailKey";
      const parsed = parseValue(depth, false);
      if (capturesThumbnail) {
        thumbnailSeen = true;
        thumbnail = parsed.kind === "string" ? sqliteText(parsed.value) : null;
      }
      skipWhitespace();
      if (value[cursor] === "}") { cursor += 1; return; }
      if (value[cursor] !== ",") throw new Error("comma expected");
      cursor += 1;
      skipWhitespace();
    }
    throw new Error("unterminated object");
  };
  const parseArray = (depth: number) => {
    if (depth > 1000) throw new Error("JSON1 nesting limit");
    cursor += 1;
    skipWhitespace();
    if (value[cursor] === "]") { cursor += 1; return; }
    while (cursor < value.length) {
      parseValue(depth, false);
      skipWhitespace();
      if (value[cursor] === "]") { cursor += 1; return; }
      if (value[cursor] !== ",") throw new Error("comma expected");
      cursor += 1;
    }
    throw new Error("unterminated array");
  };

  try {
    parseValue(0, true);
    skipWhitespace();
    if (cursor !== value.length) return null;
    return thumbnailSeen ? thumbnail : null;
  } catch {
    return null;
  }
}

// V14 is intentionally legacy-authoritative. Recompute every diagnostic leaf
// from canonical tables so a caller cannot forge a matching leaf/aggregate
// pair and conceal a divergent consumer projection in the snapshot.
function legacyConsumerProjections(tables: ExportTables) {
  const assets = new Map(rows(tables, "assets").map((row) => [row.id, row]));
  const managed = new Map(rows(tables, "managed_storage_objects").map((row) => [row.id, row]));
  const assetKey = (id: ExportRow[string]) => assets.get(id)?.r2_key ?? null;
  const managedRow = (id: ExportRow[string]) => managed.get(id);
  const relational: ExportRow[] = [];
  const content: ExportRow[] = [];
  const direct: ExportRow[] = [];

  for (const row of rows(tables, "state_representation_assets")) relational.push(projectedRow({
    consumerKind: "state_representation_asset", consumerId: row.state_hash, consumerSubId: row.asset_id,
    fileSlot: "primary", fileId: row.file_id, expectedPurpose: "embedded_content", r2Key: assetKey(row.asset_id),
  }));
  for (const row of rows(tables, "run_step_assets")) relational.push(projectedRow({
    consumerKind: "run_step_asset", consumerId: row.id, fileSlot: "primary", fileId: row.file_id,
    expectedPurpose: null, r2Key: assetKey(row.asset_id),
  }));
  for (const row of rows(tables, "metrology_template_references")) relational.push(projectedRow({
    consumerKind: "metrology_template_reference", consumerId: row.id, fileSlot: "primary", fileId: row.file_id,
    expectedPurpose: null, r2Key: assetKey(row.asset_id),
  }));
  for (const row of rows(tables, "run_step_comments")) if (row.asset_id !== null || row.file_id !== null) relational.push(projectedRow({
    consumerKind: "run_step_comment", consumerId: row.id, fileSlot: "primary", fileId: row.file_id,
    expectedPurpose: "embedded_content", r2Key: assetKey(row.asset_id),
  }));
  for (const row of rows(tables, "state_verifications")) if (row.evidence_asset_id !== null || row.evidence_file_id !== null) relational.push(projectedRow({
    consumerKind: "state_verification", consumerId: row.id, fileSlot: "evidence", fileId: row.evidence_file_id,
    expectedPurpose: "embedded_content", r2Key: assetKey(row.evidence_asset_id),
  }));

  for (const row of rows(tables, "comment_submission_items")) if (row.asset_id !== null || row.storage_object_id !== null || row.file_id !== null) {
    const object = managedRow(row.storage_object_id);
    content.push(projectedRow({
      consumerKind: "comment_submission_item", consumerId: row.id, fileSlot: "primary", fileId: row.file_id,
      expectedPurpose: row.kind === "attachment" ? "research_source"
        : row.kind === "comment_image" && row.related_item_id !== null ? "derived_preview" : "embedded_content",
      r2Key: assetKey(row.asset_id), managedProvider: object?.provider ?? null, managedKey: object?.object_key ?? null,
    }));
  }
  for (const row of rows(tables, "project_content_attachments")) {
    const object = managedRow(row.storage_object_id);
    content.push(projectedRow({
      consumerKind: "project_content_attachment", consumerId: row.project_content_id, fileSlot: "primary", fileId: row.file_id,
      expectedPurpose: null, r2Key: assetKey(row.asset_id), managedProvider: object?.provider ?? null, managedKey: object?.object_key ?? null,
    }));
  }
  for (const row of rows(tables, "attachment_derivatives")) if (row.derived_asset_id !== null || row.derived_file_id !== null) content.push(projectedRow({
    consumerKind: "attachment_derivative", consumerId: row.id, fileSlot: "derived", fileId: row.derived_file_id,
    expectedPurpose: "derived_preview", r2Key: assetKey(row.derived_asset_id),
  }));

  for (const row of rows(tables, "events")) {
    if (sqlTextPresent(row.asset_key)) direct.push(projectedRow({
      consumerKind: "event", consumerId: row.id, fileSlot: "primary", fileId: row.asset_file_id,
      expectedPurpose: "embedded_content", r2Key: row.asset_key,
    }));
    const thumbnailKey = sqliteJsonThumbnailKey(row.metadata_json);
    if (sqlTextPresent(thumbnailKey)) direct.push(projectedRow({
      consumerKind: "event", consumerId: row.id, fileSlot: "thumbnail", fileId: row.thumbnail_file_id,
      expectedPurpose: "derived_preview", r2Key: thumbnailKey,
    }));
  }
  for (const row of rows(tables, "imports")) {
    if (sqlTextPresent(row.workbook_asset_key)) direct.push(projectedRow({
      consumerKind: "import", consumerId: row.id, fileSlot: "workbook", fileId: row.workbook_file_id,
      expectedPurpose: "provenance", r2Key: row.workbook_asset_key,
    }));
    if (sqlTextPresent(row.manifest_asset_key)) direct.push(projectedRow({
      consumerKind: "import", consumerId: row.id, fileSlot: "manifest", fileId: row.manifest_file_id,
      expectedPurpose: "provenance", r2Key: row.manifest_asset_key,
    }));
  }
  for (const row of rows(tables, "template_versions")) if (sqlTextPresent(row.source_asset_key)) direct.push(projectedRow({
    consumerKind: "template_version", consumerId: row.id, fileSlot: "source", fileId: row.source_file_id,
    expectedPurpose: "provenance", r2Key: row.source_asset_key,
  }));

  return {
    file_consumer_relational_projection: relational,
    file_consumer_content_projection: content,
    file_consumer_direct_projection: direct,
  };
}

function text(value: unknown, maximum = 2048) {
  return typeof value === "string" && value.length > 0 && [...value].length <= maximum && !value.includes("\0");
}

export function observesFileAuthorityTransition(objects: ExportSchemaObject[]) {
  return objects.some((entry) => entry.type === "table" && entry.name === FILE_AUTHORITY_CONTROL_TABLE);
}

export async function validateFileAuthorityExport(tables: ExportTables, schemaObjects: ExportSchemaObject[]) {
  ensure(observesFileAuthorityTransition(schemaObjects), "schema marker");
  ensure(await fileAuthoritySchemaFingerprint(schemaObjects) === FILE_AUTHORITY_SCHEMA_FINGERPRINT_SHA256,
    "schema fingerprint");
  validateLegacyOverlap(tables);

  for (const [name, columns] of Object.entries(FILE_AUTHORITY_EXPORT_COLUMNS)) {
    const entry = schemaObjects.find((entry) => entry.type === "table" && entry.name === name);
    ensure(entry && typeof entry.sql === "string"
      && JSON.stringify(sqliteTableColumns(entry.sql, name).sort()) === JSON.stringify([...columns].sort()),
    `${name} schema columns`);
    for (const row of rows(tables, name)) {
      ensure(JSON.stringify(Object.keys(row).sort()) === JSON.stringify([...columns].sort()), `${name} row columns`);
    }
  }

  for (const [name, columns] of Object.entries(FILE_AUTHORITY_CONSUMER_COLUMNS)) {
    const entry = schemaObjects.find((entry) => entry.type === "table" && entry.name === name);
    ensure(entry && typeof entry.sql === "string", `${name} binding schema`);
    const physicalColumns = sqliteTableColumns(entry.sql, name);
    ensure(columns.every((column) => physicalColumns.filter((candidate) => candidate === column).length === 1),
      `${name} binding schema`);
    for (const row of rows(tables, name)) {
      ensure(columns.every((column) => Object.hasOwn(row, column)), `${name} binding columns`);
      ensure(columns.every((column) => row[column] === null), `${name} must remain legacy-authoritative`);
    }
  }
  for (const name of EMPTY_FILE_AUTHORITY_TABLES) ensure(rows(tables, name).length === 0,
    `${name} must remain empty in legacy mode`);

  const control = rows(tables, FILE_AUTHORITY_CONTROL_TABLE);
  ensure(control.length === 1 && control[0].singleton === 1 && control[0].mode === "legacy"
    && control[0].revision === 1 && control[0].updated_at === "2026-09-14T00:00:00.000Z"
    && control[0].activated_at === null,
    "control must select immutable legacy mode");

  const profiles = new Map(rows(tables, "storage_profiles").map((profile) => [String(profile.id), profile]));
  const runtime = rows(tables, "storage_profile_runtime");
  ensure(runtime.length === profiles.size, "runtime/profile cardinality");
  const runtimeIds = new Set<string>();
  for (const row of runtime) {
    const id = String(row.storage_profile_id);
    ensure(text(id, 256) && profiles.has(id) && !runtimeIds.has(id) && row.state === "read_only"
      && row.registered_at === profiles.get(id)?.created_at && row.activated_at === null && row.retired_at === null,
      "runtime must be a unique read-only profile companion");
    runtimeIds.add(id);
  }

  const expectedProjections = legacyConsumerProjections(tables);
  const projectionBranches: ExportRow[] = [];
  for (const [name, columns] of Object.entries(FILE_AUTHORITY_EXPORT_VIEW_COLUMNS)) {
    ensure(schemaObjects.some((entry) => entry.type === "view" && entry.name === name && typeof entry.sql === "string"),
      `${name} schema view`);
    for (const row of rows(tables, name)) {
      ensure(JSON.stringify(Object.keys(row).sort()) === JSON.stringify([...columns].sort()), `${name} row columns`);
      if (name.startsWith("file_consumer_") && name !== "file_consumer_projection") {
        ensure(row.file_id === null && row.resolution_state === "legacy_pending" && row.decision_id === null,
          `${name} legacy resolution`);
        projectionBranches.push(row);
      }
    }
    if (Object.hasOwn(expectedProjections, name)) {
      const expected = expectedProjections[name as keyof typeof expectedProjections];
      ensure(stableJson(rows(tables, name).map(stableJson).sort()) === stableJson(expected.map(stableJson).sort()),
        `${name} must match canonical legacy consumers`);
    }
  }
  ensure(stableJson(rows(tables, "file_consumer_projection").map(stableJson).sort())
    === stableJson(projectionBranches.map(stableJson).sort()), "combined consumer projection");
  for (const name of ["file_relational_retention_edges", "file_content_retention_edges", "file_direct_retention_edges", "file_retention_edges", "file_location_retention_edges", "file_location_availability"]) {
    ensure(rows(tables, name).length === 0, `${name} must be empty while legacy locators are authoritative`);
  }
}

export type FileAuthorityControlRow = ExportRow;
