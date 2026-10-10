import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { expect, it } from "vitest";

const material = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
const oldRing = { version: 1, currentKeyId: "old", keys: { old: material(11) } };
const newRing = { version: 1, currentKeyId: "new", keys: { old: material(11), new: material(22) } };
const newOnly = { version: 1, currentKeyId: "new", keys: { new: material(22) } };

it("binds native workerd reads to admitted D1 history, fences a wrapping race and preserves native restrictions", async () => {
  const bundle = await build({ stdin: { contents: `
    import {saveStorageCandidate} from './configuration-registry';
    import {startStorageCandidateCheck} from './candidate-check-service';
    import {registerStorageProfile} from './storage-profile-admission-service';
    import {reenvelopeStoredStorageCredential} from './credential-reenvelope-service';
    import {nativeS3ByteReader} from './native-s3-byte-reader';
    let unexpectedFetches=0;
    globalThis.fetch=async()=>{unexpectedFetches++;throw new Error('Live provider access forbidden');};
    export default {async fetch(request,bindings){
      const input=await request.json(),env={...bindings},actor='admin@example.test',calls=[],objects=new Map();
      const namespace={kind:'s3',endpoint:'https://s3.us-east-1.amazonaws.com',region:'us-east-1',
        bucket:'native-reader-fixture',root:'research',forcePathStyle:true,expectedBucketOwner:'111122223333'};
      const provider={fetch:async request=>{
        calls.push({method:request.method,url:request.url,owner:request.headers.get('x-amz-expected-bucket-owner'),
          oldCredential:request.headers.get('authorization').includes('Credential=fixture-old-access/')});
        if(request.method==='PUT'){objects.set(request.url,await request.arrayBuffer());return new Response(null);}
        if(request.method==='DELETE'){objects.delete(request.url);return new Response(null,{status:204});}
        const bytes=objects.get(request.url);if(!bytes)return new Response(null,{status:404});
        return new Response(request.method==='HEAD'?null:bytes.slice(0),{headers:{'content-length':String(bytes.byteLength)}});
      }};
      const candidate={expectedRevision:null,label:'Native reader',namespace,credentials:{mode:'replace',
        value:{accessKeyId:'fixture-old-access',secretAccessKey:'fixture-old-secret'}}};
      const initial=await saveStorageCandidate(env,candidate,actor);
      const saved=await saveStorageCandidate(env,{...candidate,profileId:initial.profileId,expectedRevision:1,
        label:'Revised before registration',credentials:{mode:'retain'}},actor);
      const checked=await startStorageCandidateCheck(env,{checkId:crypto.randomUUID(),profileId:saved.profileId,expectedRevision:2},actor,provider);
      const admitted=await registerStorageProfile(env,{operationId:crypto.randomUUID(),profileId:saved.profileId,expectedRevision:2,
        expectedEnvelopeRevision:1,checkId:checked.id},actor);
      calls.length=0;const url='https://s3.us-east-1.amazonaws.com/native-reader-fixture/research/files/known';
      objects.set(url,new TextEncoder().encode('known bytes').buffer);
      const profile={profileId:admitted.nativeProfileId,configurationRevision:1};
      const reader=nativeS3ByteReader(env,profile,provider),constructedCalls=calls.length;
      await saveStorageCandidate(env,{...candidate,profileId:saved.profileId,expectedRevision:2,
        namespace:{...namespace,forcePathStyle:false,expectedBucketOwner:'999988887777'},
        credentials:{mode:'replace',value:{accessKeyId:'fixture-new-access',secretAccessKey:'fixture-new-secret'}}},actor);
      const observed=await reader.read('files/known');
      const text=observed.outcome==='available'?await new Response(observed.body).text():null;
      env.STORAGE_CREDENTIAL_KEYRING=JSON.stringify(input.newRing);
      let raced=false;const constraints=[];
      const raceEnv={...env,DB:{withSession:constraint=>{
        constraints.push(constraint);const session=env.DB.withSession(constraint);
        return {prepare:sql=>({bind:(...values)=>({first:async()=>{
          if(sql.startsWith('SELECT 1 AS bound')&&!raced){
            raced=true;await reenvelopeStoredStorageCredential(env,{operationId:crypto.randomUUID(),profileId:saved.profileId,
              revision:2,credentialRef:saved.credentials.ref,expectedEnvelopeRevision:1},actor);
          }return session.prepare(sql).bind(...values).first();
        }})})};
      }}};
      const racedReader=nativeS3ByteReader(raceEnv,profile,provider),beforeRace=calls.length;
      const race=await racedReader.stat('files/known'),raceCalls=calls.length-beforeRace;
      env.STORAGE_CREDENTIAL_KEYRING=JSON.stringify(input.newOnly);
      const afterRotation=await reader.stat('files/known');
      const absent=nativeS3ByteReader({...env,DB:{prepare:()=>{throw new Error('Installation state absent');}}},profile,provider);
      const beforeAbsent=calls.length,restored=await absent.read('files/known'),restoreCalls=calls.length-beforeAbsent;
      return Response.json({profile,admittedRevision:admitted.revision,constructedCalls,text,race,raceCalls,afterRotation,restored,restoreCalls,calls,constraints,unexpectedFetches});
    }};`, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" },
    bundle: true, format: "esm", platform: "browser", write: false });
  const native = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-20",
    d1Databases: ["DB"], log: new Log(LogLevel.ERROR), bindings: { AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "admin@example.test",
      STORAGE_CREDENTIAL_KEYRING: JSON.stringify(oldRing) } });
  try {
    const db = await native.getD1Database("DB"), migrations = new URL("../../migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort())
      await db.batch(splitSql(readFileSync(new URL(name, migrations), "utf8")).map(sql => db.prepare(sql)));
    const response = await native.dispatchFetch("https://fixture.test", { method: "POST", body: JSON.stringify({ newRing, newOnly }) });
    expect(response.status).toBe(200);
    const result = await response.json() as { profile: { profileId: string }; calls: unknown[]; constraints: string[] };
    expect(result).toMatchObject({ admittedRevision: 2, constructedCalls: 0, text: "known bytes", race: { outcome: "unavailable" }, raceCalls: 0,
      afterRotation: { outcome: "available", byteSize: 11 }, restored: { outcome: "unavailable" }, restoreCalls: 0, unexpectedFetches: 0 });
    expect(result.calls).toEqual(["GET", "HEAD"].map(method => ({ method,
      url: "https://s3.us-east-1.amazonaws.com/native-reader-fixture/research/files/known", owner: "111122223333", oldCredential: true })));
    expect(result.constraints).toEqual(["first-primary", "first-primary"]);
    expect(await db.prepare("SELECT state FROM storage_profile_runtime WHERE storage_profile_id=?").bind(result.profile.profileId).first())
      .toEqual({ state: "read_only" });
    expect(await db.prepare("SELECT count(*) n FROM file_locations").first()).toEqual({ n: 0 });
    expect(await db.prepare("SELECT count(*) n FROM storage_role_defaults").first()).toEqual({ n: 0 });
    await expect(db.prepare("UPDATE storage_profile_runtime SET state='read_write' WHERE storage_profile_id=?").bind(result.profile.profileId).run())
      .rejects.toThrow("Native runtime activation requires exact tested binding");
    expect(await db.prepare("SELECT state FROM storage_profile_runtime WHERE storage_profile_id=?").bind(result.profile.profileId).first())
      .toEqual({ state: "read_only" });
    expect(await db.prepare("SELECT count(*) n FROM storage_profile_activations").first()).toEqual({ n: 0 });
    expect(await db.prepare("SELECT count(*) n FROM system_storage_native_bindings").first()).toEqual({ n: 0 });
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally { await native.dispose(); }
}, 60_000);
