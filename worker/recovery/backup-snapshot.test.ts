import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { Env } from "../types";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import { captureSystemBackupSnapshot, installSystemBackupHolds, sourceBackupCheckpoint } from "./backup-snapshot";
import { openSystemBackupSource, prepareSystemBackupArchive, validateSystemBackupArchive } from "./backup-archive";
import { finishSystemBackupManifest, planSystemBackupSources, validateSystemBackupContentImage, validateSystemBackupDocuments, type SystemBackupFile } from "../../shared/contracts/system-backup";
import { RECOVERY_SCHEMA_SHA256, RECOVERY_TABLES } from "../../shared/contracts/system-recovery-catalog";
import { createSystemBackupArchiveStream, measureSystemBackupArchive } from "../../shared/domain/system-backup-archive";
import { sourceFromBlob, type ArchiveHashFactory } from "../../shared/domain/research-archive";

const databases: DatabaseSync[] = [], payload = Uint8Array.of(1, 3, 5, 7), digest = createHash("sha256").update(payload).digest("hex");
const now = "2026-10-06T12:00:00.000Z";
afterEach(() => { databases.splice(0).forEach(database => database.close()); });
function fixture() {
  const sql = referenceTestDatabase(); databases.push(sql);
  sql.prepare("INSERT INTO samples(rowid,id,code,title,created_at,updated_at) VALUES(?,'first','FIRST','Retained sample',?,?)").run(9007199254740993n, now, now);
  sql.prepare("INSERT INTO samples(rowid,id,code,title,created_at,updated_at,deleted_at,deleted_by) VALUES(?,'deleted','DELETED','Recoverable deletion',?,?,?,'old-actor')").run(-9223372036854775808n, now, now, now);
  sql.prepare("INSERT INTO events(rowid,id,sample_id,kind,body,created_at) VALUES(?,'first-event','first','created','First history',?)").run(9007199254740993n, now);
  sql.prepare("INSERT INTO events(rowid,id,sample_id,kind,body,created_at) VALUES(?,'second-event','first','comment','Second history',?)").run(-9223372036854775808n, now);
  sql.prepare("INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at) VALUES('legacy','opaque-source','original.bin','application/octet-stream',4,'ready',?,?)").run(digest, now);
  sql.prepare(`INSERT INTO system_recovery_jobs(id,request_id,actor,kind,state,phase,input_json,accepted_at,updated_at)
    VALUES('capture','request','admin@example.test','backup','queued','snapshot','{}',?,?)`).run(now, now);
  const db = new SqliteD1Database(sql), batch = vi.spyOn(db, "batch");
  return { sql, db, batch };
}
const hashFactory: ArchiveHashFactory = () => { const hash = createHash("sha256"); return { write(bytes) { hash.update(bytes); }, finish() { return hash.digest("hex"); } }; };

describe("one-primary-batch exact system backup and closed archive admission", () => {
  it("freezes canonical/deleted history, int64 rowids, protected policy and source holds in one batch", async () => {
    const f = fixture(), records = await captureSystemBackupSnapshot(f.db as unknown as D1Database, { backupId: "capture", createdAt: now });
    expect(f.batch).toHaveBeenCalledTimes(1);
    expect(records.content.schemaVersion).toBe(24); expect(records.content.backupHoldOwner).toBe("capture");
    const samples = records.image.tables.samples, id = samples.columns.indexOf("id");
    expect(samples.rows.find(row => row.cells[id].type === "text" && row.cells[id].value === "first")!.rowid).toBe("9007199254740993");
    expect(samples.rows.find(row => row.cells[id].type === "text" && row.cells[id].value === "deleted")!.rowid).toBe("-9223372036854775808");
    expect(records.content.tables.samples.find(row => row.id === "deleted")!.deleted_at).toBe(now);
    expect(records.image.tables.system_recovery_jobs).toBeUndefined();
    expect(records.sourceMigrationLedger).toEqual({ status: "unavailable", entries: [] });
    expect(f.sql.prepare("SELECT store_kind,provider,object_key,released_at FROM system_recovery_legacy_holds WHERE job_id='capture'").all())
      .toEqual([{ store_kind: "r2", provider: "r2", object_key: "opaque-source", released_at: null }]);
    expect(records.protectedConfiguration.rootKeysIncluded).toBe(false); expect(records.protectedConfiguration.automaticExecution).toBe(false);
    const files: SystemBackupFile[] = planSystemBackupSources(records.content).map(source => ({ ...source, path: `files/${source.id}`, outcome: "packaged", byteSize: 4, sha256: digest }));
    const manifest = await finishSystemBackupManifest(records, files);
    expect(await validateSystemBackupDocuments(manifest, records, { schemaSha256: RECOVERY_SCHEMA_SHA256, tables: RECOVERY_TABLES })).toEqual({ manifest, records });
    expect(manifest.sourceCheckpoint).toBe(await sourceBackupCheckpoint(records));
  });
  it("rejects a separately valid-looking image containing altered content or swapped exact source rowids", async () => {
    const f = fixture(), records = await captureSystemBackupSnapshot(f.db as unknown as D1Database, { backupId: "capture", createdAt: now });
    const altered = structuredClone(records.image), title = altered.tables.samples.columns.indexOf("title");
    altered.tables.samples.rows[0].cells[title] = { type: "text", value: "Different research" };
    await expect(validateSystemBackupContentImage(records.content, altered)).rejects.toThrow("content_image:samples");
    const switched = structuredClone(records.image), rows = switched.tables.events.rows;
    [rows[0].rowid, rows[1].rowid] = [rows[1].rowid, rows[0].rowid];
    await expect(validateSystemBackupContentImage(records.content, switched)).rejects.toThrow("content_rowid_binding:events");
  });
  it("retains actual bounded platform receipts without inventing a source migration chain", async () => {
    const f = fixture();
    f.sql.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,applied_at TEXT)");
    for (const id of [10, 2, 1]) f.sql.prepare("INSERT INTO d1_migrations(id,name,applied_at) VALUES(?,?,?)").run(id, `unrecognized-${id}.sql`, now);
    f.sql.prepare("INSERT INTO d1_migrations(id,name,applied_at) VALUES(?,?,?)").run(9007199254740993n, "historical-unrecognized.sql", now);
    const records = await captureSystemBackupSnapshot(f.db as unknown as D1Database, { backupId: "capture", createdAt: now });
    expect(f.batch).toHaveBeenCalledTimes(1);
    expect(records.sourceMigrationLedger).toEqual({ status: "observed", entries: [
      ...[1, 2, 10].map(id => ({ id: String(id), name: `unrecognized-${id}.sql`, appliedAt: now, rawSha256: null })),
      { id: "9007199254740993", name: "historical-unrecognized.sql", appliedAt: now, rawSha256: null },
    ] });
    expect(records.image.tables.d1_migrations).toBeUndefined();
  });
  it.each(["unknown canonical table", "changed protected configuration DDL"])("rejects %s before any provider reads", async fault => {
    const f = fixture();
    f.sql.exec(fault === "unknown canonical table" ? "CREATE TABLE _cf_unclassified_research(id TEXT)"
      : "ALTER TABLE system_storage_credential_payloads ADD COLUMN unreviewed_secret TEXT");
    await expect(captureSystemBackupSnapshot(f.db as unknown as D1Database, { backupId: "capture", createdAt: now }))
      .rejects.toThrow("source schema differs from the reviewed recovery catalog");
  });
  it("admits only exact engine-owned platform DDL and rejects attached application objects", async () => {
    const f = fixture(); f.sql.exec("CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB)");
    await expect(captureSystemBackupSnapshot(f.db as unknown as D1Database, { backupId: "capture", createdAt: now })).resolves.toBeDefined();
    f.sql.exec("CREATE TRIGGER hidden_application_audit AFTER INSERT ON _cf_METADATA BEGIN SELECT 1; END");
    await expect(captureSystemBackupSnapshot(f.db as unknown as D1Database, { backupId: "capture", createdAt: now, acquireHolds: false }))
      .rejects.toThrow("source schema differs from the reviewed recovery catalog");
    f.sql.exec("DROP TRIGGER hidden_application_audit; DROP TABLE _cf_METADATA; CREATE TABLE _cf_METADATA(key TEXT, value BLOB)");
    await expect(captureSystemBackupSnapshot(f.db as unknown as D1Database, { backupId: "capture", createdAt: now, acquireHolds: false }))
      .rejects.toThrow("protected platform DDL is invalid");
  });
  it("blocks another backup's holds after a planned checkpoint while allowing its owner and read-only recapture", async () => {
    const f = fixture();
    f.sql.prepare(`INSERT INTO system_recovery_jobs(id,request_id,actor,kind,state,phase,input_json,accepted_at,updated_at)
      VALUES('other','other','admin@example.test','backup','queued','snapshot','{}',?,?)`).run(now, now);
    f.sql.prepare("UPDATE system_recovery_maintenance SET state='fenced',backup_job_id='capture',checkpoint_sha256=? WHERE singleton=1").run(digest);
    await expect(captureSystemBackupSnapshot(f.db as unknown as D1Database, { backupId: "other", createdAt: now })).rejects.toThrow();
    expect(f.sql.prepare("SELECT count(*) n FROM system_recovery_legacy_holds WHERE job_id='other'").get()).toEqual({ n: 0 });
    await expect(captureSystemBackupSnapshot(f.db as unknown as D1Database, { backupId: "capture", createdAt: now })).resolves.toBeDefined();
    await expect(captureSystemBackupSnapshot(f.db as unknown as D1Database, { backupId: "other", createdAt: now, acquireHolds: false })).resolves.toBeDefined();
    expect(f.sql.prepare("SELECT count(*) n FROM system_recovery_legacy_holds WHERE job_id='other'").get()).toEqual({ n: 0 });
  });
  it("does not issue a source GET without its exact backup hold and remains visibly partial", async () => {
    const f = fixture(), records = await captureSystemBackupSnapshot(f.db as unknown as D1Database, { backupId: "capture", createdAt: now });
    const source = planSystemBackupSources(records.content)[0], get = vi.fn(async () => null);
    const env = { DB: f.db, ASSETS: { get }, AUTH_MODE: "disabled" } as unknown as Env;
    expect(await openSystemBackupSource(env, source, async () => true, new AbortController().signal, "another-backup")).toEqual({ outcome: "missing" });
    expect(get).not.toHaveBeenCalled();
    const manifest = await finishSystemBackupManifest(records, [{ ...source, path: null, outcome: "missing", byteSize: null, sha256: null }]);
    expect(manifest.completeness).toBe("partial"); expect(manifest.counts.unavailableFiles).toBe(1);
  });
  it("does not suppress a legacy source hold for an unrelated profile using the same opaque key", async () => {
    const f = fixture();
    f.sql.prepare(`INSERT INTO storage_profiles(id,adapter_type,namespace_identity,configuration_source,configuration_revision,state,created_at)
      VALUES('unrelated','r2','different:namespace','bootstrap',1,'historical',?)`).run(now);
    f.sql.prepare(`INSERT INTO files(id,purpose,access_scope,state,created_at) VALUES('unrelated','embedded_content','system','unresolved',?)`).run(now);
    f.sql.prepare(`INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at)
      VALUES('unrelated','unrelated','unrelated','opaque-source','unresolved',?)`).run(now);
    // Seed a previously settled external physical claim to exercise the exact
    // namespace decision independently of executor admission or restore DDL.
    f.sql.exec("DROP TRIGGER file_location_gc_legacy_insert_guard; DROP TRIGGER file_location_gc_orphan_guard");
    f.sql.prepare(`INSERT INTO file_location_gc_ledger(location_id,state,operation_id,orphaned_at,deletion_started_at,deleted_at,attempt_count,updated_at)
      VALUES('unrelated','deleted','previous',?,?,?,1,?)`).run(now, now, now, now);
    await f.db.batch(installSystemBackupHolds(f.db as unknown as D1Database, "capture", now) as never);
    expect(f.sql.prepare("SELECT object_key FROM system_recovery_legacy_holds WHERE job_id='capture'").all()).toEqual([{ object_key: "opaque-source" }]);
  });
  it("round-trips a complete nonempty capsule through the shared STORE engine and rejects promised-byte corruption", async () => {
    const f = fixture(), records = await captureSystemBackupSnapshot(f.db as unknown as D1Database, { backupId: "capture", createdAt: now });
    const files: SystemBackupFile[] = planSystemBackupSources(records.content).map(source => ({ ...source, path: `files/${source.id}`, outcome: "packaged", byteSize: 4, sha256: digest }));
    const metadata = await prepareSystemBackupArchive(records, files), open = async () => new Blob([payload]).stream();
    const measured = await measureSystemBackupArchive(metadata, open, { createHash: hashFactory });
    const bytes = await new Response(createSystemBackupArchiveStream(metadata, open, { createHash: hashFactory })).arrayBuffer();
    expect(bytes.byteLength).toBe(measured.byteSize);
    const checked = await validateSystemBackupArchive(sourceFromBlob(new Blob([bytes])), { expectedSha256: measured.sha256, createHash: hashFactory });
    expect(checked.manifest).toEqual(metadata.manifest); expect(checked.records.image).toEqual(records.image);
    const corrupt = new Uint8Array(bytes.slice(0)), member = measured.entries.find(entry => entry.path === files[0].path)!;
    corrupt[member.dataOffset] ^= 1;
    await expect(validateSystemBackupArchive(sourceFromBlob(new Blob([corrupt])), { expectedSha256: createHash("sha256").update(corrupt).digest("hex"), createHash: hashFactory })).rejects.toThrow();
  }, 30_000);
});
