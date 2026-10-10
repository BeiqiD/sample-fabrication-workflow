import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { expect, it } from "vitest";
import type { ExportSchemaObject } from "../../shared/contracts/export";
import type { SystemBackupManifestV2, SystemBackupRecordsV2 } from "../../shared/contracts/system-backup-v2";
import { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_INTERNAL_SCHEMA_OBJECTS,
  PORTABLE_RUNTIME_RECOVERY_MIGRATIONS, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256 } from "../../shared/contracts/portable-runtime-recovery-catalog";
import type { SystemRecoveryReport } from "./report";
import { RECOVERY_MIGRATION_LEDGER_SQL } from "./target-migrations";

// Native workerd/D1 qualification only. The existing V1 workerd test remains
// frozen. No Node SQLite adapter, provider, root key, KDF or live binding is used.
const at = "2026-10-10T12:00:00.000Z", receiptAt = "2020-01-01T00:00:00.000Z";
const principal = "local_10000000-0000-4000-8000-000000000001";
// Protected opaque verifier cells; the separate actual identity cases qualify
// password cryptography. Recovery must preserve these bytes without executing it.
const verifier = ["scrypt", 1, 131072, 8, 1, 32, Buffer.alloc(32, 17).toString("base64url"), Buffer.alloc(32, 29).toString("base64url")].join("$");
type NativeD1 = Awaited<ReturnType<Miniflare["getD1Database"]>>;
interface CaptureResult {
  records: SystemBackupRecordsV2; manifest: SystemBackupManifestV2;
  sourceSchema: ExportSchemaObject[]; applicationObjects: ExportSchemaObject[];
  initialTarget: { empty: boolean }; archive: { format: "v2"; byteSize: number; sha256: string }; providerAttempts: number;
}
interface StepResult { done: boolean; report?: SystemRecoveryReport; providerAttempts: number }
interface VerifyResult {
  report: SystemRecoveryReport; targetSchema: ExportSchemaObject[];
  applicationObjects: ExportSchemaObject[]; providerAttempts: number;
}
let compiledWorker: Promise<string> | undefined;
function workerSource(): Promise<string> {
  return compiledWorker ??= build({ stdin: { resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", contents: String.raw`
    import {captureVersionedSystemBackupSnapshot} from './portable-backup-snapshot';
    import {prepareSystemBackupArchive,validateSystemBackupArchive} from './backup-archive';
    import {createRecoveryTargetEngine,inspectRecoveryTargetFreshness} from './target-import';
    import {inspectCurrentCloudflareSchema} from './current-cloudflare-schema';
    import {createSystemBackupArchiveStream} from '../../shared/domain/system-backup-archive';
    import {sourceFromBlob} from '../../shared/domain/research-archive';
    import {sha256Hex} from '../../shared/domain/content-addressing';
    let records,manifest,engine,command,providerAttempts=0;
    // A zero-file recovery has no reason to contact a provider. Fail on any
    // accidental production fetch rather than supplying a provider imitation.
    globalThis.fetch=async()=>{providerAttempts++;throw new Error('Unexpected provider request');};
    const observe=async db=>{
      const result=await db.prepare('SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name').all();
      if(!result.success)throw new Error('Native schema unavailable');return result.results;
    };
    export default{async fetch(request,env){try{
      const input=await request.json();
      if(input.op==='capture'){
        records=await captureVersionedSystemBackupSnapshot(env.DB,{backupId:input.backupId,createdAt:input.createdAt});
        if(records.schema!=='system-backup-records/2')throw new Error('Current dispatch did not select V2');
        const metadata=await prepareSystemBackupArchive(records,[]);
        const bytes=await new Response(createSystemBackupArchiveStream(metadata,async()=>{throw new Error('Zero-file archive opened payload');})).arrayBuffer();
        const admitted=await validateSystemBackupArchive(sourceFromBlob(new Blob([bytes])),{expectedSha256:await sha256Hex(bytes)});
        if(admitted.format!=='v2')throw new Error('Current archive admission did not select V2');
        ({records,manifest}=admitted);
        engine=createRecoveryTargetEngine(env);
        command={jobId:input.jobId,incarnation:input.incarnation,ownerToken:crypto.randomUUID(),generation:1,
          expectedTargetId:env.RECOVERY_TARGET_ID,records,manifest,mapping:[],mode:'historical',current:async()=>true,
          openPayload:async()=>{throw new Error('Zero-file recovery opened payload');}};
        const sourceSchema=await observe(env.DB),inspected=await inspectCurrentCloudflareSchema(sourceSchema);
        const initialTarget=await inspectRecoveryTargetFreshness(env,env.RECOVERY_TARGET_ID,records);
        const preview=await engine.preview(command);if(!preview.available)throw new Error('Native current preview: '+preview.reason);
        return Response.json({records,manifest,sourceSchema,applicationObjects:inspected.applicationObjects,
          initialTarget:{empty:initialTarget.empty},archive:{format:admitted.format,byteSize:admitted.byteSize,sha256:admitted.sha256},providerAttempts});
      }
      if(!command)throw new Error('No frozen current source');
      if(input.op==='step'){
        // One original production step per actual Worker request, preserving
        // the existing native harness's bounded per-invocation query workload.
        command.generation++;command.ownerToken=crypto.randomUUID();
        return Response.json({...await engine.step(command),providerAttempts});
      }
      if(input.op==='verify'){
        command.generation++;command.ownerToken=crypto.randomUUID();
        const report=await engine.verify(command),targetSchema=await observe(env.RECOVERY_DB);
        const inspected=await inspectCurrentCloudflareSchema(targetSchema);
        return Response.json({report,targetSchema,applicationObjects:inspected.applicationObjects,providerAttempts});
      }
      throw new Error('Unknown qualification operation');
    }catch(error){return Response.json({error:String(error),stack:error.stack},{status:500});}}};
  ` }, bundle: true, platform: "browser", format: "esm", write: false }).then(result => result.outputFiles[0].text);
}
async function installCurrent(db: NativeD1): Promise<void> {
  const directory = new URL("../../migrations/", import.meta.url);
  const names = readdirSync(directory).filter(name => name.endsWith(".sql")).sort();
  expect(names).toEqual(PORTABLE_RUNTIME_RECOVERY_MIGRATIONS.map(migration => migration.name));
  for (const migration of PORTABLE_RUNTIME_RECOVERY_MIGRATIONS) {
    const sql = readFileSync(new URL(migration.name, directory), "utf8");
    expect(createHash("sha256").update(sql).digest("hex")).toBe(migration.sha256);
    await db.batch(splitSql(sql).map(statement => db.prepare(statement)));
  }
}
async function sourceRows(db: NativeD1) {
  const account = await db.prepare(`SELECT principal_id,username,password_verifier,CAST(credential_revision AS TEXT) credential_revision,
    CAST(enabled AS TEXT) enabled,CAST(created_at AS TEXT) created_at FROM local_accounts ORDER BY principal_id`).all();
  const audit = await db.prepare(`SELECT CAST(sequence AS TEXT) sequence,principal_id,kind,CAST(happened_at AS TEXT) happened_at
    FROM local_auth_events ORDER BY local_auth_events.sequence`).all();
  const authority: Record<string, number> = {};
  for (const name of ["local_identity_installation", "local_admin_grants", "local_sessions", "local_login_throttle"])
    authority[name] = (await db.prepare(`SELECT count(*) n FROM ${name}`).first<{ n: number }>())!.n;
  return { account: account.results, audit: audit.results, authority };
}
async function populateSource(db: NativeD1): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO samples(rowid,id,code,title,description,created_at,updated_at) VALUES(CAST(? AS INTEGER),'retained','KEPT','Current retained',?,?,?)")
      .bind("-9223372036854775808", "Retained\0中文", at, at),
    db.prepare("INSERT INTO events(rowid,id,sample_id,kind,body,metadata_json,created_at) VALUES(CAST(? AS INTEGER),'retained-event','retained','comment','Retained event','{}',?)")
      .bind("9007199254740993", at),
    db.prepare("INSERT INTO local_accounts VALUES(?,?,?,9223372036854775807,1,0)").bind(principal, "retained.admin", verifier),
    db.prepare("INSERT INTO local_identity_installation VALUES(1,?,'local-identity-v1',0)").bind(principal),
    db.prepare("INSERT INTO local_admin_grants VALUES(?,0)").bind(principal),
    db.prepare("INSERT INTO local_sessions VALUES(?,?,9223372036854775807,0,1000,0,NULL)").bind("a".repeat(64), principal),
    db.prepare("INSERT INTO local_login_throttle VALUES(?,0,1)").bind("b".repeat(64)),
    db.prepare("INSERT INTO local_auth_events VALUES(9007199254740993,?,'bootstrap',0)").bind(principal),
  ]);
  await db.prepare(RECOVERY_MIGRATION_LEDGER_SQL).run();
  await db.batch(PORTABLE_RUNTIME_RECOVERY_MIGRATIONS.map((migration, index) =>
    db.prepare("INSERT INTO d1_migrations(id,name,applied_at) VALUES(?,?,?)").bind(index + 1, migration.name, receiptAt)));
}

it.each(["empty", "current"] as const)("captures real current workerd schema/CF receipts and restores a %s D1 target with exact protected identities and inert authority", async targetKind => {
  const persist = await mkdtemp(join(tmpdir(), "portable-current-workerd-"));
  let native: Miniflare | undefined;
  try {
    native = new Miniflare({ modules: true, script: await workerSource(), compatibilityDate: "2026-07-20",
      d1Databases: { DB: crypto.randomUUID(), RECOVERY_DB: crypto.randomUUID() },
      d1Persist: join(persist, "d1"), log: new Log(LogLevel.ERROR),
      bindings: { RECOVERY_TARGET_ID: `native-current-${targetKind}` } });
    const source = await native.getD1Database("DB"), target = await native.getD1Database("RECOVERY_DB");
    await installCurrent(source); await populateSource(source);
    if (targetKind === "current") {
      await installCurrent(target);
      // A genuine empty Wrangler ledger is admitted, then receives only new
      // reviewed destination receipts after the restored graph is verified.
      await target.prepare(RECOVERY_MIGRATION_LEDGER_SQL).run();
      expect(await target.prepare("SELECT count(*) n FROM d1_migrations").first()).toEqual({ n: 0 });
    }
    const before = await sourceRows(source);
    const invoke = async <T>(input: object): Promise<T> => {
      const response = await native!.dispatchFetch("https://qualification.invalid/", { method: "POST", body: JSON.stringify(input) });
      const result = await response.json();
      if (response.status !== 200) throw new Error(`Native current ${targetKind} failure: ${JSON.stringify(result)}`);
      return result as T;
    };
    const captured = await invoke<CaptureResult>({ op: "capture", backupId: crypto.randomUUID(), jobId: crypto.randomUUID(),
      incarnation: crypto.randomUUID().replaceAll("-", ""), createdAt: at });
    expect(captured.initialTarget.empty).toBe(targetKind === "empty");
    expect(captured.archive.format).toBe("v2"); expect(captured.archive.byteSize).toBeGreaterThan(0);
    expect(captured.archive.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(captured.providerAttempts).toBe(0);
    expect(captured.records).toMatchObject({ schema: "system-backup-records/2", content: { schemaVersion: 25 },
      image: { version: 2, checkpointId: PORTABLE_RUNTIME_CHECKPOINT_ID, schemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256 },
      origin: { capturePolicy: "atomic-primary-with-byte-holds/1" },
      sourceMigrationLedger: { kind: "cloudflare-observed-migrations/1", status: "observed" } });
    expect(captured.manifest).toMatchObject({ schema: "system-backup/2", contentSchemaVersion: 25, completeness: "complete", files: [] });
    expect(captured.records.sourceMigrationLedger.entries).toEqual(PORTABLE_RUNTIME_RECOVERY_MIGRATIONS.map((migration, index) =>
      ({ id: String(index + 1), name: migration.name, appliedAt: receiptAt, rawSha256: migration.sha256 })));
    expect(Object.hasOwn(captured.records.sourceMigrationLedger, "installationId")).toBe(false);
    expect(captured.records.content.artifacts.portableCheckpoint.value.schemaComparison).toBe("reviewed-sqlite-lexical-tokens/1");
    expect(JSON.stringify(captured.records.content)).not.toContain(verifier);
    expect(Object.keys(captured.records.image.tables)).toHaveLength(101);
    expect(captured.records.image.tables.local_accounts.rows[0].cells).toEqual([
      { type: "text", value: principal }, { type: "text", value: "retained.admin" }, { type: "text", value: verifier },
      { type: "integer", value: "9223372036854775807" }, { type: "integer", value: "1" }, { type: "integer", value: "0" },
    ]);
    expect(captured.records.image.tables.local_auth_events.rows[0].rowid).toBe("9007199254740993");
    for (const name of ["local_identity_installation", "local_admin_grants", "local_sessions", "local_login_throttle", "node_installation", "node_migrations"])
      expect(Object.hasOwn(captured.records.image.tables, name)).toBe(false);
    expect(captured.sourceSchema.map(object => object.name)).toEqual(expect.arrayContaining([
      "_cf_METADATA", "d1_migrations", "sqlite_autoindex_d1_migrations_1", "sqlite_sequence", "local_accounts", "local_auth_events",
    ]));
    expect(captured.applicationObjects.filter(object => object.sql === null || object.name.startsWith("sqlite_")))
      .toEqual(PORTABLE_RUNTIME_INTERNAL_SCHEMA_OBJECTS);
    let report: SystemRecoveryReport | undefined;
    for (let stages = 1; stages <= 160; stages++) {
      const result = await invoke<StepResult>({ op: "step" });
      expect(result.providerAttempts).toBe(0);
      if (result.done) { report = result.report; break; }
    }
    if (!report) throw new Error("Native current recovery exceeded 160 stages without a report");
    expect(report).toMatchObject({ verified: true, protectedIdentity: { destinationAccounts: "disabled", authorityRestored: false },
      execution: { authority: false, shadow: false, fileJobs: false, recoveryJobs: false, cleanup: false, oldJobReplay: false } });
    expect(report.differences.filter(value => value.reason === "identity_quarantine")).toEqual([
      expect.objectContaining({ table: "local_accounts", column: "enabled", before: { type: "integer", value: "1" }, after: { type: "integer", value: "0" } }),
    ]);
    const destination = await sourceRows(target);
    expect(destination.account).toEqual(before.account.map(row => ({ ...row, enabled: "0" })));
    expect(destination.audit).toEqual(before.audit);
    expect(Object.values(destination.authority)).toEqual([0, 0, 0, 0]);
    expect(await target.prepare("SELECT CAST(rowid AS TEXT) rowid,description FROM samples WHERE id='retained'").first())
      .toEqual({ rowid: "-9223372036854775808", description: "Retained\0中文" });
    expect(await target.prepare("SELECT CAST(rowid AS TEXT) rowid FROM events WHERE id='retained-event'").first())
      .toEqual({ rowid: "9007199254740993" });
    const receipts = await target.prepare("SELECT CAST(id AS TEXT) id,name,applied_at FROM d1_migrations ORDER BY d1_migrations.id").all<{ id: string; name: string; applied_at: string }>();
    expect(receipts.results.map(row => ({ id: row.id, name: row.name }))).toEqual(PORTABLE_RUNTIME_RECOVERY_MIGRATIONS.map((migration, index) => ({ id: String(index + 1), name: migration.name })));
    expect(receipts.results.every(row => Number.isFinite(Date.parse(row.applied_at)) && row.applied_at !== receiptAt)).toBe(true);
    expect(await sourceRows(source)).toEqual(before);
    expect((await source.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await target.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const verified = await invoke<VerifyResult>({ op: "verify" });
    expect(verified.report.targetCheckpoint).toBe(report.targetCheckpoint);
    expect(verified.providerAttempts).toBe(0);
    expect(verified.applicationObjects.filter(object => object.sql === null || object.name.startsWith("sqlite_")))
      .toEqual(PORTABLE_RUNTIME_INTERNAL_SCHEMA_OBJECTS);
    expect(verified.targetSchema.filter(object => object.type === "table" && object.name === "d1_migrations")).toHaveLength(1);
  } finally {
    try { if (native) await native.dispose(); }
    finally { await rm(persist, { recursive: true, force: true }); }
  }
}, 180_000);
