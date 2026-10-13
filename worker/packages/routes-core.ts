import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { FilePurpose } from "../../shared/contracts/files";
import { checkedResearchExportPlanInput,checkedResearchExportInput,checkedResearchUploadInput,checkedResearchImportInput,
  checkedResearchJobControl,checkedResearchJobStatus,RESEARCH_PACKAGE_PREFLIGHT_REASONS,RESEARCH_PACKAGE_PREFLIGHT_ERROR,type ResearchJobStatus,type ResearchPackagePreview } from "../../shared/contracts/research-package-api";
import { roleForFilePurpose } from "../files/storage-role-defaults-core";
import type { ByteReadResult } from "../files/byte-reader";
import { stableJson } from "../../shared/domain/content-addressing";
import { buildPackageSnapshotStatements,previewPackageSnapshot } from "./snapshot";
import { ImportDomainError } from "./import-domain-identity";
import { prepareImportDomainPlan,readImportDestinationSnapshot,importDomainIdentityStatements } from "./import-domain";
import { readValidatedPackage,readPackageUploadMetadata } from "./jobs/format-capabilities";
import type { SqlPackageRepository } from "./jobs/sql-repository";
import type { PackageTargets,PackageJob,PackageCapabilities,PackageClaim } from "./jobs/types";
import type { JobSqlDatabase,JobSqlStatement } from "../files/jobs/sql-repository";

export interface PackageRequestPorts {
  readonly actor:string;
  readonly repository:SqlPackageRepository;
  readonly database:JobSqlDatabase;
  actorAllowed():boolean;
  selectTargets(required?:readonly FilePurpose[]):Promise<{targets:PackageTargets;revision:number|null;statements:JobSqlStatement[]}>;
  inspectRuntime():Promise<{outcome:string;incarnation?:string}>;
  canManage():boolean|Promise<boolean>;
  capabilities():Promise<PackageCapabilities|null>;
  readJson(request:Request):Promise<unknown>;
  writeUpload(capabilities:PackageCapabilities,claim:PackageClaim,body:ReadableStream<Uint8Array>):Promise<void>;
  readOutput(fileId:string):Promise<ByteReadResult>;
}
export interface PackageRouteBinding<Bindings extends object> {
  run(request:Request,bindings:Bindings,actor:string,work:(ports:PackageRequestPorts)=>Promise<Response>):Promise<Response>;
}
type ApiEnv<Bindings extends object>={Bindings:Bindings;Variables:{userEmail:string}};
const publicPreflightReasons:ReadonlySet<string>=new Set(RESEARCH_PACKAGE_PREFLIGHT_REASONS);
/** Exact existing HTTP family, shared only for host admission scoping. */
export const PACKAGE_HTTP_ROUTES=Object.freeze([
  Object.freeze({method:"GET",path:"/packages/jobs"} as const),
  Object.freeze({method:"GET",path:"/packages/executor"} as const),
  Object.freeze({method:"POST",path:"/packages/plans"} as const),
  Object.freeze({method:"POST",path:"/packages/jobs"} as const),
  Object.freeze({method:"POST",path:"/packages/uploads"} as const),
  Object.freeze({method:"GET",path:"/packages/requests/:requestId"} as const),
  Object.freeze({method:"GET",path:"/packages/jobs/:jobId"} as const),
  Object.freeze({method:"GET",path:"/packages/jobs/:jobId/upload-intent"} as const),
  Object.freeze({method:"PUT",path:"/packages/jobs/:jobId/upload"} as const),
  Object.freeze({method:"GET",path:"/packages/jobs/:jobId/preview"} as const),
  Object.freeze({method:"POST",path:"/packages/imports"} as const),
  Object.freeze({method:"POST",path:"/packages/jobs/:jobId/control"} as const),
  Object.freeze({method:"GET",path:"/packages/jobs/:jobId/download"} as const),
]);
const fail=(message:string,status:400|404|409|413|503=409)=>new HTTPException(status,{message});
export async function readPackageRequestJson(request:Request,body:ReadableStream<Uint8Array>|null=request.body){const reader=body?.getReader();if(!reader)throw fail("Package input is required",400);
  let length=0;const chunks:Uint8Array[]=[];try{while(true){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;
    if(length>32*1024){await reader.cancel();throw fail("Package request is too large",413);}chunks.push(next.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{throw fail("Invalid package JSON",400);}}
export async function readPackageRolePolicyRevision(database:JobSqlDatabase){return(await database.primary().prepare("SELECT MAX(policy_revision) revision FROM storage_role_policy_revisions")
  .first<{revision:number|null}>())?.revision??null;}
const currentRevision=(ports:PackageRequestPorts)=>readPackageRolePolicyRevision(ports.database);
async function publicStatus(ports:PackageRequestPorts,id:string,actor:string):Promise<ResearchJobStatus|null>{const repository=ports.repository,job=await repository.job(id);
  if(!job||job.actor!==actor)return null;const files=await repository.files(id),artifact=files.find(file=>file.entry_kind==="artifact");
  const business=files.filter(file=>file.entry_kind!=="artifact"),items=job.kind==="upload"?files:business;
  const exportMeasured=["write","done"].includes(job.phase)&&(job.kind==="data_package"||job.kind==="report");
  const completed=items.filter(file=>exportMeasured||["verified","published"].includes(file.state));
  const retained=artifact?.result_file_id?Boolean(await repository.database.primary().prepare(`SELECT 1 FROM file_usable_publications f
    JOIN file_holds h ON h.file_id=f.file_id AND h.operation_id=? AND h.released_at IS NULL WHERE f.file_id=? AND f.purpose='job_output'`)
    .bind(`fp4-output:${id}`,artifact.result_file_id).first()):false;
  const output=artifact&&job.expires_at?{available:retained&&artifact.state==="published"&&job.state==="completed"&&Date.parse(job.expires_at)>Date.now(),
    byteSize:artifact.byte_size,sha256:artifact.sha256,expiresAt:job.expires_at}:null;
  return checkedResearchJobStatus({id,requestId:job.request_id,kind:job.kind,state:job.state,phase:job.phase,acceptedAt:job.accepted_at,updatedAt:job.updated_at,
    reason:job.reason,progress:{completedFiles:completed.length,totalFiles:items.length,bytesDone:completed.reduce((n,f)=>n+f.byte_size,0),bytesTotal:items.reduce((n,f)=>n+f.byte_size,0)},
    output,result:job.result_json?JSON.parse(job.result_json):null});}
const receipt=async(ports:PackageRequestPorts,input:{requestId:string;job:{id:string};reused:boolean} ,actor:string)=>({requestId:input.requestId,job:(await publicStatus(ports,input.job.id,actor))!,reused:input.reused});
async function ownedJob(ports:PackageRequestPorts,id:string,actor:string){const job=await ports.repository.job(id);if(!job||job.actor!==actor)throw fail("Package job does not exist",404);return job;}
async function identity(ports:PackageRequestPorts){const row=await ports.database.primary().prepare("SELECT installation_id FROM research_package_source_identity WHERE singleton=1")
  .first<{installation_id:string}>();if(!row)throw fail("Package schema is unavailable",503);return row.installation_id;}
async function requireAuthority(ports:PackageRequestPorts){const row=await ports.database.primary().prepare(`SELECT 1 FROM file_authority_control c JOIN file_authority_runtime_guard g ON g.singleton=c.singleton AND g.enabled=1 WHERE c.singleton=1 AND c.mode='active'`).first();
  if(!row)throw fail("Native packages require active File authority",503);}
async function importPlan(ports:PackageRequestPorts,job:PackageJob,suffix:string){const repository=ports.repository,pkg=await readValidatedPackage(repository,job.id);
  if(job.expires_at&&Date.parse(job.expires_at)<=Date.now())throw fail("Validated upload has expired",409);
  const selection=await ports.selectTargets(pkg.files.map(file=>file.purpose));const destination=await readImportDestinationSnapshot(repository.database,pkg,{namingSuffix:suffix});
  const files=pkg.files.map(file=>{const t=selection.targets[file.purpose];return{packageFileId:file.packageFileId,destinationFileId:crypto.randomUUID(),assetId:crypto.randomUUID(),
    profileId:t.profileId,profileRevision:t.configurationRevision,namespaceIdentity:t.namespaceIdentity,purpose:file.purpose,sha256:file.sha256,byteSize:file.byteSize,scope:"system" as const};});
  const plan=await prepareImportDomainPlan(pkg,{files,destination,randomId:()=>crypto.randomUUID(),acceptedAt:new Date().toISOString(),namingSuffix:suffix});
  return{pkg,plan,selection};}

async function makeImportPreview(ports:PackageRequestPorts,pkg:Awaited<ReturnType<typeof readValidatedPackage>>,plan:Awaited<ReturnType<typeof prepareImportDomainPlan>>,targets:PackageTargets,digest:string,actor:string,accepted?:PackageJob,previewRevision?:number|null):Promise<ResearchPackagePreview>{
  const exists=await ports.database.primary().prepare("SELECT id FROM research_package_jobs WHERE kind='import' AND actor=? AND package_digest=? AND copy_identity='normal'")
    .bind(actor,digest).first<{id:string}>();
  const revision=accepted?targets.job_output.policyRevision:previewRevision??null;
  const complete=pkg.completeness==="complete",allowed={available:complete&&revision!==null,reasons:!complete?["mandatory_payload_incomplete"]:revision===null?["role_policy_unavailable"]:[]};
  return{schema:"research-package-preview/1",kind:"data_package",roots:pkg.roots,counts:pkg.counts,archiveBytes:null,metadataBytes:new TextEncoder().encode(stableJson(pkg.records)).byteLength,
    warnings:complete?[]:["partial_package"],complete,capabilities:{dataPackage:allowed,report:{available:true,reasons:[]}},
    dependencies:pkg.dependencies.map(d=>({targetType:d.target.kind,id:d.target.sourceId,outcome:d.resolution==="included"?"included":d.resolution==="deleted"?"tombstoned":"excluded",reason:d.reason})),
    source:{installationId:pkg.sourceInstallationId,packageId:pkg.packageId,payloadSha256:digest},naming:plan.namingPreview,
    targets:[...new Set(pkg.files.map(file=>file.purpose))].map(purpose=>({purpose,role:roleForFilePurpose(purpose),profileId:targets[purpose].profileId,configurationRevision:1,available:true})),existingImportJobId:exists?.id??null,
    rolePolicyRevision:revision};}

export function createPackageRoutes<Bindings extends object>(binding:PackageRouteBinding<Bindings>){
  const routes=new Hono<ApiEnv<Bindings>>();
  routes.onError((error,c)=>error instanceof HTTPException?c.json({error:error.message},error.status)
    :error instanceof ImportDomainError&&publicPreflightReasons.has(error.reason)?c.json({error:RESEARCH_PACKAGE_PREFLIGHT_ERROR,reason:error.reason},409)
    :c.json({error:"Package operation conflicts with accepted state or an unavailable capability. Inspect the request receipt and refresh its preview."},409));
routes.get("/packages/jobs",c=>binding.run(c.req.raw,c.env,c.get("userEmail"),async ports=>{const rows=await ports.repository.list(ports.actor);return c.json({jobs:await Promise.all(rows.map(row=>publicStatus(ports,row.id,ports.actor)))});}));
routes.get("/packages/executor",c=>binding.run(c.req.raw,c.env,c.get("userEmail"),async ports=>{const runtime=await ports.inspectRuntime(),db=ports.database;
  const installed=Boolean(await db.primary().prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='research_package_jobs'").first());
  const guard=installed?await db.primary().prepare("SELECT enabled,last_heartbeat_at FROM file_job_runtime_guard WHERE singleton=1").first<{enabled:number;last_heartbeat_at:string|null}>():null;
  return c.json({supported:installed&&runtime.outcome!=="unsupported",enabled:guard?.enabled===1,
    stale:!guard?.last_heartbeat_at||Date.now()-Date.parse(guard.last_heartbeat_at)>5*60_000,canManage:await ports.canManage(),
    lastHeartbeatAt:guard?.last_heartbeat_at??null,cadenceSeconds:120,maxStepMs:60000,reason:runtime.outcome==="available"?null:runtime.outcome});}));
routes.post("/packages/plans",c=>binding.run(c.req.raw,c.env,c.get("userEmail"),async ports=>{let input;try{input=checkedResearchExportPlanInput(await ports.readJson(c.req.raw));}catch{throw fail("Invalid package selection",400);}
  const preview=await previewPackageSnapshot(ports.database,{actor:ports.actor,...input});
  const unavailable=(reason:string)=>({
    dataPackage:{available:false,reasons:[...preview.capabilities.dataPackage.reasons,reason]},
    report:{available:false,reasons:[...preview.capabilities.report.reasons,reason]}});
  try{await requireAuthority(ports);}catch{return c.json({...preview,rolePolicyRevision:await currentRevision(ports),targets:[],capabilities:unavailable("file_authority_unavailable")});}
  try{const selection=await ports.selectTargets();return c.json({...preview,rolePolicyRevision:selection.revision,
    targets:[{purpose:"job_output",role:"internal",profileId:selection.targets.job_output.profileId,configurationRevision:1,available:true}]});}
  catch{return c.json({...preview,rolePolicyRevision:await currentRevision(ports),targets:[],capabilities:unavailable("role_target_unavailable")});}}));
routes.post("/packages/jobs",c=>binding.run(c.req.raw,c.env,c.get("userEmail"),async ports=>{let input;try{input=checkedResearchExportInput(await ports.readJson(c.req.raw));}catch{throw fail("Invalid export request",400);}
  const actor=ports.actor,repository=ports.repository,prior=await repository.request(input.requestId,actor,input);if(prior)return c.json(await receipt(ports,prior,actor),202);
  await requireAuthority(ports);const selection=await ports.selectTargets(),installation=await identity(ports),id=crypto.randomUUID(),packageId=crypto.randomUUID();
  const accepted=await repository.accept({id,requestId:input.requestId,actor,kind:input.kind,input,packageId,sourceInstallationId:installation,targets:selection.targets,
    statements:(db,jobId,acceptedAt)=>[...selection.statements,...buildPackageSnapshotStatements(db,{jobId,actor,roots:input.roots,packageId,sourceInstallationId:installation,createdAt:acceptedAt,kind:input.kind})]},()=>ports.actorAllowed());
  return c.json(await receipt(ports,accepted,actor),202);}));
routes.post("/packages/uploads",c=>binding.run(c.req.raw,c.env,c.get("userEmail"),async ports=>{let input;try{input=checkedResearchUploadInput(await ports.readJson(c.req.raw));}catch{throw fail("Invalid package upload identity",400);}
  const actor=ports.actor,repository=ports.repository,prior=await repository.request(input.requestId,actor,input);if(prior)return c.json(await receipt(ports,prior,actor),202);
  await requireAuthority(ports);const selection=await ports.selectTargets(),id=crypto.randomUUID();
  const accepted=await repository.accept({id,requestId:input.requestId,actor,kind:"upload",input,packageId:crypto.randomUUID(),sourceInstallationId:await identity(ports),targets:selection.targets,
    files:[{packageFileId:"@archive",entryKind:"artifact",purpose:"job_output",byteSize:input.byteSize,sha256:input.sha256,path:"archive.zip",mediaType:"application/zip",fileId:crypto.randomUUID()}],
    statements:()=>selection.statements},()=>ports.actorAllowed());return c.json(await receipt(ports,accepted,actor),202);}));
routes.get("/packages/requests/:requestId",c=>binding.run(c.req.raw,c.env,c.get("userEmail"),async ports=>{const actor=ports.actor,found=await ports.repository.request(c.req.param("requestId"),actor);
  if(!found)throw fail("Package request is not accepted",404);return c.json(await receipt(ports,found,actor));}));
routes.get("/packages/jobs/:jobId",c=>binding.run(c.req.raw,c.env,c.get("userEmail"),async ports=>{const status=await publicStatus(ports,c.req.param("jobId"),ports.actor);if(!status)throw fail("Package job does not exist",404);return c.json(status);}));
routes.get("/packages/jobs/:jobId/upload-intent",c=>binding.run(c.req.raw,c.env,c.get("userEmail"),async ports=>{const job=await ownedJob(ports,c.req.param("jobId"),ports.actor);
  if(job.kind!=="upload")throw fail("This job has no upload intent",404);return c.json(checkedResearchUploadInput(JSON.parse(job.input_json)));}));
routes.put("/packages/jobs/:jobId/upload",c=>binding.run(c.req.raw,c.env,c.get("userEmail"),async ports=>{const actor=ports.actor,job=await ownedJob(ports,c.req.param("jobId"),actor);
  if(job.kind!=="upload")throw fail("This is not an upload job",400);if(job.phase!=="write")return c.json(await publicStatus(ports,job.id,actor));
  const input=checkedResearchUploadInput(JSON.parse(job.input_json)),declared=c.req.header("content-length");
  if(declared!==undefined&&(!/^[1-9][0-9]*$/.test(declared)||Number(declared)!==input.byteSize))throw fail("Upload size differs from accepted identity",400);
  if(!c.req.raw.body)throw fail("Package upload body is required",400);const capabilities=await ports.capabilities();if(!capabilities)throw fail("Package executor is disabled or unavailable",503);
  const repository=ports.repository,claim=await repository.claimOne(job.id,actor,capabilities.incarnation,crypto.randomUUID(),true);if(!claim)throw fail("Another upload attempt owns this request",409);
  try{await ports.writeUpload({...capabilities,repository},claim,c.req.raw.body);}catch{throw fail("Archive upload remains pending or needs reconciliation; inspect the accepted job",409);}
  return c.json(await publicStatus(ports,job.id,actor));}));
routes.get("/packages/jobs/:jobId/preview",c=>binding.run(c.req.raw,c.env,c.get("userEmail"),async ports=>{const job=await ownedJob(ports,c.req.param("jobId"),ports.actor),suffix=c.req.query("suffix")??"";
  if(suffix.length>32||/[\u0000-\u001f\u007f]/.test(suffix))throw fail("Invalid naming suffix",400);
  if(job.kind==="import"){const plan=JSON.parse(job.domain_plan_json!);const upload=await ownedJob(ports,job.source_upload_job_id!,ports.actor);
    const pkg=await readPackageUploadMetadata(ports.repository,upload.id);return c.json(await makeImportPreview(ports,pkg,plan,JSON.parse(job.target_policy_json),job.package_digest!,job.actor,job));}
  if(job.kind!=="upload"||job.state!=="preview")throw fail("Package validation has not completed",409);
  const {pkg,plan,selection}=await importPlan(ports,job,suffix);return c.json(await makeImportPreview(ports,pkg,plan,selection.targets,JSON.parse(job.frozen_archive_json!).sha256,job.actor,undefined,selection.revision));}));
routes.post("/packages/imports",c=>binding.run(c.req.raw,c.env,c.get("userEmail"),async ports=>{let input;try{input=checkedResearchImportInput(await ports.readJson(c.req.raw));}catch{throw fail("Invalid copy import request",400);}
  const actor=ports.actor,repository=ports.repository,prior=await repository.request(input.requestId,actor,input);if(prior)return c.json(await receipt(ports,prior,actor),202);
  await requireAuthority(ports);const upload=await ownedJob(ports,input.uploadJobId,actor),frozen=upload.frozen_archive_json?JSON.parse(upload.frozen_archive_json):null;
  if(upload.kind!=="upload"||!frozen?.manifest)throw fail("Archive validation has not completed",409);
  if(!input.anotherCopy){const existing=await repository.database.primary().prepare("SELECT * FROM research_package_jobs WHERE kind='import' AND actor=? AND package_digest=? AND copy_identity='normal'")
    .bind(actor,frozen.sha256).first<PackageJob>();if(existing){const accepted=await repository.accept({id:crypto.randomUUID(),requestId:input.requestId,actor,kind:"import",input,
      packageId:existing.package_id,sourceInstallationId:existing.source_installation_id,targets:JSON.parse(existing.target_policy_json),digest:frozen.sha256,
      copyIdentity:"normal",sourceUploadJobId:upload.id,domainPlan:JSON.parse(existing.domain_plan_json!)},()=>ports.actorAllowed());
      return c.json(await receipt(ports,accepted,actor),202);}}
  if(input.expectedRolePolicyRevision===null)throw fail("Configure and refresh the destination role policy before accepting a new copy",409);
  const {pkg,plan,selection}=await importPlan(ports,upload,input.naming?.suffix??"");if(pkg.completeness!=="complete")throw fail("Native copy import requires its complete mandatory payload",409);
  const id=crypto.randomUUID(),fileInputs=pkg.files.map(file=>{const target=plan.files.find(t=>t.packageFileId===file.packageFileId)!;return{
    packageFileId:file.packageFileId,purpose:file.purpose,byteSize:file.byteSize,sha256:file.sha256,path:file.path,mediaType:file.mediaType??"application/octet-stream",
    entryKind:"payload" as const,entry:frozen.entries.find((e:{path:string})=>e.path===file.path),fileId:target.destinationFileId,assetId:target.assetId,
    reuse:plan.fileReuses.find(r=>r.packageFileId===file.packageFileId),originalName:target.originalName,aliasCreatedAt:target.aliasCreatedAt??undefined};});
  const expected=input.expectedRolePolicyRevision;
  const accepted=await repository.accept({id,requestId:input.requestId,actor,kind:"import",input,packageId:pkg.packageId,sourceInstallationId:pkg.sourceInstallationId,
    sourceUploadJobId:upload.id,digest:frozen.sha256,copyIdentity:input.anotherCopy?input.requestId:"normal",domainPlan:plan,targets:selection.targets,files:fileInputs,
    statements:(db,jobId)=>[db.prepare("SELECT CASE WHEN(SELECT MAX(policy_revision) FROM storage_role_policy_revisions) IS ? THEN 1 ELSE json('Role policy changed after preview') END").bind(expected),
      ...selection.statements,...importDomainIdentityStatements(db,jobId,plan)]},()=>ports.actorAllowed());
  return c.json(await receipt(ports,accepted,actor),202);}));
routes.post("/packages/jobs/:jobId/control",c=>binding.run(c.req.raw,c.env,c.get("userEmail"),async ports=>{let input;try{input=checkedResearchJobControl(await ports.readJson(c.req.raw));}catch{throw fail("Invalid package control",400);}
  const actor=ports.actor,id=c.req.param("jobId");await ports.repository.control(id,actor,input.action);return c.json(await publicStatus(ports,id,actor));}));
routes.get("/packages/jobs/:jobId/download",c=>binding.run(c.req.raw,c.env,c.get("userEmail"),async ports=>{const job=await ownedJob(ports,c.req.param("jobId"),ports.actor);
  if(job.state!=="completed"||job.kind==="upload"||!job.expires_at||Date.parse(job.expires_at)<=Date.now())throw fail("Package output is expired or unavailable",404);
  const repository=ports.repository,file=(await repository.files(job.id)).find(f=>f.entry_kind==="artifact"&&f.state==="published");
  if(!file?.result_file_id)throw fail("Package output is unavailable",404);
  if(!await repository.database.primary().prepare("SELECT 1 FROM file_holds WHERE file_id=? AND operation_id=? AND released_at IS NULL")
    .bind(file.result_file_id,`fp4-output:${job.id}`).first())throw fail("Package output was released for cleanup",404);
  const object=await ports.readOutput(file.result_file_id);
  if(object.outcome!=="available")throw fail("Package output bytes are unavailable or were excluded during recovery",404);
  return new Response(object.body,{headers:{"content-type":"application/zip","content-disposition":`attachment; filename="${job.kind}-${job.id}.zip"`,
    "cache-control":"private, no-store","x-content-type-options":"nosniff"}});}));
  return routes;
}
