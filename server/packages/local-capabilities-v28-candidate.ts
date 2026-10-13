import { randomUUID } from "node:crypto";
import { bindPackageFormatCapabilities } from "../../worker/packages/jobs/format-capabilities";
import { SqlPackageRepository } from "../../worker/packages/jobs/sql-repository";
import type { PackageCapabilities, PackageClaim, PackageRepository } from "../../worker/packages/jobs/types";
import { openStorageProfile } from "../../worker/files/storage-profile-opening";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { captureInstalledIdentityExecutionOwnerV28Candidate } from "../auth/installed-identity-execution-owner-v28-candidate";
import type { ReviewedInstallationAdmission } from "../migrations";
import { assertNodeRuntimeConfiguration, type LoadedNodeRuntimeConfiguration } from "../node-runtime-config";
import { asAdmittedJobSqlDatabase, createSqliteBatchAdmission } from "../sqlite";
import { createNodePackagePurposeV28Candidate } from "./local-permission-v28-candidate";
import { nodeSha256 } from "../storage/node-sha256";
import { ownedLocalVolumeProfileContextV28Candidate, type LocalVolumeProfileOpeningV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate";
import { localJobPrincipalId, ownedJobPrincipalAuthority, type InstalledJobPrincipalAuthority } from "../files/jobs/principal-authority";
import { captureNodeJobProfileAuthority, nodeFileJobExecutionChecks, type NodeFileJobExecutionAdmission } from "../files/jobs/execution-admission";

type PackageIdentityOwner = Readonly<{
  configuration:LoadedNodeRuntimeConfiguration; config:ReturnType<typeof assertNodeRuntimeConfiguration>;
  opening:LocalVolumeProfileOpeningV28Candidate; authentication:object;
  auth:ReturnType<typeof localAuthenticationIdentityAuthority>;
  identity:ReturnType<typeof localAuthenticationIdentityAuthority>["identity"];
  database:ReturnType<typeof ownedJobPrincipalAuthority>["database"];
  nativeDatabase:ReturnType<typeof ownedJobPrincipalAuthority>["nativeDatabase"];
  admission:ReviewedInstallationAdmission; captured:ReturnType<typeof captureInstalledIdentityExecutionOwnerV28Candidate>;
}>;
// Only the original privately issued principal authority owns this lifetime.
// Its checked accessor rejects closed authorities before any cache lookup;
// captured schema/ledger checks remain live, and execution grants are never cached.
const packageIdentityOwners=new WeakMap<InstalledJobPrincipalAuthority,PackageIdentityOwner>();

type Policy = Readonly<{kind:"owner"}> | Readonly<{kind:"actor";actor:string;jobId?:string}>;
const OWNER:Policy=Object.freeze({kind:"owner"});
/** Separate concrete V28 Group-root adapter only. No Request, route, profile registration,
 * File activation, executor enablement or restored V28 grant is issued here.
 * The sole scheduled source/Native/physical owner belongs to the actual host.
 * Current ordinary research authority requires a genuine active Group member
 * and each selected live root grant or fresh creation capability; admin alone
 * does not issue those rights. The original same-BEGIN SQL checks prevent a revocation racing
 * a formatter or publication after its JavaScript current() check. */
export function createNodePackageCapabilitiesV28Candidate(options: {
  configuration:LoadedNodeRuntimeConfiguration; opening:LocalVolumeProfileOpeningV28Candidate; authentication:object; admission:ReviewedInstallationAdmission;
  authority:InstalledJobPrincipalAuthority; executionAdmission:NodeFileJobExecutionAdmission; incarnation:string;
}): Readonly<{capabilities:PackageCapabilities;maintain():Promise<boolean>}> {
  if(Object.keys(options).sort().join(",")!=="admission,authentication,authority,configuration,executionAdmission,incarnation,opening")throw new Error("Closed V28 Package scheduled owner is required");
  const {configuration,opening,authentication,admission,authority,executionAdmission,incarnation}=options;
  const config=assertNodeRuntimeConfiguration(configuration);
  if(!config.enableLocalFile||!config.enableLocalJobs||!config.localVolumes.length)throw new Error("Explicit Node package host opt-in is unavailable");
  const local=ownedLocalVolumeProfileContextV28Candidate(opening),owner=ownedJobPrincipalAuthority(authority);
  if(local.database!==owner.database||local.nativeDatabase!==owner.nativeDatabase
    ||local.installationCheckpointId!=="portable-runtime/v28"||typeof incarnation!=="string"||!incarnation)
    throw new Error("Current Node package installation is unavailable");
  const auth=localAuthenticationIdentityAuthority(authentication);
  const groupPurpose=createNodePackagePurposeV28Candidate({authority,opening,authentication,admission});
  const cachedIdentity=packageIdentityOwners.get(authority);
  if(cachedIdentity&&(cachedIdentity.configuration!==configuration||cachedIdentity.config!==config
    ||cachedIdentity.opening!==opening||cachedIdentity.authentication!==authentication||cachedIdentity.auth!==auth
    ||cachedIdentity.identity!==auth.identity||cachedIdentity.database!==local.database
    ||cachedIdentity.nativeDatabase!==local.nativeDatabase||cachedIdentity.admission!==admission))
    throw new Error("Original Node package identity owner changed");
  const identity=cachedIdentity?.captured??captureInstalledIdentityExecutionOwnerV28Candidate(auth.identity,local.database,local.nativeDatabase,admission);
  if(cachedIdentity)identity.assertCurrent();
  if(identity.installation.installationId!==config.expectedInstallationId)throw new Error("Configured Node package installation changed");
  const nativeFile=local.nativeDatabase.prepare("PRAGMA database_list").all().find(row=>row.name==="main");
  if(nativeFile?.file!==config.databasePath)throw new Error("Configured Node package database owner changed");
  if(!cachedIdentity)packageIdentityOwners.set(authority,Object.freeze({configuration,config,opening,authentication,auth,
    identity:auth.identity,database:local.database,nativeDatabase:local.nativeDatabase,admission,captured:identity}));
  function current():void {
    if(assertNodeRuntimeConfiguration(configuration)!==config)throw new Error("Original Node package configuration changed");
    owner.assertCurrent();local.assertCurrent();identity.assertCurrent();groupPurpose.current();
    if(localAuthenticationIdentityAuthority(authentication)!==auth)throw new Error("Original Node package identity changed");
  }
  function actorAllowed(actor:string,jobId?:string):boolean {
    try { current(); return groupPurpose.actorAllowed(actor,jobId); } catch { return false; }
  }

  function view(policy:()=>Policy,settlement=false) {
    return asAdmittedJobSqlDatabase(owner.database,()=>{
      current();const selected=policy();
      const checks=[...nodeFileJobExecutionChecks(executionAdmission,authority,settlement)];
      if(selected.kind==="actor") {
        const id=localJobPrincipalId(selected.actor);if(!id)throw new Error("Current package actor is unavailable");
        checks.push(...groupPurpose.checks(selected.actor,selected.jobId));
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
      // The concrete adapter selects the same original bounded10 rows so its
      // same-BEGIN claim check also knows the actual job and every root.
      const rows=await original.database.primary().prepare(`SELECT id,actor FROM research_package_jobs WHERE state='queued'
        OR(state='running' AND julianday(lease_expires_at)<=julianday('now')) ORDER BY updated_at,id LIMIT 10`).all<{id:string;actor:string}>();
      for(const row of rows.results){
        if(!actorAllowed(row.actor,row.id)||restrict(row.actor)!==true){
          selected=OWNER;
          await settled.database.primary().prepare("UPDATE research_package_jobs SET state='paused',reason='actor_revoked',generation=generation+1,updated_at=? WHERE id=? AND state IN('queued','running')")
            .bind(new Date().toISOString(),row.id).run();continue;
        }
        selected=Object.freeze({kind:"actor",actor:row.actor,jobId:row.id});
        const claimed=await active.claimOne(row.id,row.actor,value,token,false);
        if(claimed){selected=claimPolicy(claimed);return claimed;}
        selected=OWNER;
      }
      return null;
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
  const capabilities=Object.freeze(bindPackageFormatCapabilities({repository:owned,incarnation,authorizeActor:actor=>actorAllowed(actor,selected.kind==="actor"?selected.jobId:undefined),
    now:()=>new Date(),randomId:randomUUID,
    async openStorage(target,access,beforeRequest,signal){
      current();captureNodeJobProfileAuthority(executionAdmission,authority,target,access,4);
      await active.database.batch([]);
      const opened=await openStorageProfile(opening.capabilities,target,access,{signal,async beforeRequest(operation){
        current();await active.database.batch([]);
        if(await beforeRequest(operation)!==true)return false;
        current();await active.database.batch([]);return true;
      }});
      return {...opened,namespaceIdentity:opened.storage.namespaceIdentity,adapterType:opened.storage.adapterType,
        atomicSinglePut:true,...(opened.dispose?{dispose:opened.dispose.bind(opened)}:{})};
    },
  },nodeSha256));
  const originalImportPublication=capabilities.importPublication.bind(capabilities);
  const groupCapabilities:PackageCapabilities=Object.freeze({...capabilities,
    async importPublication(claim: PackageClaim){
      const actual=await originalImportPublication(claim);
      return{statements:groupPurpose.publication(claim,owned.database.primary(),actual.statements),result:actual.result};
    },
  });
  return Object.freeze({capabilities:groupCapabilities,async maintain(){current();await original.database.prepare("UPDATE file_job_runtime_guard SET last_heartbeat_at=? WHERE singleton=1 AND enabled=1 AND incarnation=?").bind(new Date().toISOString(),incarnation).run();return original.maintain(incarnation);}});
}
