import { build } from "esbuild";
import { Log, LogLevel, Miniflare, Response as MiniflareResponse } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { expect, it } from "vitest";
import type { StorageCandidate } from "../../shared/contracts/storage-configuration";
import { checkedStorageProfileAdmissionReceipt } from "../../shared/contracts/storage-profile-admission";

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(19)));
const nextKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(29)));
const oldRing = { version: 1, currentKeyId: "old", keys: { old: key } };
const nextRing = { version: 1, currentKeyId: "next", keys: { old: key, next: nextKey } };
const candidate = { expectedRevision: null, label: "Native admission fixture", namespace: { kind: "s3",
  endpoint: "https://s3.eu-central-1.amazonaws.com", region: "eu-central-1", bucket: "admission-fixture",
  root: "", forcePathStyle: true, expectedBucketOwner: "111122223333" },
  credentials: { mode: "replace", value: { accessKeyId: "fixture-id", secretAccessKey: "fixture-secret" } } };

it("atomically registers once in native D1, performs no admission I/O, and rejects candidate/envelope changes at publication", async () => {
  const bundle = await build({ stdin: { contents: `
    import {saveStorageCandidate} from './configuration-registry';
    import {startStorageCandidateCheck} from './candidate-check-service';
    import {registerStorageProfile} from './storage-profile-admission-service';
    import {reenvelopeStoredStorageCredential} from './credential-reenvelope-service';
    let providerCalls=0,unexpectedFetches=0;const objects=new Map();
    globalThis.fetch=async()=>{unexpectedFetches++;throw new Error('Live provider access forbidden');};
    export default {async fetch(request,env){
      const input=await request.json(),actor='admin@example.test';
      const provider={fetch:async request=>{
        providerCalls++;
        if(request.method==='PUT'){objects.set(request.url,await request.arrayBuffer());return new Response(null,{status:200});}
        if(request.method==='DELETE'){objects.delete(request.url);return new Response(null,{status:204});}
        const body=objects.get(request.url);if(!body)return new Response(null,{status:404});
        return new Response(request.method==='HEAD'?null:body.slice(0),{headers:{'content-length':String(body.byteLength)}});
      }};
      try{
        let value;
        if(input.action==='save')value=await saveStorageCandidate(env,input.command,actor);
        else if(input.action==='check')value=await startStorageCandidateCheck(env,input.command,actor,provider);
        else if(input.action==='register'){
          const scoped={...env,DB:{prepare:env.DB.prepare.bind(env.DB),batch:async statements=>{
            if(input.barrier){const gate=await env.GATE.fetch('https://gate.test/');if(gate.status!==204)throw new Error('Native race gate failed');}
            if(input.change?.action==='save')await saveStorageCandidate(env,input.change.command,actor);
            if(input.change?.action==='reenvelope')await reenvelopeStoredStorageCredential({...env,STORAGE_CREDENTIAL_KEYRING:JSON.stringify(input.change.keyring)},input.change.command,actor);
            return env.DB.batch(statements);
          }}};
          value=await registerStorageProfile(scoped,input.command,actor);
        }else value={providerCalls,unexpectedFetches,remaining:objects.size};
        return Response.json(value);
      }catch(error){return Response.json({error:error.message},{status:error.status||503});}
    }};`, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" },
    bundle: true, format: "esm", platform: "browser", write: false });
  let arrivals = 0, release: (ok: boolean) => void = () => undefined;
  const gate = new Promise<boolean>(resolve => { release = resolve; });
  const timers: ReturnType<typeof setTimeout>[] = [];
  const native = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-20",
    d1Databases: ["DB"], log: new Log(LogLevel.ERROR), bindings: { AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "admin@example.test",
      STORAGE_CREDENTIAL_KEYRING: JSON.stringify(oldRing) }, serviceBindings: { GATE: async () => {
        if (++arrivals === 2) release(true);
        else timers.push(setTimeout(() => release(false), 3_000));
        return new MiniflareResponse(null, { status: await gate ? 204 : 503 });
      } } });
  try {
    const db = await native.getD1Database("DB"), migrations = new URL("../../migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort())
      await db.batch(splitSql(readFileSync(new URL(name, migrations), "utf8")).map(sql => db.prepare(sql)));
    const call = async (input: unknown) => {
      const response = await native.dispatchFetch("https://fixture.test", { method: "POST", body: JSON.stringify(input) });
      return { status: response.status, body: await response.json() };
    };
    const save = async (command: unknown) => {
      const result = await call({ action: "save", command }); expect(result.status, JSON.stringify(result.body)).toBe(200);
      return result.body as StorageCandidate;
    };
    const check = async (saved: StorageCandidate, checkId: string) => {
      const result = await call({ action: "check", command: { checkId, profileId: saved.profileId, expectedRevision: saved.revision } });
      expect(result.status).toBe(200); expect(result.body).toMatchObject({ status: "succeeded" });
    };
    const saved = await save(candidate), firstCheck = "11111111-1111-4111-8111-111111111111";
    await check(saved, firstCheck);
    const input = { operationId: "22222222-2222-4222-8222-222222222222", profileId: saved.profileId,
      expectedRevision: 1, expectedEnvelopeRevision: 1, checkId: firstCheck };
    const before = await call({ action: "io" });
    const simultaneous = await Promise.all([call({ action: "register", command: input, barrier: true }), call({ action: "register", command: input, barrier: true })]);
    for (const result of simultaneous) expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(arrivals).toBe(2); expect(simultaneous[0].body).toEqual(simultaneous[1].body);
    const receipt = checkedStorageProfileAdmissionReceipt(simultaneous[0].body);
    expect(receipt).toMatchObject({ profileId: saved.profileId, revision: 1, runtimeAccess: "read_only" });
    expect(await call({ action: "io" })).toEqual(before);
    expect(await db.prepare("SELECT count(*) n FROM storage_profile_admissions").first()).toEqual({ n: 1 });
    expect(await db.prepare("SELECT count(*) n FROM file_locations").first()).toEqual({ n: 0 });

    const other = await save({ ...candidate, namespace: { ...candidate.namespace, bucket: "admission-race-fixture" } });
    const otherCheck = "33333333-3333-4333-8333-333333333333";
    await check(other, otherCheck);
    const otherInput = { ...input, operationId: "44444444-4444-4444-8444-444444444444", profileId: other.profileId, checkId: otherCheck };
    const revisionRace = await call({ action: "register", command: otherInput, change: { action: "save", command: {
      ...candidate, profileId: other.profileId, expectedRevision: 1, label: "Changed before admission", namespace: other.namespace,
      credentials: { mode: "retain" },
    } } });
    expect(revisionRace.status, JSON.stringify(revisionRace.body)).toBe(409);
    const revised = { ...other, revision: 2 }, revisedCheck = "55555555-5555-4555-8555-555555555555";
    await check(revised, revisedCheck);
    const payload = await db.prepare("SELECT credential_ref FROM system_storage_configuration_revisions WHERE profile_id=? AND revision=2")
      .bind(other.profileId).first<{ credential_ref: string }>();
    const envelopeRace = await call({ action: "register", command: { ...otherInput, expectedRevision: 2, checkId: revisedCheck },
      change: { action: "reenvelope", keyring: nextRing, command: { operationId: "66666666-6666-4666-8666-666666666666",
        profileId: other.profileId, revision: 2, credentialRef: payload!.credential_ref, expectedEnvelopeRevision: 1 } } });
    expect(envelopeRace.status, JSON.stringify(envelopeRace.body)).toBe(409);
    expect(await db.prepare("SELECT count(*) n FROM storage_profile_admissions").first()).toEqual({ n: 1 });
    expect(await db.prepare("SELECT count(*) n FROM storage_profiles WHERE adapter_type='s3'").first()).toEqual({ n: 1 });
    expect((await call({ action: "register", command: input })).body).toEqual(receipt);
    expect((await call({ action: "io" })).body).toEqual({ providerCalls: 15, unexpectedFetches: 0, remaining: 0 });
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally { for (const timer of timers) clearTimeout(timer); await native.dispose(); }
}, 60_000);
