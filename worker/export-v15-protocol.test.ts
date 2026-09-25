import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { restoreExportToIsolatedDirectory } from "../scripts/lib/export-restore";
import { type ExportSchemaObject } from "../shared/contracts/export";
import { buildFileShadowBlobExportPlan, FILE_SHADOW_HEAD_INTEGRITY_SQL, fileShadowSchemaFingerprint, FILE_SHADOW_SCHEMA_FINGERPRINT_SHA256 } from "../shared/contracts/export-file-shadow";
import { createExportArtifact, validateFullExportV15 } from "../shared/contracts/export-protocol";
import { buildFullExportArchiveV15 } from "../src/lib/exportAll";
import { snapshotFullExportV15 } from "./export-v15-snapshot";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const databases: DatabaseSync[] = [];
const now = "2026-09-25T00:00:00.000Z", hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
afterEach(() => { vi.unstubAllGlobals(); while (databases.length) databases.pop()!.close(); });
function snapshot(db: DatabaseSync) { return snapshotFullExportV15(new SqliteD1Database(db) as unknown as D1Database); }
function fixture() {
  const db = referenceTestDatabase(); databases.push(db);
  db.exec(`
    INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('reference-sample-a','V15','Archive fixture','${now}','${now}');
    INSERT INTO storage_profiles(id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at)
      VALUES('shadow-profile','r2','bucket-one','bootstrap',NULL,1,'historical','${now}'),
      ('other-profile','r2','bucket-two','bootstrap',NULL,1,'historical','${now}');
    INSERT INTO events(rowid,id,sample_id,kind,asset_key,metadata_json,created_at)
      VALUES(-31,'shadow-event','reference-sample-a','image','source/old','{"action":"sample_record"}','${now}');
    UPDATE events SET asset_key='source/key' WHERE id='shadow-event';
    INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,verified_sha256,state,active_location_id,created_at)
      VALUES('source-file','embedded_content','system',3,'${hash}',NULL,'unresolved',NULL,'${now}'),
      ('candidate-file','embedded_content','system',3,'${hash}',NULL,'unresolved',NULL,'${now}'),
      ('other-file','embedded_content','system',3,'${hash}',NULL,'unresolved',NULL,'${now}');
    INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at)
      VALUES('source-location','source-file','shadow-profile','source/key','unresolved','${now}'),
      ('candidate-location','candidate-file','shadow-profile','candidate/key','unresolved','${now}'),
      ('other-location','other-file','other-profile','candidate/key','unresolved','${now}');
    INSERT INTO legacy_file_mappings(store_kind,provider,object_key,file_id,location_id,classification,evidence_json,observed_at)
      VALUES('r2','r2','source/key','source-file','source-location','classified','{}','${now}');
    INSERT INTO file_shadow_enablements(singleton,expected_epoch,enabled_by,enabled_at)
      SELECT 1,epoch,'fixture','${now}' FROM file_shadow_control;
    INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,verified_sha256,state,active_location_id,created_at)
      VALUES('unverified-output','job_output','system',NULL,NULL,NULL,'unresolved',NULL,'${now}');
    INSERT INTO file_derivations(id,source_file_id,derived_file_id,generator,generator_version,parameters_sha256,trust_state,evidence_json,created_at)
      VALUES('unverified-derivation','source-file','unverified-output','fixture','1','${hash}','unverified','{}','${now}');
    INSERT INTO file_shadow_profile_enablements(storage_profile_id,configuration_revision,enabled_by,enabled_at)
      VALUES('shadow-profile',1,'fixture','${now}');
    UPDATE file_shadow_runtime_guard SET enabled=1,incarnation='original-runtime',enabled_by='fixture',updated_at='${now}' WHERE singleton=1;
    INSERT INTO file_shadow_operations(id,occurrence_id,captured_epoch,baseline_sha256,purpose,access_scope,
      source_store_kind,source_provider,source_object_key,source_profile_id,source_profile_revision,
      source_expected_byte_size,source_expected_sha256,destination_profile_id,destination_profile_revision,status,created_by,created_at)
      SELECT 'shadow-operation',h.occurrence_id,c.epoch,'${hash}','embedded_content','system','r2','r2','source/key','shadow-profile',1,
        3,'${hash}','shadow-profile',1,'pending','fixture','${now}'
      FROM file_shadow_heads h CROSS JOIN file_shadow_control c WHERE h.consumer_kind='event' AND h.consumer_id='shadow-event' AND h.file_slot='primary';
    INSERT INTO file_shadow_legacy_holds(id,operation_id,store_kind,provider,object_key,storage_profile_id,profile_revision,acquired_at)
      VALUES('source-hold','shadow-operation','r2','r2','source/key','shadow-profile',1,'${now}');
    INSERT INTO file_shadow_attempts(id,operation_id,attempt_number,owner_token,runtime_incarnation,state,lease_expires_at,created_at)
      VALUES('shadow-attempt','shadow-operation',1,'original-owner','original-runtime','staged','2099-01-01T00:00:00.000Z','${now}');
    UPDATE file_shadow_attempts SET candidate_file_id='candidate-file',candidate_location_id='candidate-location',candidate_object_key='candidate/key',
      verified_byte_size=3,verified_sha256='${hash}',source_verified_at='${now}' WHERE id='shadow-attempt';
    INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at)
      VALUES('destination-hold','candidate-location','transition_destination','shadow-operation','archive fixture','${now}');
    UPDATE file_shadow_attempts SET state='write_started',write_started_at='${now}' WHERE id='shadow-attempt';
    UPDATE file_shadow_attempts SET state='unknown' WHERE id='shadow-attempt';
  `);
  return db;
}

function publish(db: DatabaseSync) {
    db.exec(`
      UPDATE file_shadow_attempts SET state='verified',verified_at='${now}' WHERE id='shadow-attempt';
      INSERT INTO file_location_publications(location_id,file_id,storage_profile_id,object_key,verified_byte_size,verified_sha256,verification_method,verification_operation_id,verified_at,published_at)
        VALUES('candidate-location','candidate-file','shadow-profile','candidate/key',3,'${hash}','full_read_sha256','shadow-operation','${now}','${now}');
      INSERT INTO file_publications(file_id,purpose,access_scope,verified_byte_size,verified_sha256,active_location_id,state,published_at)
        VALUES('candidate-file','embedded_content','system',3,'${hash}','candidate-location','ready','${now}');
      INSERT INTO file_shadow_decisions(occurrence_id,operation_id,decision,file_id,location_id,baseline_sha256,reason,decided_by,decided_at)
        SELECT occurrence_id,id,'resolved','candidate-file','candidate-location',baseline_sha256,NULL,'fixture','${now}' FROM file_shadow_operations WHERE id='shadow-operation';
      UPDATE file_shadow_attempts SET state='published',completed_at='${now}' WHERE id='shadow-attempt';
      UPDATE file_shadow_operations SET status='resolved',completed_at='${now}' WHERE id='shadow-operation';
      UPDATE file_shadow_legacy_holds SET released_at='${now}' WHERE id='source-hold';
      UPDATE file_location_holds SET released_at='${now}' WHERE id='destination-hold';
    `);
}

describe("V15 portable shadow checkpoint", () => {
  it("pins the same exact schema after whole-file and Wrangler-split migration execution", { timeout: 120_000 }, async () => {
    const whole = new DatabaseSync(":memory:"), split = new DatabaseSync(":memory:"); databases.push(whole, split);
    for (const name of (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
      const sql = await readFile(join(migrationsDirectory, name), "utf8"); whole.exec(sql);
      for (const statement of splitSql(sql)) split.exec(statement);
    }
    for (const db of [whole, split]) expect(await fileShadowSchemaFingerprint(db.prepare(
      "SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name",
    ).all() as unknown as ExportSchemaObject[])).toBe(FILE_SHADOW_SCHEMA_FINGERPRINT_SHA256);
  });

  it("checks missing, stale and tombstoned sources in both directions after materializing the source projection", () => {
    const db = fixture();
    expect(db.prepare(FILE_SHADOW_HEAD_INTEGRITY_SQL).get()).toEqual({ invalid_count: 0 });
    const cases = [
      ["file_shadow_heads", "DELETE FROM file_shadow_heads WHERE consumer_id='shadow-event'"],
      ["file_shadow_heads", "UPDATE file_shadow_heads SET source_json='{}' WHERE consumer_id='shadow-event'"],
      ["file_shadow_heads", "UPDATE file_shadow_heads SET source_rowid=999 WHERE consumer_id='shadow-event'"],
      ["file_shadow_heads", "UPDATE file_shadow_heads SET present=0,source_rowid=NULL,source_json='{}' WHERE consumer_id='shadow-event'"],
      ["events", "DELETE FROM events WHERE id='shadow-event'"],
    ];
    for (const [table, mutation] of cases) {
      db.exec("SAVEPOINT corrupted_source");
      try {
        const triggers = db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").all(table);
        for (const trigger of triggers) db.exec(`DROP TRIGGER "${String(trigger.name).replaceAll('"', '""')}"`);
        db.exec(mutation);
        expect(Number(db.prepare(FILE_SHADOW_HEAD_INTEGRITY_SQL).get()?.invalid_count), mutation).toBeGreaterThan(0);
      } finally { db.exec("ROLLBACK TO corrupted_source; RELEASE corrupted_source"); }
    }
    db.exec("DELETE FROM events WHERE id='shadow-event'");
    expect(db.prepare(FILE_SHADOW_HEAD_INTEGRITY_SQL).get()).toEqual({ invalid_count: 0 });
  });

  it("retains new-only candidates and identical keys in separate profile namespaces without reading them", async () => {
    const manifest = await snapshot(fixture());
    expect(manifest.schemaVersion).toBe(15);
    expect(manifest.tables.file_shadow_attempts[0].state).toBe("unknown");
    expect(manifest.tables).not.toHaveProperty("file_shadow_runtime_guard");
    expect(manifest.tables).not.toHaveProperty("file_shadow_runtime_incarnations");
    const candidates = manifest.blobs.filter((blob) => blob.byteAuthority === "file_location" && blob.objectKey === "candidate/key");
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((entry) => entry.locatorId)).size).toBe(2);
    expect(candidates.every((entry) => entry.downloadUrl === null && entry.initialOutcome === "metadata_not_ready")).toBe(true);
    const fetcher = vi.fn(async () => new Response("", { status: 404 }));
    const packaged = await buildFullExportArchiveV15(manifest, undefined, fetcher as unknown as typeof fetch);
    expect(fetcher.mock.calls.length).toBe(manifest.blobs.filter((entry) => entry.downloadUrl !== null).length);
    expect(packaged.results.filter((entry) => entry.byteAuthority === "file_location").every((entry) => entry.outcome === "metadata_not_ready")).toBe(true);
  });

  it("exports a verified publication through its exact bound profile", async () => {
    const db = fixture();
    publish(db);
    const manifest = await snapshot(db);
    expect(manifest.blobs.find((entry) => entry.locationId === "candidate-location")).toMatchObject({
      byteAuthority: "file_location", storageProfileId: "shadow-profile", storageProfileRevision: 1,
      expectedByteSize: 3, expectedSha256: hash, initialOutcome: null,
      downloadUrl: "/exports/file-locations/candidate-location?profile=shadow-profile&revision=1",
    });
    expect(manifest.tables.events.find((row) => row.id === "shadow-event")?.asset_file_id).toBeNull();
  });

  it.each(["unknown", "published"])("round-trips rowid/generation history and %s ownership while disabling restored execution", async (state) => {
    const source = fixture();
    if (state === "published") publish(source);
    const manifest = await snapshot(source);
    const packaged = await buildFullExportArchiveV15(manifest, undefined, vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch);
    const directory = await mkdtemp(join(tmpdir(), "shadow-archive-"));
    try {
      const archivePath = join(directory, "archive.zip");
      await writeFile(archivePath, Buffer.from(await packaged.archive.arrayBuffer()));
      const restored = await restoreExportToIsolatedDirectory({ archivePath, destination: join(directory, "restored"), migrationsDirectory, targetCompatibilitySchema: "S2" });
      const db = new DatabaseSync(join(restored.restoredDirectory, "database.sqlite"));
      try {
        expect(db.prepare("SELECT rowid FROM events WHERE id='shadow-event'").get()).toEqual({ rowid: -31 });
        expect(db.prepare("SELECT mode FROM file_authority_control").get()).toEqual({ mode: "overlap" });
        expect(db.prepare("SELECT incarnation,enabled FROM file_shadow_runtime_guard").get()).toEqual({ incarnation: null, enabled: 0 });
        expect(db.prepare("SELECT COUNT(*) AS count FROM file_shadow_runtime_incarnations").get()).toEqual({ count: 0 });
        expect(db.prepare("SELECT * FROM file_shadow_attempts").all()).toEqual(manifest.tables.file_shadow_attempts);
        expect(db.prepare("SELECT * FROM file_shadow_occurrences ORDER BY id").all()).toEqual([...manifest.tables.file_shadow_occurrences].sort((a,b) => String(a.id).localeCompare(String(b.id))));
        expect(restored.report.shadowRecovery).toMatchObject({ providerIO: false, runtimeExecutionEnabled: false, unfinishedOperationsResumed: false, recordedAuthorityMode: "overlap" });
        expect(() => db.exec(`UPDATE file_shadow_attempts SET state='verified',verified_at='${now}' WHERE id='shadow-attempt';
          UPDATE file_shadow_attempts SET state='published',completed_at='${now}' WHERE id='shadow-attempt'`)).toThrow();
      } finally { db.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("packages ready location bytes and retains missing location identity across equal keys in two profiles", async () => {
    const source = fixture(); publish(source);
    source.exec(`
      INSERT INTO events(id,sample_id,kind,asset_key,metadata_json,created_at)
        VALUES('other-event','reference-sample-a','image','other/source','{"action":"sample_record"}','${now}');
      INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,verified_sha256,state,active_location_id,created_at)
        VALUES('other-source-file','embedded_content','system',3,'${hash}',NULL,'unresolved',NULL,'${now}');
      INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at)
        VALUES('other-source-location','other-source-file','other-profile','other/source','unresolved','${now}');
      INSERT INTO legacy_file_mappings(store_kind,provider,object_key,file_id,location_id,classification,evidence_json,observed_at)
        VALUES('r2','r2','other/source','other-source-file','other-source-location','classified','{}','${now}');
      INSERT INTO file_shadow_profile_enablements(storage_profile_id,configuration_revision,enabled_by,enabled_at)
        VALUES('other-profile',1,'fixture','${now}');
      INSERT INTO file_shadow_operations(id,occurrence_id,captured_epoch,baseline_sha256,purpose,access_scope,
        source_store_kind,source_provider,source_object_key,source_profile_id,source_profile_revision,
        source_expected_byte_size,source_expected_sha256,destination_profile_id,destination_profile_revision,status,created_by,created_at)
        SELECT 'other-operation',h.occurrence_id,c.epoch,'${hash}','embedded_content','system','r2','r2','other/source','other-profile',1,
          3,'${hash}','other-profile',1,'pending','fixture','${now}'
        FROM file_shadow_heads h CROSS JOIN file_shadow_control c WHERE h.consumer_kind='event' AND h.consumer_id='other-event' AND h.file_slot='primary';
      INSERT INTO file_shadow_legacy_holds(id,operation_id,store_kind,provider,object_key,storage_profile_id,profile_revision,acquired_at)
        VALUES('other-source-hold','other-operation','r2','r2','other/source','other-profile',1,'${now}');
      INSERT INTO file_shadow_attempts(id,operation_id,attempt_number,owner_token,runtime_incarnation,state,lease_expires_at,created_at)
        VALUES('other-attempt','other-operation',1,'other-owner','original-runtime','staged','2099-01-01T00:00:00.000Z','${now}');
      UPDATE file_shadow_attempts SET candidate_file_id='other-file',candidate_location_id='other-location',candidate_object_key='candidate/key',
        verified_byte_size=3,verified_sha256='${hash}',source_verified_at='${now}' WHERE id='other-attempt';
      INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at)
        VALUES('other-destination-hold','other-location','transition_destination','other-operation','archive fixture','${now}');
      UPDATE file_shadow_attempts SET state='write_started',write_started_at='${now}' WHERE id='other-attempt';
      UPDATE file_shadow_attempts SET state='verified',verified_at='${now}' WHERE id='other-attempt';
      INSERT INTO file_location_publications(location_id,file_id,storage_profile_id,object_key,verified_byte_size,verified_sha256,verification_method,verification_operation_id,verified_at,published_at)
        VALUES('other-location','other-file','other-profile','candidate/key',3,'${hash}','full_read_sha256','other-operation','${now}','${now}');
      INSERT INTO file_publications(file_id,purpose,access_scope,verified_byte_size,verified_sha256,active_location_id,state,published_at)
        VALUES('other-file','embedded_content','system',3,'${hash}','other-location','ready','${now}');
      INSERT INTO file_shadow_decisions(occurrence_id,operation_id,decision,file_id,location_id,baseline_sha256,reason,decided_by,decided_at)
        SELECT occurrence_id,id,'resolved','other-file','other-location',baseline_sha256,NULL,'fixture','${now}' FROM file_shadow_operations WHERE id='other-operation';
      UPDATE file_shadow_attempts SET state='published',completed_at='${now}' WHERE id='other-attempt';
      UPDATE file_shadow_operations SET status='resolved',completed_at='${now}' WHERE id='other-operation';
      UPDATE file_shadow_legacy_holds SET released_at='${now}' WHERE id='other-source-hold';
      UPDATE file_location_holds SET released_at='${now}' WHERE id='other-destination-hold';
    `);
    const manifest = await snapshot(source);
    const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).includes("/file-locations/candidate-location?")
      ? new Response("abc") : new Response("", { status: 404 }));
    const packaged = await buildFullExportArchiveV15(manifest, undefined, fetcher as typeof fetch);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toContain("/exports/file-locations/candidate-location?profile=shadow-profile&revision=1");
    expect(fetcher.mock.calls.map(([url]) => String(url))).toContain("/exports/file-locations/other-location?profile=other-profile&revision=1");
    const exactReady = { byteAuthority: "file_location", storageProfileId: "shadow-profile", storageProfileRevision: 1, locationId: "candidate-location" };
    const exactMissing = { byteAuthority: "file_location", storageProfileId: "other-profile", storageProfileRevision: 1, locationId: "other-location" };
    expect(packaged.results.find((entry) => entry.locationId === "candidate-location")).toMatchObject({ ...exactReady, outcome: "packaged", expectedSha256: hash, expectedByteSize: 3 });
    expect(packaged.warnings.find((entry) => entry.locationId === "other-location")).toMatchObject({ ...exactMissing, code: "missing" });
    const directory = await mkdtemp(join(tmpdir(), "shadow-bytes-"));
    try {
      const archivePath = join(directory, "archive.zip"); await writeFile(archivePath, Buffer.from(await packaged.archive.arrayBuffer()));
      const network = vi.fn(() => { throw new Error("Restore must not open a provider"); }); vi.stubGlobal("fetch", network);
      const restored = await restoreExportToIsolatedDirectory({ archivePath, destination: join(directory, "restored"), migrationsDirectory, targetCompatibilitySchema: "S2" });
      expect(network).not.toHaveBeenCalled();
      const providers = JSON.parse(await readFile(join(restored.restoredDirectory, "provider-manifest.json"), "utf8"));
      const ready = providers.find((entry: { locationId: string }) => entry.locationId === "candidate-location");
      expect(ready).toMatchObject({ ...exactReady, outcome: "packaged", objectKey: "candidate/key" });
      expect(await readFile(join(restored.restoredDirectory, ready.path), "utf8")).toBe("abc");
      expect(providers.find((entry: { locationId: string }) => entry.locationId === "other-location")).toMatchObject({ ...exactMissing, outcome: "missing", objectKey: "candidate/key", path: null });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("preserves exact historical BLOB dependency evidence while keeping canonical table cells scalar", async () => {
    const db = referenceTestDatabase(); databases.push(db);
    db.exec(`INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,created_at)
      VALUES(x'00FF','history/blob','old.bin','application/octet-stream',0,'ready','${now}')`);
    await expect(snapshot(db)).rejects.toThrow(/table rows contain unsupported values/);
    db.exec("DELETE FROM assets WHERE typeof(id)='blob'");
    const manifest = await snapshot(db);
    const version = manifest.tables.file_shadow_dependency_versions.find((row) => row.dependency_kind === "assets" && row.present === 1)!;
    expect(JSON.parse(String(version.snapshot_json)).id).toEqual({ $sqliteBlob: "00FF" });
    const corrupted = JSON.parse(String(version.snapshot_json)); corrupted.id.$sqliteBlob = "00ff";
    version.snapshot_json = JSON.stringify(corrupted);
    await expect(validateFullExportV15(manifest)).rejects.toThrow(/dependency snapshot values/);
  });

  it("retains the dormant legacy mode boundary when archive rows are forged", async () => {
    const db = referenceTestDatabase(); databases.push(db);
    db.exec(`INSERT INTO files(id,purpose,access_scope,state,created_at)
      VALUES('source','embedded_content','system','unresolved','${now}'),('derived','job_output','system','unresolved','${now}')`);
    const manifest = await snapshot(db);
    manifest.tables.file_derivations.push({ id: "forged", source_file_id: "source", derived_file_id: "derived", generator: "fixture", generator_version: "1",
      parameters_sha256: hash, trust_state: "unverified", source_verified_sha256: null, derived_verified_sha256: null, verification_operation_id: null,
      evidence_json: "{}", created_at: now });
    await expect(validateFullExportV15(manifest)).rejects.toThrow(/legacy mode cannot contain executed shadow state/);
  });

  it("rejects rehashed rowid rebinding and operation history corruption", async () => {
    const original = await snapshot(fixture());
    const altered = structuredClone(original);
    const eventIndex = altered.tables.events.findIndex((row) => row.id === "shadow-event");
    altered.artifacts.sourceRowids.value.tables.events[eventIndex].rowid = "10001";
    altered.artifacts.sourceRowids = await createExportArtifact(altered.artifacts.sourceRowids.path, altered.artifacts.sourceRowids.value);
    await expect(validateFullExportV15(altered)).rejects.toThrow(/physical source identity/);
    const operation = structuredClone(original);
    operation.tables.file_shadow_operations[0].source_profile_revision = 2;
    await expect(validateFullExportV15(operation)).rejects.toThrow(/profile revision/);
    const dependency = structuredClone(original);
    const sampleHistory = dependency.tables.file_shadow_dependency_versions.filter((row) => row.dependency_kind === "samples").sort((a,b) => Number(b.revision) - Number(a.revision));
    const payload = JSON.parse(String(sampleHistory[0].snapshot_json)); payload.status = "invented";
    sampleHistory[0].snapshot_json = JSON.stringify(payload);
    await expect(validateFullExportV15(dependency)).rejects.toThrow(/dependency latest metadata/);
    const brokenHistory = structuredClone(original);
    brokenHistory.tables.file_shadow_dependency_versions = brokenHistory.tables.file_shadow_dependency_versions.filter((row) => row.dependency_kind !== "storage_profile_runtime" || row.revision !== 1);
    await expect(validateFullExportV15(brokenHistory)).rejects.toThrow(/dependency revision chain/);
    const cancelled = structuredClone(original);
    cancelled.tables.file_shadow_operations[0].status = "cancelled"; cancelled.tables.file_shadow_operations[0].completed_at = now;
    await expect(validateFullExportV15(cancelled)).rejects.toThrow(/cancelled operation crossed provider write boundary/);
    const bytes = structuredClone(original); bytes.tables.file_shadow_operations[0].source_expected_sha256 = "b".repeat(64);
    await expect(validateFullExportV15(bytes)).rejects.toThrow(/candidate\/operation byte identity/);
    const hold = structuredClone(original); hold.tables.file_shadow_legacy_holds[0].released_at = now;
    // Rebuild projections/catalog independently: the semantic fence must reject
    // forged release even when all derived archive rows agree with that release.
    hold.tables.blob_retention_edges = hold.tables.blob_retention_edges.filter((row) => row.occurrence_id !== "source-hold");
    hold.blobs = buildFileShadowBlobExportPlan(hold.tables);
    await expect(validateFullExportV15(hold)).rejects.toThrow(/legacy source hold identity/);
  });
});
