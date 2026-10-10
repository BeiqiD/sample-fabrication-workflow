import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { recoveryCellBinding, recoveryTableSnapshotSql, validateSystemRecoveryCell, validateSystemRecoveryImage, type RecoveryTableSpec, type SystemRecoveryImageV1 } from "./system-recovery-image";

const spec: RecoveryTableSpec = { name: "exact_cells", columns: ["integer_value", "real_value", "text_value", "blob_value", "null_value"], withoutRowid: false, local: false };
const admission = { schemaSha256: "a".repeat(64), tables: [spec] };
const image = (): SystemRecoveryImageV1 => ({ version: 1, kind: "system-recovery-image", schemaSha256: admission.schemaSha256,
  sourceSnapshotClock: "2026-10-06T15:00:00.123Z", tables: { exact_cells: { columns: [...spec.columns], rows: [{ rowid: "9007199254740993",
    cells: [{ type: "integer", value: "-9223372036854775808" }, { type: "real", value: "1.2345678901234567" },
      { type: "text", value: "中文\u0000e\u0301; DROP TABLE exact_cells;" }, { type: "blob", value: "00FF80" }, { type: "null" }] }] } } });

describe("exact typed system recovery images", () => {
  it("round-trips int64 rowids/cells, full binary64 precision, text with NUL and uninterpreted SQL, blobs and NULL", () => {
    const source = new DatabaseSync(":memory:"), destination = new DatabaseSync(":memory:");
    try {
      for (const db of [source, destination]) db.exec("CREATE TABLE exact_cells(integer_value,real_value,text_value,blob_value,null_value)");
      const expected = image(), row = expected.tables.exact_cells.rows[0];
      const bindings = row.cells.map(recoveryCellBinding);
      source.prepare(`INSERT INTO exact_cells(rowid,${spec.columns.join(",")}) VALUES(CAST(? AS INTEGER),${bindings.map(binding => binding.expression).join(",")})`)
        .run(row.rowid, ...bindings.map(binding => binding.value));
      const raw = source.prepare(recoveryTableSnapshotSql(spec)).get() as { rowid: string; cells: string };
      expected.tables.exact_cells.rows = [{ rowid: raw.rowid, cells: JSON.parse(raw.cells) }];
      const admitted = validateSystemRecoveryImage(expected, admission).tables.exact_cells.rows[0];
      const recovered = admitted.cells.map(recoveryCellBinding);
      destination.prepare(`INSERT INTO exact_cells(rowid,${spec.columns.join(",")}) VALUES(CAST(? AS INTEGER),${recovered.map(binding => binding.expression).join(",")})`)
        .run(admitted.rowid, ...recovered.map(binding => binding.value));
      expect(destination.prepare(recoveryTableSnapshotSql(spec)).get()).toEqual(raw);
      expect(destination.prepare("SELECT real_value,typeof(integer_value) AS int_type,typeof(real_value) AS real_type,typeof(text_value) AS text_type,typeof(blob_value) AS blob_type FROM exact_cells").get())
        .toEqual({ real_value: 1.2345678901234567, int_type: "integer", real_type: "real", text_type: "text", blob_type: "blob" });
    } finally { source.close(); destination.close(); }
  });

  it.each(["-9223372036854775808", "-9007199254740993", "0", "9007199254740993", "9223372036854775807"])("admits canonical signed int64 %s", value => {
    expect(validateSystemRecoveryCell({ type: "integer", value })).toEqual({ type: "integer", value });
  });
  it.each(["9223372036854775808", "-9223372036854775809", "-0", "01", "+1", "1.0", "1e2"])("rejects unsafe integer spelling/range %s", value => {
    expect(() => validateSystemRecoveryCell({ type: "integer", value })).toThrow(/lossy SQLite cell/);
  });
  it.each([{ type: "real", value: "Infinity" }, { type: "real", value: "1e999" }, { type: "real", value: "1e-999" }, { type: "real", value: "NaN" }, { type: "blob", value: "ff" },
    { type: "blob", value: "0" }, { type: "text", value: "\ud800" }, { type: "null", value: "injected" }, { type: "integer", value: 9007199254740992 }])("rejects unsupported cells %#", cell => {
    expect(() => validateSystemRecoveryCell(cell)).toThrow(/rejected/);
  });
  it("rejects table, column, image-schema and duplicate rowid substitution before SQL preparation", () => {
    for (const alter of [
      (value: SystemRecoveryImageV1) => { value.schemaSha256 = "b".repeat(64); },
      (value: SystemRecoveryImageV1) => { value.tables.secret = { columns: [], rows: [] }; },
      (value: SystemRecoveryImageV1) => { value.tables.exact_cells.columns.reverse(); },
      (value: SystemRecoveryImageV1) => { value.tables.exact_cells.rows.push(structuredClone(value.tables.exact_cells.rows[0])); },
      (value: SystemRecoveryImageV1) => { (value.tables.exact_cells.rows[0] as unknown as Record<string, unknown>).sql = "DELETE FROM samples"; },
    ]) {
      const value = image(); alter(value); expect(() => validateSystemRecoveryImage(value, admission)).toThrow(/rejected/);
    }
  });
  it("requires null rowids for WITHOUT ROWID tables and excludes installation local tables", () => {
    const value = image();
    expect(() => validateSystemRecoveryImage(value, { ...admission, tables: [{ ...spec, withoutRowid: true }] })).toThrow(/rowid/);
    value.tables.exact_cells.rows[0].rowid = null;
    expect(validateSystemRecoveryImage(value, { ...admission, tables: [{ ...spec, withoutRowid: true }] })).toBe(value);
    expect(() => validateSystemRecoveryImage(value, { ...admission, tables: [{ ...spec, local: true }] })).toThrow(/excluded/);
  });
  it("rejects rows above the D1 admission budget and metadata above the enclosing capsule budget", () => {
    const value = image(); value.tables.exact_cells.rows[0].cells[2] = { type: "text", value: "x".repeat(64 * 1024) };
    expect(() => validateSystemRecoveryImage(value, admission)).toThrow(/D1 admission budget/);
    expect(() => validateSystemRecoveryImage(image(), { ...admission, maxMetadataBytes: 1 })).toThrow(/metadata budget/);
  });
});
