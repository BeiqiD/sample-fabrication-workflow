import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeAcceptanceFixture } from "../uploads/native-acceptance-test-support";
import { SqliteD1Database, referenceTestDatabase } from "../reference-test-support";
import { acceptAndUploadR2Asset } from "../uploads/r2-upload-acceptance";
import { captureSystemBackupSnapshot } from "./backup-snapshot";
import { finishSystemBackupManifest, planSystemBackupSources, type SystemBackupFile } from "../../shared/contracts/system-backup";
import { stableJson } from "../../shared/domain/content-addressing";
import { createRecoveryTargetEngine, inspectRecoveryTargetFreshness, type RecoveryTargetInput } from "./target-import";
import { recoverySourceProfileId } from "./target-files";
import { RECOVERY_TABLES } from "./trusted-schema";

const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach(database => database.close()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function target(empty = false) {
  const sql = empty ? new DatabaseSync(":memory:") : referenceTestDatabase(); databases.push(sql); sql.exec("PRAGMA foreign_keys=ON");
  return { sql, db: new SqliteD1Database(sql) as unknown as D1Database };
}
async function source(withFile = true) {
  const fixture = await nativeAcceptanceFixture(false, { throughMigration: "0022_fp5_recovery_evidence.sql" }); databases.push(fixture.sql);
  fixture.env.ACCESS_TEAM_DOMAIN = "https://qualification.cloudflareaccess.com"; fixture.env.ACCESS_AUD = "qualification";
  // Signed int64 physical identity never passes through a JavaScript number.
  fixture.sql.prepare("INSERT INTO samples(rowid,id,code,title,description,created_at,updated_at) VALUES(CAST(? AS INTEGER),'signed-sample','SIGNED','Signed physical identity',?,?,?)")
    .run("-9223372036854775807", "Original text\u0000retained", fixture.now, fixture.now);
  if (withFile) {
    const bytes = new TextEncoder().encode("A verified recovery source that remains readable until cutover");
    const accepted = await acceptAndUploadR2Asset(fixture.env, { requestId: crypto.randomUUID(), actorEmail: fixture.actor,
      ingress: "ordinary_image", originalName: "original-proof.png", mimeType: "image/png", bytes: bytes.buffer });
    expect(accepted.state.status).toBe("ready");
    if (accepted.state.status !== "ready") throw new Error("Fixture File did not publish");
    const result = accepted.state.result!;
    const asset = fixture.sql.prepare("SELECT * FROM assets WHERE id=?").get(result.id)!;
    const file=fixture.sql.prepare("SELECT c.result_file_id file_id FROM file_acceptance_candidates c JOIN r2_upload_requests r ON r.id=c.acceptance_id WHERE c.acceptance_kind='r2_upload' AND c.item_id='' AND c.state='ready' AND r.candidate_asset_id=?").get(result.id)!;
    fixture.sql.prepare("INSERT INTO events(id,sample_id,kind,asset_key,asset_file_id,metadata_json,created_at) VALUES('recovery-event','sample-native','image',?,?,?,?)")
      .run(result.key, file.file_id, JSON.stringify({ assetId: asset.id }), fixture.now);
  }
  const records = await captureSystemBackupSnapshot(fixture.env.DB, { backupId: crypto.randomUUID(), acquireHolds: false });
  const payloads = new Map<string, Uint8Array>(), files: SystemBackupFile[] = [];
  for (const source of planSystemBackupSources(records.content)) {
    const bytes = fixture.r2Objects.get(source.source.objectKey);
    if (!bytes) throw new Error(`Fixture source bytes missing: ${source.source.locatorId}`);
    const value = new Uint8Array(bytes); payloads.set(source.id, value);
    files.push({ ...source, path: `files/${source.id}`, outcome: "packaged", byteSize: value.length, sha256: hash(value) });
  }
  const manifest = await finishSystemBackupManifest(records, files);
  const snapshot = () => stableJson(RECOVERY_TABLES.filter(table => !table.local).map(table =>
    [table.name, fixture.sql.prepare(`SELECT * FROM "${table.name}"`).all()]));
  return { fixture, records, manifest, payloads, snapshot };
}
function input(value: Awaited<ReturnType<typeof source>>, destinationProfileId: string): RecoveryTargetInput {
  return { jobId: crypto.randomUUID(), incarnation: crypto.randomUUID().replaceAll("-", ""), ownerToken: crypto.randomUUID(), generation: 1,
    expectedTargetId: "isolated-qualification-target", records: value.records, manifest: value.manifest,
    mapping: [...new Set(value.manifest.files.map(recoverySourceProfileId))].map(sourceProfileId => ({ sourceProfileId, destinationProfileId, configurationRevision: 1 })),
    mode: "historical", current: async () => true,
    openPayload: async file => new Response(value.payloads.get(file.id)!.slice().buffer).body! };
}
async function finish(engine: ReturnType<typeof createRecoveryTargetEngine>, command: RecoveryTargetInput) {
  for (let index = 0; index < 160; index++) {
    command.generation++; command.ownerToken = crypto.randomUUID();
    const result = await engine.step(command); if (result.done) return result.report!;
  }
  throw new Error("Recovery did not finish within the declared stage count");
}
describe("fresh-target exact system recovery", () => {
  it("restores signed rowids, original canonical cells and encrypted administration history into an empty target with every execution capability inert", async () => {
    const value = await source(false), destination = target(true), before = value.snapshot();
    const env = { ...value.fixture.env, RECOVERY_DB: destination.db, RECOVERY_TARGET_ID: "isolated-qualification-target" };
    const engine = createRecoveryTargetEngine(env), command = input(value, "r2-profile");
    expect(await engine.preview(command)).toMatchObject({ available: true });
    const report = await finish(engine, command);
    expect(report.verified).toBe(true); expect(report.counts.auditedCellDifferences).toBe(0);
    expect(report.protectedSettings).toMatchObject({ included: true, nativeBindingsEnabled: false, rootKeysIncluded: false, automaticExecution: false });
    expect(destination.sql.prepare("SELECT CAST(rowid AS TEXT) rowid,description FROM samples WHERE id='signed-sample'").get())
      .toEqual({ rowid: "-9223372036854775807", description: "Original text\u0000retained" });
    expect(destination.sql.prepare("SELECT enabled,incarnation FROM file_authority_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
    expect(destination.sql.prepare("SELECT count(*) count FROM system_storage_native_bindings").get()).toEqual({ count: 0 });
    expect(value.snapshot()).toBe(before);
    command.generation++; command.ownerToken = crypto.randomUUID();
    expect((await engine.verify(command)).targetCheckpoint).toBe(report.targetCheckpoint);
  }, 60_000);

  it("copies native R2 Files to admitted S3 with a new owned prefix, preserves source IDs/history/bytes, and rejects post-verification canonical tampering", async () => {
    const value = await source(), destination = target(), before = value.snapshot();
    const oldKeys = [...value.fixture.r2Objects.keys()], originalBytes = oldKeys.map(key => hash(new Uint8Array(value.fixture.r2Objects.get(key)!)));
    const env = { ...value.fixture.env, RECOVERY_DB: destination.db, RECOVERY_TARGET_ID: "isolated-qualification-target" };
    const engine = createRecoveryTargetEngine(env), command = input(value, value.fixture.admission.nativeProfileId);
    expect(await engine.preview(command)).toMatchObject({ available: true, files: value.manifest.files.length });
    const report = await finish(engine, command);
    const originalFile = value.records.content.tables.file_publications[0];
    const restored = destination.sql.prepare("SELECT p.file_id,l.object_key,l.storage_profile_id,p.verified_sha256 FROM file_publications p JOIN file_location_publications l ON l.location_id=p.active_location_id WHERE p.file_id=?")
      .get(originalFile.file_id)!;
    expect(restored.file_id).toBe(originalFile.file_id); expect(restored.object_key).toMatch(new RegExp(`^fp5-recovery/${command.incarnation}/`));
    expect(restored.storage_profile_id).toBe(value.fixture.admission.nativeProfileId); expect(restored.verified_sha256).toBe(originalFile.verified_sha256);
    expect(report.execution.oldJobReplay).toBe(false); expect(value.snapshot()).toBe(before);
    expect(oldKeys.map(key => hash(new Uint8Array(value.fixture.r2Objects.get(key)!)))).toEqual(originalBytes);
    expect(value.fixture.s3Fetch.mock.calls.filter(([request]) => (request as Request).method === "PUT")).toHaveLength(value.manifest.files.length);
    destination.sql.prepare("UPDATE samples SET title='Unexpected target mutation' WHERE id='sample-native'").run();
    command.generation++; command.ownerToken = crypto.randomUUID();
    await expect(engine.verify(command)).rejects.toThrow("unclassified_recovery_cell_change:");
  }, 60_000);

  it("rejects source aliases, nonfresh targets, partial backups and revoked execution before any source bytes or target business rows change", async () => {
    const value = await source(), destination = target(), command = input(value, "r2-profile"), before = value.snapshot();
    const alias = { ...value.fixture.env, RECOVERY_DB: new SqliteD1Database(value.fixture.sql) as unknown as D1Database, RECOVERY_TARGET_ID: command.expectedTargetId };
    await expect(inspectRecoveryTargetFreshness(alias, command.expectedTargetId)).rejects.toThrow("recovery_target_alias");
    const env = { ...value.fixture.env, RECOVERY_DB: destination.db, RECOVERY_TARGET_ID: command.expectedTargetId }, engine = createRecoveryTargetEngine(env);
    const partial = { ...command, manifest: structuredClone(command.manifest) };
    partial.manifest.completeness = "partial";
    expect(await engine.preview(partial)).toMatchObject({ available: false, reason: "partial_backup_not_complete_recovery" });
    command.current = async () => false; await expect(engine.step(command)).rejects.toThrow("recovery_actor_or_lease_changed");
    expect(destination.sql.prepare("SELECT count(*) count FROM system_recovery_target_claim").get()).toEqual({ count: 0 });
    destination.sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('occupied','OCCUPIED','Existing target',?,?)").run(value.fixture.now, value.fixture.now);
    expect(await engine.preview(command)).toMatchObject({ available: false, reason: "target_not_fresh" });
    expect(value.snapshot()).toBe(before); expect(value.fixture.r2Put).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("rejects disguised unreviewed schema objects and a partial Wrangler ledger before any claim or provider write", async () => {
    const value=await source(false), destination=target(), command=input(value,"r2-profile");
    const env={...value.fixture.env,RECOVERY_DB:destination.db,RECOVERY_TARGET_ID:command.expectedTargetId},engine=createRecoveryTargetEngine(env);
    for(const name of ['_cf_fake','acfuture']){
      destination.sql.exec(`CREATE TABLE "${name}"(id TEXT)`);
      expect(await engine.preview(command)).toMatchObject({available:false,reason:'target_schema_not_reviewed'});
      destination.sql.exec(`DROP TABLE "${name}"`);
    }
    // A quoted type token is not a PRIMARY KEY constraint. Presentation-only
    // normalization must not let it impersonate the engine-owned table.
    destination.sql.exec('CREATE TABLE _cf_METADATA(key INTEGER "PRIMARY KEY",value BLOB)');
    expect(destination.sql.prepare('PRAGMA table_info(_cf_METADATA)').get()?.pk).toBe(0);
    expect(await engine.preview(command)).toMatchObject({available:false,reason:'recovery_preflight_failed'});
    expect(destination.sql.prepare('SELECT count(*) count FROM system_recovery_target_claim').get()).toEqual({count:0});
    expect(value.fixture.r2Put).not.toHaveBeenCalled();
    destination.sql.exec('DROP TABLE _cf_METADATA');
    destination.sql.exec('CREATE TABLE "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
    destination.sql.prepare('INSERT INTO d1_migrations(id,name) VALUES(1,?)').run('0001_canonical_baseline.sql');
    expect(await engine.preview(command)).toMatchObject({available:false});
    expect(destination.sql.prepare('SELECT count(*) count FROM system_recovery_target_claim').get()).toEqual({count:0});
    expect(value.fixture.r2Put).not.toHaveBeenCalled();
  },60_000);

  it("reconciles a lost native PUT acknowledgement using full verified reads and never replays the owned target key", async () => {
    const value=await source(), destination=target(), before=value.snapshot(), command=input(value,"r2-profile");
    const originalPut=value.fixture.r2Put.getMockImplementation()!;
    value.fixture.r2Put.mockImplementationOnce(async(key:string,body:BodyInit)=>{await originalPut(key,body);throw new Error('Lost PUT acknowledgement');});
    const engine=createRecoveryTargetEngine({...value.fixture.env,RECOVERY_DB:destination.db,RECOVERY_TARGET_ID:command.expectedTargetId});
    let interrupted=false;
    for(let index=0;index<160;index++){
      command.generation++;command.ownerToken=crypto.randomUUID();
      try{await engine.step(command);}catch(error){
        expect(String(error)).toMatch(/ByteVerificationError/);interrupted=true;break;
      }
    }
    expect(interrupted).toBe(true);
    expect(destination.sql.prepare('SELECT state FROM system_recovery_target_files').get()).toEqual({state:'unknown'});
    const puts=value.fixture.r2Put.mock.calls.length;
    expect((await finish(engine,command)).verified).toBe(true);
    expect(puts).toBe(2);
    const targetPuts=value.fixture.r2Put.mock.calls.filter(([key])=>key.startsWith(`fp5-recovery/${command.incarnation}/`));
    expect(targetPuts).toHaveLength(value.manifest.files.length);
    expect(new Set(targetPuts.map(([key])=>key)).size).toBe(targetPuts.length);expect(value.snapshot()).toBe(before);
  },60_000);
});
