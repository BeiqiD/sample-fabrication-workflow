import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Log, LogLevel, Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import type { ExportSchemaObject } from "../shared/contracts/export";
import {
  FILE_AUTHORITY_SCHEMA_FINGERPRINT_SHA256,
  fileAuthoritySchemaFingerprint,
  fileAuthoritySchemaSlice,
} from "../shared/contracts/export-file-authority";

const migrationsDirectory = new URL("../migrations/", import.meta.url);
const migrationNames = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith(".sql") && name <= "0007_fp1_file_authority_transition.sql")
  .sort();
const schemaQuery = "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema ORDER BY type, name";

function observeHost(database: DatabaseSync) {
  return database.prepare(schemaQuery).all() as unknown as ExportSchemaObject[];
}

describe("V14 File authority schema fingerprint", () => {
  it("is identical for Node whole-file, Wrangler-split Node, and Miniflare D1 migrations", { timeout: 90_000 }, async () => {
    const whole = new DatabaseSync(":memory:");
    const split = new DatabaseSync(":memory:");
    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("schema fingerprint parity") } }',
      compatibilityDate: "2026-07-20",
      d1Databases: ["DB"],
      log: new Log(LogLevel.ERROR),
    });
    try {
      const d1 = await miniflare.getD1Database("DB");
      for (const name of migrationNames) {
        const sql = readFileSync(new URL(name, migrationsDirectory), "utf8");
        whole.exec(sql);
        const statements = splitSql(sql);
        for (const statement of statements) split.exec(statement);
        await d1.batch(statements.map((statement) => d1.prepare(statement)));
      }

      const d1Objects = (await d1.prepare(schemaQuery).all()).results as unknown as ExportSchemaObject[];
      const wholeObjects = observeHost(whole);
      const splitObjects = observeHost(split);
      const wholeSlice = fileAuthoritySchemaSlice(wholeObjects);
      const splitSlice = fileAuthoritySchemaSlice(splitObjects);
      const d1Slice = fileAuthoritySchemaSlice(d1Objects);

      expect(splitSlice).toEqual(wholeSlice);
      expect(d1Slice).toEqual(wholeSlice);
      expect(wholeSlice).toHaveLength(412);

      const [wholeDigest, splitDigest, d1Digest] = await Promise.all([
        fileAuthoritySchemaFingerprint(wholeObjects),
        fileAuthoritySchemaFingerprint(splitObjects),
        fileAuthoritySchemaFingerprint(d1Objects),
      ]);
      expect({ wholeDigest, splitDigest, d1Digest }).toEqual({
        wholeDigest: FILE_AUTHORITY_SCHEMA_FINGERPRINT_SHA256,
        splitDigest: FILE_AUTHORITY_SCHEMA_FINGERPRINT_SHA256,
        d1Digest: FILE_AUTHORITY_SCHEMA_FINGERPRINT_SHA256,
      });
    } finally {
      whole.close();
      split.close();
      await miniflare.dispose();
    }
  });
});
