import type { Env } from "../types";
import type { FilePurpose } from "../../shared/contracts/files";
import { prepareStorageRoleSelection,roleForFilePurpose } from "../files/storage-role-selection";
import { canAdministerSystemSettings } from "../storage/system-administrator";
import { inspectWorkerFileJobRuntime } from "../files/jobs/worker-runtime";
import { readPublishedFile } from "../files/authority-reader";
import { HTTPException } from "hono/http-exception";
import { packageActorAllowed,packageSqlDatabase,workerPackageCapabilities } from "./jobs/worker-runtime";
import { SqlPackageRepository } from "./jobs/sql-repository";
import { closeFileJobExecutions } from "../files/jobs/execution-lifetime";
import { writePackageUpload } from "./jobs/kernel";
import type { PackageTargets } from "./jobs/types";
import type { JobSqlStatement } from "../files/jobs/sql-repository";
import { createPackageRoutes,readPackageRequestJson,readPackageRolePolicyRevision } from "./routes-core";

const purposes:FilePurpose[]=["research_source","provenance","embedded_content","derived_preview","job_output"];
const fail=(message:string,status:400|404|409|413|503=409)=>new HTTPException(status,{message});
async function targetSelection(env:Env,required:readonly FilePurpose[]=["job_output"]){
  const revision=await readPackageRolePolicyRevision(packageSqlDatabase(env.DB)),needed=[...new Set(required)];
  if(!needed.length&&revision===null)throw fail("Role policy is unavailable",409);
  const prepared=needed.length?await prepareStorageRoleSelection(env.DB,env,needed,new Date().toISOString())
    :{rolePolicyRevision:revision!,statements:[] as D1PreparedStatement[],profileFor(_purpose:FilePurpose):never{throw fail("Unselected package role is unavailable",409);}};
  const metadata=(await packageSqlDatabase(env.DB).primary().prepare(`SELECT d.role,p.id,p.namespace_identity
    FROM storage_role_defaults d JOIN storage_profiles p ON p.id=d.storage_profile_id AND p.configuration_revision=d.storage_profile_revision`).all<{role:string;id:string;namespace_identity:string}>()).results;
  const targets={} as Record<FilePurpose,PackageTargets[FilePurpose]>;
  for(const purpose of purposes){const role=roleForFilePurpose(purpose),stored=metadata.find(row=>row.role===role);
    const p=needed.includes(purpose)||!stored?prepared.profileFor(needed.find(p=>roleForFilePurpose(p)===role)??"job_output"):null;
    targets[purpose]={profileId:p?.id??stored!.id,configurationRevision:1,namespaceIdentity:p?.namespaceIdentity??stored!.namespace_identity,policyRevision:prepared.rolePolicyRevision};}
  if(await readPackageRolePolicyRevision(packageSqlDatabase(env.DB))!==revision)throw fail("Role policy changed while preparing its preview",409);
  return{targets,revision,statements:prepared.statements as unknown as JobSqlStatement[]};}

/** Only concrete Worker bindings live here; the HTTP algorithm is shared. */
export const packageRoutes=createPackageRoutes<Env>({
  async run(_request,env,actor,work){
    const database=packageSqlDatabase(env.DB),repository=new SqlPackageRepository(database);
    return work({actor,repository,database,
      actorAllowed:()=>packageActorAllowed(env,actor),
      selectTargets:required=>targetSelection(env,required),
      inspectRuntime:()=>inspectWorkerFileJobRuntime(env),
      canManage:()=>canAdministerSystemSettings(env,actor),
      capabilities:()=>workerPackageCapabilities(env),
      readJson:readPackageRequestJson,
      async writeUpload(capabilities,claim,body){
        try{await writePackageUpload(capabilities,claim,body);}
        finally{await closeFileJobExecutions(capabilities);}
      },
      readOutput:fileId=>readPublishedFile(env,{fileId,purpose:"job_output"}),
    });
  },
});
