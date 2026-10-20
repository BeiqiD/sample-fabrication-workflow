import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExportSchemaObject } from "./export";
import { canonicalFileAuthoritySchemaSql, canonicalFileAuthoritySchemaSqlJson,
  FILE_AUTHORITY_SCHEMA_FINGERPRINT_SHA256, fileAuthoritySchemaFingerprint } from "./export-file-authority";
import { FILE_SHADOW_SCHEMA_FINGERPRINT_ALGORITHM, FILE_SHADOW_SCHEMA_FINGERPRINT_SHA256,
  fileShadowSchemaFingerprint, fileShadowSchemaSlice } from "./export-file-shadow";
import { FILE_SHADOW_WITHDRAWAL_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-shadow-withdrawals";
import { FILE_SHADOW_ADJUDICATION_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-shadow-adjudications";
import { FILE_AUTHORITY_RUNTIME_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-runtime";
import { FILE_R2_ROLE_DEFAULTS_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-role-policy";
import { FILE_NATIVE_ADMISSION_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-native-admission";
import { FILE_NATIVE_RUNTIME_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-native-runtime";
import { FILE_MIGRATION_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-migrations";
import { RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256 } from "./export-research-packages";
import { SYSTEM_RECOVERY_SCHEMA_FINGERPRINT_SHA256 } from "./export-system-recovery";
import { contentExportSchemaObjects } from "./storage-configuration-schema";
import { sha256Hex } from "../domain/content-addressing";

const previousFingerprint = (objects: ExportSchemaObject[]) => sha256Hex(JSON.stringify([
  FILE_SHADOW_SCHEMA_FINGERPRINT_ALGORITHM,
  fileShadowSchemaSlice(objects).map((entry) => [entry.type, entry.name, entry.tableName, entry.sql]),
]));
const quoted: ExportSchemaObject[] = [
  { type: "view", name: "quoted\"view", tableName: "quoted\"view", sql: `CREATE VIEW "quoted" AS SELECT '--literal', "/*identifier*/", X'00ff', '😀', '],null,[';` },
  { type: "index", name: "sqlite_autoindex_example_1", tableName: "example", sql: null },
  { type: "table", name: "example", tableName: "example", sql: "CREATE TABLE example(id TEXT PRIMARY KEY)" },
  { type: "table", name: "d1_migrations", tableName: "d1_migrations", sql: "invalid excluded platform SQL" },
];

const checkpoints: [string, string][] = [
  ["0007_fp1_file_authority_transition.sql", FILE_AUTHORITY_SCHEMA_FINGERPRINT_SHA256],
  ["0008_fp1_shadow_runtime.sql", FILE_SHADOW_SCHEMA_FINGERPRINT_SHA256],
  ["0009_fp1_shadow_withdrawals.sql", FILE_SHADOW_WITHDRAWAL_SCHEMA_FINGERPRINT_SHA256],
  ["0010_fp1_shadow_adjudications.sql", FILE_SHADOW_ADJUDICATION_SCHEMA_FINGERPRINT_SHA256],
  ["0012_fp1_file_authority_runtime.sql", FILE_AUTHORITY_RUNTIME_SCHEMA_FINGERPRINT_SHA256],
  ["0013_fp1_r2_role_defaults.sql", FILE_R2_ROLE_DEFAULTS_SCHEMA_FINGERPRINT_SHA256],
  ["0017_fp2_native_storage_profiles.sql", FILE_NATIVE_ADMISSION_SCHEMA_FINGERPRINT_SHA256],
  ["0018_fp2_native_file_runtime.sql", FILE_NATIVE_RUNTIME_SCHEMA_FINGERPRINT_SHA256],
  ["0019_fp3_file_jobs.sql", FILE_MIGRATION_SCHEMA_FINGERPRINT_SHA256],
  ["0020_fp4_research_packages.sql", RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256],
  ["0022_fp5_recovery_evidence.sql", SYSTEM_RECOVERY_SCHEMA_FINGERPRINT_SHA256],
];
const historicalSchema = new Map<string, ExportSchemaObject[]>();
beforeAll(() => {
  const directory = fileURLToPath(new URL("../../migrations/", import.meta.url));
  const wanted = new Set(checkpoints.map(([name]) => name));
  const database = new DatabaseSync(":memory:");
  try {
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      database.exec(readFileSync(`${directory}/${name}`, "utf8"));
      if (wanted.has(name)) {
        const observed = database.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name").all() as unknown as ExportSchemaObject[];
        historicalSchema.set(name, contentExportSchemaObjects(observed));
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      }
    }
    expect(historicalSchema.size).toBe(checkpoints.length);
  } finally { database.close(); }
});

describe("exact SQL canonical string reuse", () => {
  it("keeps the previous fingerprint JSON encoding for quoted bytes, null SQL and reversed fresh objects", async () => {
    expect(await fileShadowSchemaFingerprint([])).toBe(await previousFingerprint([]));
    const originalOrder = quoted.map((entry) => entry.name), expected = await previousFingerprint(quoted);
    expect(await fileShadowSchemaFingerprint(quoted)).toBe(expected);
    expect(await fileShadowSchemaFingerprint([...quoted].reverse().map((entry) => ({ ...entry })))).toBe(expected);
    expect(quoted.map((entry) => entry.name)).toEqual(originalOrder);
    const raw = `SELECT 'a\\b', '😀', '--quoted', X'00ff'`;
    expect(canonicalFileAuthoritySchemaSqlJson(raw)).toBe(JSON.stringify(canonicalFileAuthoritySchemaSql(raw)));
  });

  it("does not expose cached arrays to mutations of tokens or public schema slices", async () => {
    const expected = await fileShadowSchemaFingerprint(quoted), raw = quoted[0].sql!;
    const json = canonicalFileAuthoritySchemaSqlJson(raw), tokens = canonicalFileAuthoritySchemaSql(raw);
    tokens.splice(0, tokens.length, "forged");
    const slice = fileShadowSchemaSlice(quoted);
    for (const entry of slice) entry.sql?.splice(0, entry.sql.length, "forged");
    expect(canonicalFileAuthoritySchemaSqlJson(raw)).toBe(json);
    expect(canonicalFileAuthoritySchemaSql(raw)).not.toEqual(tokens);
    expect(await fileShadowSchemaFingerprint(quoted)).toBe(expected);
  });

  it("rechecks changed SQL on the same objects and rejects malformed SQL after a valid warm cache", async () => {
    const objects = quoted.map((entry) => ({ ...entry })), expected = await fileShadowSchemaFingerprint(objects);
    objects[0].sql = objects[0].sql!.replace("--literal", "--changed");
    expect(await fileShadowSchemaFingerprint(objects)).not.toBe(expected);
    expect(await fileShadowSchemaFingerprint(objects)).toBe(await previousFingerprint(objects));
    objects[0].sql = "CREATE VIEW quoted AS SELECT 'unterminated";
    await expect(fileShadowSchemaFingerprint(objects)).rejects.toThrow("unterminated quote");
    await expect(fileShadowSchemaFingerprint(objects)).rejects.toThrow("unterminated quote");
    objects[0].sql = quoted[0].sql;
    expect(await fileShadowSchemaFingerprint(objects)).toBe(expected);
  });

  it.each(checkpoints)("retains the reviewed %s schema pin and original token encoding", async (name, pinned) => {
    const objects = historicalSchema.get(name);
    if (!objects) throw new Error("Missing actual historical schema fixture");
    if (name === "0007_fp1_file_authority_transition.sql") {
      expect(await fileAuthoritySchemaFingerprint(objects)).toBe(pinned);
    } else {
      expect(await fileShadowSchemaFingerprint(objects)).toBe(pinned);
      expect(await fileShadowSchemaFingerprint(objects)).toBe(await previousFingerprint(objects));
    }
  });
});
