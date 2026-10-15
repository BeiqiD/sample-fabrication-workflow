import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { Env } from "../types";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import { captureSystemBackupSnapshot, installSystemBackupHolds, sourceBackupCheckpoint } from "./backup-snapshot";
import { openSystemBackupSource, prepareSystemBackupArchive, validateSystemBackupArchive } from "./backup-archive";
import { finishSystemBackupManifest, planSystemBackupSources, validateSystemBackupContentImage, validateSystemBackupDocuments, type SystemBackupFile } from "../../shared/contracts/system-backup";
import { RECOVERY_SCHEMA_SHA256, RECOVERY_TABLES } from "../../shared/contracts/system-recovery-catalog";
import { createSystemBackupArchiveStream, measureSystemBackupArchive } from "../../shared/domain/system-backup-archive";
import { sourceFromBlob, type ArchiveHashFactory } from "../../shared/domain/research-archive";
import { installNativeV5SystemBackupHolds, installPortableSystemBackupHolds } from "./portable-backup-holds";

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

/** Isolated actual SQLite integration of the original hold installer. These
 * intentionally constructed SQL inputs are not a V5 image, admitted File
 * graph, Worker HTTP workflow, native provider or public backup qualification. */
function holdSqlFixture(includeNull: boolean) {
  const sql = new DatabaseSync(":memory:"); databases.push(sql);
  sql.exec(`
    CREATE TABLE retention_inputs(store_kind TEXT NOT NULL,provider TEXT NOT NULL,object_key);
    CREATE VIEW blob_retention_edges AS SELECT store_kind,provider,object_key FROM retention_inputs;
    CREATE TABLE assets(r2_key TEXT);
    CREATE TABLE managed_storage_objects(provider TEXT,object_key TEXT);
    CREATE TABLE imports(workbook_asset_key TEXT,manifest_asset_key TEXT);
    CREATE TABLE template_versions(source_asset_key TEXT);
    CREATE TABLE events(asset_key TEXT);
    CREATE TABLE system_recovery_jobs(id TEXT PRIMARY KEY);
    CREATE TABLE system_recovery_legacy_holds(
      job_id TEXT NOT NULL REFERENCES system_recovery_jobs(id),
      store_kind TEXT NOT NULL CHECK(store_kind IN('r2','managed')),
      provider TEXT NOT NULL,object_key TEXT NOT NULL,released_at TEXT,
      PRIMARY KEY(job_id,store_kind,provider,object_key));
    CREATE TABLE blob_gc_ledger(store_kind TEXT,provider TEXT,object_key TEXT,state TEXT);
    CREATE TABLE file_shadow_legacy_deletion_claims(store_kind TEXT,provider TEXT,object_key TEXT);
    CREATE TABLE legacy_file_mappings(store_kind TEXT,provider TEXT,object_key TEXT,location_id TEXT);
    CREATE TABLE file_location_gc_ledger(location_id TEXT,state TEXT);
    CREATE TABLE file_authority_control(singleton INTEGER PRIMARY KEY,mode TEXT);
    CREATE TABLE file_location_publications(location_id TEXT PRIMARY KEY);
    CREATE TABLE file_location_availability(location_id TEXT PRIMARY KEY,availability TEXT);
    CREATE TABLE file_location_holds(id TEXT PRIMARY KEY,location_id TEXT NOT NULL,hold_kind TEXT NOT NULL,
      operation_id TEXT NOT NULL,reason TEXT NOT NULL,acquired_at TEXT NOT NULL,expires_at TEXT,released_at TEXT);
    CREATE TABLE batch_probe(id TEXT PRIMARY KEY);
    INSERT INTO system_recovery_jobs VALUES('native'),('default'),('rollback'),('prior');
    INSERT INTO retention_inputs VALUES('r2','r2','same-key'),('r2','r2','same-key'),
      ('managed','s3','same-key'),('r2','r2','deleting-key'),
      ('r2','r2','claimed-key'),('r2','r2','mapped-deleting-key');
    INSERT INTO assets VALUES('direct-asset');
    INSERT INTO imports VALUES('same-key',NULL);
    INSERT INTO events VALUES('direct-event');
    INSERT INTO blob_gc_ledger VALUES('r2','r2','deleting-key','deleting');
    INSERT INTO file_shadow_legacy_deletion_claims VALUES('r2','r2','claimed-key');
    INSERT INTO legacy_file_mappings VALUES('r2','r2','mapped-deleting-key','old-location');
    INSERT INTO file_location_gc_ledger VALUES('old-location','deleted'),('physical-deleting','deleting');
    INSERT INTO file_authority_control VALUES(1,'active');
    INSERT INTO file_location_publications VALUES('physical-live'),('physical-deleting'),('physical-unavailable');
    INSERT INTO file_location_availability VALUES('physical-live','available'),
      ('physical-deleting','available'),('physical-unavailable','metadata_not_ready');
    INSERT INTO system_recovery_legacy_holds VALUES('prior','r2','r2','prior-key',NULL);
  `);
  if (includeNull) sql.prepare("INSERT INTO retention_inputs VALUES('r2','r2',NULL)").run();
  const db = new SqliteD1Database(sql), source = () => sql.prepare("SELECT rowid,* FROM retention_inputs ORDER BY rowid").all();
  const legacy = (job: string) => sql.prepare(`SELECT store_kind,provider,object_key,released_at
    FROM system_recovery_legacy_holds WHERE job_id=? ORDER BY store_kind,provider,object_key`).all(job);
  const physical = (job: string) => sql.prepare(`SELECT id,location_id,hold_kind,operation_id,reason,acquired_at,expires_at,released_at
    FROM file_location_holds WHERE operation_id=? ORDER BY location_id`).all("fp5-backup:" + job);
  const expectedLegacy = [
    { store_kind: "managed", provider: "s3", object_key: "same-key", released_at: null },
    { store_kind: "r2", provider: "r2", object_key: "direct-asset", released_at: null },
    { store_kind: "r2", provider: "r2", object_key: "direct-event", released_at: null },
    { store_kind: "r2", provider: "r2", object_key: "same-key", released_at: null },
  ];
  return { sql, db, source, legacy, physical, expectedLegacy };
}

describe("isolated original SQLite hold installer semantics", () => {
  it("keeps NULL metadata rows while retaining every real legacy namespace and the original physical File hold", async () => {
    const f = holdSqlFixture(true), source = f.source(), prior = f.legacy("prior");
    expect(source.filter(row => row.object_key === null)).toHaveLength(1);
    const statements = installNativeV5SystemBackupHolds(f.db as unknown as D1Database, "native", now);
    expect(statements).toHaveLength(2);
    await f.db.batch(statements);
    expect(f.source()).toEqual(source); expect(f.legacy("prior")).toEqual(prior);
    expect(f.legacy("native")).toEqual(f.expectedLegacy);
    const held = f.physical("native"); expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ location_id: "physical-live", hold_kind: "export", operation_id: "fp5-backup:native",
      reason: "Frozen system backup source", acquired_at: now, expires_at: null, released_at: null });
    expect(held[0].id).toMatch(/^fp5_[a-f0-9]{32}$/);
    await f.db.batch(installNativeV5SystemBackupHolds(f.db as unknown as D1Database, "native", now));
    expect(f.source()).toEqual(source); expect(f.legacy("native")).toEqual(f.expectedLegacy);
    expect(f.physical("native")).toEqual(held);
  });
  it("retains the default installer's NULL rejection and rolls back its original batch without consuming source metadata", async () => {
    const f = holdSqlFixture(true), source = f.source(), prior = f.legacy("prior");
    await expect(f.db.batch([f.db.prepare("INSERT INTO batch_probe VALUES('default')") as unknown as D1PreparedStatement,
      ...installPortableSystemBackupHolds(f.db as unknown as D1Database, "default", now)]))
      .rejects.toThrow(/NOT NULL/);
    expect(f.sql.prepare("SELECT * FROM batch_probe").all()).toEqual([]);
    expect(f.legacy("default")).toEqual([]); expect(f.physical("default")).toEqual([]);
    expect(f.source()).toEqual(source); expect(f.legacy("prior")).toEqual(prior);
  });
  it("preserves default non-NULL hold results and atomically rolls back Native holds when a later original batch statement fails", async () => {
    const f = holdSqlFixture(false), source = f.source(), prior = f.legacy("prior");
    await f.db.batch(installPortableSystemBackupHolds(f.db as unknown as D1Database, "default", now));
    await f.db.batch(installNativeV5SystemBackupHolds(f.db as unknown as D1Database, "native", now));
    expect(f.legacy("default")).toEqual(f.expectedLegacy); expect(f.legacy("native")).toEqual(f.expectedLegacy);
    const defaultPhysical = f.physical("default"), nativePhysical = f.physical("native");
    expect(defaultPhysical).toHaveLength(1); expect(nativePhysical).toHaveLength(1);
    expect(defaultPhysical[0]).toMatchObject({ location_id: "physical-live", acquired_at: now, released_at: null });
    expect(nativePhysical[0]).toMatchObject({ location_id: "physical-live", acquired_at: now, released_at: null });
    await expect(f.db.batch([f.db.prepare("INSERT INTO batch_probe VALUES('rollback')") as unknown as D1PreparedStatement,
      ...installNativeV5SystemBackupHolds(f.db as unknown as D1Database, "rollback", now),
      f.db.prepare("SELECT json('Original later batch guard rejects')") as unknown as D1PreparedStatement]))
      .rejects.toThrow();
    expect(f.sql.prepare("SELECT * FROM batch_probe").all()).toEqual([]);
    expect(f.legacy("rollback")).toEqual([]); expect(f.physical("rollback")).toEqual([]);
    expect(f.legacy("default")).toEqual(f.expectedLegacy); expect(f.legacy("native")).toEqual(f.expectedLegacy);
    expect(f.physical("default")).toEqual(defaultPhysical); expect(f.physical("native")).toEqual(nativePhysical);
    expect(f.source()).toEqual(source); expect(f.legacy("prior")).toEqual(prior);
  });
});

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
