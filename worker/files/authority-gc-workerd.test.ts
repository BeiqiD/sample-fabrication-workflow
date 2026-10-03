import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { expect, it } from "vitest";

const OLD = "2026-09-01T00:00:00.000Z";
const NOW = "2026-10-04T00:00:00.000Z";
const RECLAIMED = "2026-10-04T00:16:00.000Z";
const KEY = "owned/file";
const SHA = "a".repeat(64);
const namespace = JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "native-gc-fixture" });

const bundledWorker = build({ stdin: { contents: `
  import {runFileGarbageCollection} from './authority-gc';
  let unexpectedFetches=0;
  globalThis.fetch=async()=>{unexpectedFetches++;throw new Error('Live provider access forbidden');};
  export default {async fetch(request,bindings){
    const input=await request.json(),constraints=[],deletes=[];
    let paused=false;
    const pause=async()=>{
      if(paused)return;paused=true;
      await bindings.DB.prepare("UPDATE file_authority_runtime_guard SET enabled=0,updated_at=? WHERE singleton=1")
        .bind(input.now).run();
    };
    const DB={withSession:constraint=>{
      constraints.push(constraint);const session=bindings.DB.withSession(constraint);
      return {prepare:sql=>{
        const statement=session.prepare(sql);
        if(input.scenario!=='pause-before-delete'||!sql.startsWith('SELECT 1 AS writable'))return statement;
        return {bind:(...values)=>{
          const bound=statement.bind(...values);
          return {first:async()=>{await pause();return bound.first();}};
        }};
      },batch:statements=>session.batch(statements)};
    }};
    const ASSETS={
      get:key=>bindings.ASSETS.get(key),head:key=>bindings.ASSETS.head(key),
      delete:async key=>{
        deletes.push(key);await bindings.ASSETS.delete(key);
        if(input.scenario==='pause-after-delete')await pause();
        if(input.scenario==='reclaimed-lease')await bindings.DB.prepare(
          "UPDATE file_location_gc_ledger SET attempt_count=attempt_count+1,deletion_started_at=?,updated_at=? WHERE location_id='location'")
          .bind(input.reclaimed,input.reclaimed).run();
      },
    };
    const result=await runFileGarbageCollection({...bindings,DB,ASSETS},new Date(input.now));
    return Response.json({result,deletes,constraints,unexpectedFetches,paused});
  }};`, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" },
  bundle: true, format: "esm", platform: "browser", write: false });

it.each(["baseline", "pause-before-delete", "pause-after-delete", "reclaimed-lease"] as const)(
  "qualifies exact native D1/R2 File deletion and acknowledgment fences: %s", async scenario => {
    const bundle = await bundledWorker;
    const native = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-07-20", d1Databases: ["DB"], r2Buckets: ["ASSETS", "OTHER_ASSETS"],
      log: new Log(LogLevel.ERROR), bindings: { R2_BOOTSTRAP_NAMESPACE: namespace } });
    try {
      const db = await native.getD1Database("DB"), migrations = new URL("../../migrations/", import.meta.url);
      for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort())
        await db.batch(splitSql(readFileSync(new URL(name, migrations), "utf8")).map(sql => db.prepare(sql)));
      // Install one unretained location as a fixture in an atomic batch. Every
      // real lifecycle/runtime guard is restored before the collector executes.
      const { results: triggers } = await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'")
        .all<{ name: string; sql: string }>();
      await db.batch([
        ...triggers.map(trigger => db.prepare(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`)),
        db.prepare("UPDATE file_authority_control SET mode='active',activated_at=?,updated_at=? WHERE singleton=1").bind(OLD, OLD),
        db.prepare("UPDATE file_authority_runtime_guard SET incarnation='native-gc-test',enabled=1,enabled_by='test',updated_at=? WHERE singleton=1").bind(OLD),
        db.prepare("INSERT INTO storage_profiles VALUES('profile','r2',?,'bootstrap',NULL,1,'historical',?)").bind(namespace, OLD),
        db.prepare("INSERT INTO storage_profile_runtime VALUES('profile','read_write',?,?,NULL)").bind(OLD, OLD),
        db.prepare("INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at) VALUES('file','embedded_content','system',4,?,'unresolved',?)").bind(SHA, OLD),
        db.prepare("INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at) VALUES('location','file','profile',?,'unresolved',?)").bind(KEY, OLD),
        db.prepare(`INSERT INTO file_location_publications(location_id,file_id,storage_profile_id,object_key,verified_byte_size,
          verified_sha256,verification_method,verification_operation_id,verified_at,published_at)
          VALUES('location','file','profile',?,4,?,'full_read_sha256','verified',?,?)`).bind(KEY, SHA, OLD, OLD),
        db.prepare(`INSERT INTO file_location_gc_ledger(location_id,state,operation_id,orphaned_at,deletion_started_at,
          deleted_at,attempt_count,last_error,updated_at) VALUES('location','orphaned',NULL,?,NULL,NULL,0,NULL,?)`).bind(OLD, OLD),
        ...triggers.map(trigger => db.prepare(trigger.sql)),
      ]);
      const assets = await native.getR2Bucket("ASSETS"), sibling = await native.getR2Bucket("OTHER_ASSETS");
      await assets.put(KEY, "file"); await sibling.put(KEY, "retained other namespace");
      const response = await native.dispatchFetch("https://fixture.test", { method: "POST",
        body: JSON.stringify({ scenario, now: NOW, reclaimed: RECLAIMED }) });
      expect(response.status, await response.clone().text()).toBe(200);
      const observed = await response.json() as { result: Record<string, number>; deletes: string[]; constraints: string[];
        unexpectedFetches: number; paused: boolean };
      expect(observed.unexpectedFetches).toBe(0);
      expect(observed.constraints.length).toBeGreaterThan(1);
      expect(observed.constraints.every(constraint => constraint === "first-primary")).toBe(true);
      expect(observed.result).toEqual({ orphanCandidatesMarked: 0, imageDeleted: scenario === "baseline" ? 1 : 0,
        managedDeleted: 0, failures: scenario === "baseline" ? 0 : 1 });
      expect(observed.deletes).toEqual(scenario === "pause-before-delete" ? [] : [KEY]);
      expect(await sibling.get(KEY).then(object => object!.text())).toBe("retained other namespace");
      expect(await assets.head(KEY)).toEqual(scenario === "pause-before-delete" ? expect.objectContaining({ size: 4 }) : null);
      const ledger = await db.prepare("SELECT state,attempt_count,deleted_at,last_error FROM file_location_gc_ledger WHERE location_id='location'").first();
      expect(ledger).toEqual({ state: scenario === "baseline" ? "deleted" : "deleting",
        attempt_count: scenario === "reclaimed-lease" ? 2 : 1, deleted_at: scenario === "baseline" ? NOW : null, last_error: null });
      expect(observed.paused).toBe(scenario.startsWith("pause-"));
      expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally { await native.dispose(); }
  }, 60_000);
