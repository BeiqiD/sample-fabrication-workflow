import { RECOVERY_SCHEMA_SHA256, RECOVERY_TABLES } from "./system-recovery-catalog";

/** SQLite storage classes are part of recovery. In particular, signed int64
 * values are never routed through a JavaScript number. */
export type SystemRecoveryCell = { type: "null" }
  | { type: "integer" | "real" | "text" | "blob"; value: string };
export interface SystemRecoveryRow { rowid: string | null; cells: SystemRecoveryCell[] }
export interface SystemRecoveryTable { columns: string[]; rows: SystemRecoveryRow[] }
export interface RecoveryTableSpec {
  name: string; columns: readonly string[]; withoutRowid: boolean; local: boolean;
  primaryKeyColumns?: readonly string[];
}
export interface SystemRecoveryImageV1 {
  version: 1; kind: "system-recovery-image"; schemaSha256: string;
  sourceSnapshotClock: string; tables: Record<string, SystemRecoveryTable>;
}
export type SystemRecoveryImage = SystemRecoveryImageV1;
export const SYSTEM_RECOVERY_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const SYSTEM_RECOVERY_IMAGE_MAX_ROWS = 16_384;
export const SYSTEM_RECOVERY_ROW_MAX_BYTES = 64 * 1024;
const integer = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const real = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const minInteger = -9223372036854775808n, maxInteger = 9223372036854775807n;

function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`System recovery image rejected: ${reason}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Reflect.ownKeys(value).length === keys.length
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
export function isRecoveryInteger(value: unknown): value is string {
  if (typeof value !== "string" || !integer.test(value) || value.length > 20) return false;
  const number = BigInt(value);
  return number >= minInteger && number <= maxInteger;
}
function validText(value: string) {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
export function validateSystemRecoveryCell(value: unknown): SystemRecoveryCell {
  ensure(record(value) && typeof value.type === "string", "invalid SQLite cell");
  if (value.type === "null") ensure(exactKeys(value, ["type"]), "invalid NULL cell");
  else {
    ensure(exactKeys(value, ["type", "value"]) && typeof value.value === "string", "invalid typed SQLite cell");
    ensure(value.type === "integer" ? isRecoveryInteger(value.value)
      : value.type === "real" ? value.value.length <= 256 && real.test(value.value) && Number.isFinite(Number(value.value))
        && (Number(value.value) !== 0 || !/[1-9]/.test(value.value.split(/[eE]/)[0]))
        : value.type === "blob" ? /^(?:[0-9A-F]{2})*$/.test(value.value)
          : value.type === "text" && validText(value.value), "unsupported or lossy SQLite cell");
  }
  return value as unknown as SystemRecoveryCell;
}

/** Caller-supplied schema evidence never chooses the target SQL or catalog. */
export function validateSystemRecoveryImage(value: unknown, options: {
  schemaSha256?: string; tables?: readonly RecoveryTableSpec[]; maxMetadataBytes?: number;
} = {}): SystemRecoveryImageV1 {
  ensure(record(value) && exactKeys(value, ["version", "kind", "schemaSha256", "sourceSnapshotClock", "tables"])
    && value.version === 1 && value.kind === "system-recovery-image"
    && value.schemaSha256 === (options.schemaSha256 ?? RECOVERY_SCHEMA_SHA256), "unknown image or reviewed schema");
  ensure(typeof value.sourceSnapshotClock === "string"
    && /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)?$/.test(value.sourceSnapshotClock)
    && Number.isFinite(Date.parse(value.sourceSnapshotClock.endsWith("Z") || /[+-]\d\d:\d\d$/.test(value.sourceSnapshotClock)
      ? value.sourceSnapshotClock : `${value.sourceSnapshotClock.replace(" ", "T")}Z`)), "invalid source snapshot clock");
  ensure(record(value.tables), "invalid table catalog");
  const specs = (options.tables ?? RECOVERY_TABLES).filter(table => !table.local);
  ensure(exactKeys(value.tables, specs.map(table => table.name)), "unknown, excluded or missing table");
  let count = 0;
  for (const spec of specs) {
    const table = value.tables[spec.name];
    ensure(record(table) && exactKeys(table, ["columns", "rows"]) && Array.isArray(table.columns)
      && JSON.stringify(table.columns) === JSON.stringify(spec.columns) && Array.isArray(table.rows), `column catalog differs: ${spec.name}`);
    count += table.rows.length;
    ensure(count <= SYSTEM_RECOVERY_IMAGE_MAX_ROWS, "row budget exceeded");
    const rowids = new Set<string>();
    for (const row of table.rows) {
      ensure(record(row) && exactKeys(row, ["rowid", "cells"]) && Array.isArray(row.cells)
        && row.cells.length === spec.columns.length, `invalid row: ${spec.name}`);
      ensure(spec.withoutRowid ? row.rowid === null : isRecoveryInteger(row.rowid) && !rowids.has(row.rowid), `invalid or duplicate rowid: ${spec.name}`);
      if (typeof row.rowid === "string") rowids.add(row.rowid);
      for (const cell of row.cells) validateSystemRecoveryCell(cell);
      ensure(new TextEncoder().encode(JSON.stringify(row)).length <= SYSTEM_RECOVERY_ROW_MAX_BYTES, `row exceeds D1 admission budget: ${spec.name}`);
    }
  }
  ensure(new TextEncoder().encode(JSON.stringify(value)).length <= (options.maxMetadataBytes ?? SYSTEM_RECOVERY_IMAGE_MAX_BYTES), "metadata budget exceeded");
  return value as unknown as SystemRecoveryImageV1;
}

/** Each expression is code-owned and values remain prepared-statement binds. */
export function recoveryCellBinding(cell: SystemRecoveryCell): { expression: string; value: string | null | Uint8Array } {
  validateSystemRecoveryCell(cell);
  if (cell.type === "null") return { expression: "?", value: null };
  if (cell.type === "integer") return { expression: "CAST(? AS INTEGER)", value: cell.value };
  if (cell.type === "real") return { expression: "CAST(? AS REAL)", value: cell.value };
  if (cell.type === "text") return { expression: "?", value: cell.value };
  const bytes = new Uint8Array(cell.value.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(cell.value.slice(index * 2, index * 2 + 2), 16);
  return { expression: "?", value: bytes };
}

/** SQL for one exact typed row; the caller supplies a reviewed table spec. */
export function recoveryTableSnapshotSql(spec: RecoveryTableSpec): string {
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const cells = spec.columns.map(column => {
    const value = quote(column);
    return `CASE typeof(${value}) WHEN 'null' THEN json_object('type','null') WHEN 'integer' THEN json_object('type','integer','value',CAST(${value} AS TEXT)) WHEN 'real' THEN json_object('type','real','value',printf('%!.17g',${value})) WHEN 'text' THEN json_object('type','text','value',${value}) WHEN 'blob' THEN json_object('type','blob','value',hex(${value})) END`;
  });
  return `SELECT ${spec.withoutRowid ? "NULL" : "CAST(rowid AS TEXT)"} AS rowid, json_array(${cells.join(",")}) AS cells FROM ${quote(spec.name)}${spec.withoutRowid ? "" : " ORDER BY rowid"}`;
}
