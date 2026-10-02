import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { checkedStorageCandidateCheck } from "../../shared/contracts/storage-candidate-check";
import { checkedStorageCandidateReadiness } from "../../shared/contracts/storage-candidate-readiness";
import type { StorageCandidate } from "../../shared/contracts/storage-configuration";

const bucketOwner = "111122223333", changedOwner = "444455556666";
const candidate = { expectedRevision: null, label: "Native owner binding fixture", namespace: {
  kind: "s3", endpoint: "https://s3.eu-central-1.amazonaws.com", bucket: "owner-binding-fixture", region: "eu-central-1",
  root: "probes", forcePathStyle: true, expectedBucketOwner: bucketOwner,
}, credentials: { mode: "replace", value: { accessKeyId: "fixture-id", secretAccessKey: "fixture-secret" } } };
interface ProviderCall { checkId: string; method: string; owner: string | null; authorization: string | null }
interface ProviderState { calls: ProviderCall[]; remaining: number; unexpectedFetches: number }

// Native Worker crypto and D1 exercise our application contract. The independent
// fake below enforces the owner header; this is not live AWS/provider acceptance.
async function fixture() {
  const bundle = await build({ stdin: { contents: `
    import {saveStorageCandidate} from './configuration-registry';
    import {startStorageCandidateCheck,cleanupStorageCandidateCheck} from './candidate-check-service';
    import {readStorageCandidateReadiness} from './candidate-readiness-service';
    const objects=new Map(),calls=[];
    let denyDelete=false,unexpectedFetches=0;
    globalThis.fetch=async()=>{unexpectedFetches++;throw new Error('Live network is forbidden in this fixture');};
    export default {async fetch(request,env){
      const input=await request.json(),actor='admin@example.test';
      const options={fetch:async request=>{
        const key=decodeURIComponent(new URL(request.url).pathname).slice('/owner-binding-fixture/probes/'.length);
        const accepted=await env.DB.prepare('SELECT id,write_outcome FROM system_storage_candidate_checks WHERE probe_key=?').bind(key).first();
        if(!accepted||request.method==='PUT'&&accepted.write_outcome!=='unknown')throw new Error('I/O without durable acceptance');
        const owner=request.headers.get('x-amz-expected-bucket-owner');
        calls.push({checkId:accepted.id,method:request.method,owner,authorization:request.headers.get('authorization')});
        // Provider ownership is a fixed fixture fact, never derived from the
        // candidate or its captured receipt. Omission also fails closed here.
        if(owner!=='111122223333')return new Response(null,{status:403});
        if(request.method==='PUT'){objects.set(request.url,await request.arrayBuffer());return new Response(null,{status:200});}
        if(request.method==='DELETE'){
          if(denyDelete)return new Response(null,{status:403});
          objects.delete(request.url);return new Response(null,{status:204});
        }
        const value=objects.get(request.url);if(!value)return new Response(null,{status:404});
        return new Response(request.method==='HEAD'?null:value.slice(0),{headers:{'content-length':String(value.byteLength),'content-type':'application/octet-stream'}});
      }};
      try{
        let value;
        if(input.action==='save')value=await saveStorageCandidate(env,input.command,actor);
        else if(input.action==='start')value=await startStorageCandidateCheck(env,input.command,actor,options);
        else if(input.action==='cleanup')value=await cleanupStorageCandidateCheck(env,input.id,actor,options);
        else if(input.action==='readiness')value=await readStorageCandidateReadiness(env,input.command,actor);
        else if(input.action==='denyDelete'){denyDelete=input.value;value={ok:true};}
        else value={calls,remaining:objects.size,unexpectedFetches};
        return Response.json(value);
      }catch(error){return Response.json({error:error.message},{status:error.status||503});}
    }};`, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" },
    bundle: true, format: "esm", platform: "browser", write: false });
  const native = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-20", d1Databases: ["DB"],
    log: new Log(LogLevel.ERROR), bindings: { AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "admin@example.test",
      STORAGE_CREDENTIAL_KEYRING: JSON.stringify({ version: 1, currentKeyId: "fixture-key",
        keys: { "fixture-key": btoa(String.fromCharCode(...new Uint8Array(32).fill(19))) } }) } });
  try {
    const db = await native.getD1Database("DB");
    for (const filename of ["0014_fp2_storage_configuration.sql", "0015_fp2_storage_candidate_checks.sql"])
      await db.batch(splitSql(readFileSync(new URL(`../../migrations/${filename}`, import.meta.url), "utf8")).map(statement => db.prepare(statement)));
    const call = async (input: unknown) => {
      const response = await native.dispatchFetch("https://fixture.test", { method: "POST", body: JSON.stringify(input) });
      const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200); return body;
    };
    const save = async (command: unknown = candidate) => await call({ action: "save", command }) as StorageCandidate;
    const check = async (saved: StorageCandidate, checkId: string) => checkedStorageCandidateCheck(await call({ action: "start",
      command: { checkId, profileId: saved.profileId, expectedRevision: saved.revision } }));
    const readiness = async (saved: StorageCandidate) => checkedStorageCandidateReadiness(await call({ action: "readiness",
      command: { profileId: saved.profileId, expectedRevision: saved.revision } }));
    const io = async () => await call({ action: "io" }) as ProviderState;
    return { db, call, save, check, readiness, io, dispose: () => native.dispose() };
  } catch (error) { await native.dispose(); throw error; }
}

describe("S3 expected bucket owner with native Worker crypto and D1", () => {
  it("binds every probe and original-context cleanup, invalidates current evidence on edit, and never retries a denied PUT without the owner", async () => {
    const f = await fixture();
    try {
      const first = await f.save(), successId = "11111111-1111-4111-8111-111111111111";
      expect(first.namespace).toMatchObject({ expectedBucketOwner: bucketOwner });
      const success = await f.check(first, successId);
      expect(success).toMatchObject({ revision: 1, status: "succeeded", write: "passed", read: "passed", metadata: "passed", cleanup: "confirmed_absent" });
      expect((await f.readiness(first)).evidence).toMatchObject({ currentConfigurationSuccessCount: 1,
        historicalConfigurationSuccessCount: 0, exactCurrentContextSuccess: { checkId: successId, completedAt: success.completedAt } });
      const firstIo = await f.io();
      expect(firstIo.calls.map(call => call.method)).toEqual(["PUT", "GET", "HEAD", "DELETE", "HEAD"]);

      // Retain a real cleanup obligation before editing the candidate owner.
      await f.call({ action: "denyDelete", value: true });
      const cleanupId = "22222222-2222-4222-8222-222222222222";
      expect(await f.check(first, cleanupId)).toMatchObject({ revision: 1, status: "failed", write: "passed", cleanup: "required" });
      const captured = await f.db.prepare("SELECT namespace_json,configuration_sha256,namespace_sha256 FROM system_storage_candidate_checks WHERE id=?")
        .bind(cleanupId).first<{ namespace_json: string; configuration_sha256: string; namespace_sha256: string }>();
      expect(JSON.parse(captured!.namespace_json).expectedBucketOwner).toBe(bucketOwner);

      const next = await f.save({ ...candidate, profileId: first.profileId, expectedRevision: first.revision,
        namespace: { ...candidate.namespace, expectedBucketOwner: changedOwner }, credentials: { mode: "retain" } });
      expect(next).toMatchObject({ profileId: first.profileId, revision: 2, namespace: { expectedBucketOwner: changedOwner } });
      const beforeRead = await f.io();
      expect((await f.readiness(next)).evidence).toEqual({ currentConfigurationSuccessCount: 0,
        historicalConfigurationSuccessCount: 1, exactCurrentContextSuccess: null, inProgressCount: 0, unresolvedCleanupCount: 1 });
      expect(await f.io()).toEqual(beforeRead);

      await f.call({ action: "denyDelete", value: false });
      expect(checkedStorageCandidateCheck(await f.call({ action: "cleanup", id: cleanupId })))
        .toMatchObject({ revision: 1, status: "failed", cleanup: "confirmed_absent" });
      const afterCleanup = await f.io();
      expect(afterCleanup.calls.slice(beforeRead.calls.length).map(call => ({ method: call.method, owner: call.owner })))
        .toEqual([{ method: "DELETE", owner: bucketOwner }, { method: "HEAD", owner: bucketOwner }]);
      expect(afterCleanup.remaining).toBe(0);
      expect(await f.db.prepare("SELECT namespace_json,configuration_sha256,namespace_sha256 FROM system_storage_candidate_checks WHERE id=?")
        .bind(cleanupId).first()).toEqual(captured);

      const deniedId = "33333333-3333-4333-8333-333333333333";
      const denied = await f.check(next, deniedId);
      expect(denied).toMatchObject({ revision: 2, status: "failed", write: "unknown", cleanup: "required", code: "provider_unavailable" });
      const afterDenied = await f.io(), deniedCalls = afterDenied.calls.filter(call => call.checkId === deniedId);
      expect(deniedCalls.map(call => call.method)).toEqual(["PUT", "DELETE", "HEAD"]);
      expect(deniedCalls.every(call => call.owner === changedOwner)).toBe(true);
      expect(await f.check(next, deniedId)).toEqual(denied);
      expect(await f.io()).toEqual(afterDenied);
      expect((await f.readiness(next)).evidence).toEqual({ currentConfigurationSuccessCount: 0,
        historicalConfigurationSuccessCount: 1, exactCurrentContextSuccess: null, inProgressCount: 0, unresolvedCleanupCount: 1 });

      for (const call of afterDenied.calls) {
        expect(call.owner).toBe(call.checkId === deniedId ? changedOwner : bucketOwner);
        expect(call.authorization?.match(/SignedHeaders=([^,]+)/)?.[1].split(";"))
          .toContain("x-amz-expected-bucket-owner");
      }
      expect(afterDenied.calls.filter(call => call.method === "PUT")).toHaveLength(3);
      expect(afterDenied.remaining).toBe(0); expect(afterDenied.unexpectedFetches).toBe(0);
      expect((await f.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally { await f.dispose(); }
  }, 30_000);
});
