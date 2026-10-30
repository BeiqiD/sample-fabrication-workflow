import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { describe, expect, it } from "vitest";
import { canonicalNativeS3Namespace } from "../../shared/contracts/storage-profile-admission";
import type { ExportSchemaObject } from "../../shared/contracts/export";
import { FILE_NATIVE_ADMISSION_SCHEMA_FINGERPRINT_SHA256 } from "../../shared/contracts/export-file-native-admission";
import { fileShadowSchemaFingerprint } from "../../shared/contracts/export-file-shadow";
import { contentExportSchemaObjects } from "../../shared/contracts/storage-configuration-schema";

const migrationDir = new URL("../../migrations/", import.meta.url);
const migrationName = "0017_fp2_native_storage_profiles.sql";
const migration = readFileSync(new URL(migrationName, migrationDir), "utf8");
const previous = readdirSync(migrationDir).filter(name => name.endsWith(".sql") && name < migrationName).sort();
const time = "2026-10-02T12:00:00.000Z";
const namespace = canonicalNativeS3Namespace({ kind: "aws-s3", partition: "aws", accountId: "111122223333", bucketName: "native-fixture", root: "research" });
const namespaceHash = createHash("sha256").update(namespace).digest("hex"), nativeId = `storage-profile:aws-s3:${namespaceHash}`;
const profileInsert = "INSERT INTO storage_profiles VALUES(?,'s3',?,'system',NULL,1,'historical',?)";
const seed = [
  `INSERT INTO storage_profiles(rowid,id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at)
    VALUES(-7,'old-r2','r2','r2:fixture:bucket','bootstrap',NULL,1,'historical','${time}')`,
  `INSERT INTO storage_profiles(rowid,id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at)
    VALUES(42,'old-managed','switchdrive','switchdrive:fixture:root','environment','environment:SWITCHDRIVE',1,'historical','${time}')`,
  `INSERT INTO files VALUES('old-file','research_source','system',1,'${"a".repeat(64)}',NULL,'unresolved',NULL,'${time}')`,
  `INSERT INTO file_locations VALUES('old-location','old-file','old-r2','old-object','unresolved','${time}')`,
  `INSERT INTO legacy_file_mappings VALUES('r2','r2','old-object','old-file','old-location','classified','{}','${time}')`,
];
function host() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of previous) db.exec(readFileSync(new URL(name, migrationDir), "utf8"));
  for (const sql of seed) db.exec(sql);
  return db;
}
function hostSnapshot(db: DatabaseSync) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [String(name), db.prepare(`SELECT * FROM "${name}"`).all()]));
}
function admission(db: DatabaseSync) {
  db.prepare(`INSERT INTO storage_profile_admissions VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    "11111111-1111-4111-8111-111111111111", nativeId, "candidate-profile", 2, 3,
    "22222222-2222-4222-8222-222222222222", "b".repeat(64), namespaceHash, "admin@example.test", time,
  );
}

describe("native S3 profile registration schema", () => {
  it("preserves populated profile identities, dependent data, attached guards and rowid claims in a transaction", () => {
    const db = host();
    try {
      const before = hostSnapshot(db);
      const schema = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN('view','trigger','index') AND sql IS NOT NULL ORDER BY type,name").all();
      db.exec(`BEGIN IMMEDIATE;${migration}COMMIT;`);
      const { storage_profile_admissions, ...after } = hostSnapshot(db);
      expect(storage_profile_admissions).toEqual([]); expect(after).toEqual(before);
      expect(db.prepare("SELECT rowid,id FROM storage_profiles ORDER BY rowid").all()).toEqual([{ rowid: -7, id: "old-r2" }, { rowid: 42, id: "old-managed" }]);
      const afterSchema = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN('view','trigger','index') AND sql IS NOT NULL ORDER BY type,name").all();
      for (const entry of schema) expect(afterSchema).toContainEqual(entry);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  });

  it("permits only a canonical read-only identity and immutable non-secret admission evidence", () => {
    const db = host();
    try {
      db.exec(`BEGIN IMMEDIATE;${migration}COMMIT;`);
      db.prepare(profileInsert).run(nativeId, namespace, time);
      expect(db.prepare("SELECT state,activated_at,retired_at FROM storage_profile_runtime WHERE storage_profile_id=?").get(nativeId))
        .toEqual({ state: "read_only", activated_at: null, retired_at: null });
      expect(() => db.prepare("INSERT INTO file_locations VALUES('forbidden','old-file',?,'new-object','unresolved',?)").run(nativeId, time))
        .toThrow("later storage generation");
      expect(() => db.prepare("UPDATE storage_profile_runtime SET state='read_write',activated_at=? WHERE storage_profile_id=?").run(time, nativeId))
        .toThrow();
      expect(() => db.prepare("UPDATE storage_profile_runtime SET state='retired',retired_at=? WHERE storage_profile_id=?").run(time, nativeId))
        .toThrow();
      admission(db);
      expect(db.prepare("SELECT * FROM storage_profile_admissions").all()).toHaveLength(1);
      expect(() => admission(db)).toThrow("immutable");
      expect(() => db.exec("UPDATE storage_profile_admissions SET envelope_revision=4")).toThrow("immutable");
      expect(() => db.exec("DELETE FROM storage_profile_admissions")).toThrow("cannot be deleted");
      expect(() => db.prepare(profileInsert).run(`storage-profile:aws-s3:${"c".repeat(64)}`, namespace.replace('"partition":"aws"', '"partition":"aws-cn"'), time))
        .toThrow("Invalid native AWS namespace");
      expect(() => db.prepare(profileInsert).run(`storage-profile:aws-s3:${"c".repeat(64)}`, namespace.replace('"root":"research"', '"root":"../research"'), time))
        .toThrow("Invalid native AWS namespace");
      for (const bucketName of ["123", "123.456"]) {
        const identity = canonicalNativeS3Namespace({ ...JSON.parse(namespace), bucketName });
        const id = `storage-profile:aws-s3:${createHash("sha256").update(identity).digest("hex")}`;
        db.prepare(profileInsert).run(id, identity, time);
      }
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  });

  it("rejects a real FK violation before resetting deferred counters and rolls back the whole native D1 rebuild", async () => {
    const native = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}",
      compatibilityDate: "2026-07-20", d1Databases: ["DB"], log: new Log(LogLevel.ERROR) });
    try {
      const db = await native.getD1Database("DB");
      for (const name of previous) await db.batch(splitSql(readFileSync(new URL(name, migrationDir), "utf8")).map(sql => db.prepare(sql)));
      for (const sql of seed) await db.prepare(sql).run();
      const snapshot = async () => {
        const tables = (await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>()).results;
        return Object.fromEntries(await Promise.all(tables.map(async ({ name }) => [name, (await db.prepare(`SELECT * FROM "${name}"`).all()).results])));
      };
      const before = await snapshot();
      const schemaBefore = (await db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all()).results;
      const broken = migration.replace("state,created_at FROM storage_profiles;", "state,created_at FROM storage_profiles WHERE id<>'old-r2';");
      expect(broken).not.toBe(migration);
      await expect(db.batch(splitSql(broken).map(sql => db.prepare(sql)))).rejects.toThrow(/malformed JSON|foreign key/i);
      expect(await snapshot()).toEqual(before);
      expect((await db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all()).results).toEqual(schemaBefore);
      await db.batch(splitSql(migration).map(sql => db.prepare(sql)));
      const objects = (await db.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name").all<ExportSchemaObject>()).results;
      expect(await fileShadowSchemaFingerprint(contentExportSchemaObjects(objects))).toBe(FILE_NATIVE_ADMISSION_SCHEMA_FINGERPRINT_SHA256);
      const { storage_profile_admissions, ...after } = await snapshot();
      expect(storage_profile_admissions).toEqual([]); expect(after).toEqual(before);
      expect((await db.prepare("SELECT rowid,id FROM storage_profiles ORDER BY rowid").all()).results)
        .toEqual([{ rowid: -7, id: "old-r2" }, { rowid: 42, id: "old-managed" }]);
      await db.prepare(profileInsert).bind(nativeId, namespace, time).run();
      await expect(db.prepare("INSERT INTO file_locations VALUES('forbidden','old-file',?,'new-object','unresolved',?)").bind(nativeId, time).run())
        .rejects.toThrow("later storage generation");
      await expect(db.prepare("UPDATE storage_profile_runtime SET state='read_write',activated_at=? WHERE storage_profile_id=?").bind(time, nativeId).run()).rejects.toThrow();
      expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally { await native.dispose(); }
  }, 60_000);
});
