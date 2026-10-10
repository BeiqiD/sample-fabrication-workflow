import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { unstable_splitSqlQuery } from "wrangler";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteD1Database } from "../reference-test-support";
import { nativeAcceptanceFixture } from "../uploads/native-acceptance-test-support";
import { PORTABLE_RUNTIME_RECOVERY_MIGRATIONS, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256,
  PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256, PORTABLE_RUNTIME_CHECKPOINT_ID } from "../../shared/contracts/portable-runtime-recovery-catalog";
import { capturePortableSystemBackupSnapshot, captureVersionedSystemBackupSnapshot, sourceVersionedBackupCheckpoint } from "./portable-backup-snapshot";
import { snapshotFullExportV25 } from "../export-v25-snapshot";
import { validateCloudflareMigrationProvenance, validateSystemBackupDocumentsV2 } from "../../shared/contracts/system-backup-v2";
import { prepareSystemBackupArchive } from "./backup-archive";
import { createRecoveryTargetEngine, type RecoveryTargetInput } from "./target-import";
import { inspectRecoveryMigrationLedger, RECOVERY_MIGRATION_LEDGER_SQL } from "./target-migrations";
import { inspectCurrentCloudflareSchema } from "./current-cloudflare-schema";
import { installPortableSystemBackupHolds } from "./portable-backup-holds";
import { installLegacySystemBackupHolds } from "./backup-holds-legacy-test-support";
import { stableJson } from "../../shared/domain/content-addressing";
import type { ExportSchemaObject } from "../../shared/contracts/export";

const paths: string[] = [], opened: DatabaseSync[] = [];
const at = "2026-10-10T12:00:00.000Z", principal = "local_10000000-0000-4000-8000-000000000001";
// These are protected opaque cells; real identity/KDF tests separately qualify
// their cryptography. This suite runs the actual Cloudflare recovery services
// through the existing native SQLite-backed D1 fixture, never a Node Env adapter.
const verifier = ["scrypt", 1, 131072, 8, 1, 32, Buffer.alloc(32, 17).toString("base64url"), Buffer.alloc(32, 29).toString("base64url")].join("$");
function database(name: string, schema = true, split = false): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "portable-current-worker-")); paths.push(directory);
  const native = new DatabaseSync(join(directory, `${name}.sqlite`), { allowExtension: false, enableForeignKeyConstraints: true });
  opened.push(native);
  if (schema) for (const migration of PORTABLE_RUNTIME_RECOVERY_MIGRATIONS) {
    const sql = readFileSync(new URL(`../../migrations/${migration.name}`, import.meta.url), "utf8");
    expect(createHash("sha256").update(sql).digest("hex")).toBe(migration.sha256);
    if (split) for (const statement of unstable_splitSqlQuery(sql)) native.exec(statement);
    else native.exec(sql);
  }
  return native;
}
function adapter(native: DatabaseSync): D1Database { return new SqliteD1Database(native) as unknown as D1Database; }
function protect(native: DatabaseSync): void {
  native.prepare("INSERT INTO samples(rowid,id,code,title,description,created_at,updated_at) VALUES(?,'retained','KEPT','Current retained',?,?,?)")
    .run(-9223372036854775808n, "Retained\0中文", at, at);
  native.prepare("INSERT INTO events(rowid,id,sample_id,kind,body,metadata_json,created_at) VALUES(?,'retained-event','retained','comment','Retained event','{}',?)")
    .run(9007199254740993n, at);
  native.prepare("INSERT INTO local_accounts VALUES(?,?,?,9223372036854775807,1,0)").run(principal, "retained.admin", verifier);
  native.prepare("INSERT INTO local_identity_installation VALUES(1,?,'local-identity-v1',0)").run(principal);
  native.prepare("INSERT INTO local_admin_grants VALUES(?,0)").run(principal);
  native.prepare("INSERT INTO local_sessions VALUES(?,?,9223372036854775807,0,1000,0,NULL)").run("a".repeat(64), principal);
  native.prepare("INSERT INTO local_login_throttle VALUES(?,0,1)").run("b".repeat(64));
  native.prepare("INSERT INTO local_auth_events VALUES(?,?,'bootstrap',0)").run(9007199254740993n, principal);
}
function ledger(native: DatabaseSync): void {
  native.exec(RECOVERY_MIGRATION_LEDGER_SQL);
  for (const [index, migration] of PORTABLE_RUNTIME_RECOVERY_MIGRATIONS.entries())
    native.prepare("INSERT INTO d1_migrations(id,name,applied_at) VALUES(?,?,?)").run(index + 1, migration.name, at);
  native.exec("CREATE TABLE _cf_METADATA(key INTEGER PRIMARY KEY,value BLOB)");
}
afterEach(() => {
  for (const native of opened.splice(0)) if (native.isOpen) { if (native.isTransaction) native.exec("ROLLBACK"); native.close(); }
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("captures actual split23 file-backed Cloudflare schema, all101 typed tables and observed receipts in ONE atomic batch without Node provenance or research credentials", async () => {
  const native = database("split-source", true, true); protect(native); ledger(native);
  const db = adapter(native), batch = vi.spyOn(db, "batch");
  const records = await capturePortableSystemBackupSnapshot(db, { backupId: "current-cf", createdAt: at });
  expect(batch).toHaveBeenCalledTimes(1);
  expect(records.sourceMigrationLedger).toMatchObject({ kind: "cloudflare-observed-migrations/1", status: "observed" });
  expect(records.sourceMigrationLedger.entries).toHaveLength(23);
  expect(Object.hasOwn(records.sourceMigrationLedger, "installationId")).toBe(false);
  expect(Object.keys(records.image.tables)).toHaveLength(101);
  expect(records.image.tables.local_auth_events.rows[0].rowid).toBe("9007199254740993");
  expect(records.content.schemaVersion).toBe(25);
  expect(JSON.stringify(records.content)).not.toContain(verifier);
  expect(records.content.artifacts.portableCheckpoint.value.schemaComparison).toBe("reviewed-sqlite-lexical-tokens/1");
  for (const name of ["local_sessions", "local_admin_grants", "local_identity_installation", "local_login_throttle", "node_installation", "node_migrations"])
    expect(Object.hasOwn(records.image.tables, name)).toBe(false);
  const metadata = await prepareSystemBackupArchive(records, []);
  await expect(validateSystemBackupDocumentsV2(metadata.manifest, records)).resolves.toMatchObject({ manifest: { schema: "system-backup/2" } });
}, 20_000);

it("admits actual whole-file and Wrangler-split current observations with the distinct lexical proof while leaving raw Node checkpoint digests untouched", async () => {
  for (const split of [false, true]) {
    const native = database(`research-${split}`, true, split); protect(native); ledger(native);
    const db = adapter(native), batch = vi.spyOn(db, "batch");
    const content = await snapshotFullExportV25(db);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(content.artifacts.sourceRowids.value.tables.events[0].rowid).toBe("9007199254740993");
    expect(JSON.stringify(content)).not.toContain(verifier);
    const objects: ExportSchemaObject[] = native.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name").all().map(row => {
      const { type, name, tableName, sql } = row;
      if ((type !== "table" && type !== "index" && type !== "view" && type !== "trigger")
        || typeof name !== "string" || typeof tableName !== "string" || !(sql === null || typeof sql === "string"))
        throw new Error("Native schema observation has unexpected cells");
      return { type, name, tableName, sql };
    });
    await expect(inspectCurrentCloudflareSchema(objects)).resolves.toMatchObject({ ledgerPresent: true });
  }
  expect(PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256).toBe("f325f0ce87b8ce0e700853f17fd3e05401d476c1e6468fa32b3a73f867906ad3");
  expect(PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256[PORTABLE_RUNTIME_CHECKPOINT_ID]).toBe("d861d4522cd498c834fbe8c17b3b1c7562ed619a7bceaf6c3cddca3bf18ab793");
}, 20_000);

it("detects actual protected-account changes during planned recapture while preserving the previously frozen source cells", async () => {
  const native = database("checkpoint"), db = adapter(native); protect(native);
  const before = await captureVersionedSystemBackupSnapshot(db, { backupId: "fenced-current", createdAt: at });
  const image = stableJson(before.image), first = await sourceVersionedBackupCheckpoint(before);
  native.prepare("UPDATE local_accounts SET enabled=0 WHERE principal_id=?").run(principal);
  const after = await captureVersionedSystemBackupSnapshot(db, { backupId: "fenced-current", createdAt: at, acquireHolds: false });
  expect(await sourceVersionedBackupCheckpoint(after)).not.toBe(first);
  expect(stableJson(before.image)).toBe(image);
}, 20_000);

it("rejects coercible current ledger statuses, cross-platform source claims and unknown record/image versions", async () => {
  for (const status of [["observed"], ["unavailable"], {}, 1, null])
    expect(() => validateCloudflareMigrationProvenance({ kind: "cloudflare-observed-migrations/1", status, entries: [] })).toThrow();
  const native = database("closed-source"); protect(native);
  const records = await capturePortableSystemBackupSnapshot(adapter(native), { backupId: "closed-current", createdAt: at });
  const metadata = await prepareSystemBackupArchive(records, []);
  for (const change of [
    (value: typeof records) => { value.sourceMigrationLedger = { ...value.sourceMigrationLedger, kind: "node-reviewed-migrations/1" } as typeof value.sourceMigrationLedger; },
    (value: typeof records) => { value.image.version = 3 as 2; },
    (value: typeof records) => { value.schema = "system-backup-records/3" as typeof value.schema; },
  ]) {
    const changed = structuredClone(records); change(changed);
    await expect(validateSystemBackupDocumentsV2(metadata.manifest, changed)).rejects.toThrow();
  }
}, 20_000);

async function currentTargetFixture() {
  const source = await nativeAcceptanceFixture(false, { throughMigration: "0023_portable_local_identity.sql",
    databaseFactory: () => database("native-acceptance-current") });
  // The existing fixture supplies actual Cloudflare service/provider contracts;
  // this zero-payload recovery must never exercise those provider methods.
  protect(source.sql);
  const records = await capturePortableSystemBackupSnapshot(source.env.DB, { backupId: "target-current", createdAt: at });
  const metadata = await prepareSystemBackupArchive(records, []), target = database("isolated-target", false);
  const env = { ...source.env, RECOVERY_DB: adapter(target), RECOVERY_TARGET_ID: "isolated-current-target" };
  const command: RecoveryTargetInput = { jobId: crypto.randomUUID(), incarnation: crypto.randomUUID().replaceAll("-", ""),
    ownerToken: crypto.randomUUID(), generation: 1, expectedTargetId: env.RECOVERY_TARGET_ID, records, manifest: metadata.manifest,
    mapping: [], mode: "historical", current: async () => true,
    openPayload: async () => { throw new Error("Zero-payload recovery must not open source bytes"); } };
  return { source, target, env, command };
}
it("loads actual V25 cells into a fresh current Cloudflare target, disables accounts, empties authority, writes NEW reviewed23 receipts and verifies exact original provenance without provider calls", async () => {
  const f = await currentTargetFixture(), engine = createRecoveryTargetEngine(f.env);
  expect(await engine.preview(f.command)).toMatchObject({ available: true });
  let report;
  for (let step = 0; step < 160; step++) {
    f.command.generation++; f.command.ownerToken = crypto.randomUUID();
    const result = await engine.step(f.command);
    if (result.done) { report = result.report; break; }
  }
  expect(report?.verified).toBe(true);
  expect(report?.differences.filter(value => value.reason === "identity_quarantine")).toHaveLength(1);
  expect(report?.protectedIdentity).toMatchObject({ destinationAccounts: "disabled", authorityRestored: false });
  expect(f.target.prepare("SELECT password_verifier,enabled FROM local_accounts WHERE principal_id=?").get(principal)).toEqual({ password_verifier: verifier, enabled: 0 });
  expect(f.target.prepare("SELECT CAST(rowid AS TEXT) rowid,description FROM samples WHERE id='retained'").get()).toEqual({ rowid: "-9223372036854775808", description: "Retained\0中文" });
  for (const name of ["local_identity_installation", "local_admin_grants", "local_sessions", "local_login_throttle"])
    expect(f.target.prepare(`SELECT count(*) count FROM ${name}`).get()?.count).toBe(0);
  await expect(inspectRecoveryMigrationLedger(f.env.RECOVERY_DB, true, PORTABLE_RUNTIME_RECOVERY_MIGRATIONS)).resolves.toMatchObject({ complete: true });
  expect(f.source.r2Put).not.toHaveBeenCalled(); expect(f.source.r2Get).not.toHaveBeenCalled(); expect(f.source.s3Fetch).not.toHaveBeenCalled();
  f.command.generation++; f.command.ownerToken = crypto.randomUUID();
  expect((await engine.verify(f.command)).targetCheckpoint).toBe(report?.targetCheckpoint);
}, 40_000);

it("refuses a nonfresh current target and foreign current schema before claims or any provider call", async () => {
  const f = await currentTargetFixture(), occupied = database("occupied-current");
  occupied.prepare("INSERT INTO local_accounts VALUES(?,?,?,1,0,0)").run(principal, "already.present", verifier);
  const engine = createRecoveryTargetEngine({ ...f.env, RECOVERY_DB: adapter(occupied) });
  expect(await engine.preview(f.command)).toMatchObject({ available: false, reason: "target_not_fresh" });
  expect(occupied.prepare("SELECT count(*) count FROM system_recovery_target_claim").get()?.count).toBe(0);
  const original = f.target.prepare("SELECT count(*) count FROM sqlite_schema").get();
  f.target.exec("CREATE TABLE _cf_METADATA(key INTEGER 'PRIMARY KEY',value BLOB)");
  expect(await createRecoveryTargetEngine(f.env).preview(f.command)).toMatchObject({ available: false });
  expect(f.target.prepare("SELECT count(*) count FROM sqlite_schema").get()).not.toEqual(original);
  expect(f.source.r2Put).not.toHaveBeenCalled(); expect(f.source.s3Fetch).not.toHaveBeenCalled();
}, 20_000);

function populateHoldSources(native: DatabaseSync, backupId: string): void {
  protect(native);
  native.prepare(`INSERT INTO system_recovery_jobs(id,request_id,actor,kind,state,phase,input_json,accepted_at,updated_at)
    VALUES(?,?,'admin@example.test','backup','queued','snapshot','{}',?,?)`).run(backupId, backupId, at, at);
  for (const key of ["kept-source", "Kept-Source", "claimed-source"])
    native.prepare("INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,created_at) VALUES(?,?,'source.bin','application/octet-stream',4,'ready',?)").run(key, key, at);
  native.prepare("UPDATE events SET asset_key='kept-source' WHERE id='retained-event'").run();
  // The retained tombstone is generated by the actual terminal ledger guard,
  // rather than bypassing its admission or creating authority from a fixture.
  native.prepare(`INSERT INTO blob_gc_ledger(store_kind,provider,object_key,state,operation_id,orphaned_at,deletion_started_at,deleted_at,attempt_count,updated_at)
    VALUES('r2','r2','claimed-source','deleted','old-claim',?,?,?,1,?)`).run(at, at, at, at);
  expect(native.prepare("SELECT first_state FROM file_shadow_legacy_deletion_claims WHERE object_key='claimed-source'").get()?.first_state).toBe("deleted");
}
it("preserves populated legacy retention/asset/event duplicates and physical-deletion exclusions exactly while avoiding the current D1 outer UNION", async () => {
  const results = [];
  for (const current of [false, true]) {
    const native = database(`hold-equivalence-${current}`); populateHoldSources(native, "hold-proof");
    const db = adapter(native), statements = (current ? installPortableSystemBackupHolds : installLegacySystemBackupHolds)(db, "hold-proof", at);
    await db.batch(statements); await db.batch(statements);
    results.push(native.prepare("SELECT job_id,store_kind,provider,object_key,released_at FROM system_recovery_legacy_holds ORDER BY job_id,store_kind,provider,object_key").all());
  }
  expect(results[1]).toEqual(results[0]);
  expect(results[1]).toEqual(["Kept-Source", "kept-source"].map(object_key => ({ job_id: "hold-proof", store_kind: "r2", provider: "r2", object_key, released_at: null })));
}, 20_000);

it("rolls back actual current legacy hold writes when a later statement in the sole source snapshot batch fails", async () => {
  const native = database("atomic-holds"); populateHoldSources(native, "atomic-proof");
  const db = adapter(native), originalBatch = db.batch.bind(db);
  const batch = vi.spyOn(db, "batch").mockImplementation(statements => originalBatch([
    ...statements, db.prepare("SELECT json('Intentional late native snapshot failure')"),
  ]));
  await expect(capturePortableSystemBackupSnapshot(db, { backupId: "atomic-proof", createdAt: at })).rejects.toThrow("malformed JSON");
  expect(batch).toHaveBeenCalledTimes(1);
  expect(native.prepare("SELECT count(*) count FROM system_recovery_legacy_holds WHERE job_id='atomic-proof'").get()?.count).toBe(0);
  expect(native.prepare("SELECT enabled,password_verifier FROM local_accounts WHERE principal_id=?").get(principal)).toEqual({ enabled: 1, password_verifier: verifier });
}, 20_000);
