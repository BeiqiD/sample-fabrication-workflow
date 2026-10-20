import { allowedEmail } from "../../auth";
import { primaryD1 } from "../../d1-primary";
import type { Env } from "../../types";
import type { JobSqlDatabase, JobSqlStatement } from "../../files/jobs/sql-repository";
import { inspectWorkerFileJobRuntime } from "../../files/jobs/worker-runtime";
import { openShadowProfile } from "../../files/shadow-profile";
import { cloudflareSha256 } from "../../files/storage-adapters/cloudflare-sha256";
import { bindPackageFormatCapabilities } from "./format-capabilities";
export { readPackageUploadMetadata, readValidatedPackage } from "./format-capabilities";
import { SqlPackageRepository } from "./sql-repository";
import { runPackageJobStep } from "./kernel";
import { closeFileJobExecutions } from "../../files/jobs/execution-lifetime";
import type { PackageCapabilities } from "./types";

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
export async function workerPackageCapabilities(env:Env):Promise<PackageCapabilities|null> {
  const runtime=await inspectWorkerFileJobRuntime(env);if(runtime.outcome!=="available"||!runtime.incarnation)return null;
  if(!await packageSqlDatabase(env.DB).primary().prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='research_package_jobs'").first())return null;
  const repository=packageRepository(env);
  return bindPackageFormatCapabilities({repository,incarnation:runtime.incarnation,authorizeActor:actor=>packageActorAllowed(env,actor),
    now:()=>new Date(),randomId:()=>crypto.randomUUID(),
    async openStorage(target,access,beforeRequest,signal){const profile=await openShadowProfile(env,target,access,{beforeRequest,signal});
      return {...profile,namespaceIdentity:profile.storage.namespaceIdentity,adapterType:profile.storage.adapterType,
        atomicSinglePut:profile.storage.adapterType==="r2"||profile.storage.adapterType==="s3"};},
  },cloudflareSha256);
}

/** Uses the existing explicitly enabled independent invocation, one action.
 * No trigger/cadence or job execution is installed by an HTTP route. */
export async function dispatchPackageJobs(env:Env,expectedIncarnation?:string){
  if(!await packageSqlDatabase(env.DB).primary().prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='research_package_jobs'").first())return {jobId:null,outcome:"unsupported"};
  const capabilities=await workerPackageCapabilities(env);if(!capabilities)return {jobId:null,outcome:"disabled"};
  if(expectedIncarnation!==undefined&&capabilities.incarnation!==expectedIncarnation)return {jobId:null,outcome:"reconfigured"};
  await capabilities.repository.database.primary().prepare("UPDATE file_job_runtime_guard SET last_heartbeat_at=? WHERE singleton=1 AND enabled=1 AND incarnation=?")
    .bind(new Date().toISOString(),capabilities.incarnation).run();
  if(await (capabilities.repository as SqlPackageRepository).maintain(capabilities.incarnation))return {jobId:null,outcome:"cleaned"};
  try{return await runPackageJobStep(capabilities);}finally{await closeFileJobExecutions(capabilities);}
}
