import { allowedEmail } from "../../auth";
import { primaryD1 } from "../../d1-primary";
import type { Env } from "../../types";
import type { JobSqlDatabase, JobSqlStatement } from "../../files/jobs/sql-repository";
import { inspectWorkerFileJobRuntime } from "../../files/jobs/worker-runtime";
import { openShadowProfile } from "../../files/shadow-profile";
import { cloudflareSha256 } from "../../files/storage-adapters/cloudflare-sha256";
import { stableJson, sha256Hex } from "../../../shared/domain/content-addressing";
import { bufferByteStream } from "../../files/byte-verification";
import { measureStoreArchive, createStoreArchiveStream, validateStoreArchive, sourceFromStream, openStoreArchiveEntry,
  type ArchiveEntry, type ArchiveIndexEntry, type ArchiveSource } from "../../../shared/domain/research-archive";
import { researchRecordsDocument, validateResearchPackage, RESEARCH_PACKAGE_MAX_RECORD_BYTES, RESEARCH_PACKAGE_MAX_PERSISTED_MANIFEST_BYTES, type ResearchPackageV1 } from "../../../shared/contracts/research-package";
import { renderResearchPackageReport } from "../../../shared/domain/research-report";
import { readPackageSnapshot } from "../snapshot";
import { prepareImportDomainPublication, readImportDestinationColumns, estimateResearchImportPlanBudget, type FrozenImportDomainPlan } from "../import-domain";
import { SqlPackageRepository } from "./sql-repository";
import { runPackageJobStep } from "./kernel";
import type { PackageCapabilities, PackageClaim, PackageFile } from "./types";

/** Adapter only: the repository/domain code has no Cloudflare globals. */
export function packageSqlDatabase(database:D1Database):JobSqlDatabase {
  return {prepare(sql){return database.prepare(sql) as unknown as JobSqlStatement;},
    batch(statements){return database.batch(statements as unknown as D1PreparedStatement[]);},
    primary(){return packageSqlDatabase(primaryD1(database));}};
}
export function packageActorAllowed(env:Env,actor:string) {
  if(env.AUTH_MODE==="disabled") return actor==="local-development";
  return env.AUTH_MODE==="access"&&typeof actor==="string"&&actor.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actor)
    &&Boolean(env.ACCESS_TEAM_DOMAIN&&env.ACCESS_AUD)&&allowedEmail(actor,env.ALLOWED_EMAILS);
}
export function packageRepository(env:Env) {return new SqlPackageRepository(packageSqlDatabase(env.DB));}
type FrozenArchive={byteSize:number;sha256:string;entries:ArchiveIndexEntry[];manifest?:Omit<ResearchPackageV1,"records">};
async function archiveMetadata(repository:SqlPackageRepository,claim:PackageClaim) {
  const snapshot=await readPackageSnapshot(repository.database,claim.id);
  if(snapshot.kind==='data_package'){
    const columns=await readImportDestinationColumns(repository.database,snapshot),targets=JSON.parse(claim.target_policy_json);
    const budget=await estimateResearchImportPlanBudget(snapshot,{columns,targets:Object.entries(targets).map(([purpose,value])=>{
      const target=value as {profileId:string;configurationRevision:number;namespaceIdentity:string};
      return {purpose:purpose as PackageFile['purpose'],profileId:target.profileId,profileRevision:target.configurationRevision,namespaceIdentity:target.namespaceIdentity};})});
    if(!budget.supported)throw new Error(budget.reason??'import_plan_budget');
  }
  const report=renderResearchPackageReport(snapshot);
  const {records,...manifest}=snapshot;
  const contents=new Map<string,string>([["manifest.json",stableJson(manifest)],["records.json",stableJson(researchRecordsDocument(records))],
    ["report/index.html",report.html],["report/report.md",report.markdown]]);
  const entries:ArchiveEntry[]=[];let metadataBytes=0;
  for(const [path,content]of contents){const bytes=new TextEncoder().encode(content);metadataBytes+=bytes.byteLength;
    entries.push({path,kind:path.startsWith("report/")?"report":"metadata",byteSize:bytes.byteLength,sha256:await sha256Hex(content)});}
  if(metadataBytes>4*1024*1024) throw new Error("metadata_budget");
  for(const file of snapshot.files)entries.push({path:file.path,kind:"payload",byteSize:file.byteSize,sha256:file.sha256});
  return {snapshot,contents,entries};
}
/** Historical accepted scope uses immutable validated metadata even after raw
 * archive expiry or cleanup. Fresh admission calls readValidatedPackage below. */
export async function readPackageUploadMetadata(repository:SqlPackageRepository,jobId:string):Promise<ResearchPackageV1> {
  const job=await repository.job(jobId);
  if(!job?.frozen_archive_json||job.kind!=="upload") throw new Error("Validated package is unavailable");
  const frozen=JSON.parse(job.frozen_archive_json) as FrozenArchive;
  return validateResearchPackage(frozen.manifest,researchRecordsDocument((await repository.records(jobId)).map(row=>JSON.parse(row.record_json))));
}
export async function readValidatedPackage(repository:SqlPackageRepository,jobId:string):Promise<ResearchPackageV1> {
  const job=await repository.job(jobId);
  if(job?.state!=="preview"||(job.expires_at&&Date.parse(job.expires_at)<=Date.now()))throw new Error("Validated package is expired or unavailable");
  const artifact=(await repository.files(jobId)).find(file=>file.entry_kind==='artifact');
  if(!artifact?.result_file_id||!await repository.database.primary().prepare("SELECT 1 FROM file_holds WHERE file_id=? AND operation_id=? AND released_at IS NULL")
    .bind(artifact.result_file_id,`fp4-output:${jobId}`).first())throw new Error("Validated package archive was released");
  return readPackageUploadMetadata(repository,jobId);
}
export async function workerPackageCapabilities(env:Env):Promise<PackageCapabilities|null> {
  const runtime=await inspectWorkerFileJobRuntime(env);if(runtime.outcome!=="available"||!runtime.incarnation)return null;
  if(!await packageSqlDatabase(env.DB).primary().prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='research_package_jobs'").first())return null;
  const repository=packageRepository(env);
  const capabilities:PackageCapabilities={repository,incarnation:runtime.incarnation,authorizeActor:actor=>packageActorAllowed(env,actor),
    now:()=>new Date(),randomId:()=>crypto.randomUUID(),
    async openStorage(target,access,beforeRequest,signal){const profile=await openShadowProfile(env,target,access,{beforeRequest,signal});
      return {...profile,namespaceIdentity:profile.storage.namespaceIdentity,adapterType:profile.storage.adapterType,
        atomicSinglePut:profile.storage.adapterType==="r2"||profile.storage.adapterType==="s3"};},
    async measureExport(claim,current,signal){const metadata=await archiveMetadata(repository,claim);
      const measured=await measureStoreArchive(metadata.entries,(entry,entrySignal)=>openExportEntry(claim,entry,metadata.contents,current,entrySignal ?? signal),{signal,createHash:cloudflareSha256});
      const {records:_records,...manifest}=metadata.snapshot;
      if(new TextEncoder().encode(stableJson({...measured,manifest})).byteLength>RESEARCH_PACKAGE_MAX_PERSISTED_MANIFEST_BYTES)throw new Error("manifest_budget");
      return measured;},
    async exportBody(claim,current,signal){const metadata=await archiveMetadata(repository,claim);
      return createStoreArchiveStream(metadata.entries,(entry,entrySignal)=>openExportEntry(claim,entry,metadata.contents,current,entrySignal ?? signal),{signal,createHash:cloudflareSha256});},
    async validateUpload(claim,current,signal){const artifact=(await repository.files(claim.id)).find(file=>file.entry_kind==="artifact");
      if(!artifact)throw new Error("Upload archive is unavailable");
      const source=await heldArchiveSource(claim,artifact,current,signal);let pkg:ResearchPackageV1|undefined;
      try{const validated=await validateStoreArchive(source,{expectedSha256:artifact.sha256,signal,createHash:cloudflareSha256,
        expectedEntries:async(metadata)=>{
          const parse=(path:string)=>JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(metadata.get(path)));
          pkg=await validateResearchPackage(parse("manifest.json"),parse("records.json"));
          const entries:ArchiveEntry[]=[];
          for(const [path,bytes]of metadata)entries.push({path,kind:path.startsWith("report/")?"report":"metadata",byteSize:bytes.byteLength,
            sha256:await sha256Hex(new TextDecoder("utf-8",{fatal:true}).decode(bytes))});
          entries.push(...pkg.files.map(file=>({path:file.path,kind:"payload" as const,byteSize:file.byteSize,sha256:file.sha256})));return entries;
        }});
        if(!pkg||!await current())throw new Error("Package validation lost ownership");
        // Bounded JSON groups keep individual D1 parameters small; the complete
        // validated record set and frozen index commit under one current lease.
        const db=repository.database.primary(),groups:Array<Array<{kind:string;id:string;json:string;ordinal:number}>>=[];
        let group:Array<{kind:string;id:string;json:string;ordinal:number}>=[],bytes=0;
        pkg.records.forEach((record,ordinal)=>{const json=stableJson(record),length=new TextEncoder().encode(json).byteLength;
          if(length>RESEARCH_PACKAGE_MAX_RECORD_BYTES)throw new Error("record_budget");if(bytes+length>256*1024&&group.length){groups.push(group);group=[];bytes=0;}
          group.push({kind:record.kind,id:record.sourceId,json,ordinal});bytes+=length;});if(group.length)groups.push(group);
        await db.batch([repository.guard(db,claim),...groups.map(rows=>db.prepare(`INSERT INTO research_package_records(job_id,record_kind,source_id,record_json,ordinal)
          SELECT ?,json_extract(value,'$.kind'),json_extract(value,'$.id'),json_extract(value,'$.json'),json_extract(value,'$.ordinal') FROM json_each(?)
          WHERE NOT EXISTS(SELECT 1 FROM research_package_records existing WHERE existing.job_id=? AND existing.record_kind=json_extract(value,'$.kind') AND existing.source_id=json_extract(value,'$.id'))`)
          .bind(claim.id,stableJson(rows),claim.id)),db.prepare("SELECT CASE WHEN(SELECT count(*) FROM research_package_records WHERE job_id=?)=? THEN 1 ELSE json('Validated package records incomplete') END")
          .bind(claim.id,pkg.records.length)]);
        const {records:_records,...manifest}=pkg;
        const frozen={byteSize:validated.byteSize,sha256:validated.sha256,entries:validated.entries,manifest};
        if(new TextEncoder().encode(stableJson(frozen)).byteLength>RESEARCH_PACKAGE_MAX_PERSISTED_MANIFEST_BYTES)throw new Error("manifest_budget");
        return frozen;
      }finally{await source.dispose?.();}},
    async importBody(claim,file,current,signal){const upload=await repository.job(claim.source_upload_job_id!);
      if(!upload?.frozen_archive_json)throw new Error("Validated upload is unavailable");
      const artifact=(await repository.files(upload.id)).find(row=>row.entry_kind==="artifact"),frozen=JSON.parse(upload.frozen_archive_json) as FrozenArchive;
      const entry=frozen.entries.find(row=>row.path===file.archive_path);
      if(!artifact||!entry||entry.byteSize!==file.byte_size||entry.sha256!==file.sha256)throw new Error("Frozen archive entry changed");
      const source=await heldArchiveSource(claim,artifact,current,signal);
      try{return await openStoreArchiveEntry(source,entry,{signal,createHash:cloudflareSha256});}catch(error){await source.dispose?.();throw error;}},
    async importPublication(claim){if(!claim.domain_plan_json)throw new Error("Frozen import plan is unavailable");
      const plan=JSON.parse(claim.domain_plan_json) as FrozenImportDomainPlan;
      return {statements:prepareImportDomainPublication(repository.database.primary(),plan),result:{roots:plan.roots,reused:false}};},
  };
  async function openExportEntry(claim:PackageClaim,entry:ArchiveEntry,contents:Map<string,string>,current:()=>Promise<boolean>,signal:AbortSignal){
    if(contents.has(entry.path)){const bytes=new TextEncoder().encode(contents.get(entry.path)!);return bufferByteStream(bytes.buffer as ArrayBuffer);}
    const file=(await repository.files(claim.id)).find(row=>row.entry_kind==="source"&&row.archive_path===entry.path);
    if(!file)throw new Error("Frozen source entry is unavailable");
    const fence=async()=>await current()&&Boolean(await repository.database.primary().prepare(`SELECT 1 FROM file_location_holds
      WHERE location_id=? AND operation_id=? AND released_at IS NULL`).bind(file.source_location_id,file.hold_operation_id).first());
    const storage=await capabilities.openStorage({profileId:file.source_profile_id!,configurationRevision:file.source_profile_revision!},"read",fence,signal);
    if(storage.namespaceIdentity!==file.source_namespace)throw new Error("Frozen source namespace changed");
    const object=await storage.reader.read(file.source_object_key!);if(object.outcome!=="available")throw new Error("Frozen source bytes unavailable");return object.body;
  }
  async function heldArchiveSource(claim:PackageClaim,file:PackageFile,current:()=>Promise<boolean>,signal:AbortSignal):Promise<ArchiveSource>{
    const db=repository.database.primary();
    const location=await db.prepare(`SELECT l.object_key,l.storage_profile_id,p.configuration_revision,p.namespace_identity
      FROM file_location_publications l JOIN storage_profiles p ON p.id=l.storage_profile_id WHERE l.location_id=? AND l.file_id=?`)
      .bind(file.result_location_id,file.result_file_id).first<{object_key:string;storage_profile_id:string;configuration_revision:number;namespace_identity:string}>();
    if(!location)throw new Error("Held archive location is unavailable");
    const fence=async()=>await current()&&Boolean(await repository.database.primary().prepare(claim.kind==="import"
      ?"SELECT 1 FROM file_location_holds WHERE location_id=? AND operation_id=? AND released_at IS NULL"
      :"SELECT 1 FROM file_holds WHERE file_id=? AND operation_id=? AND released_at IS NULL")
      .bind(claim.kind==="import"?file.result_location_id:file.result_file_id,claim.kind==="import"?`fp4-source:${claim.id}`:`fp4-output:${claim.id}`).first());
    return sourceFromStream(file.byte_size,async(reopenSignal)=>{const storage=await capabilities.openStorage({profileId:location.storage_profile_id,configurationRevision:location.configuration_revision},"read",fence,reopenSignal ?? signal);
      if(storage.namespaceIdentity!==location.namespace_identity)throw new Error("Held archive namespace changed");
      const object=await storage.reader.read(location.object_key);if(object.outcome!=="available")throw new Error("Held archive bytes unavailable");return object.body;});
  }
  return capabilities;
}

/** Uses the existing explicitly enabled independent invocation, one action.
 * No trigger/cadence or job execution is installed by an HTTP route. */
export async function dispatchPackageJobs(env:Env){
  if(!await packageSqlDatabase(env.DB).primary().prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='research_package_jobs'").first())return {jobId:null,outcome:"unsupported"};
  const capabilities=await workerPackageCapabilities(env);if(!capabilities)return {jobId:null,outcome:"disabled"};
  await capabilities.repository.database.primary().prepare("UPDATE file_job_runtime_guard SET last_heartbeat_at=? WHERE singleton=1 AND enabled=1 AND incarnation=?")
    .bind(new Date().toISOString(),capabilities.incarnation).run();
  if(await (capabilities.repository as SqlPackageRepository).maintain(capabilities.incarnation))return {jobId:null,outcome:"cleaned"};
  return runPackageJobStep(capabilities);
}
