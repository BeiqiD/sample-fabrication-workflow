import { ByteVerificationError, verifyStoredBytes } from "../../files/byte-verification";
import { writeVerifiedBytes } from "../../files/byte-writer";
import type { PackageAttempt, PackageCapabilities, PackageClaim } from "./types";

export const PACKAGE_STEP_MS=60_000;
/** One durable action, composed from persistence, format and exact transport
 * capabilities. Closing an HTTP request is unrelated to this executor. */
export async function runPackageJobStep(capabilities:PackageCapabilities) {
  const repository=capabilities.repository;
  const claim=await repository.claim(capabilities.incarnation,capabilities.randomId(),capabilities.authorizeActor);
  if(!claim) return {jobId:null,outcome:"idle"};
  let attempt:PackageAttempt|null=null;
  const abort=new AbortController(),deadline=capabilities.now().getTime()+PACKAGE_STEP_MS;
  let expired=false,timer:ReturnType<typeof setTimeout>|undefined;
  const current=async()=>!expired&&!abort.signal.aborted&&capabilities.now().getTime()<deadline
    && capabilities.authorizeActor(claim.actor)&&await repository.owns(claim);
  const perform=async()=>{
    if(!await current()) throw new Error("actor_or_lease_unavailable");
    if(claim.kind==="upload"&&claim.phase==="validate") {
      const validated=await capabilities.validateUpload(claim,current,abort.signal);
      if(!await current()) throw new Error("actor_or_lease_unavailable");
      await repository.checkpoint(claim,"preview",{archive:validated});
      return "preview";
    }
    if((claim.kind==="data_package"||claim.kind==="report")&&["snapshot","measure"].includes(claim.phase)) {
      const measured=await capabilities.measureExport(claim,current,abort.signal) as {byteSize?:unknown;sha256?:unknown};
      if(!Number.isSafeInteger(measured.byteSize)||Number(measured.byteSize)<0||Number(measured.byteSize)>100*1024*1024
        ||typeof measured.sha256!=="string"||!/^[a-f0-9]{64}$/.test(measured.sha256)) throw new Error("archive_budget_or_integrity");
      if(!await current()) throw new Error("actor_or_lease_unavailable");
      await repository.addOutput(claim,{byteSize:Number(measured.byteSize),sha256:measured.sha256});
      await repository.checkpoint(claim,"write",{archive:measured});
      return "measured";
    }
    const files=await repository.files(claim.id);
    let file=files.find(row=>row.entry_kind!=="source"&&!['verified','published'].includes(row.state));
    if(!file)for(const candidate of files){
      if(candidate.entry_kind==='source'||candidate.state!=='verified'||candidate.reuse_file_id)continue;
      const pending=await repository.attempt(candidate);
      if(pending?.state==='verified'){file=candidate;break;}
    }
    if(file) {
      attempt=await repository.attempt(file);
      const destination=await capabilities.openStorage({profileId:file.target_profile_id!,configurationRevision:file.target_profile_revision!},"write",current,abort.signal);
      if(destination.namespaceIdentity!==file.target_namespace||!destination.writer) throw new Error("frozen_target_unavailable");
      const expected={byteSize:file.byte_size,sha256:file.sha256};
      if(attempt&&["write_started","unknown","verified"].includes(attempt.state)) {
        if(!attempt.io_settled_at&&!destination.atomicSinglePut) throw new Error("write_settlement_required");
        await verifyStoredBytes(destination.reader,attempt.object_key,expected,destination.createHash);
        if(!attempt.io_settled_at) await repository.settled(attempt);
      } else {
        if(claim.kind==="upload") throw new Error("upload_body_required");
        if(attempt?.state==="staged"&&(attempt.owner_token!==claim.owner_token||attempt.generation!==claim.generation)) {
          // No write began, so this registered key can be abandoned safely.
          const db=repository.database.primary();
          await db.batch([repository.guard(db,claim),db.prepare("UPDATE research_package_attempts SET state='cancelled',updated_at=? WHERE id=? AND state='staged'")
            .bind(capabilities.now().toISOString(),attempt.id),db.prepare("UPDATE file_location_holds SET released_at=? WHERE operation_id=? AND released_at IS NULL")
            .bind(capabilities.now().toISOString(),attempt.id)]); attempt=null;
        }
        if(!attempt||attempt.state!=="staged") attempt=await repository.stage(claim,file);
        const body=claim.kind==="import"?await capabilities.importBody(claim,file,current,abort.signal):await capabilities.exportBody(claim,current,abort.signal);
        if(!await current()) {await body.cancel();throw new Error("actor_or_lease_unavailable");}
        try {await repository.startWrite(claim,attempt);} catch(error){await body.cancel().catch(()=>undefined);throw error;}
        const transport=destination.writer,ownedAttempt=attempt;
        await writeVerifiedBytes({...destination,writer:{accepts:transport.accepts,async write(input){await transport.write(input);await repository.settled(ownedAttempt);}}},
          {key:attempt.object_key,body,...expected,contentType:file.media_type,filename:file.archive_path});
      }
      if(!await current()) throw new Error("actor_or_lease_unavailable");
      await repository.verify(claim,file,attempt);
      if(claim.kind!=="import") await repository.publish(claim,[],{roots:JSON.parse(claim.input_json).roots ?? [],reused:false});
      else {await repository.publishFile(claim,file,attempt);await repository.checkpoint(claim,"copy");}
      return "file_verified";
    }
    if(claim.kind==="import") {
      const publication=await capabilities.importPublication(claim);
      if(!await current()) throw new Error("actor_or_lease_unavailable");
      await repository.publish(claim,publication.statements,publication.result);
      return "completed";
    }
    await repository.publish(claim,[],{roots:JSON.parse(claim.input_json).roots ?? [],reused:false});
    return "completed";
  };
  const work=perform();
  // The timeout aborts provider calls and sources. It does not certify an R2 or
  // remote non-atomic PUT stopped; the registered attempt remains held unknown.
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;abort.abort();reject(new Error("execution_budget_exhausted"));},PACKAGE_STEP_MS);});
  try {return {jobId:claim.id,outcome:await Promise.race([work,timeout])};}
  catch(error) {
    const known=["actor_or_lease_unavailable","archive_budget_or_integrity","frozen_target_unavailable","write_settlement_required","upload_body_required","execution_budget_exhausted","manifest_budget","metadata_budget","record_budget","import_plan_budget","publication_statement_limit","publication_row_size_limit","unsupported_source_import_state"];
    const reason=error instanceof ByteVerificationError?`${error.phase}_${error.reason}`:error instanceof Error&&known.includes(error.message)?error.message:"package_validation_or_storage_failed";
    await repository.pause(claim,reason,attempt);
    return {jobId:claim.id,outcome:"paused"};
  } finally {if(timer)clearTimeout(timer);}
}

/** Raw archive ingress only. It neither parses nor imports business records. */
export async function writePackageUpload(capabilities:PackageCapabilities,claim:PackageClaim,body:ReadableStream<Uint8Array>) {
  const repository=capabilities.repository,abort=new AbortController(),deadline=capabilities.now().getTime()+PACKAGE_STEP_MS;
  let expired=false,timer:ReturnType<typeof setTimeout>|undefined,attempt:PackageAttempt|null=null;
  const current=async()=>!expired&&!abort.signal.aborted&&capabilities.now().getTime()<deadline&&capabilities.authorizeActor(claim.actor)&&await repository.owns(claim);
  // A provider binding cannot always abort an already issued PUT. Stop the HTTP
  // source promptly without waiting for its cancellation acknowledgement; the
  // registered write remains unknown until its original positive settlement.
  const reader=body.getReader();let ended=false;
  const release=()=>{try{reader.releaseLock();}catch{/* A pending raw read settles separately. */}};
  const forwarded=new ReadableStream<Uint8Array>({
    start(controller){abort.signal.addEventListener("abort",()=>{if(ended)return;ended=true;controller.error(new Error("execution_budget_exhausted"));
      void reader.cancel().catch(()=>undefined);release();},{once:true});},
    async pull(controller){try{const next=await reader.read();if(ended)return;if(next.done){ended=true;release();controller.close();}else controller.enqueue(next.value);}
      catch(error){if(!ended){ended=true;release();controller.error(error);}}},
    cancel(reason){if(ended)return;ended=true;void reader.cancel(reason).catch(()=>undefined);release();},
  });
  const perform=async()=>{
    const file=(await repository.files(claim.id)).find(row=>row.entry_kind==="artifact");
    if(!file) throw new Error("Upload has no admitted archive identity");
    attempt=await repository.attempt(file);
    if(file.state==="published"||attempt?.state==="published"){await repository.publish(claim);return;}
    if(attempt&&["write_started","unknown","verified"].includes(attempt.state)){
      if(!attempt.io_settled_at)throw new Error("write_settlement_required");
      const previous=await capabilities.openStorage({profileId:file.target_profile_id!,configurationRevision:file.target_profile_revision!},"read",current,abort.signal);
      if(previous.namespaceIdentity!==file.target_namespace)throw new Error("frozen_target_unavailable");
      await verifyStoredBytes(previous.reader,attempt.object_key,{byteSize:file.byte_size,sha256:file.sha256},previous.createHash);
      if(!await current())throw new Error("actor_or_lease_unavailable");
      await repository.verify(claim,file,attempt);await repository.publish(claim);return;
    }
    if(!["pending","copying","failed"].includes(file.state))throw new Error("Upload requires its existing verified publication");
    if(attempt){
      // A failed admission before startWrite can safely use a fresh key. A
      // started write needs positive settlement and a terminal failed result.
      // Keep the old candidate hold/evidence for qualified cleanup.
      const db=repository.database.primary(),at=capabilities.now().toISOString();
      await db.batch([repository.guard(db,claim),db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM research_package_attempts
        WHERE id=? AND job_id=? AND logical_file_id=? AND file_id=? AND location_id=? AND
        ((state IN('staged','failed','cancelled') AND write_started_at IS NULL) OR(state IN('failed','cancelled') AND io_settled_at IS NOT NULL)))
        THEN 1 ELSE json('Upload candidate still requires settlement') END`)
        .bind(attempt.id,claim.id,file.logical_file_id,file.candidate_file_id,attempt.location_id),
        db.prepare("UPDATE research_package_attempts SET state='cancelled',updated_at=? WHERE id=? AND state<>'cancelled'").bind(at,attempt.id)]);
      attempt=null;
    }
    attempt=await repository.stage(claim,file);
    const destination=await capabilities.openStorage({profileId:file.target_profile_id!,configurationRevision:file.target_profile_revision!},"write",current,abort.signal);
    if(!destination.writer||destination.namespaceIdentity!==file.target_namespace) throw new Error("frozen_target_unavailable");
    await repository.startWrite(claim,attempt);
    const transport=destination.writer,ownedAttempt=attempt;
    await writeVerifiedBytes({...destination,writer:{accepts:transport.accepts,async write(input){await transport.write(input);await repository.settled(ownedAttempt);}}},
      {key:attempt.object_key,body:forwarded,byteSize:file.byte_size,sha256:file.sha256,contentType:"application/zip",filename:"research-package.zip"});
    if(!await current()) throw new Error("actor_or_lease_unavailable");
    await repository.verify(claim,file,attempt);await repository.publish(claim);
  };
  const work=perform(),timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;abort.abort();reject(new Error("execution_budget_exhausted"));},PACKAGE_STEP_MS);});
  try{await Promise.race([work,timeout]);}
  catch(error){abort.abort();void forwarded.cancel().catch(()=>undefined);
    const reason=expired?"execution_budget_exhausted":error instanceof Error&&error.message==="write_settlement_required"?error.message:"upload_unavailable_or_incomplete";
    await repository.pause(claim,reason,attempt);throw error;}
  finally{if(timer)clearTimeout(timer);abort.abort();void forwarded.cancel().catch(()=>undefined);}
}
