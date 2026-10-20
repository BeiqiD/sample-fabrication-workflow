import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { expect, it } from "vitest";
import { RECOVERY_MIGRATIONS } from "./trusted-schema";

const at = "2026-10-10T12:00:00.000Z";
type NativeD1 = Awaited<ReturnType<Miniflare["getD1Database"]>>;
let compiledWorker: Promise<string> | undefined;
function workerSource(): Promise<string> {
  return compiledWorker ??= build({ stdin: { resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", contents: String.raw`
    import {captureSystemBackupSnapshot} from './backup-snapshot';
    let providerAttempts=0;
    globalThis.fetch=async()=>{providerAttempts++;throw new Error('Unexpected provider request');};
    export default{async fetch(request,env){let batches=0;try{
      const input=await request.json();
      const tracked={prepare:sql=>env.DB.prepare(sql),withSession(){return tracked;},async batch(statements){
        batches++;return env.DB.batch(input.lateFailure?[...statements,env.DB.prepare("SELECT json('Intentional late native backup failure')")]:statements);
      }};
      // The actual historical default must acquire holds. No disabled guards,
      // acquireHolds:false, Node SQLite adapter, provider or archive substitution.
      const records=await captureSystemBackupSnapshot(tracked,{backupId:'native-hold-backup',createdAt:input.createdAt});
      const holds=await env.DB.prepare('SELECT store_kind,provider,object_key,released_at FROM system_recovery_legacy_holds ORDER BY object_key').all();
      return Response.json({schema:records.schema,contentSchema:records.content.schemaVersion,imageVersion:records.image.version,
        sampleTitle:records.content.tables.samples[0].title,holds:holds.results,batches,providerAttempts});
    }catch(error){return Response.json({error:String(error),batches,providerAttempts},{status:500});}}};
  ` }, bundle: true, platform: "browser", format: "esm", write: false }).then(result => result.outputFiles[0].text);
}
async function installHistorical(db: NativeD1): Promise<void> {
  expect(RECOVERY_MIGRATIONS).toHaveLength(22);
  for (const migration of RECOVERY_MIGRATIONS) {
    const sql = readFileSync(new URL(`../../migrations/${migration.name}`, import.meta.url), "utf8");
    expect(createHash("sha256").update(sql).digest("hex")).toBe(migration.sha256);
    await db.batch(splitSql(sql).map(statement => db.prepare(statement)));
  }
}
async function populate(db: NativeD1): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('native-hold-sample','NATIVE','Native retained',?,?)").bind(at, at),
    ...["kept-source", "Kept-Source", "claimed-source"].map(key =>
      db.prepare("INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at) VALUES(?,?,'source.bin','application/octet-stream',4,'ready',?,?)")
        .bind(key, key, createHash("sha256").update(key).digest("hex"), at)),
    db.prepare("INSERT INTO events(id,sample_id,kind,asset_key,metadata_json,created_at) VALUES('native-hold-event','native-hold-sample','image','kept-source','{}',?)").bind(at),
    db.prepare("INSERT INTO system_recovery_jobs(id,request_id,actor,kind,state,phase,input_json,accepted_at,updated_at) VALUES('native-hold-backup','native-hold-request','admin@example.test','backup','queued','snapshot','{}',?,?)").bind(at, at),
    db.prepare("INSERT INTO blob_gc_ledger(store_kind,provider,object_key,state,operation_id,orphaned_at,deletion_started_at,deleted_at,attempt_count,updated_at) VALUES('r2','r2','claimed-source','deleted','native-old-claim',?,?,?,1,?)").bind(at, at, at, at),
  ]);
  expect(await db.prepare("SELECT first_state FROM file_shadow_legacy_deletion_claims WHERE object_key='claimed-source'").first()).toEqual({ first_state: "deleted" });
}

async function qualifyNativeHistoricalHolds(lateFailure: boolean): Promise<void> {
  const persist = await mkdtemp(join(tmpdir(), "historical-backup-holds-"));
  let native: Miniflare | undefined;
  try {
    native = new Miniflare({ modules: true, script: await workerSource(), compatibilityDate: "2026-07-20",
      d1Databases: { DB: crypto.randomUUID() }, d1Persist: join(persist, "d1"), log: new Log(LogLevel.ERROR) });
    const source = await native.getD1Database("DB"); await installHistorical(source); await populate(source);
    const response = await native.dispatchFetch("https://qualification.invalid/", { method: "POST", body: JSON.stringify({ createdAt: at, lateFailure }) });
    const result = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Native hold response is not an object");
    if (lateFailure) {
      if (!("error" in result) || typeof result.error !== "string") throw new Error("Native late failure has no error string");
      expect(response.status).toBe(500);
      expect(result).toMatchObject({ batches: 1, providerAttempts: 0 });
      expect(result.error).toContain("malformed JSON");
      expect(await source.prepare("SELECT count(*) n FROM system_recovery_legacy_holds").first()).toEqual({ n: 0 });
      expect(await source.prepare("SELECT title FROM samples WHERE id='native-hold-sample'").first()).toEqual({ title: "Native retained" });
      expect((await source.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
      return;
    }
    if (response.status !== 200) throw new Error(`Native default V1 hold failure: ${JSON.stringify(result)}`);
    expect(result).toMatchObject({ schema: "system-backup-records/1", contentSchema: 24, imageVersion: 1,
      sampleTitle: "Native retained", batches: 1, providerAttempts: 0 });
    if (!("holds" in result) || !Array.isArray(result.holds)) throw new Error("Native successful response has no hold rows");
    expect(result.holds).toEqual(["Kept-Source", "kept-source"].map(object_key => ({ store_kind: "r2", provider: "r2", object_key, released_at: null })));
    expect(await source.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='local_accounts'").first()).toEqual({ n: 0 });
    expect((await source.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    try { if (native) await native.dispose(); }
    finally { await rm(persist, { recursive: true, force: true }); }
  }
}
it("captures the genuine 22-migration default V1 backup with native holds, duplicates and deletion fences", () => qualifyNativeHistoricalHolds(false), 45_000);
it("rolls back genuine native 22-migration hold writes after a late failure in the sole V1 capture batch", () => qualifyNativeHistoricalHolds(true), 45_000);
