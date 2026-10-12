import { HTTPException } from "hono/http-exception";
import { prepareAuthorityImportFilesWithCapabilities } from "../../worker/imports/fabublox-authority-core";
import { recoverAuthorityImportWithDatabase } from "../../worker/imports/fabublox-authority-recovery-core";
import { StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";
import { prepareLocalVolumeProfileAuthorityFence } from "../storage/local-volume-profile-opening";
import type { LocalUploadExecution } from "../files/local-upload-execution";
import type { NativeFileAuthoritySqlDatabase } from "../file-authority-sql";
import type { PreparedFabubloxPayload } from "../../worker/imports/fabublox-payload";
import { ownedLocalFabubloxAcceptedV28Candidate, type LocalFabubloxAcceptedV28Candidate } from "./local-fabublox-permission-v28-candidate";

declare const preparedBrand: unique symbol;
export interface LocalFabubloxPreparedFilesV28Candidate { readonly [preparedBrand]: true }
type Candidate = { kind: "workbook" | "manifest" | "image"; localId: string; originalName: string;
  mimeType: string; buffer: ArrayBuffer; sha256: string; image?: PreparedFabubloxPayload["manifest"]["images"][number] };
type Prepared = Awaited<ReturnType<typeof prepareAuthorityImportFilesWithCapabilities<Candidate>>>;
const preparedOwners = new WeakMap<LocalFabubloxPreparedFilesV28Candidate,
  Readonly<{ accepted: LocalFabubloxAcceptedV28Candidate; execution: LocalUploadExecution; request: Request;
    result: Prepared; database: NativeFileAuthoritySqlDatabase }>>();
const preparations = new WeakMap<LocalFabubloxAcceptedV28Candidate, Promise<LocalFabubloxPreparedFilesV28Candidate>>();
const recoveries = new WeakMap<LocalFabubloxAcceptedV28Candidate, Promise<Awaited<ReturnType<typeof recoverAuthorityImportWithDatabase>>>>();
const consumed = new WeakSet<LocalFabubloxPreparedFilesV28Candidate>();
const denied = () => new HTTPException(403,{message:"The original accepted local import execution is required."});

function retainedCleanup(error:unknown,seen=new Set<unknown>()):StorageProfileCleanupError|undefined {
  if(error instanceof StorageProfileCleanupError)return error;
  if(!error || typeof error!=="object" || seen.has(error))return;
  seen.add(error);
  if(error instanceof AggregateError)for(const child of error.errors){const found=retainedCleanup(child,seen);if(found)return found;}
  if(error instanceof Error)return retainedCleanup(error.cause,seen);
}
async function finalCurrent(execution:LocalUploadExecution,work:()=>Promise<Prepared>):Promise<Prepared> {
  if(typeof execution.assertFabubloxRequestCurrent!=="function")throw denied();
  let failed=false,cause:unknown,result:Prepared|undefined;
  try{result=await work();}catch(error){failed=true;cause=error;}
  let finalFailed=false,finalCause:unknown;
  try{await execution.assertFabubloxRequestCurrent();}catch(error){finalFailed=true;finalCause=error;}
  if(failed || finalFailed){
    const original=failed && finalFailed?new AggregateError([cause,finalCause],"Original import preparation and final current authority failed")
      :failed?cause:finalCause;
    const cleanup=retainedCleanup(original);
    // Preserve the exact ordered work/final causes as validationCause while
    // keeping the original first failed disposer and parent lease quarantined.
    if(cleanup && original!==cleanup)throw new StorageProfileCleanupError(original,cleanup.cleanupCause,cleanup.ownership);
    throw original;
  }
  return result!;
}

/** Private selected-purpose publisher only. Its actual receipt was accepted
 * under the same original Request/core/lease and body first ACK. The original
 * full PUT/readback, typed native aliases and unpublished SQL are preserved;
 * no replay can invoke this publisher or repeat an uncertain PUT. */
export function prepareLocalFabubloxAuthorityV28Candidate(execution:LocalUploadExecution,request:Request,
  accepted:LocalFabubloxAcceptedV28Candidate):Promise<LocalFabubloxPreparedFilesV28Candidate> {
  const selected=ownedLocalFabubloxAcceptedV28Candidate(accepted,execution,request);
  const existing=preparations.get(accepted);if(existing)return existing;
  // Reserve and observe the one whole operation before any original await or
  // provider work. Reentry receives this same cached original outcome.
  const original=Promise.resolve().then(async()=>{
    const {payload,input,authorities}=selected;
    const candidates:Candidate[]=[
      {kind:"workbook",localId:"workbook",originalName:payload.workbook.name,mimeType:payload.workbookMimeType,
        buffer:payload.workbookBuffer,sha256:payload.actualSha},
      {kind:"manifest",localId:"manifest",originalName:"manifest.json",mimeType:"application/json",
        buffer:payload.manifestBuffer,sha256:payload.manifestSha256},
      ...payload.imageInputs.map(({image,file,buffer,sha256})=>({kind:"image" as const,localId:image.localId,
        originalName:file.name,mimeType:file.type||image.mimeType,buffer,sha256,image})),
    ];
    const database=execution.database(authorities);
    const result=await finalCurrent(execution,()=>prepareAuthorityImportFilesWithCapabilities({database,openProfile:execution.openProfile},
      {importId:input.importId,operationId:input.operationId,actorEmail:input.actorEmail},candidates));
    selected.assertCurrent();
    // Same-BEGIN physical tuple checks lead the later original final batch.
    // The genuine Native view owns each statement; nothing is serialized.
    result.statements.unshift(...authorities.map(authority=>prepareLocalVolumeProfileAuthorityFence(authority,database)));
    const token=Object.freeze({}) as LocalFabubloxPreparedFilesV28Candidate;
    preparedOwners.set(token,Object.freeze({accepted,execution,request,result,database}));return token;
  });
  preparations.set(accepted,original);original.then(()=>undefined,()=>undefined);return original;
}

/** Internal input to the later whole original Node metadata/finalizer only.
 * The same still-held execution must consume it once; copied/foreign receipts
 * and callbacks cannot obtain statements, bytes, a provider or new grants.
 * A result here is verified_unpublished, never an HTTP201/import-ready result. */
export function consumeLocalFabubloxPreparedFilesV28Candidate(execution:LocalUploadExecution,request:Request,
  accepted:LocalFabubloxAcceptedV28Candidate,token:LocalFabubloxPreparedFilesV28Candidate):
  Readonly<{ result: Prepared; database: NativeFileAuthoritySqlDatabase }> {
  ownedLocalFabubloxAcceptedV28Candidate(accepted,execution,request);
  const owner=preparedOwners.get(token);
  if(!owner || owner.accepted!==accepted || owner.execution!==execution || owner.request!==request || consumed.has(token))throw denied();
  consumed.add(token);return Object.freeze({result:owner.result,database:owner.database});
}

/** Metadata-only original active recovery. This is one owned invocation with
 * claim→changes() guard adjacency, exact native same-BEGIN results and no
 * provider/hash/delete/retry. It does not schedule recovery, grant a Project
 * root or invoke the unreviewed legacy1195 recovery algorithm. If current
 * live authority denies it, the original durable receipt remains for a later
 * genuine stopped recovery owner; no SQL/admin bypass is attempted here. */
export function recoverLocalFabubloxAuthorityV28Candidate(execution:LocalUploadExecution,request:Request,
  accepted:LocalFabubloxAcceptedV28Candidate,message:string) {
  const owner=ownedLocalFabubloxAcceptedV28Candidate(accepted,execution,request);
  const existing=recoveries.get(accepted);if(existing)return existing;
  if(typeof message!=="string" || message.length>4096)throw denied();
  const original=Promise.resolve().then(async()=>{
    const preparation=preparations.get(accepted);
    if(preparation){
      // A failed original provider/body ACK is not permission for parent
      // metadata recovery or release. Preserve its typed first failure.
      try{await preparation;}catch(error){const cleanup=retainedCleanup(error);if(cleanup)throw cleanup;}
    }
    owner.assertCurrent();
    const recoveryOperationId=crypto.randomUUID();
    let failed=false,cause:unknown,result:Awaited<ReturnType<typeof recoverAuthorityImportWithDatabase>>|undefined;
    try{
      result=await recoverAuthorityImportWithDatabase(execution.historyDatabase(),{importId:owner.input.importId,
        operationId:owner.input.operationId,recoveryOperationId,message,timestamp:new Date().toISOString()});
      if(result.importsFailed===1)owner.acknowledgeRecovery(recoveryOperationId);
    }catch(error){failed=true;cause=error;}
    let finalFailed=false,finalCause:unknown;
    try{
      if(typeof execution.assertFabubloxRequestCurrent!=="function")throw denied();
      await execution.assertFabubloxRequestCurrent();owner.assertCurrent();
    }catch(error){finalFailed=true;finalCause=error;}
    if(failed && finalFailed)throw new AggregateError([cause,finalCause],"Original import recovery and final current authority failed");
    if(failed)throw cause;if(finalFailed)throw finalCause;return result!;
  });
  recoveries.set(accepted,original);original.then(()=>undefined,()=>undefined);return original;
}
