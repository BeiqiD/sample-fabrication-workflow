import { build } from "esbuild";
import { createHash } from "node:crypto";
import { Log, LogLevel, Miniflare, Response as MiniflareResponse } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { checkedResearchJobStatus } from "../../shared/contracts/research-package-api";
import type { ResearchPackageV1 } from "../../shared/contracts/research-package";
import type { FilePurpose } from "../../shared/contracts/files";

export type NativePackageSide = "source" | "destination";
const actor = "native-package-owner@example.test";
const sourceTarget = "native-package-r2";
const bootstrapNamespace = JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "native-package-assets" });
const s3Bucket = "native-package-destination";
const s3Root = "research";
const s3Endpoint = "https://s3.us-east-1.amazonaws.com";
const expectedOwner = "111122223333";
const credentialKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(47)));

// Only the fixture's transport and installation bootstrap live in this wrapper.
// Routes, hashes, D1 transactions, admission, File authority and package kernel
// execute unchanged inside workerd against all released migration guards.
const workerSource = `
import { Hono } from 'hono';
import { packageRoutes } from './routes';
import { dispatchPackageJobs,packageRepository,readValidatedPackage } from './jobs/worker-runtime';
import { activateFileAuthority } from '../files/authority-activation';
import { setFileJobExecution } from '../files/jobs/worker-runtime';
import { readPublishedFile } from '../files/authority-reader';
import { saveStorageCandidate } from '../storage/configuration-registry';
import { startStorageCandidateCheck } from '../storage/candidate-check-service';
import { registerStorageProfile } from '../storage/storage-profile-admission-service';
import { activateNativeStorageProfile } from '../storage/native-profile-activation';
import { setStorageRoleDefaults } from '../storage/storage-role-policy';
const actor=${JSON.stringify(actor)},r2Profile=${JSON.stringify(sourceTarget)};
const diagnostics={source:[],destination:[]};
function note(side,error,sql){
  diagnostics[side].push({error:String(error),sql:sql.length<=2048?sql:sql.slice(0,768)+' ... SQL tail ... '+sql.slice(-1280)});
  if(diagnostics[side].length>32)diagnostics[side].shift();
}
function database(native,side,lifecycle={}){
  function statement(sql,inner,values=[]){
    async function execute(method,args){try{return await inner[method](...args);}catch(error){note(side,error,sql);throw error;}}
    return {sql,inner,values,bind(...values){return statement(sql,inner.bind(...values),values);},
      first(...args){return execute('first',args);},all(...args){return execute('all',args);},
      raw(...args){return execute('raw',args);},run(...args){return execute('run',args);}};
  }
  return {prepare(sql){try{return statement(sql,native.prepare(sql));}catch(error){note(side,error,sql);throw error;}},
    withSession(...args){return database(typeof native.withSession==='function'?native.withSession(...args):native,side,lifecycle);},
    async batch(statements){try{
      if(lifecycle.beforeBatch)await lifecycle.beforeBatch(statements);
      return await native.batch(statements.map(item=>item.inner));}
      catch(error){
        note(side,error,statements.map(item=>item.sql.slice(0,100)).join(' | '));
        // EXPLAIN compiles the exact bound statement and inherited triggers,
        // but does not execute or retry any mutation after the failed batch.
        // Diagnostics expose SQL placeholders only, never bound credentials.
        for(let index=0;index<statements.length;index++){
          const item=statements[index];
          try{await native.prepare('EXPLAIN '+item.sql).bind(...item.values).all();}
          catch(explainError){note(side,'Batch EXPLAIN statement '+(index+1)+'/'+statements.length+': '+String(explainError),item.sql);}
        }
        throw error;
      }}};
}
async function defaults(env,profileId){
  const revision=await env.DB.prepare('SELECT MAX(policy_revision) revision FROM storage_role_policy_revisions').first();
  return setStorageRoleDefaults(env,{operationId:crypto.randomUUID(),expectedPolicyRevision:revision.revision,
    internalProfileId:profileId,originalsProfileId:profileId},actor);
}
async function bootstrap(env,side){
  const db=env.DB,now=new Date().toISOString();
  await db.prepare("INSERT INTO storage_profiles VALUES(?,'r2',?,'bootstrap',NULL,1,'historical',?)")
    .bind(r2Profile,env.R2_BOOTSTRAP_NAMESPACE,now).run();
  await db.prepare('INSERT INTO file_shadow_enablements SELECT 1,epoch,?,? FROM file_shadow_control').bind(actor,now).run();
  await db.prepare('INSERT INTO file_shadow_profile_enablements VALUES(?,1,?,?)').bind(r2Profile,actor,now).run();
  await db.prepare('UPDATE file_shadow_runtime_guard SET incarnation=?,enabled=1,enabled_by=?,updated_at=?')
    .bind(crypto.randomUUID(),actor,now).run();
  await db.prepare('UPDATE file_shadow_runtime_guard SET enabled=0').run();
  const cutoff=await db.prepare('SELECT c.epoch,r.incarnation FROM file_shadow_control c JOIN file_shadow_runtime_guard r ON r.singleton=c.singleton').first();
  await activateFileAuthority(db,actor,{requestId:crypto.randomUUID(),expectedEpoch:cutoff.epoch,expectedShadowIncarnation:cutoff.incarnation});
  let target=r2Profile,admission=null,activation=null;
  if(side==='destination'){
    const saved=await saveStorageCandidate(env,{expectedRevision:null,label:'Native package destination',
      namespace:{kind:'s3',endpoint:${JSON.stringify(s3Endpoint)},region:'us-east-1',bucket:${JSON.stringify(s3Bucket)},root:${JSON.stringify(s3Root)},
        forcePathStyle:true,expectedBucketOwner:${JSON.stringify(expectedOwner)}},
      credentials:{mode:'replace',value:{accessKeyId:'fixture-package-access',secretAccessKey:'fixture-package-secret'}}},actor);
    const check=await startStorageCandidateCheck(env,{checkId:crypto.randomUUID(),profileId:saved.profileId,expectedRevision:1},actor);
    if(check.status!=='succeeded')throw new Error('Native package candidate check did not succeed: '+JSON.stringify(check));
    admission=await registerStorageProfile(env,{operationId:crypto.randomUUID(),profileId:saved.profileId,expectedRevision:1,
      expectedEnvelopeRevision:1,checkId:check.id},actor);
    activation=await activateNativeStorageProfile(env,{operationId:crypto.randomUUID(),nativeProfileId:admission.nativeProfileId,
      candidateProfileId:saved.profileId,expectedCandidateRevision:1,expectedEnvelopeRevision:1,checkId:check.id,expectedBindingRevision:null},actor);
    target=admission.nativeProfileId;
  }
  const policy=await defaults(env,target);
  const executor=await setFileJobExecution(env,true);
  return {target,admission,activation,policy,executor};
}
async function activationRace(env,rawDb,lifecycle){
  const columns='SELECT b.storage_profile_id,b.binding_revision,b.candidate_profile_id,b.candidate_revision,b.check_id,b.activation_operation_id,r.state,r.activated_at FROM system_storage_native_bindings b JOIN storage_profile_runtime r ON r.storage_profile_id=b.storage_profile_id';
  const before=await rawDb.prepare(columns).first();
  if(!before)throw new Error('Activation race requires a real admitted native binding');
  const auditSql='SELECT * FROM storage_profile_activations WHERE operation_id=?';
  const originalBefore=await rawDb.prepare(auditSql).bind(before.activation_operation_id).first();
  const operationId=crypto.randomUUID(),competitorOperationId=crypto.randomUUID();
  const input={nativeProfileId:before.storage_profile_id,candidateProfileId:before.candidate_profile_id,
    expectedCandidateRevision:before.candidate_revision,expectedEnvelopeRevision:1,
    checkId:before.check_id,expectedBindingRevision:before.binding_revision};
  let observedBatchFence=false,competitor=null,errorStatus=null;
  lifecycle.beforeBatch=async(statements)=>{
    if(!statements[0].sql.startsWith('SELECT CASE WHEN EXISTS(SELECT p.id AS profile_id'))return;
    lifecycle.beforeBatch=null;observedBatchFence=true;
    competitor=await activateNativeStorageProfile({...env,DB:rawDb},{...input,operationId:competitorOperationId},actor);
  };
  try{
    await activateNativeStorageProfile(env,{...input,operationId},actor);
  }catch(error){errorStatus=error.status??null;}
  finally{lifecycle.beforeBatch=null;}
  const after=await rawDb.prepare(columns).first();
  const originalAfter=await rawDb.prepare(auditSql).bind(before.activation_operation_id).first();
  const audit=await rawDb.prepare('SELECT count(*) count FROM storage_profile_activations WHERE operation_id=?').bind(operationId).first();
  return {observedBatchFence,competitor,errorStatus,before,after,originalBefore,originalAfter,newActivationCount:audit.count};
}
const app=new Hono();
app.use('*',async(c,next)=>{c.set('userEmail',actor);await next();});
app.route('/api',packageRoutes);
export default {async fetch(request,bindings,ctx){
  const url=new URL(request.url),match=/^\\/(source|destination)(\\/.*)$/.exec(url.pathname);
  if(!match)return new Response('Unknown native fixture side',{status:404});
  const side=match[1],path=match[2],rawDb=side==='source'?bindings.SOURCE_DB:bindings.DESTINATION_DB;
  const lifecycle={},env={...bindings,DB:database(rawDb,side,lifecycle),ASSETS:bindings.BUCKET};
  try{
    if(path==='/__fixture/bootstrap'&&request.method==='POST')return Response.json(await bootstrap(env,side));
    if(path==='/__fixture/step'&&request.method==='POST'){
      const result=await dispatchPackageJobs(env);return Response.json({...result,diagnostics:diagnostics[side]});
    }
    if(path==='/__fixture/defaults'&&request.method==='POST'){
      const input=await request.json();return Response.json(await defaults(env,input.profileId));
    }
    if(path==='/__fixture/metadata'&&request.method==='GET')return Response.json(await readValidatedPackage(packageRepository(env),url.searchParams.get('jobId')));
    if(path==='/__fixture/diagnostics'&&request.method==='GET')return Response.json(diagnostics[side]);
    if(path==='/__fixture/activation-race'&&request.method==='POST')return Response.json(await activationRace(env,rawDb,lifecycle));
    if(path==='/__fixture/read'&&request.method==='GET'){
      const file=await readPublishedFile(env,{fileId:url.searchParams.get('fileId'),purpose:url.searchParams.get('purpose')});
      if(file.outcome!=='available')return Response.json(file,{status:409});
      return new Response(file.body,{headers:{'content-type':file.contentType}});
    }
    if(!path.startsWith('/api/'))return new Response('Unknown native fixture command',{status:404});
    url.pathname=path;
    return app.fetch(new Request(url,request),env,ctx);
  }catch(error){return Response.json({error:String(error),diagnostics:diagnostics[side]},{status:500});}
}};`;

let bundlePromise: Promise<string> | undefined;
function bundledWorker() {
  return bundlePromise ??= build({ stdin: { contents: workerSource, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" },
    bundle: true, format: "esm", platform: "browser", write: false }).then(result => result.outputFiles[0].text);
}

export interface NativePackageProviderRequest {
  method: string;
  url: string;
  contentLength: string | null;
  byteSize: number | null;
}
type NativeDatabase = Awaited<ReturnType<Miniflare["getD1Database"]>>;
type NativeDispatchInit = Parameters<Miniflare["dispatchFetch"]>[1];
type PackageStep = { jobId: string | null; outcome: string; diagnostics: Array<{ error: string; sql: string }> };
interface NativeBootstrap { target: string; admission: unknown; activation: unknown; policy: unknown; executor: unknown }

/** Two independent native installations share one declared R2 namespace; the
 * admitted destination S3 bytes exist only in the isolated outbound service. */
export async function nativePackageRoundtripFixture() {
  const provider = { objects: new Map<string, ArrayBuffer>(), puts: [] as string[], gets: [] as string[],
    heads: [] as string[], deletes: [] as string[], violations: [] as string[], requests: [] as NativePackageProviderRequest[] };
  const native = new Miniflare({ modules: true, script: await bundledWorker(), compatibilityDate: "2026-07-20",
    d1Databases: ["SOURCE_DB", "DESTINATION_DB"], r2Buckets: { BUCKET: "native-package-assets" }, log: new Log(LogLevel.ERROR),
    bindings: { AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: actor, ACCESS_TEAM_DOMAIN: "qualification.cloudflareaccess.com",
      ACCESS_AUD: "native-package-qualification", ALLOWED_EMAILS: actor, R2_BOOTSTRAP_NAMESPACE: bootstrapNamespace,
      STORAGE_CREDENTIAL_KEYRING: JSON.stringify({ version: 1, currentKeyId: "fixture", keys: { fixture: credentialKey } }) },
    outboundService: async request => {
      const url = new URL(request.url), length = request.headers.get("content-length");
      const reject = (message: string): never => { provider.violations.push(message); throw new Error(message); };
      if (url.origin !== s3Endpoint || !url.pathname.startsWith(`/${s3Bucket}/${s3Root}/`) || url.search || url.hash)
        reject("Native package provider address escaped its isolated namespace");
      if (!/^AWS4-HMAC-SHA256 Credential=fixture-package-access\//.test(request.headers.get("authorization") ?? ""))
        reject("Native package provider request omitted its exact fixture SigV4 credential");
      if (request.headers.get("x-amz-expected-bucket-owner") !== expectedOwner)
        reject("Native package provider request omitted its expected owner");
      if (!["PUT", "GET", "HEAD", "DELETE"].includes(request.method)) reject("Unsupported native package provider method");
      const observed: NativePackageProviderRequest = { method: request.method, url: request.url, contentLength: length, byteSize: null };
      provider.requests.push(observed);
      if (request.method === "PUT") {
        const bytes = await request.arrayBuffer(); observed.byteSize = bytes.byteLength;
        if (length !== String(bytes.byteLength) || request.headers.get("transfer-encoding") !== null)
          reject("Native package PUT did not preserve its exact known content length");
        if (request.headers.get("x-amz-content-sha256") !== createHash("sha256").update(new Uint8Array(bytes)).digest("hex"))
          reject("Native package PUT did not preserve its known payload SHA-256");
        provider.puts.push(request.url); provider.objects.set(request.url, bytes.slice(0));
        return new MiniflareResponse(null);
      }
      if (request.method === "DELETE") {
        provider.deletes.push(request.url); provider.objects.delete(request.url);
        return new MiniflareResponse(null, { status: 204 });
      }
      (request.method === "HEAD" ? provider.heads : provider.gets).push(request.url);
      const bytes = provider.objects.get(request.url);
      if (!bytes) return new MiniflareResponse(null, { status: 404 });
      return new MiniflareResponse(request.method === "HEAD" ? null : bytes.slice(0), {
        headers: { "content-length": String(bytes.byteLength), "content-type": "application/octet-stream", etag: '"native-package-qualification"' },
      });
    },
  });
  try {
    const sourceDb = await native.getD1Database("SOURCE_DB"), destinationDb = await native.getD1Database("DESTINATION_DB");
    const directory = new URL("../../migrations/", import.meta.url);
    const migrations = readdirSync(directory).filter(name => name.endsWith(".sql") && name <= "0020_fp4_research_packages.sql").sort();
    if (migrations.at(-1) !== "0020_fp4_research_packages.sql") throw new Error("Native package migrations did not include FP4");
    for (const db of [sourceDb, destinationDb]) for (const filename of migrations) {
      const statements = splitSql(readFileSync(new URL(filename, directory), "utf8"));
      await db.batch(statements.map(sql => db.prepare(sql)));
    }
    const command = (side: NativePackageSide, path: string, init?: RequestInit) =>
      native.dispatchFetch(`https://native-package.test/${side}/__fixture/${path}`, init as NativeDispatchInit);
    const commandJson = async <T>(side: NativePackageSide, path: string, init?: RequestInit): Promise<T> => {
      const response = await command(side, path, init), body = await response.json();
      if (response.status !== 200) throw new Error(`Native package ${side} ${path}: ${response.status} ${JSON.stringify(body)}`);
      return body as T;
    };
    const sourceBootstrap = await commandJson<NativeBootstrap>("source", "bootstrap", { method: "POST" });
    const destinationBootstrap = await commandJson<NativeBootstrap>("destination", "bootstrap", { method: "POST" });
    const client = (side: NativePackageSide, db: NativeDatabase) => {
      const request = (path: string, init?: RequestInit) => {
        if (!path.startsWith("/packages/")) throw new Error("Native package client expects /packages/... paths");
        return native.dispatchFetch(`https://native-package.test/${side}/api${path}`, init as NativeDispatchInit);
      };
      const json = async (path: string, value: unknown, expected = 202) => {
        const response = await request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
        const body = await response.json();
        if (response.status !== expected) throw new Error(`Native package ${side} ${path}: expected ${expected}, received ${response.status} ${JSON.stringify(body)}; ${JSON.stringify(await commandJson(side, "diagnostics"))}`);
        return body;
      };
      const status = async (id: string) => {
        const response = await request(`/packages/jobs/${id}`), body = await response.json();
        if (response.status !== 200) throw new Error(`Native package ${side} status ${id}: ${response.status} ${JSON.stringify(body)}`);
        return checkedResearchJobStatus(body);
      };
      return { side, db, request, json, status, step: () => commandJson<PackageStep>(side, "step", { method: "POST" }) };
    };
    return { source: client("source", sourceDb), destination: client("destination", destinationDb), sourceDb, destinationDb,
      sourceTarget: sourceBootstrap.target, target: destinationBootstrap.target, destinationTarget: destinationBootstrap.target,
      sourceBootstrap, destinationBootstrap, provider,
      setDefaults: (side: NativePackageSide, profileId: string) => commandJson(side, "defaults", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profileId }),
      }),
      readFile: (side: NativePackageSide, fileId: string, purpose: FilePurpose) => command(side,
        `read?${new URLSearchParams({ fileId, purpose })}`),
      readValidated: (side: NativePackageSide, uploadId: string) => commandJson<ResearchPackageV1>(side,
        `metadata?${new URLSearchParams({ jobId: uploadId })}`),
      diagnostics: (side: NativePackageSide) => commandJson<Array<{ error: string; sql: string }>>(side, "diagnostics"),
      activationRace: () => commandJson<{ observedBatchFence: boolean; competitor: { operationId: string; bindingRevision: number }; errorStatus: number;
        before: Record<string, unknown>; after: Record<string, unknown>; originalBefore: Record<string, unknown>; originalAfter: Record<string, unknown>;
        newActivationCount: number }>("destination", "activation-race", { method: "POST" }),
      dispose: () => native.dispose(),
    };
  } catch (error) { await native.dispose(); throw error; }
}
