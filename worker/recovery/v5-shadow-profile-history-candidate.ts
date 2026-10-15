// Finite pre-trigger fresh-target history only. Uploaded rows never select SQL.
import type { ExportRow } from "../../shared/contracts/export";
import type { SystemRecoveryCell, SystemRecoveryRow, SystemRecoveryTable } from "../../shared/contracts/system-recovery-image";
import { recoveryCellBinding, SYSTEM_RECOVERY_IMAGE_MAX_ROWS } from "../../shared/contracts/system-recovery-image";
import { SYSTEM_BACKUP_MAX_RECORDS_BYTES } from "../../shared/contracts/system-backup";
import { FILE_SHADOW_DEPENDENCY_SPECS } from "../../shared/contracts/file-shadow-schema";
import { FILE_SHADOW_HEAD_INTEGRITY_SQL } from "../../shared/contracts/export-file-shadow";
import { stableJson } from "../../shared/domain/content-addressing";
import { V5_RECOVERY_CATALOG_CANDIDATE as catalog } from "./v5-catalog-candidate";

const keys = ["consumer_kind", "consumer_id", "consumer_sub_id", "file_slot"] as const;
const encoder = new TextEncoder(), MAX_HEADS = 16, MAX_DESTINATIONS = 8;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error("v5_shadow_profile_history_" + reason);
}
const integer = (value: number): SystemRecoveryCell => ({ type: "integer", value: String(value) });
const text = (value: string): SystemRecoveryCell => ({ type: "text", value });
function columns(table: string) {
  const spec = catalog.tables.find(spec => spec.name === table); ensure(spec, "catalog_table"); return spec.columns;
}
function cell(row: SystemRecoveryRow, table: string, column: string): SystemRecoveryCell {
  const index = columns(table).indexOf(column); ensure(index >= 0, "catalog_column"); return row.cells[index];
}
function string(row: SystemRecoveryRow, table: string, column: string): string {
  const value = cell(row, table, column); ensure(value.type === "text", "text_cell:" + column); return value.value;
}
function number(row: SystemRecoveryRow, table: string, column: string): number {
  const value = cell(row, table, column); ensure(value.type === "integer" && /^(0|[1-9][0-9]*)$/.test(value.value)
    && Number.isSafeInteger(Number(value.value)), "integer_cell:" + column); return Number(value.value);
}
function replace(row: SystemRecoveryRow, table: string, values: Record<string, SystemRecoveryCell>): SystemRecoveryRow {
  return { rowid: row.rowid, cells: columns(table).map((name, index) => structuredClone(values[name] ?? row.cells[index])) };
}
function tuple(row: SystemRecoveryRow): Record<typeof keys[number], string> {
  return Object.fromEntries(keys.map(key => [key, string(row, "file_shadow_heads", key)])) as Record<typeof keys[number], string>;
}
function typed(table: string, row: ExportRow): SystemRecoveryRow {
  return { rowid: null, cells: columns(table).map(name => {
    const value = row[name]; ensure(value !== undefined && (value === null || typeof value === "string"
      || typeof value === "number" && Number.isSafeInteger(value)), "metadata_scalar");
    return value === null ? { type: "null" } : typeof value === "number" ? integer(value) : text(value);
  }) };
}

/** Change only the one code-owned integer token. Re-serializing SQLite JSON
 * would change unrelated number/string representation or property order. */
export function nextV5ShadowProfileSourceCandidate(source: string, before: number, after: number): string {
  ensure(encoder.encode(source).byteLength <= 8192 && Number.isSafeInteger(before) && before >= 0
    && after === before + 1 && Number.isSafeInteger(after), "source_or_revision_budget");
  let offset = 0, tokens = 0;
  const selections: Array<{ start: number; end: number }> = [];
  function whitespace() { while (/\s/.test(source[offset] ?? "") && offset < source.length) offset++; }
  function quoted(): string {
    const start = offset; ensure(source[offset++] === '"', "json_string");
    let escaped = false;
    while (offset < source.length) {
      const character = source[offset++];
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (character === '"') {
        const value: unknown = JSON.parse(source.slice(start, offset)); ensure(typeof value === "string", "json_key"); return value;
      }
    }
    throw new Error("v5_shadow_profile_history_json_unterminated");
  }
  function value(path: readonly (string | number)[], depth: number): void {
    ensure(++tokens <= 4096 && depth <= 48, "json_budget"); whitespace(); const start = offset, first = source[offset];
    if (first === "{") {
      offset++; whitespace(); const seen = new Set<string>();
      if (source[offset] !== "}") for (;;) {
        const name = quoted(); ensure(!seen.has(name), "duplicate_json_key"); seen.add(name); whitespace();
        ensure(source[offset++] === ":", "json_colon"); value([...path, name], depth + 1); whitespace();
        if (source[offset] !== ",") break; offset++; whitespace();
      }
      ensure(source[offset++] === "}", "json_object");
    } else if (first === "[") {
      offset++; whitespace(); let index = 0;
      if (source[offset] !== "]") for (;;) {
        value([...path, index++], depth + 1); whitespace(); if (source[offset] !== ",") break; offset++;
      }
      ensure(source[offset++] === "]", "json_array");
    } else if (first === '"') quoted();
    else {
      const token = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(offset));
      ensure(token, "json_scalar"); offset += token[0].length;
    }
    if (path.length === 2 && path[0] === "_dependencies" && path[1] === "profileRevision") {
      ensure(selections.length === 0 && source.slice(start, offset) === String(before), "exact_current_profile_revision");
      selections.push({ start, end: offset });
    }
  }
  value([], 0); whitespace(); const selected = selections[0];
  ensure(offset === source.length && selections.length === 1 && selected, "exact_json_inventory");
  return source.slice(0, selected.start) + String(after) + source.slice(selected.end);
}

export interface V5ShadowImageChangeCandidate {
  table: "file_shadow_control" | "file_shadow_heads";
  keys: Readonly<Record<string, string>>;
  column: "epoch" | "generation" | "occurrence_id" | "source_json" | "observed_epoch";
  cell: SystemRecoveryCell;
}
export interface V5ShadowProfileEventCandidate {
  metadataTable: "storage_profiles" | "storage_profile_runtime";
  destinationProfileId: string;
  metadata: SystemRecoveryRow;
  dependency: SystemRecoveryRow;
  beforeEpoch: number; afterEpoch: number; beforeProfileRevision: number; afterProfileRevision: number;
  beforeHeads: readonly SystemRecoveryRow[]; afterHeads: readonly SystemRecoveryRow[];
  occurrences: readonly SystemRecoveryRow[]; closures: readonly SystemRecoveryRow[];
}
export interface V5ShadowProfileHistoryCandidate {
  events: readonly V5ShadowProfileEventCandidate[];
  typedAppends: Readonly<Record<string, readonly SystemRecoveryRow[]>>;
  changes: readonly V5ShadowImageChangeCandidate[];
}

/** Original admitted image plus code-owned destination metadata only. Every
 * ID, tuple, closure and final typed change is chosen before the first write. */
export function planV5ShadowProfileHistoryCandidate(tables: Record<string, SystemRecoveryTable>,
  destinations: readonly { profile: ExportRow; runtime: ExportRow }[], clock: string,
  publicationBudget: { extraRows: number; extraBytes: number }): V5ShadowProfileHistoryCandidate | undefined {
  let heads = tables.file_shadow_heads.rows.filter(row => number(row, "file_shadow_heads", "present") === 1)
    .map(row => structuredClone(row));
  if (!heads.length) return undefined;
  ensure(heads.length <= MAX_HEADS && destinations.length <= MAX_DESTINATIONS
    && Number.isFinite(Date.parse(clock)), "inventory_budget");
  ensure(heads.reduce((sum, row) => sum + encoder.encode(string(row, "file_shadow_heads", "source_json")).byteLength, 0) <= 8192,
    "source_tuple_budget");
  ensure(tables.file_shadow_control.rows.length === 1, "control_inventory");
  const originalEpoch = number(tables.file_shadow_control.rows[0], "file_shadow_control", "epoch");
  let epoch = originalEpoch, revision = tables.file_shadow_dependency_versions.rows.filter(row =>
    ["storage_profiles", "storage_profile_runtime"].includes(string(row, "file_shadow_dependency_versions", "dependency_kind"))).length;
  const originals = new Map(tables.file_shadow_occurrences.rows.map(row => [string(row, "file_shadow_occurrences", "id"), row]));
  const ids = new Set(originals.keys()), typedAppends: Record<string, SystemRecoveryRow[]> = {}, events: V5ShadowProfileEventCandidate[] = [];
  const append = (table: string, row: SystemRecoveryRow) => (typedAppends[table] ??= []).push(row);
  for (const destination of destinations) for (const metadataTable of ["storage_profiles", "storage_profile_runtime"] as const) {
    const row = metadataTable === "storage_profiles" ? destination.profile : destination.runtime;
    const spec = FILE_SHADOW_DEPENDENCY_SPECS[metadataTable], dependencyKey = JSON.stringify(spec.keyColumns.map(column => row[column]));
    ensure(!tables.file_shadow_dependency_versions.rows.some(version =>
      string(version, "file_shadow_dependency_versions", "dependency_kind") === metadataTable
      && string(version, "file_shadow_dependency_versions", "dependency_key") === dependencyKey), "dependency_identity_collision");
    const dependency = typed("file_shadow_dependency_versions", { dependency_kind: metadataTable, dependency_key: dependencyKey,
      revision: 1, present: 1, snapshot_json: JSON.stringify(Object.fromEntries(spec.snapshotColumns.map(column => [column, row[column]]))) });
    ensure(Number.isSafeInteger(epoch + 1) && Number.isSafeInteger(revision + 1), "epoch_or_revision_overflow");
    const beforeHeads = heads, afterHeads: SystemRecoveryRow[] = [], occurrences: SystemRecoveryRow[] = [], closures: SystemRecoveryRow[] = [];
    for (const head of heads) {
      const previousId = string(head, "file_shadow_heads", "occurrence_id"), previous = originals.get(previousId);
      ensure(previous && number(head, "file_shadow_heads", "generation") === number(previous, "file_shadow_occurrences", "generation")
        && keys.every(key => string(head, "file_shadow_heads", key) === string(previous, "file_shadow_occurrences", key))
        && stableJson(cell(head, "file_shadow_heads", "source_rowid")) === stableJson(cell(previous, "file_shadow_occurrences", "source_rowid"))
        && string(head, "file_shadow_heads", "source_json") === string(previous, "file_shadow_occurrences", "source_json")
        && number(previous, "file_shadow_occurrences", "present") === 1
        && !tables.file_shadow_closures.rows.some(row => string(row, "file_shadow_closures", "occurrence_id") === previousId), "exact_open_occurrence");
      const generation = number(head, "file_shadow_heads", "generation") + 1; ensure(Number.isSafeInteger(generation), "generation_overflow");
      const id = "shadow:" + crypto.randomUUID().replaceAll("-", ""); ensure(!ids.has(id), "fresh_occurrence_collision"); ids.add(id);
      const source = nextV5ShadowProfileSourceCandidate(string(head, "file_shadow_heads", "source_json"), revision, revision + 1);
      const occurrence = replace(previous, "file_shadow_occurrences", { id: text(id), generation: integer(generation),
        source_json: text(source), observed_epoch: integer(epoch + 1), observed_at: text(clock) });
      const closure = typed("file_shadow_closures", { occurrence_id: previousId, successor_occurrence_id: id,
        closed_epoch: epoch + 1, closed_at: clock });
      const next = replace(head, "file_shadow_heads", { generation: integer(generation), occurrence_id: text(id),
        source_json: text(source), observed_epoch: integer(epoch + 1) });
      occurrences.push(occurrence); closures.push(closure); afterHeads.push(next); originals.set(id, occurrence);
      append("file_shadow_occurrences", occurrence); append("file_shadow_closures", closure);
    }
    ensure(typeof destination.profile.id === "string" && destination.runtime.storage_profile_id === destination.profile.id,
      "metadata_identity");
    const event = { metadataTable, destinationProfileId: destination.profile.id, metadata: typed(metadataTable, row), dependency,
      beforeEpoch: epoch, afterEpoch: epoch + 1,
      beforeProfileRevision: revision, afterProfileRevision: revision + 1, beforeHeads, afterHeads, occurrences, closures };
    ensure(encoder.encode(stableJson(event)).byteLength <= 48 * 1024, "atomic_event_wire_budget");
    events.push(event); append("file_shadow_dependency_versions", dependency); heads = afterHeads; epoch++; revision++;
  }
  const changes: V5ShadowImageChangeCandidate[] = [];
  if (events.length) {
    changes.push({ table: "file_shadow_control", keys: { singleton: "1" }, column: "epoch", cell: integer(epoch) });
    for (const head of heads) for (const column of ["generation", "occurrence_id", "source_json", "observed_epoch"] as const)
      changes.push({ table: "file_shadow_heads", keys: tuple(head), column, cell: cell(head, "file_shadow_heads", column) });
  }
  const originalRows = Object.values(tables).reduce((sum, table) => sum + table.rows.length, 0);
  const appendedRows = Object.values(typedAppends).reduce((sum, rows) => sum + rows.length, 0) + destinations.length * 2;
  ensure(Number.isSafeInteger(publicationBudget.extraRows) && publicationBudget.extraRows >= 0
    && Number.isSafeInteger(publicationBudget.extraBytes) && publicationBudget.extraBytes >= 0
    && originalRows + appendedRows + publicationBudget.extraRows <= SYSTEM_RECOVERY_IMAGE_MAX_ROWS, "final_image_row_budget");
  // A conservative frozen upper bound includes every event tuple, closure,
  // head change and metadata scalar before any target or provider write.
  ensure(encoder.encode(stableJson(tables)).byteLength + encoder.encode(stableJson({ events, changes })).byteLength
    + publicationBudget.extraBytes + 64 * 1024 <= SYSTEM_BACKUP_MAX_RECORDS_BYTES, "final_image_metadata_budget");
  return { events, typedAppends, changes };
}

function insertRows(db: D1Database, table: string, rows: readonly SystemRecoveryRow[]) {
  const names = columns(table), scalar = (index: number) => {
    const type = `json_extract(value,'$.cells[${index}].type')`, value = `json_extract(value,'$.cells[${index}].value')`;
    return `CASE ${type} WHEN 'integer' THEN CAST(${value} AS INTEGER) WHEN 'real' THEN CAST(${value} AS REAL) WHEN 'blob' THEN unhex(${value}) WHEN 'text' THEN ${value} ELSE NULL END`;
  };
  return db.prepare(`INSERT INTO ${quote(table)} (${names.map(quote).join(",")}) SELECT ${names.map((_, index) => scalar(index)).join(",")} FROM json_each(?)`)
    .bind(stableJson(rows));
}
function headGuard(db: D1Database, row: SystemRecoveryRow) {
  const values = row.cells.map(recoveryCellBinding);
  return db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_shadow_heads WHERE ${columns("file_shadow_heads")
    .map((name, index) => `${quote(name)} IS ${values[index].expression}`).join(" AND ")}) THEN 1 ELSE json('V5 frozen shadow head changed') END`)
    .bind(...values.map(value => value.value));
}
/** One event is one original claim-guarded D1 transaction. Trusted views prove
 * the frozen source at both ends; no target observation becomes an exemption. */
export function v5ShadowProfileEventStatementsCandidate(db: D1Database, event: V5ShadowProfileEventCandidate): D1PreparedStatement[] {
  const count = "(SELECT count(*) FROM file_shadow_dependency_versions WHERE dependency_kind IN('storage_profiles','storage_profile_runtime'))";
  const guard = (epoch: number, revision: number) => db.prepare(`SELECT CASE WHEN
    (SELECT epoch FROM file_shadow_control WHERE singleton=1)=? AND ${count}=? THEN 1 ELSE json('V5 frozen shadow event changed') END`).bind(epoch, revision);
  const headIntegrity = () => db.prepare(`SELECT CASE WHEN invalid_count=0 THEN 1 ELSE json('V5 current shadow source differs') END FROM (${FILE_SHADOW_HEAD_INTEGRITY_SQL})`);
  return [guard(event.beforeEpoch, event.beforeProfileRevision), ...event.beforeHeads.map(row => headGuard(db, row)), headIntegrity(),
    insertRows(db, event.metadataTable, [event.metadata]), insertRows(db, "file_shadow_dependency_versions", [event.dependency]),
    db.prepare("UPDATE file_shadow_control SET epoch=? WHERE singleton=1 AND epoch=?").bind(event.afterEpoch, event.beforeEpoch),
    insertRows(db, "file_shadow_occurrences", event.occurrences), insertRows(db, "file_shadow_closures", event.closures),
    ...event.afterHeads.map(row => {
      const mutable = ["generation", "occurrence_id", "source_json", "observed_epoch"];
      const values = [...mutable, ...keys].map(name => recoveryCellBinding(cell(row, "file_shadow_heads", name)));
      return db.prepare(`UPDATE file_shadow_heads SET ${mutable.map((name, index) => `${quote(name)}=${values[index].expression}`).join(",")}
        WHERE ${keys.map((name, index) => `${quote(name)} IS ${values[index + mutable.length].expression}`).join(" AND ")}`)
        .bind(...values.map(value => value.value));
    }), guard(event.afterEpoch, event.afterProfileRevision), ...event.afterHeads.map(row => headGuard(db, row)), headIntegrity()];
}
