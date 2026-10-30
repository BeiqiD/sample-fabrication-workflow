import { describe, expect, it } from "vitest";
import { RECOVERY_MIGRATIONS, RECOVERY_SCHEMA_SHA256, RECOVERY_SCHEMA_STATEMENTS, RECOVERY_SEED_TABLE_ROWS, RECOVERY_TABLES } from "./trusted-schema";
import { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_RECOVERY_MIGRATIONS, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256,
  PORTABLE_RUNTIME_RECOVERY_TABLES, PORTABLE_RUNTIME_SCHEMA_STATEMENTS, PORTABLE_RUNTIME_SEED_TABLE_ROWS } from "./portable-runtime-trusted-schema";
import type { RecoveryTableSpec, SystemRecoveryRow, SystemRecoveryTable } from "../../shared/contracts/system-recovery-image";
import { recoveryDestinationTable, selectReviewedRecoveryCatalog, validateRecoverySourceImage, type VersionedRecoveryRecords } from "./versioned-catalog";

// These fixtures cover the catalog/image helper only. Complete content/archive
// and source migration provenance admission are tested by their owners.
function fixture(version: 1 | 2): VersionedRecoveryRecords {
  const specs = version === 1 ? RECOVERY_TABLES : PORTABLE_RUNTIME_RECOVERY_TABLES;
  const seeds = version === 1 ? RECOVERY_SEED_TABLE_ROWS : PORTABLE_RUNTIME_SEED_TABLE_ROWS;
  return { schema: `system-backup-records/${version}`, image: {
    version, kind: "system-recovery-image", schemaSha256: version === 1 ? RECOVERY_SCHEMA_SHA256 : PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256,
    ...(version === 2 ? { checkpointId: PORTABLE_RUNTIME_CHECKPOINT_ID } : {}), sourceSnapshotClock: "2026-01-01T00:00:00.000Z",
    tables: Object.fromEntries(specs.filter(spec => !spec.local).map(spec => [spec.name, structuredClone(seeds[spec.name])])),
  } } as VersionedRecoveryRecords;
}
function row(spec: RecoveryTableSpec, values: Record<string, SystemRecoveryRow["cells"][number]>, rowid = "17"): SystemRecoveryRow {
  return { rowid: spec.withoutRowid ? null : rowid, cells: spec.columns.map(name => values[name] ?? { type: "null" }) };
}
function account(records: VersionedRecoveryRecords, enabled = "1"): SystemRecoveryTable {
  const spec = PORTABLE_RUNTIME_RECOVERY_TABLES.find(spec => spec.name === "local_accounts")!;
  const table = records.image.tables.local_accounts;
  table.rows = [row(spec, {
    principal_id: { type: "text", value: "local_11111111-1111-4111-8111-111111111111" },
    username: { type: "text", value: "operator" }, password_verifier: { type: "text", value: "opaque syntactic verifier" },
    credential_revision: { type: "integer", value: "9007199254740991" }, enabled: { type: "integer", value: enabled },
    created_at: { type: "integer", value: "1000" },
  }, "-9223372036854775807")];
  return table;
}
describe("closed code-owned recovery catalog dispatch", () => {
  it("preserves every frozen V1 SQL, table, seed and migration value in owned immutable copies", () => {
    const records = fixture(1), catalog = selectReviewedRecoveryCatalog(records);
    expect(catalog).toMatchObject({ imageVersion: 1, recordsSchema: "system-backup-records/1", checkpointId: null, schemaSha256: RECOVERY_SCHEMA_SHA256 });
    expect(catalog.schemaStatements).toEqual(RECOVERY_SCHEMA_STATEMENTS); expect(catalog.tables).toEqual(RECOVERY_TABLES);
    expect(catalog.seedTableRows).toEqual(RECOVERY_SEED_TABLE_ROWS); expect(catalog.migrations).toEqual(RECOVERY_MIGRATIONS);
    expect(catalog.schemaStatements).not.toBe(RECOVERY_SCHEMA_STATEMENTS); expect(catalog.seedTableRows).not.toBe(RECOVERY_SEED_TABLE_ROWS);
    expect(Object.isFrozen(catalog)).toBe(true); expect(Object.isFrozen(catalog.tables[0].columns)).toBe(true);
    const seeded = Object.values(catalog.seedTableRows).find(table => table.rows.length)!;
    expect(Object.isFrozen(seeded.rows[0].cells[0])).toBe(true);
    expect(Reflect.set(catalog, "schemaSha256", PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256)).toBe(false);
    expect(validateRecoverySourceImage(records)).toBe(records.image);
  });
  it("selects only the separate V25/image2 DDL, seeds, classifications and raw migration chain", () => {
    const records = fixture(2), catalog = selectReviewedRecoveryCatalog(records);
    expect(catalog).toMatchObject({ imageVersion: 2, recordsSchema: "system-backup-records/2", checkpointId: PORTABLE_RUNTIME_CHECKPOINT_ID,
      schemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256 });
    expect(catalog.schemaStatements).toEqual(PORTABLE_RUNTIME_SCHEMA_STATEMENTS); expect(catalog.tables).toEqual(PORTABLE_RUNTIME_RECOVERY_TABLES);
    expect(catalog.seedTableRows).toEqual(PORTABLE_RUNTIME_SEED_TABLE_ROWS); expect(catalog.migrations).toEqual(PORTABLE_RUNTIME_RECOVERY_MIGRATIONS);
    expect(validateRecoverySourceImage(records).version).toBe(2);
  });
  it("refuses mixed or unknown records, image, checkpoint, schema and kind selection tuples", () => {
    const alterations: Array<(records: Record<string, unknown>) => void> = [
      records => { records.schema = "system-backup-records/3"; },
      records => { (records.image as Record<string, unknown>).version = 1; },
      records => { (records.image as Record<string, unknown>).checkpointId = "portable-runtime/v26"; },
      records => { (records.image as Record<string, unknown>).schemaSha256 = RECOVERY_SCHEMA_SHA256; },
      records => { (records.image as Record<string, unknown>).kind = "archive-owned-schema"; },
    ];
    for (const alter of alterations) {
      const records = fixture(2); alter(records as unknown as Record<string, unknown>);
      expect(() => selectReviewedRecoveryCatalog(records)).toThrow("catalog_unsupported");
    }
    const historical = fixture(1); Object.assign(historical.image, { checkpointId: PORTABLE_RUNTIME_CHECKPOINT_ID });
    expect(() => selectReviewedRecoveryCatalog(historical)).toThrow("catalog_unsupported");
  });
  it("fully rejects excluded local tables, unknown tables, missing tables and extra image fields", () => {
    const local = fixture(2); local.image.tables.local_sessions = structuredClone(PORTABLE_RUNTIME_SEED_TABLE_ROWS.local_sessions);
    expect(() => validateRecoverySourceImage(local)).toThrow(/unknown, excluded or missing/);
    const unknown = fixture(1); unknown.image.tables.sqliteX_unreviewed = { columns: [], rows: [] };
    expect(() => validateRecoverySourceImage(unknown)).toThrow(/unknown, excluded or missing/);
    const missing = fixture(2); delete missing.image.tables.local_auth_events;
    expect(() => validateRecoverySourceImage(missing)).toThrow(/unknown, excluded or missing/);
    const extra = fixture(1); Object.assign(extra.image, { archiveSql: "CREATE TABLE attacker(id)" });
    expect(() => validateRecoverySourceImage(extra)).toThrow(/unknown image/);
  });
  it("keeps V1 signed int64, blob, NULL and text cells exact without mutating or aliasing source rows", () => {
    const records = fixture(1), spec = RECOVERY_TABLES.find(table => table.name === "samples")!, table = records.image.tables.samples;
    table.rows = [row(spec, { id: { type: "blob", value: "00FF" }, title: { type: "text", value: "NUL\0😀" }, pinned: { type: "integer", value: "9223372036854775807" } }, "-9223372036854775808")];
    validateRecoverySourceImage(records);
    const before = structuredClone(table), destination = recoveryDestinationTable(records, "samples");
    expect(destination).toEqual(before); expect(destination).not.toBe(table); expect(destination.rows[0].cells).not.toBe(table.rows[0].cells);
    destination.rows[0].cells[0] = { type: "null" }; expect(table).toEqual(before);
  });
  it.each(["0", "1"])("quarantines current account enabled=%s and preserves every other typed cell and rowid", enabled => {
    const records = fixture(2), table = account(records, enabled), before = structuredClone(table);
    validateRecoverySourceImage(records);
    const destination = recoveryDestinationTable(records, "local_accounts"), position = table.columns.indexOf("enabled");
    const expected = structuredClone(before); expected.rows[0].cells[position] = { type: "integer", value: "0" };
    expect(destination).toEqual(expected); expect(table).toEqual(before);
    expect(destination.rows[0].rowid).toBe("-9223372036854775807");
  });
  it("retains protected identity audit provenance exactly without appending destination authority", () => {
    const records = fixture(2), spec = PORTABLE_RUNTIME_RECOVERY_TABLES.find(table => table.name === "local_auth_events")!;
    records.image.tables.local_auth_events.rows = [row(spec, { sequence: { type: "integer", value: "17" }, principal_id: { type: "text", value: "historical-attribution" },
      kind: { type: "text", value: "bootstrap" }, happened_at: { type: "integer", value: "1000" } })];
    const before = structuredClone(records.image.tables.local_auth_events);
    expect(recoveryDestinationTable(records, "local_auth_events")).toEqual(before); expect(records.image.tables.local_auth_events).toEqual(before);
  });
  it("takes the four current identity authority/throttle tables only from reviewed empty local seeds", () => {
    const records = fixture(2);
    for (const name of ["local_identity_installation", "local_admin_grants", "local_sessions", "local_login_throttle"]) {
      // Even a caller that skips whole-image admission cannot import local rows.
      records.image.tables[name] = { columns: ["forged"], rows: [{ rowid: "1", cells: [{ type: "text", value: "authority" }] }] };
      expect(recoveryDestinationTable(records, name)).toEqual(PORTABLE_RUNTIME_SEED_TABLE_ROWS[name]);
      expect(recoveryDestinationTable(records, name).rows).toEqual([]);
    }
    expect(() => validateRecoverySourceImage(records)).toThrow(/unknown, excluded or missing/);
  });
  it("keeps other historical local seeds exact and returns independent copies", () => {
    const records = fixture(1), name = "system_recovery_runtime", result = recoveryDestinationTable(records, name);
    expect(result).toEqual(RECOVERY_SEED_TABLE_ROWS[name]); expect(result).not.toBe(RECOVERY_SEED_TABLE_ROWS[name]);
    result.rows.splice(0); expect(RECOVERY_SEED_TABLE_ROWS[name].rows.length).toBeGreaterThan(0);
  });
  it("rejects unreviewed names, duplicate rowids and lossy typed cells before destination rows exist", () => {
    const records = fixture(1), spec = RECOVERY_TABLES.find(table => table.name === "samples")!;
    expect(() => recoveryDestinationTable(records, "sqliteX_unreviewed")).toThrow("table_unreviewed");
    records.image.tables.samples.rows = [row(spec, {}), row(spec, {})];
    expect(() => recoveryDestinationTable(records, "samples")).toThrow(/duplicate rowid/);
    records.image.tables.samples.rows = [row(spec, { id: { type: "integer", value: "9223372036854775808" } })];
    expect(() => recoveryDestinationTable(records, "samples")).toThrow(/lossy SQLite cell/);
  });
  it("does not hide malformed protected account state by replacing it with disabled zero", () => {
    const records = fixture(2), table = account(records);
    table.rows[0].cells[table.columns.indexOf("enabled")] = { type: "text", value: "1" };
    expect(() => validateRecoverySourceImage(records)).toThrow(/protected account identity\/state/);
    expect(() => recoveryDestinationTable(records, "local_accounts")).toThrow("protected_account_state");
  });
});
