import { randomUUID } from "node:crypto";
import { bindPackageFormatCapabilities } from "../../worker/packages/jobs/format-capabilities";
import { SqlPackageRepository } from "../../worker/packages/jobs/sql-repository";
import type { PackageCapabilities, PackageClaim, PackageRepository } from "../../worker/packages/jobs/types";
import { openStorageProfile } from "../../worker/files/storage-profile-opening";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { captureInstalledIdentityExecutionOwner } from "../auth/installed-identity-execution-owner";
import type { ReviewedInstallationAdmission } from "../migrations";
import { assertNodeRuntimeConfiguration, type LoadedNodeRuntimeConfiguration } from "../node-runtime-config";
import { asAdmittedJobSqlDatabase, createSqliteBatchAdmission } from "../sqlite";
import { nodeSha256 } from "../storage/node-sha256";
import { ownedLocalVolumeProfileContext, type LocalVolumeProfileOpening } from "../storage/local-volume-profile-opening";
import { localJobPrincipalId, ownedJobPrincipalAuthority, type InstalledJobPrincipalAuthority } from "../files/jobs/principal-authority";
import { captureNodeJobProfileAuthority, nodeFileJobExecutionChecks, type NodeFileJobExecutionAdmission } from "../files/jobs/execution-admission";

type Policy = Readonly<{kind:"owner"}> | Readonly<{kind:"actor";actor:string;jobId?:string}>;
const OWNER:Policy=Object.freeze({kind:"owner"});
/** Internal concrete V26 adapter only. No Request, route, profile registration,
 * File activation, executor enablement or restored V28 grant is issued here.
 * The sole scheduled source/Native/physical owner belongs to the actual host.
 * Current account authorization is ordinary research authority, never an admin
 * requirement. The original same-BEGIN SQL checks prevent a revocation racing
 * a formatter or publication after its JavaScript current() check. */
export function createNodePackageCapabilities(options: {
  configuration:LoadedNodeRuntimeConfiguration; opening:LocalVolumeProfileOpening; authentication:object; admission:ReviewedInstallationAdmission;
  authority:InstalledJobPrincipalAuthority; executionAdmission:NodeFileJobExecutionAdmission; incarnation:string;
}): Readonly<{capabilities:PackageCapabilities;maintain():Promise<boolean>}> {
  const {configuration,opening,authentication,admission,authority,executionAdmission,incarnation}=options;
  const config=assertNodeRuntimeConfiguration(configuration);
  if(!config.enableLocalFile||!config.enableLocalJobs||!config.localVolumes.length)throw new Error("Explicit Node package host opt-in is unavailable");
  const local=ownedLocalVolumeProfileContext(opening),owner=ownedJobPrincipalAuthority(authority);
  if(local.database!==owner.database||local.nativeDatabase!==owner.nativeDatabase
    ||local.installationCheckpointId!=="portable-runtime/v26"||typeof incarnation!=="string"||!incarnation)
    throw new Error("Current Node package installation is unavailable");
  const auth=localAuthenticationIdentityAuthority(authentication);
  const identity=captureInstalledIdentityExecutionOwner(auth.identity,local.database,local.nativeDatabase,admission);
  if(identity.installation.installationId!==config.expectedInstallationId)throw new Error("Configured Node package installation changed");
  const nativeFile=local.nativeDatabase.prepare("PRAGMA database_list").all().find(row=>row.name==="main");
  if(nativeFile?.file!==config.databasePath)throw new Error("Configured Node package database owner changed");
  function current():void {
    if(assertNodeRuntimeConfiguration(configuration)!==config)throw new Error("Original Node package configuration changed");
    owner.assertCurrent();local.assertCurrent();identity.assertCurrent();
    if(localAuthenticationIdentityAuthority(authentication)!==auth)throw new Error("Original Node package identity changed");
  }
  function actorAllowed(actor:string):boolean {
    try {
      current();const id=localJobPrincipalId(actor);if(!id)return false;
      const row=local.nativeDatabase.prepare(`SELECT 1 FROM local_accounts WHERE principal_id=? AND enabled=1`).get(id);
      current();return !!row;
    } catch{return false;}
  }
  function view(policy:()=>Policy,settlement=false) {
    return asAdmittedJobSqlDatabase(owner.database,()=>{
      current();const selected=policy();
      const checks=[...nodeFileJobExecutionChecks(executionAdmission,authority,settlement)];
      if(selected.kind==="actor") {
        const id=localJobPrincipalId(selected.actor);if(!id)throw new Error("Current package actor is unavailable");
        const statement=selected.jobId===undefined
          ?owner.database.prepare("SELECT 1 AS admitted FROM local_accounts WHERE principal_id=? AND enabled=1").bind(id)
          :owner.database.prepare(`SELECT 1 AS admitted FROM local_accounts a JOIN research_package_jobs j
            ON j.actor='local-account:'||a.principal_id WHERE a.principal_id=? AND a.enabled=1 AND j.id=?`).bind(id,selected.jobId);
        checks.push({statement,rejection:new Error("Current package actor is unavailable")});
      }
      return createSqliteBatchAdmission(owner.database,checks);
    },{assertHeld:current});
  }
  const repository=(policy:Policy|(()=>Policy)=OWNER,settlement=false)=>new SqlPackageRepository(
    view(typeof policy==="function"?policy:()=>policy,settlement),()=>new Date(),randomUUID);
  const original=repository(),settled=repository(OWNER,true);
  let selected:Policy=OWNER;
  const active=repository(()=>selected);
  const claimPolicy=(claim:PackageClaim):Policy=>{
    current();if(claim.runtime_incarnation!==incarnation)throw new Error("Original package incarnation changed");
    return Object.freeze({kind:"actor",actor:claim.actor,jobId:claim.id});
  };
  const owned:PackageRepository={database:active.database,
    guard:(db,claim)=>active.guard(db,claim),
    async claim(value,token,restrict){
      if(value!==incarnation)throw new Error("Original package incarnation changed");selected=OWNER;
      const claimed=await active.claim(value,token,actor=>{
        if(!actorAllowed(actor)||restrict(actor)!==true){selected=OWNER;return false;}
        selected=Object.freeze({kind:"actor",actor});return true;
      });
      selected=claimed?claimPolicy(claimed):OWNER;return claimed;
    },
    owns:claim=>original.owns(claim),job:id=>active.job(id),status:(id,actor)=>active.status(id,actor),
    files:id=>active.files(id),records:id=>active.records(id),attempt:file=>active.attempt(file),
    stage:(claim,file)=>repository(claimPolicy(claim)).stage(claim,file),
    startWrite:(claim,attempt)=>repository(claimPolicy(claim)).startWrite(claim,attempt),
    // Original positive I/O evidence and denial bookkeeping remain possible
    // after actor/executor revocation, under the retained same source owner.
    settled:attempt=>settled.settled(attempt),pause:(claim,reason,attempt)=>settled.pause(claim,reason,attempt),
    verify:(claim,file,attempt)=>repository(claimPolicy(claim)).verify(claim,file,attempt),
    checkpoint:(claim,phase,values)=>repository(claimPolicy(claim)).checkpoint(claim,phase,values),
    addOutput:(claim,expectation)=>repository(claimPolicy(claim)).addOutput(claim,expectation),
    publishFile:(claim,file,attempt)=>repository(claimPolicy(claim)).publishFile(claim,file,attempt),
    publish:(claim,statements,result)=>active.publish(claim,statements,result),
  };
  const capabilities=Object.freeze(bindPackageFormatCapabilities({repository:owned,incarnation,authorizeActor:actorAllowed,
    now:()=>new Date(),randomId:randomUUID,
    async openStorage(target,access,beforeRequest,signal){
      current();captureNodeJobProfileAuthority(executionAdmission,authority,target,access,4);
      await original.database.batch([]);
      const opened=await openStorageProfile(opening.capabilities,target,access,{signal,async beforeRequest(operation){
        current();await original.database.batch([]);
        if(await beforeRequest(operation)!==true)return false;
        current();await original.database.batch([]);return true;
      }});
      return {...opened,namespaceIdentity:opened.storage.namespaceIdentity,adapterType:opened.storage.adapterType,
        atomicSinglePut:true,...(opened.dispose?{dispose:opened.dispose.bind(opened)}:{})};
    },
  },nodeSha256));
  return Object.freeze({capabilities,async maintain(){current();await original.database.prepare("UPDATE file_job_runtime_guard SET last_heartbeat_at=? WHERE singleton=1 AND enabled=1 AND incarnation=?").bind(new Date().toISOString(),incarnation).run();return original.maintain(incarnation);}});
}
