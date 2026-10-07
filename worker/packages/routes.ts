import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import type { FilePurpose } from "../../shared/contracts/files";
import { checkedResearchExportPlanInput,checkedResearchExportInput,checkedResearchUploadInput,checkedResearchImportInput,
  checkedResearchJobControl,checkedResearchJobStatus,RESEARCH_PACKAGE_PREFLIGHT_REASONS,RESEARCH_PACKAGE_PREFLIGHT_ERROR,type ResearchJobStatus,type ResearchPackagePreview } from "../../shared/contracts/research-package-api";
import { prepareStorageRoleSelection,roleForFilePurpose } from "../files/storage-role-selection";
import { canAdministerSystemSettings } from "../storage/system-administrator";
import { inspectWorkerFileJobRuntime } from "../files/jobs/worker-runtime";
import { readPublishedFile } from "../files/authority-reader";
import { stableJson } from "../../shared/domain/content-addressing";
import { buildPackageSnapshotStatements,previewPackageSnapshot } from "./snapshot";
import { ImportDomainError } from "./import-domain-identity";
import { prepareImportDomainPlan,readImportDestinationSnapshot,importDomainIdentityStatements } from "./import-domain";
import { packageRepository,packageActorAllowed,packageSqlDatabase,readValidatedPackage,readPackageUploadMetadata,workerPackageCapabilities } from "./jobs/worker-runtime";
import { writePackageUpload } from "./jobs/kernel";
import type { PackageTargets,PackageJob } from "./jobs/types";
import type { JobSqlStatement } from "../files/jobs/sql-repository";

type ApiEnv={Bindings:Env;Variables:{userEmail:string}};
export const packageRoutes=new Hono<ApiEnv>();
const publicPreflightReasons:ReadonlySet<string>=new Set(RESEARCH_PACKAGE_PREFLIGHT_REASONS);
packageRoutes.onError((error,c)=>error instanceof HTTPException?c.json({error:error.message},error.status)
  :error instanceof ImportDomainError&&publicPreflightReasons.has(error.reason)?c.json({error:RESEARCH_PACKAGE_PREFLIGHT_ERROR,reason:error.reason},409)
  :c.json({error:"Package operation conflicts with accepted state or an unavailable capability. Inspect the request receipt and refresh its preview."},409));
const purposes:FilePurpose[]=["research_source","provenance","embedded_content","derived_preview","job_output"];
const fail=(message:string,status:400|404|409|413|503=409)=>new HTTPException(status,{message});
async function json(request:Request){const reader=request.body?.getReader();if(!reader)throw fail("Package input is required",400);
  let length=0;const chunks:Uint8Array[]=[];try{while(true){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;
    if(length>32*1024){await reader.cancel();throw fail("Package request is too large",413);}chunks.push(next.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{throw fail("Invalid package JSON",400);}}
async function currentRevision(env:Env){return(await packageSqlDatabase(env.DB).primary().prepare("SELECT MAX(policy_revision) revision FROM storage_role_policy_revisions")
  .first<{revision:number|null}>())?.revision??null;}
async function targetSelection(env:Env,required:readonly FilePurpose[]=["job_output"]){
  const revision=await currentRevision(env),needed=[...new Set(required)];
  if(!needed.length&&revision===null)throw fail("Role policy is unavailable",409);
  const prepared=needed.length?await prepareStorageRoleSelection(env.DB,env,needed,new Date().toISOString())
    :{rolePolicyRevision:revision!,statements:[] as D1PreparedStatement[],profileFor(_purpose:FilePurpose):never{throw fail("Unselected package role is unavailable",409);}};
  const metadata=(await packageSqlDatabase(env.DB).primary().prepare(`SELECT d.role,p.id,p.namespace_identity
    FROM storage_role_defaults d JOIN storage_profiles p ON p.id=d.storage_profile_id AND p.configuration_revision=d.storage_profile_revision`).all<{role:string;id:string;namespace_identity:string}>()).results;
  const targets={} as Record<FilePurpose,PackageTargets[FilePurpose]>;
  for(const purpose of purposes){const role=roleForFilePurpose(purpose),stored=metadata.find(row=>row.role===role);
    const p=needed.includes(purpose)||!stored?prepared.profileFor(needed.find(p=>roleForFilePurpose(p)===role)??"job_output"):null;
    targets[purpose]={profileId:p?.id??stored!.id,configurationRevision:1,namespaceIdentity:p?.namespaceIdentity??stored!.namespace_identity,policyRevision:prepared.rolePolicyRevision};}
  if(await currentRevision(env)!==revision)throw fail("Role policy changed while preparing its preview",409);
  return{targets,revision,statements:prepared.statements as unknown as JobSqlStatement[]};}
async function publicStatus(env:Env,id:string,actor:string):Promise<ResearchJobStatus|null>{const repository=packageRepository(env),job=await repository.job(id);
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
const receipt=async(env:Env,input:{requestId:string;job:{id:string};reused:boolean} ,actor:string)=>({requestId:input.requestId,job:(await publicStatus(env,input.job.id,actor))!,reused:input.reused});
async function ownedJob(env:Env,id:string,actor:string){const job=await packageRepository(env).job(id);if(!job||job.actor!==actor)throw fail("Package job does not exist",404);return job;}
async function identity(env:Env){const row=await packageSqlDatabase(env.DB).primary().prepare("SELECT installation_id FROM research_package_source_identity WHERE singleton=1")
  .first<{installation_id:string}>();if(!row)throw fail("Package schema is unavailable",503);return row.installation_id;}
async function requireAuthority(env:Env){const row=await packageSqlDatabase(env.DB).primary().prepare(`SELECT 1 FROM file_authority_control c JOIN file_authority_runtime_guard g ON g.singleton=c.singleton AND g.enabled=1 WHERE c.singleton=1 AND c.mode='active'`).first();
  if(!row)throw fail("Native packages require active File authority",503);}
async function importPlan(env:Env,job:PackageJob,suffix:string){const repository=packageRepository(env),pkg=await readValidatedPackage(repository,job.id);
  if(job.expires_at&&Date.parse(job.expires_at)<=Date.now())throw fail("Validated upload has expired",409);
  const selection=await targetSelection(env,pkg.files.map(file=>file.purpose));const destination=await readImportDestinationSnapshot(repository.database,pkg,{namingSuffix:suffix});
  const files=pkg.files.map(file=>{const t=selection.targets[file.purpose];return{packageFileId:file.packageFileId,destinationFileId:crypto.randomUUID(),assetId:crypto.randomUUID(),
    profileId:t.profileId,profileRevision:t.configurationRevision,namespaceIdentity:t.namespaceIdentity,purpose:file.purpose,sha256:file.sha256,byteSize:file.byteSize,scope:"system" as const};});
  const plan=await prepareImportDomainPlan(pkg,{files,destination,randomId:()=>crypto.randomUUID(),acceptedAt:new Date().toISOString(),namingSuffix:suffix});
  return{pkg,plan,selection};}

packageRoutes.get("/packages/jobs",async c=>{const rows=await packageRepository(c.env).list(c.get("userEmail"));return c.json({jobs:await Promise.all(rows.map(row=>publicStatus(c.env,row.id,c.get("userEmail"))))});});
packageRoutes.get("/packages/executor",async c=>{const runtime=await inspectWorkerFileJobRuntime(c.env),db=packageSqlDatabase(c.env.DB);
  const installed=Boolean(await db.primary().prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='research_package_jobs'").first());
  const guard=installed?await db.primary().prepare("SELECT enabled,last_heartbeat_at FROM file_job_runtime_guard WHERE singleton=1").first<{enabled:number;last_heartbeat_at:string|null}>():null;
  return c.json({supported:installed&&runtime.outcome!=="unsupported",enabled:guard?.enabled===1,
    stale:!guard?.last_heartbeat_at||Date.now()-Date.parse(guard.last_heartbeat_at)>5*60_000,canManage:canAdministerSystemSettings(c.env,c.get("userEmail")),
    lastHeartbeatAt:guard?.last_heartbeat_at??null,cadenceSeconds:120,maxStepMs:60000,reason:runtime.outcome==="available"?null:runtime.outcome});});
packageRoutes.post("/packages/plans",async c=>{let input;try{input=checkedResearchExportPlanInput(await json(c.req.raw));}catch{throw fail("Invalid package selection",400);}
  const preview=await previewPackageSnapshot(packageSqlDatabase(c.env.DB),{actor:c.get("userEmail"),...input});
  const unavailable=(reason:string)=>({
    dataPackage:{available:false,reasons:[...preview.capabilities.dataPackage.reasons,reason]},
    report:{available:false,reasons:[...preview.capabilities.report.reasons,reason]}});
  try{await requireAuthority(c.env);}catch{return c.json({...preview,rolePolicyRevision:await currentRevision(c.env),targets:[],capabilities:unavailable("file_authority_unavailable")});}
  try{const selection=await targetSelection(c.env);return c.json({...preview,rolePolicyRevision:selection.revision,
    targets:[{purpose:"job_output",role:"internal",profileId:selection.targets.job_output.profileId,configurationRevision:1,available:true}]});}
  catch{return c.json({...preview,rolePolicyRevision:await currentRevision(c.env),targets:[],capabilities:unavailable("role_target_unavailable")});}});
packageRoutes.post("/packages/jobs",async c=>{let input;try{input=checkedResearchExportInput(await json(c.req.raw));}catch{throw fail("Invalid export request",400);}
  const actor=c.get("userEmail"),repository=packageRepository(c.env),prior=await repository.request(input.requestId,actor,input);if(prior)return c.json(await receipt(c.env,prior,actor),202);
  await requireAuthority(c.env);const selection=await targetSelection(c.env),installation=await identity(c.env),id=crypto.randomUUID(),packageId=crypto.randomUUID();
  const accepted=await repository.accept({id,requestId:input.requestId,actor,kind:input.kind,input,packageId,sourceInstallationId:installation,targets:selection.targets,
    statements:(db,jobId,acceptedAt)=>[...selection.statements,...buildPackageSnapshotStatements(db,{jobId,actor,roots:input.roots,packageId,sourceInstallationId:installation,createdAt:acceptedAt,kind:input.kind})]},()=>packageActorAllowed(c.env,actor));
  return c.json(await receipt(c.env,accepted,actor),202);});
packageRoutes.post("/packages/uploads",async c=>{let input;try{input=checkedResearchUploadInput(await json(c.req.raw));}catch{throw fail("Invalid package upload identity",400);}
  const actor=c.get("userEmail"),repository=packageRepository(c.env),prior=await repository.request(input.requestId,actor,input);if(prior)return c.json(await receipt(c.env,prior,actor),202);
  await requireAuthority(c.env);const selection=await targetSelection(c.env),id=crypto.randomUUID();
  const accepted=await repository.accept({id,requestId:input.requestId,actor,kind:"upload",input,packageId:crypto.randomUUID(),sourceInstallationId:await identity(c.env),targets:selection.targets,
    files:[{packageFileId:"@archive",entryKind:"artifact",purpose:"job_output",byteSize:input.byteSize,sha256:input.sha256,path:"archive.zip",mediaType:"application/zip",fileId:crypto.randomUUID()}],
    statements:()=>selection.statements},()=>packageActorAllowed(c.env,actor));return c.json(await receipt(c.env,accepted,actor),202);});
packageRoutes.get("/packages/requests/:requestId",async c=>{const actor=c.get("userEmail"),found=await packageRepository(c.env).request(c.req.param("requestId"),actor);
  if(!found)throw fail("Package request is not accepted",404);return c.json(await receipt(c.env,found,actor));});
packageRoutes.get("/packages/jobs/:jobId",async c=>{const status=await publicStatus(c.env,c.req.param("jobId"),c.get("userEmail"));if(!status)throw fail("Package job does not exist",404);return c.json(status);});
packageRoutes.get("/packages/jobs/:jobId/upload-intent",async c=>{const job=await ownedJob(c.env,c.req.param("jobId"),c.get("userEmail"));
  if(job.kind!=="upload")throw fail("This job has no upload intent",404);return c.json(checkedResearchUploadInput(JSON.parse(job.input_json)));});
packageRoutes.put("/packages/jobs/:jobId/upload",async c=>{const actor=c.get("userEmail"),job=await ownedJob(c.env,c.req.param("jobId"),actor);
  if(job.kind!=="upload")throw fail("This is not an upload job",400);if(job.phase!=="write")return c.json(await publicStatus(c.env,job.id,actor));
  const input=checkedResearchUploadInput(JSON.parse(job.input_json)),declared=c.req.header("content-length");
  if(declared!==undefined&&(!/^[1-9][0-9]*$/.test(declared)||Number(declared)!==input.byteSize))throw fail("Upload size differs from accepted identity",400);
  if(!c.req.raw.body)throw fail("Package upload body is required",400);const capabilities=await workerPackageCapabilities(c.env);if(!capabilities)throw fail("Package executor is disabled or unavailable",503);
  const repository=packageRepository(c.env),claim=await repository.claimOne(job.id,actor,capabilities.incarnation,crypto.randomUUID(),true);if(!claim)throw fail("Another upload attempt owns this request",409);
  try{await writePackageUpload({...capabilities,repository},claim,c.req.raw.body);}catch{throw fail("Archive upload remains pending or needs reconciliation; inspect the accepted job",409);}
  return c.json(await publicStatus(c.env,job.id,actor));});
packageRoutes.get("/packages/jobs/:jobId/preview",async c=>{const job=await ownedJob(c.env,c.req.param("jobId"),c.get("userEmail")),suffix=c.req.query("suffix")??"";
  if(suffix.length>32||/[\u0000-\u001f\u007f]/.test(suffix))throw fail("Invalid naming suffix",400);
  if(job.kind==="import"){const plan=JSON.parse(job.domain_plan_json!);const upload=await ownedJob(c.env,job.source_upload_job_id!,c.get("userEmail"));
    const pkg=await readPackageUploadMetadata(packageRepository(c.env),upload.id);return c.json(await makeImportPreview(c.env,pkg,plan,JSON.parse(job.target_policy_json),job.package_digest!,job.actor,job));}
  if(job.kind!=="upload"||job.state!=="preview")throw fail("Package validation has not completed",409);
  const {pkg,plan,selection}=await importPlan(c.env,job,suffix);return c.json(await makeImportPreview(c.env,pkg,plan,selection.targets,JSON.parse(job.frozen_archive_json!).sha256,job.actor,undefined,selection.revision));});
async function makeImportPreview(env:Env,pkg:Awaited<ReturnType<typeof readValidatedPackage>>,plan:Awaited<ReturnType<typeof prepareImportDomainPlan>>,targets:PackageTargets,digest:string,actor:string,accepted?:PackageJob,previewRevision?:number|null):Promise<ResearchPackagePreview>{
  const exists=await packageSqlDatabase(env.DB).primary().prepare("SELECT id FROM research_package_jobs WHERE kind='import' AND actor=? AND package_digest=? AND copy_identity='normal'")
    .bind(actor,digest).first<{id:string}>();
  const revision=accepted?targets.job_output.policyRevision:previewRevision??null;
  const complete=pkg.completeness==="complete",allowed={available:complete&&revision!==null,reasons:!complete?["mandatory_payload_incomplete"]:revision===null?["role_policy_unavailable"]:[]};
  return{schema:"research-package-preview/1",kind:"data_package",roots:pkg.roots,counts:pkg.counts,archiveBytes:null,metadataBytes:new TextEncoder().encode(stableJson(pkg.records)).byteLength,
    warnings:complete?[]:["partial_package"],complete,capabilities:{dataPackage:allowed,report:{available:true,reasons:[]}},
    dependencies:pkg.dependencies.map(d=>({targetType:d.target.kind,id:d.target.sourceId,outcome:d.resolution==="included"?"included":d.resolution==="deleted"?"tombstoned":"excluded",reason:d.reason})),
    source:{installationId:pkg.sourceInstallationId,packageId:pkg.packageId,payloadSha256:digest},naming:plan.namingPreview,
    targets:[...new Set(pkg.files.map(file=>file.purpose))].map(purpose=>({purpose,role:roleForFilePurpose(purpose),profileId:targets[purpose].profileId,configurationRevision:1,available:true})),existingImportJobId:exists?.id??null,
    rolePolicyRevision:revision};}
packageRoutes.post("/packages/imports",async c=>{let input;try{input=checkedResearchImportInput(await json(c.req.raw));}catch{throw fail("Invalid copy import request",400);}
  const actor=c.get("userEmail"),repository=packageRepository(c.env),prior=await repository.request(input.requestId,actor,input);if(prior)return c.json(await receipt(c.env,prior,actor),202);
  await requireAuthority(c.env);const upload=await ownedJob(c.env,input.uploadJobId,actor),frozen=upload.frozen_archive_json?JSON.parse(upload.frozen_archive_json):null;
  if(upload.kind!=="upload"||!frozen?.manifest)throw fail("Archive validation has not completed",409);
  if(!input.anotherCopy){const existing=await repository.database.primary().prepare("SELECT * FROM research_package_jobs WHERE kind='import' AND actor=? AND package_digest=? AND copy_identity='normal'")
    .bind(actor,frozen.sha256).first<PackageJob>();if(existing){const accepted=await repository.accept({id:crypto.randomUUID(),requestId:input.requestId,actor,kind:"import",input,
      packageId:existing.package_id,sourceInstallationId:existing.source_installation_id,targets:JSON.parse(existing.target_policy_json),digest:frozen.sha256,
      copyIdentity:"normal",sourceUploadJobId:upload.id,domainPlan:JSON.parse(existing.domain_plan_json!)},()=>packageActorAllowed(c.env,actor));
      return c.json(await receipt(c.env,accepted,actor),202);}}
  if(input.expectedRolePolicyRevision===null)throw fail("Configure and refresh the destination role policy before accepting a new copy",409);
  const {pkg,plan,selection}=await importPlan(c.env,upload,input.naming?.suffix??"");if(pkg.completeness!=="complete")throw fail("Native copy import requires its complete mandatory payload",409);
  const id=crypto.randomUUID(),fileInputs=pkg.files.map(file=>{const target=plan.files.find(t=>t.packageFileId===file.packageFileId)!;return{
    packageFileId:file.packageFileId,purpose:file.purpose,byteSize:file.byteSize,sha256:file.sha256,path:file.path,mediaType:file.mediaType??"application/octet-stream",
    entryKind:"payload" as const,entry:frozen.entries.find((e:{path:string})=>e.path===file.path),fileId:target.destinationFileId,assetId:target.assetId,
    reuse:plan.fileReuses.find(r=>r.packageFileId===file.packageFileId),originalName:target.originalName,aliasCreatedAt:target.aliasCreatedAt??undefined};});
  const expected=input.expectedRolePolicyRevision;
  const accepted=await repository.accept({id,requestId:input.requestId,actor,kind:"import",input,packageId:pkg.packageId,sourceInstallationId:pkg.sourceInstallationId,
    sourceUploadJobId:upload.id,digest:frozen.sha256,copyIdentity:input.anotherCopy?input.requestId:"normal",domainPlan:plan,targets:selection.targets,files:fileInputs,
    statements:(db,jobId)=>[db.prepare("SELECT CASE WHEN(SELECT MAX(policy_revision) FROM storage_role_policy_revisions) IS ? THEN 1 ELSE json('Role policy changed after preview') END").bind(expected),
      ...selection.statements,...importDomainIdentityStatements(db,jobId,plan)]},()=>packageActorAllowed(c.env,actor));
  return c.json(await receipt(c.env,accepted,actor),202);});
packageRoutes.post("/packages/jobs/:jobId/control",async c=>{let input;try{input=checkedResearchJobControl(await json(c.req.raw));}catch{throw fail("Invalid package control",400);}
  const actor=c.get("userEmail"),id=c.req.param("jobId");await packageRepository(c.env).control(id,actor,input.action);return c.json(await publicStatus(c.env,id,actor));});
packageRoutes.get("/packages/jobs/:jobId/download",async c=>{const job=await ownedJob(c.env,c.req.param("jobId"),c.get("userEmail"));
  if(job.state!=="completed"||job.kind==="upload"||!job.expires_at||Date.parse(job.expires_at)<=Date.now())throw fail("Package output is expired or unavailable",404);
  const repository=packageRepository(c.env),file=(await repository.files(job.id)).find(f=>f.entry_kind==="artifact"&&f.state==="published");
  if(!file?.result_file_id)throw fail("Package output is unavailable",404);
  if(!await repository.database.primary().prepare("SELECT 1 FROM file_holds WHERE file_id=? AND operation_id=? AND released_at IS NULL")
    .bind(file.result_file_id,`fp4-output:${job.id}`).first())throw fail("Package output was released for cleanup",404);
  const object=await readPublishedFile(c.env,{fileId:file.result_file_id,purpose:"job_output"});
  if(object.outcome!=="available")throw fail("Package output bytes are unavailable or were excluded during recovery",404);
  return new Response(object.body,{headers:{"content-type":"application/zip","content-disposition":`attachment; filename="${job.kind}-${job.id}.zip"`,
    "cache-control":"private, no-store","x-content-type-options":"nosniff"}});});
