import { describe, expect, it } from "vitest";
import type { ExportSchemaObject } from "../../shared/contracts/export";
import { PORTABLE_RUNTIME_INTERNAL_SCHEMA_OBJECTS } from "../../shared/contracts/portable-runtime-recovery-catalog";
import { NODE_PLATFORM_OBJECTS } from "../../shared/contracts/node-installation-schema";
import { PORTABLE_RUNTIME_SCHEMA_STATEMENTS } from "./portable-runtime-trusted-schema";
import { RECOVERY_MIGRATION_LEDGER_SQL } from "./target-migrations";
import { inspectCurrentCloudflareSchema, stripReviewedCurrentCloudflarePlatformSchema } from "./current-cloudflare-schema";

// Code-catalog fixtures only: no native SQLite/workerd execution is claimed by
// this source-only suite. Actual D1 inventories are qualified by the owner.
const ledger: ExportSchemaObject = { type: "table", name: "d1_migrations", tableName: "d1_migrations", sql: RECOVERY_MIGRATION_LEDGER_SQL };
const autoindex: ExportSchemaObject = { type: "index", name: "sqlite_autoindex_d1_migrations_1", tableName: "d1_migrations", sql: null };
const sequence: ExportSchemaObject = { type: "table", name: "sqlite_sequence", tableName: "sqlite_sequence", sql: "CREATE TABLE sqlite_sequence(name,seq)" };
const kv: ExportSchemaObject = { type: "table", name: "_cf_KV", tableName: "_cf_KV", sql: "CREATE TABLE _cf_KV(key TEXT PRIMARY KEY,value BLOB) WITHOUT ROWID" };
const metadata: ExportSchemaObject = { type: "table", name: "_cf_METADATA", tableName: "_cf_METADATA", sql: "CREATE TABLE _cf_METADATA(key INTEGER PRIMARY KEY,value BLOB)" };
function application(): ExportSchemaObject[] { return structuredClone([...PORTABLE_RUNTIME_SCHEMA_STATEMENTS, ...PORTABLE_RUNTIME_INTERNAL_SCHEMA_OBJECTS]); }
function fixture(extras: readonly ExportSchemaObject[] = [ledger, autoindex, sequence, kv, metadata]): ExportSchemaObject[] {
  return [...application(), ...structuredClone(extras)];
}
function object(values: ExportSchemaObject[], name: string): ExportSchemaObject { return values.find(value => value.name === name)!; }

describe("exact current Cloudflare schema ownership", () => {
  it("strips only exact platform objects for an otherwise truly empty target without admitting an empty current application", async () => {
    const platform = structuredClone([ledger, autoindex, sequence, kv, metadata]);
    expect(stripReviewedCurrentCloudflarePlatformSchema(platform)).toEqual({ applicationObjects: [], ledgerPresent: true });
    expect(stripReviewedCurrentCloudflarePlatformSchema(structuredClone([kv, metadata]))).toEqual({ applicationObjects: [], ledgerPresent: false });
    await expect(inspectCurrentCloudflareSchema(platform)).rejects.toThrow(/Portable full export rejected/);
  });
  it("rejects a fake attached platform object synchronously before an empty-target decision", () => {
    const platform = structuredClone([ledger, autoindex, sequence, metadata]);
    platform.push({ type: "trigger", name: "fake_platform", tableName: "_cf_METADATA", sql: "unreviewed attached SQL" });
    expect(() => stripReviewedCurrentCloudflarePlatformSchema(platform)).toThrow("platform_not_reviewed");
  });
  it("strips only the complete reviewed platform inventory and preserves all actual application/internal observations", async () => {
    const values = fixture(), before = structuredClone(values), result = await inspectCurrentCloudflareSchema(values);
    expect(result.ledgerPresent).toBe(true);
    expect(result.applicationObjects).toHaveLength(PORTABLE_RUNTIME_SCHEMA_STATEMENTS.length + PORTABLE_RUNTIME_INTERNAL_SCHEMA_OBJECTS.length);
    const byName = new Map(result.applicationObjects.map(value => [value.name, value]));
    for (const value of application()) expect(byName.get(value.name)).toEqual(value);
    expect(values).toEqual(before); expect(result.applicationObjects.some(value => value.name === "sqlite_sequence")).toBe(false);
    expect(result.applicationObjects.filter(value => value.sql === null)).toEqual(PORTABLE_RUNTIME_INTERNAL_SCHEMA_OBJECTS.filter(value => value.sql === null));
  });
  it.each([{ name: "none", extras: [] }, { name: "KV", extras: [kv] }, { name: "metadata", extras: [metadata] },
    { name: "both", extras: [kv, metadata] }])("admits optional exact engine tables without inventing a migration ledger: $name", async ({ extras }) => {
    const result = await inspectCurrentCloudflareSchema(fixture(extras));
    expect(result.ledgerPresent).toBe(false); expect(result.applicationObjects).toHaveLength(application().length);
  });
  it("accepts presentation-only comments/whitespace while returning actual observed SQL rather than target SQL", async () => {
    const values = fixture();
    object(values, "d1_migrations").sql = RECOVERY_MIGRATION_LEDGER_SQL.replace("CREATE TABLE", "CREATE /* platform comment */\n TABLE") + ";\n";
    object(values, "_cf_METADATA").sql = metadata.sql!.replace("CREATE TABLE", "CREATE -- engine comment\n TABLE");
    const table = values.find(value => value.type === "table" && value.name === "samples")!;
    table.sql = table.sql!.replace("CREATE TABLE", "CREATE /* actual D1 presentation */ TABLE");
    const result = await inspectCurrentCloudflareSchema(values);
    expect(result.ledgerPresent).toBe(true); expect(object(result.applicationObjects, "samples").sql).toBe(table.sql);
  });
  it("refuses missing members or dangling sequence/index objects instead of hiding a partial ledger", async () => {
    for (const extras of [[ledger, sequence], [ledger, autoindex], [autoindex, sequence], [sequence], [autoindex]]) {
      await expect(inspectCurrentCloudflareSchema(fixture(extras))).rejects.toThrow("ledger_pair");
    }
  });
  it("refuses altered ledger semantics despite the reviewed table name", async () => {
    for (const sql of [RECOVERY_MIGRATION_LEDGER_SQL.replace(" AUTOINCREMENT", ""), RECOVERY_MIGRATION_LEDGER_SQL.replace(" UNIQUE", ""),
      RECOVERY_MIGRATION_LEDGER_SQL.replace("CURRENT_TIMESTAMP", "'unreviewed'"), RECOVERY_MIGRATION_LEDGER_SQL.replace("PRIMARY KEY", '"PRIMARY KEY"')]) {
      const values = fixture(); object(values, "d1_migrations").sql = sql;
      await expect(inspectCurrentCloudflareSchema(values)).rejects.toThrow("platform_not_reviewed");
    }
  });
  it("does not treat quoted constraint-looking text, extra columns or a changed sequence as platform presentation", async () => {
    const badMetadata = fixture(); object(badMetadata, "_cf_METADATA").sql = 'CREATE TABLE _cf_METADATA(key INTEGER "PRIMARY KEY",value BLOB)';
    await expect(inspectCurrentCloudflareSchema(badMetadata)).rejects.toThrow("platform_not_reviewed");
    const badKv = fixture(); object(badKv, "_cf_KV").sql = kv.sql!.replace("value BLOB", "value BLOB,extra TEXT");
    await expect(inspectCurrentCloudflareSchema(badKv)).rejects.toThrow("platform_not_reviewed");
    const badSequence = fixture(); object(badSequence, "sqlite_sequence").sql = "CREATE TABLE sqlite_sequence(name,seq,extra)";
    await expect(inspectCurrentCloudflareSchema(badSequence)).rejects.toThrow("platform_not_reviewed");
  });
  it("refuses every unknown platform-owned trigger, index and view before platform removal", async () => {
    for (const type of ["trigger", "index", "view"] as const) for (const tableName of ["d1_migrations", "_cf_KV", "_cf_METADATA", "sqlite_sequence"]) {
      const values = fixture(); values.push({ type, name: `unreviewed_${type}`, tableName, sql: "unreviewed platform SQL" });
      await expect(inspectCurrentCloudflareSchema(values)).rejects.toThrow("platform_not_reviewed");
    }
  });
  it("requires exact platform names, types, owning tables and null-only ledger autoindex SQL", async () => {
    const mutations: Array<(value: ExportSchemaObject) => void> = [
      value => { value.name = "sqlite_autoindex_d1_migrations_2"; },
      value => { value.type = "trigger"; }, value => { value.tableName = "samples"; },
      value => { value.sql = "CREATE INDEX sqlite_autoindex_d1_migrations_1 ON d1_migrations(name)"; },
    ];
    for (const mutate of mutations) {
      const values = fixture(); mutate(object(values, "sqlite_autoindex_d1_migrations_1"));
      await expect(inspectCurrentCloudflareSchema(values)).rejects.toThrow("platform_not_reviewed");
    }
    const wrongOwner = fixture(); object(wrongOwner, "_cf_METADATA").tableName = "samples";
    await expect(inspectCurrentCloudflareSchema(wrongOwner)).rejects.toThrow("platform_not_reviewed");
  });
  it("validates duplicate names and all closed fields before excluding even an otherwise exact platform table", async () => {
    const duplicate = fixture(); duplicate.push({ ...metadata });
    await expect(inspectCurrentCloudflareSchema(duplicate)).rejects.toThrow("object_value_or_duplicate");
    for (const alter of [
      (value: ExportSchemaObject) => { Object.assign(value, { extra: "hidden" }); },
      (value: ExportSchemaObject) => { Object.defineProperty(value, Symbol("hidden"), { value: true }); },
      (value: ExportSchemaObject) => { value.tableName = ""; },
      (value: ExportSchemaObject) => { value.name += "\0"; },
      (value: ExportSchemaObject) => { value.sql = ""; },
    ]) {
      const values = fixture(); alter(object(values, "_cf_METADATA"));
      await expect(inspectCurrentCloudflareSchema(values)).rejects.toThrow("current_cloudflare_schema_");
    }
    const accessor = fixture(); let called = false;
    Object.defineProperty(object(accessor, "_cf_METADATA"), "sql", { enumerable: true, get() { called = true; return metadata.sql; } });
    await expect(inspectCurrentCloudflareSchema(accessor)).rejects.toThrow("object_fields"); expect(called).toBe(false);
  });
  it("preserves unknown application and internal objects for current-pin rejection instead of prefix filtering", async () => {
    for (const extra of [
      { type: "table", name: "_cf_unreviewed", tableName: "_cf_unreviewed", sql: "CREATE TABLE _cf_unreviewed(id)" },
      { type: "table", name: "sqliteX_unreviewed", tableName: "sqliteX_unreviewed", sql: "CREATE TABLE sqliteX_unreviewed(id)" },
      { type: "index", name: "sqlite_autoindex_attacker_1", tableName: "samples", sql: null },
    ] as ExportSchemaObject[]) await expect(inspectCurrentCloudflareSchema([...fixture(), extra])).rejects.toThrow(/Portable full export rejected/);
    const missing = fixture().filter(value => value.name !== "samples");
    await expect(inspectCurrentCloudflareSchema(missing)).rejects.toThrow(/Portable full export rejected/);
  });
  it("does not admit Node platform ledger objects as Cloudflare-local omissions", async () => {
    await expect(inspectCurrentCloudflareSchema([...fixture(), ...structuredClone(NODE_PLATFORM_OBJECTS)])).rejects.toThrow(/Portable full export rejected/);
  });
  it("captures copied primitive object fields before the asynchronous application schema pin", async () => {
    const values = fixture(), expected = object(values, "samples").sql;
    const pending = inspectCurrentCloudflareSchema(values);
    object(values, "samples").sql = "CREATE TABLE samples(attacker)";
    object(values, "d1_migrations").sql = "CREATE TABLE d1_migrations(attacker)";
    values.splice(0);
    const result = await pending;
    expect(result.ledgerPresent).toBe(true); expect(object(result.applicationObjects, "samples").sql).toBe(expected);
  });
});
