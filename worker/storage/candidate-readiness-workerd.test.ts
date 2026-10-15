import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { checkedStorageCandidateCheck } from "../../shared/contracts/storage-candidate-check";
import { checkedStorageCandidateReadiness } from "../../shared/contracts/storage-candidate-readiness";
import { checkedStorageCredentialReenvelopeReceipt } from "../../shared/contracts/storage-credential-reenvelope";
import type { StorageCandidate } from "../../shared/contracts/storage-configuration";

const oldKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(19)));
const nextKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(29)));
const oldKeyring = { version: 1, currentKeyId: "fixture-old", keys: { "fixture-old": oldKey } };
const nextKeyring = { version: 1, currentKeyId: "fixture-next", keys: { "fixture-old": oldKey, "fixture-next": nextKey } };
const nextOnlyKeyring = { version: 1, currentKeyId: "fixture-next", keys: { "fixture-next": nextKey } };
const candidate = { expectedRevision: null, label: "Native readiness fixture", namespace: { kind: "s3", endpoint: "https://objects.example.test",
  bucket: "test-bucket", region: "region-one", root: "", forcePathStyle: true },
  credentials: { mode: "replace", value: { accessKeyId: "fixture-id", secretAccessKey: "fixture-secret" } } };
const tables = ["system_storage_profiles", "system_storage_configuration_revisions", "system_storage_credential_descriptors",
  "system_storage_credential_payloads", "system_storage_configuration_audit", "system_storage_candidate_checks",
  "system_storage_candidate_check_audit", "system_storage_credential_reenvelopes"];

async function fixture() {
  const bundle = await build({ stdin: { contents: `
    import {saveStorageCandidate} from './configuration-registry';
    import {startStorageCandidateCheck} from './candidate-check-service';
    import {reenvelopeStoredStorageCredential} from './credential-reenvelope-service';
    import {readStorageCandidateReadiness} from './candidate-readiness-service';
    const objects=new Map(),calls=[];
    let unexpectedFetches=0;
    globalThis.fetch=async()=>{unexpectedFetches++;throw new Error('Readiness must not contact a provider');};
    export default {async fetch(request,env){
      const input=await request.json(),actor=input.actor||'admin@example.test';
      const serviceEnv={...env,...('keyring' in input?{STORAGE_CREDENTIAL_KEYRING:JSON.stringify(input.keyring)}:{})};
      const options={fetch:async request=>{
        calls.push(request.method);
        if(request.method==='PUT'){objects.set(request.url,await request.arrayBuffer());return new Response(null,{status:200});}
        if(request.method==='DELETE'){objects.delete(request.url);return new Response(null,{status:204});}
        const value=objects.get(request.url);if(!value)return new Response(null,{status:404});
        return new Response(request.method==='HEAD'?null:value.slice(0),{headers:{'content-length':String(value.byteLength),'content-type':'application/octet-stream'}});
      }};
      let reads=0;
      function readOnly(database){return {
        withSession:constraint=>readOnly(database.withSession(constraint)),
        batch:()=>{throw new Error('Readiness attempted a batch');},exec:()=>{throw new Error('Readiness attempted exec');},
        prepare:sql=>{
          if(!/^\\s*(SELECT|WITH)\\b/i.test(sql))throw new Error('Readiness attempted a mutation');
          function statement(value){return {
            bind:(...values)=>statement(value.bind(...values)),
            run:()=>{throw new Error('Readiness attempted run');},
            first:async(...args)=>{
              const result=await value.first(...args);
              if(++reads===1&&input.change){
                if(input.change.action==='save')await saveStorageCandidate(serviceEnv,input.change.command,actor);
                else await reenvelopeStoredStorageCredential(serviceEnv,input.change.command,actor);
              }
              return result;
            },all:value.all.bind(value),raw:value.raw.bind(value),
          };}return statement(database.prepare(sql));
        },
      };}
      try{
        let value;
        if(input.action==='save')value=await saveStorageCandidate(serviceEnv,input.command,actor);
        else if(input.action==='start')value=await startStorageCandidateCheck(serviceEnv,input.command,actor,options);
        else if(input.action==='reenvelope')value=await reenvelopeStoredStorageCredential(serviceEnv,input.command,actor);
        else if(input.action==='readiness')value=await readStorageCandidateReadiness({...serviceEnv,DB:readOnly(env.DB)},input.command,actor);
        else value={calls,remaining:objects.size,unexpectedFetches};
        return Response.json(value);
      }catch(error){return Response.json({error:error.message},{status:error.status||503});}
    }};`, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" },
    bundle: true, format: "esm", platform: "browser", write: false });
  const native = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-20", d1Databases: ["DB"],
    log: new Log(LogLevel.ERROR), bindings: { AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "admin@example.test", STORAGE_CREDENTIAL_KEYRING: JSON.stringify(oldKeyring) } });
  try {
    const db = await native.getD1Database("DB");
    for (const filename of ["0014_fp2_storage_configuration.sql", "0015_fp2_storage_candidate_checks.sql", "0016_fp2_credential_reenvelopes.sql"])
      await db.batch(splitSql(readFileSync(new URL(`../../migrations/${filename}`, import.meta.url), "utf8")).map(statement => db.prepare(statement)));
    const call = async (input: unknown) => {
      const response = await native.dispatchFetch("https://fixture.test", { method: "POST", body: JSON.stringify(input) });
      return { status: response.status, body: await response.json() };
    };
    const save = async (command: unknown = candidate) => {
      const result = await call({ action: "save", command }); expect(result.status).toBe(200); return result.body as StorageCandidate;
    };
    const readiness = async (saved: StorageCandidate, extra: Record<string, unknown> = {}) => {
      const result = await call({ action: "readiness", command: { profileId: saved.profileId, expectedRevision: saved.revision }, ...extra });
      expect(result.status, JSON.stringify(result.body)).toBe(200); return checkedStorageCandidateReadiness(result.body);
    };
    const check = async (saved: StorageCandidate, checkId: string, keyring = oldKeyring) => {
      const result = await call({ action: "start", command: { checkId, profileId: saved.profileId, expectedRevision: saved.revision }, keyring });
      expect(result.status).toBe(200); expect(checkedStorageCandidateCheck(result.body)).toMatchObject({ status: "succeeded", cleanup: "confirmed_absent" });
      return checkedStorageCandidateCheck(result.body);
    };
    const snapshot = async () => Promise.all(tables.map(async table => ({ table, rows: (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results })));
    return { db, call, save, readiness, check, snapshot, dispose: () => native.dispose() };
  } catch (error) { await native.dispose(); throw error; }
}
function rotation(saved: StorageCandidate, operationId: string, expectedEnvelopeRevision = 1) {
  return { operationId, profileId: saved.profileId, revision: saved.revision, credentialRef: saved.credentials.ref, expectedEnvelopeRevision };
}
function revised(saved: StorageCandidate) {
  return { ...candidate, profileId: saved.profileId, expectedRevision: saved.revision, namespace: { ...candidate.namespace, region: "region-two" } };
}
type NativeFixture = Awaited<ReturnType<typeof fixture>>;
/** Construct retained receipts through their actual acceptance and outcome
 * guards. Only the first receipt needs a provider probe; large history here
 * qualifies aggregation rather than repeating provider qualification. */
async function acceptedHistory(f: NativeFixture, sourceId: string, id: string, createdAt: string,
  outcome: "succeeded" | "uncertain" | "expired") {
  const source = await f.db.prepare("SELECT * FROM system_storage_candidate_checks WHERE id=?").bind(sourceId).first<Record<string, string | number | null>>();
  const row = { ...source!, id, probe_key: `__fp2_checks/${id}/retained-native-fixture`, execution_kind: "check", execution_token: `fixture-${id}`,
    execution_deadline: new Date(Date.parse(createdAt) + 60_000).toISOString(), status: "running", write_outcome: "pending", read_outcome: "pending",
    metadata_outcome: "pending", delete_outcome: "pending", cleanup_outcome: "pending", result_code: null, created_at: createdAt, updated_at: createdAt, completed_at: null };
  const entries = Object.entries(row);
  const statements = [f.db.prepare(`INSERT INTO system_storage_candidate_checks (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`)
    .bind(...entries.map(([, value]) => value))];
  if (outcome !== "expired") {
    statements.push(f.db.prepare("UPDATE system_storage_candidate_checks SET write_outcome='unknown' WHERE id=?").bind(id));
    const completedAt = new Date(Date.parse(createdAt) + 1_000).toISOString();
    statements.push(f.db.prepare(outcome === "succeeded"
      ? "UPDATE system_storage_candidate_checks SET status='succeeded',write_outcome='acknowledged',read_outcome='verified',metadata_outcome='verified',delete_outcome='acknowledged',cleanup_outcome='confirmed_absent',updated_at=?,completed_at=? WHERE id=?"
      : "UPDATE system_storage_candidate_checks SET status='failed',read_outcome='failed',cleanup_outcome='required',result_code='provider_unavailable',updated_at=?,completed_at=? WHERE id=?")
      .bind(completedAt, completedAt, id));
  }
  await f.db.batch(statements);
}

describe("candidate readiness with native Worker crypto and D1", () => {
  it("retains historical success but matches the exact envelope only until re-enveloping, without writes or provider I/O", async () => {
    const f = await fixture();
    try {
      const saved = await f.save(), id = "11111111-1111-4111-8111-111111111111";
      const checked = await f.check(saved, id);
      const snapshot = await f.snapshot(), io = (await f.call({ action: "io" })).body;
      const first = await f.readiness(saved);
      expect(first).toMatchObject({ credential: { envelopeRevision: 1, status: "current" }, evidence: {
        currentConfigurationSuccessCount: 1, historicalConfigurationSuccessCount: 0,
        exactCurrentContextSuccess: { checkId: id, completedAt: checked.completedAt }, inProgressCount: 0, unresolvedCleanupCount: 0 }, canActivate: false });
      expect((await f.readiness(saved, { keyring: nextKeyring })).credential).toEqual({ envelopeRevision: 1, status: "needs_reenvelope" });
      expect((await f.readiness(saved, { keyring: null })).credential).toEqual({ envelopeRevision: 1, status: "unavailable" });
      expect(await f.snapshot()).toEqual(snapshot); expect((await f.call({ action: "io" })).body).toEqual(io);
      const captured = await f.db.prepare("SELECT * FROM system_storage_candidate_checks WHERE id=?").bind(id).first();
      const rotated = await f.call({ action: "reenvelope", command: rotation(saved, "22222222-2222-4222-8222-222222222222"), keyring: nextKeyring });
      expect(rotated.status).toBe(200); expect(checkedStorageCredentialReenvelopeReceipt(rotated.body).outcome).toBe("reenveloped");
      expect(await f.db.prepare("SELECT * FROM system_storage_candidate_checks WHERE id=?").bind(id).first()).toEqual(captured);
      const afterRotation = await f.readiness(saved, { keyring: nextOnlyKeyring });
      expect(afterRotation).toMatchObject({ credential: { envelopeRevision: 2, status: "current" }, evidence: {
        currentConfigurationSuccessCount: 1, historicalConfigurationSuccessCount: 0, exactCurrentContextSuccess: null } });
      const secondId = "33333333-3333-4333-8333-333333333333";
      await f.check(saved, secondId, nextKeyring);
      const beforeNoop = await f.readiness(saved, { keyring: nextOnlyKeyring });
      expect(beforeNoop.evidence).toMatchObject({ currentConfigurationSuccessCount: 2, exactCurrentContextSuccess: { checkId: secondId } });
      const current = await f.call({ action: "reenvelope", command: rotation(saved, "44444444-4444-4444-8444-444444444444", 2), keyring: nextOnlyKeyring });
      expect(current.status).toBe(200); expect(checkedStorageCredentialReenvelopeReceipt(current.body).outcome).toBe("already_current");
      const afterNoop = await f.readiness(saved, { keyring: nextOnlyKeyring });
      expect(afterNoop.credential).toEqual(beforeNoop.credential); expect(afterNoop.evidence).toEqual(beforeNoop.evidence);
      const next = await f.save(revised(saved));
      expect((await f.readiness(next)).evidence).toEqual({ currentConfigurationSuccessCount: 0, historicalConfigurationSuccessCount: 2,
        exactCurrentContextSuccess: null, inProgressCount: 0, unresolvedCleanupCount: 0 });
      const finalIo = (await f.call({ action: "io" })).body as { calls: string[]; remaining: number; unexpectedFetches: number };
      expect(finalIo.calls.filter(method => method === "PUT")).toHaveLength(2); expect(finalIo.remaining).toBe(0); expect(finalIo.unexpectedFetches).toBe(0);
      expect((await f.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally { await f.dispose(); }
  }, 60_000);

  it("aggregates beyond fifty retained checks and observes expired leases without reconciling or losing older cleanup uncertainty", async () => {
    const f = await fixture();
    try {
      const first = await f.save(), historicalId = "55555555-5555-4555-8555-555555555555";
      await f.check(first, historicalId);
      await acceptedHistory(f, historicalId, "66666666-6666-4666-8666-666666666666", "2026-08-01T00:00:00.000Z", "uncertain");
      const current = await f.save(revised(first)), seed = "77777777-7777-4777-8777-777777777777";
      const checked = await f.check(current, seed);
      for (let index = 1; index <= 51; index++)
        await acceptedHistory(f, seed, `80000000-0000-4000-8000-${String(index).padStart(12, "0")}`, `2026-09-01T00:${String(index).padStart(2, "0")}:00.000Z`, "succeeded");
      const expiredId = "99999999-9999-4999-8999-999999999999";
      await acceptedHistory(f, seed, expiredId, "2026-09-02T00:00:00.000Z", "expired");
      const latest = (await f.db.prepare("SELECT id FROM system_storage_candidate_checks ORDER BY created_at DESC,id LIMIT 50").all()).results;
      expect(latest).toHaveLength(50); expect(latest).not.toContainEqual({ id: "66666666-6666-4666-8666-666666666666" });
      const before = await f.snapshot(), io = (await f.call({ action: "io" })).body;
      const report = await f.readiness(current);
      expect(report.evidence).toEqual({ currentConfigurationSuccessCount: 52, historicalConfigurationSuccessCount: 1,
        exactCurrentContextSuccess: { checkId: seed, completedAt: checked.completedAt }, inProgressCount: 1, unresolvedCleanupCount: 2 });
      expect(await f.snapshot()).toEqual(before); expect((await f.call({ action: "io" })).body).toEqual(io);
      expect(await f.db.prepare("SELECT status,cleanup_outcome FROM system_storage_candidate_checks WHERE id=?").bind(expiredId).first())
        .toEqual({ status: "running", cleanup_outcome: "pending" });
      expect((await f.db.prepare("SELECT count(*) n FROM system_storage_candidate_checks").first<{ n: number }>())!.n).toBe(55);
      expect((await f.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally { await f.dispose(); }
  }, 60_000);

  it("enforces service authorization and rejects a configuration or envelope changed between authentication and final evidence observation", async () => {
    const f = await fixture();
    try {
      const saved = await f.save(), command = { profileId: saved.profileId, expectedRevision: 1 };
      const before = await f.snapshot();
      expect((await f.call({ action: "readiness", command, actor: "reader@example.test" })).status).toBe(403);
      expect((await f.call({ action: "readiness", command: { ...command, profileId: "missing" } })).status).toBe(404);
      expect((await f.call({ action: "readiness", command: { ...command, expectedRevision: 2 } })).status).toBe(409);
      expect(await f.snapshot()).toEqual(before);
      const changedEnvelope = await f.call({ action: "readiness", command, keyring: nextKeyring,
        change: { action: "reenvelope", command: rotation(saved, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") } });
      expect(changedEnvelope.status).toBe(409);
      expect((await f.readiness(saved, { keyring: nextOnlyKeyring })).credential).toEqual({ envelopeRevision: 2, status: "current" });
      const changedConfiguration = await f.call({ action: "readiness", command, keyring: nextKeyring, change: { action: "save", command: revised(saved) } });
      expect(changedConfiguration.status).toBe(409);
      expect((await f.call({ action: "io" })).body).toEqual({ calls: [], remaining: 0, unexpectedFetches: 0 });
      expect((await f.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally { await f.dispose(); }
  }, 60_000);
});
