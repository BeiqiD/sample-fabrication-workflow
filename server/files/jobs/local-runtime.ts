import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { closeFileJobExecutions, FileJobExecutionDrainError } from "../../../worker/files/jobs/execution-lifetime";
import { runFileJobCleanupStep, runFileJobStep } from "../../../worker/files/jobs/migration-kernel";
import type { FileJobCapabilities } from "../../../worker/files/jobs/types";
import { openStorageProfile } from "../../../worker/files/storage-profile-opening";
import { localAuthenticationIdentityAuthority } from "../../auth/local-auth-http";
import { assertInstalledLocalIdentityOwner } from "../../auth/identity";
import type { ReviewedInstallationAdmission } from "../../migrations";
import { assertNodeRuntimeConfiguration, type LoadedNodeRuntimeConfiguration } from "../../node-runtime-config";
import { ownedLocalVolumeProfileContext, type LocalVolumeProfileOpening } from "../../storage/local-volume-profile-opening";
import { createNodeFileJobExecutionAdmission } from "./execution-admission";
import { createInstalledJobPrincipalAuthority } from "./principal-authority";
import { createOwnedNodeFileJobPort } from "./repository";
import { createNodeFileJobHttpRoutes } from "./request-http";

export const NODE_LOCAL_FILE_JOB_CADENCE_MS = 120_000;
type FileJobStorageArguments = Parameters<FileJobCapabilities["openStorage"]>;
export interface NodeLocalFileJobResult { readonly jobId: string | null; readonly outcome: string }
export class NodeLocalFileJobDrainError extends FileJobExecutionDrainError {
  constructor(errors: readonly unknown[], owners: readonly unknown[]) {
    super(errors, owners); this.name="NodeLocalFileJobDrainError";
  }
}
const retainedInstallations = new Set<object>();
const installedRunners = new WeakMap<DatabaseSync, object>();
/** One background runner belongs to the already-issued application opening.
 * No second Native/core/physical lease is created or closed here. HTTP writes
 * only persist/control original Job history; independent 120s slots execute
 * unchanged kernel work. Config opt-in does not enable the persisted executor
 * or resume restored paused jobs, create profiles, or grant an administrator. */
export function createNodeLocalFileJobs(options: {
  configuration: LoadedNodeRuntimeConfiguration; opening: LocalVolumeProfileOpening;
  authentication: object; admission: ReviewedInstallationAdmission;
  /** Deny-only notification to the sole application owner after failed ACK. */
  stopApplicationAdmission: () => void;
}) {
  const {configuration, opening, authentication, admission}=options;
  const config=assertNodeRuntimeConfiguration(configuration), local=ownedLocalVolumeProfileContext(opening);
  if (!config.enableLocalFile || !config.enableLocalJobs || !config.localVolumes.length) throw new Error("Local Job configuration is unavailable");
  if (installedRunners.has(local.nativeDatabase)) throw new Error("Original application Job runner is already owned");
  const auth=localAuthenticationIdentityAuthority(authentication);
  assertInstalledLocalIdentityOwner(auth.identity, local.database, local.nativeDatabase, admission);
  const authority=createInstalledJobPrincipalAuthority({database:local.database, nativeDatabase:local.nativeDatabase,
    admission, writerLease:local.writerLease});
  const http=createNodeFileJobHttpRoutes<{readonly database: typeof local.database}>({authority,authentication,admission,writerLease:local.writerLease});
  const invocations=new Set<Promise<NodeLocalFileJobResult>>();
  let phase: "open" | "stopping" | "closed" | "quarantined"="open";
  let active: Promise<NodeLocalFileJobResult> | undefined, close: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, transport: Server | undefined;
  let listening: (()=>void) | undefined, failure: NodeLocalFileJobDrainError | undefined;
  const state={configuration,opening,authentication,admission,authority,http,invocations};
  retainedInstallations.add(state); installedRunners.set(local.nativeDatabase,state);
  function current(): void {
    if (assertNodeRuntimeConfiguration(configuration)!==config || localAuthenticationIdentityAuthority(authentication)!==auth)
      throw new Error("Original local Job configuration changed");
    local.assertCurrent(); assertInstalledLocalIdentityOwner(auth.identity,local.database,local.nativeDatabase,admission);
  }
  function inspect(): { outcome: "available" | "disabled" | "paused"; incarnation?: string } {
    current();
    const row=local.nativeDatabase.prepare(`SELECT j.enabled,j.incarnation,c.mode,f.enabled AS file_enabled,m.state,
      (SELECT count(*) FROM system_recovery_write_leases WHERE released_at IS NULL) AS writers
      FROM file_job_runtime_guard j JOIN file_authority_control c ON c.singleton=j.singleton
      JOIN file_authority_runtime_guard f ON f.singleton=j.singleton
      JOIN system_recovery_maintenance m ON m.singleton=j.singleton WHERE j.singleton=1`).get();
    if (!row || row.enabled!==1 || typeof row.incarnation!=="string" || !row.incarnation) return {outcome:"disabled"};
    if (row.mode!=="active" || row.file_enabled!==1 || row.state!=="open" || row.writers!==0) return {outcome:"paused"};
    return {outcome:"available",incarnation:row.incarnation};
  }
  function quarantine(error: unknown, original?: Promise<NodeLocalFileJobResult>): NodeLocalFileJobDrainError {
    if (original) invocations.add(original);
    if (!failure) failure=new NodeLocalFileJobDrainError([error],[state,transport,timer,active,...invocations]);
    phase="quarantined";
    http.stopAdmission();
    if (timer!==undefined) {clearTimeout(timer);timer=undefined;}
    options.stopApplicationAdmission();
    return failure;
  }
  function dispatchOnce(): Promise<NodeLocalFileJobResult> {
    if (phase!=="open") return Promise.reject(failure??new Error("Local File Job runner is closed"));
    if (active) return Promise.reject(new Error("Local File Job runner is busy"));
    try {
    const observed=inspect();
    if (observed.outcome!=="available") return Promise.resolve({jobId:null,outcome:observed.outcome});
    const incarnation=observed.incarnation!;
    const source=createNodeFileJobExecutionAdmission({authority,writerLease:local.writerLease,opening,incarnation});
    const port=createOwnedNodeFileJobPort({authority,incarnation,executionAdmission:source.token});
    const capabilities: FileJobCapabilities=Object.freeze({repository:port.repository,incarnation,
      now:()=>new Date(),randomId:()=>crypto.randomUUID(),
      authorizeAdministrator:port.authorizeAdministrator,authorizeSystemCleanup:port.authorizeSystemCleanup,
      async openStorage(target: FileJobStorageArguments[0],access: FileJobStorageArguments[1],
        beforeRequest: FileJobStorageArguments[2],signal: FileJobStorageArguments[3]) {
        current(); await source.beforeRequest(); source.captureProfile(target,access);
        const opened=await openStorageProfile(opening.capabilities,target,access,{signal,
          async beforeRequest(operation) {
            current(); await source.beforeRequest();
            if (await beforeRequest(operation)!==true) return false;
            current(); await source.beforeRequest(); return true;
          }});
        return {namespaceIdentity:opened.storage.namespaceIdentity,adapterType:opened.storage.adapterType,
          reader:opened.reader,writer:opened.writer,createHash:opened.createHash,atomicSinglePut:true,
          ...(opened.dispose ? {dispose:opened.dispose.bind(opened)} : {})};
      },
    });
    const original=local.writerLease.withWriter(async ()=>{
      await source.acquire();
      let workFailed=false,workError: unknown;
      try {
        const cleanup=await runFileJobCleanupStep(capabilities);
        if (!["idle","disabled"].includes(cleanup.outcome)) return {jobId:null,outcome:cleanup.outcome};
        return await runFileJobStep(capabilities);
      } catch(error) {workFailed=true;workError=error;throw error;}
      finally {
        // No source release until every original byte/provider operation has
        // settled and its first disposer acknowledged. Failed close keeps the
        // durable scheduled source and the application's physical owner.
        try {await closeFileJobExecutions(capabilities);await source.close();}
        catch(error) {if(workFailed) throw new AggregateError([workError,error],"Local File Job work and original close failed");throw error;}
      }
    });
    active=original;invocations.add(original);
    original.then(()=>{if(active===original)active=undefined;invocations.delete(original);},error=>{
      if(active===original)active=undefined;quarantine(error,original);
    });
    return original;
    } catch(error) {
      // Preserve the original application owner when issuing a source/port or
      // starting its physical lease scope fails before a Promise is returned.
      // The cadence receives the same rejected outcome instead of throwing
      // out of its callback and losing the runner's first drain obligation.
      return Promise.reject(quarantine(error));
    }
  }
  function schedule(): void {
    if (phase!=="open" || timer!==undefined) return;
    timer=setTimeout(()=>{timer=undefined;const original=dispatchOnce();
      original.then(()=>schedule(),error=>{quarantine(error,original);});
    },NODE_LOCAL_FILE_JOB_CADENCE_MS);
    timer.unref();
  }
  function stopAdmission(): void {
    if(phase==="open")phase="stopping";http.stopAdmission();
    if(timer!==undefined){clearTimeout(timer);timer=undefined;}
    if(transport && listening)transport.removeListener("listening",listening);
  }
  const admittedRoutes=Object.freeze([
    {method:"GET",path:"/files/migrations"},{method:"GET",path:"/files/migrations/files"},
    {method:"GET",path:"/files/migrations/executor"},{method:"POST",path:"/files/migrations/executor"},
    {method:"POST",path:"/files/migrations/plans"},{method:"POST",path:"/files/migrations"},
    {method:"GET",path:"/files/migrations/:jobId"},{method:"GET",path:"/files/migrations/:jobId/items"},
    {method:"POST",path:"/files/migrations/:jobId/cleanup"},{method:"POST",path:"/files/migrations/:jobId/:action"},
  ].map(route=>Object.freeze(route)));
  return Object.freeze({routes:http.routes,admittedRoutes,dispatchOnce,stopAdmission,
    startOnListening(server: Server): void {
      if(phase!=="open" || transport)throw new Error("Original local Job transport is already bound");
      current();transport=server;listening=()=>{if(phase==="open")schedule();};
      if(server.listening)listening();else server.once("listening",listening);
    },
    drain(): Promise<void> {
      if(close)return close;stopAdmission();
      close=(async()=>{
        const errors: unknown[]=[];
        const results=await Promise.allSettled([...invocations]);
        for(const value of results)if(value.status==="rejected")errors.push(value.reason);
        try{await http.drain();}catch(error){errors.push(error);}
        if(failure || errors.length)throw quarantine(failure??new AggregateError(errors,"Original local File Job drain failed"));
        current();authority.close();phase="closed";retainedInstallations.delete(state);
        if(installedRunners.get(local.nativeDatabase)===state)installedRunners.delete(local.nativeDatabase);
      })().catch(error=>{throw quarantine(error);});
      close.then(()=>undefined,()=>undefined);return close;
    },
  });
}
