import type { Env } from "../types";
import { openShadowProfile } from "../files/shadow-profile";
import { legacyByteReader } from "../files/legacy-byte-reader";
import type { SystemBackupSource } from "../../shared/contracts/system-backup";
import { abortableSystemBackupSource, type SystemBackupSourceRead } from "./archive-format";
export { prepareSystemBackupArchive, validateSystemBackupArchive } from "./archive-format";
export type { SystemBackupSourceRead } from "./archive-format";

/** Resolve only the frozen physical tuple through deployment-owned providers.
 * An archive URL is never fetched and no credential is taken from its metadata. */
export async function openSystemBackupSource(env: Env, source: SystemBackupSource, current: () => Promise<boolean>, signal: AbortSignal, backupId?: string): Promise<SystemBackupSourceRead> {
  if (signal.aborted || !await current()) throw new Error("system_backup_owner_unavailable");
  const entry = source.source;
  if (entry.initialOutcome !== null) return { outcome: entry.initialOutcome === "metadata_not_ready" ? "metadata_unavailable"
    : entry.initialOutcome === "provider_unavailable" ? "provider_unavailable" : "missing" };
  let body: ReadableStream<Uint8Array>;
  if (entry.byteAuthority === "file_location") {
    if (!entry.storageProfileId || !entry.storageProfileRevision || !entry.locationId) return { outcome: "metadata_unavailable" };
    if (!backupId || !await env.DB.prepare(`SELECT 1 FROM file_location_holds h WHERE h.location_id=? AND h.operation_id=? AND h.hold_kind='export' AND h.released_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM file_location_gc_ledger gc WHERE gc.location_id=h.location_id AND gc.state IN('deleting','deleted'))`)
      .bind(entry.locationId, `fp5-backup:${backupId}`).first()) return { outcome: "missing" };
    let selected;
    try { selected = await openShadowProfile(env, { profileId: entry.storageProfileId, configurationRevision: entry.storageProfileRevision }, "read", { signal, beforeRequest: current }); }
    catch { return { outcome: "provider_unavailable" }; }
    const read = await selected.reader.read(entry.objectKey);
    if (read.outcome !== "available") return { outcome: read.outcome === "missing" ? "missing" : "provider_unavailable" };
    body = read.body;
  } else {
    if (!backupId || !await env.DB.prepare(`SELECT 1 FROM system_recovery_legacy_holds h
      WHERE h.job_id=? AND h.store_kind=? AND h.provider=? AND h.object_key=? AND h.released_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM blob_gc_ledger gc WHERE gc.store_kind=h.store_kind AND gc.provider=h.provider AND gc.object_key=h.object_key AND gc.state IN('deleting','deleted'))
        AND NOT EXISTS(SELECT 1 FROM file_shadow_legacy_deletion_claims gc WHERE gc.store_kind=h.store_kind AND gc.provider=h.provider AND gc.object_key=h.object_key)
        AND NOT EXISTS(SELECT 1 FROM legacy_file_mappings m JOIN file_location_gc_ledger gc ON gc.location_id=m.location_id
          WHERE gc.state IN('deleting','deleted') AND m.store_kind=h.store_kind AND m.provider=h.provider AND m.object_key=h.object_key)`)
      .bind(backupId, entry.storeKind, entry.provider, entry.objectKey).first()) return { outcome: "missing" };
    const selected = legacyByteReader(env, { storeKind: entry.storeKind, provider: entry.provider });
    if (selected.outcome !== "selected") return { outcome: "provider_unavailable" };
    const read = await selected.reader.read(entry.objectKey);
    if (read.outcome !== "available") return { outcome: read.outcome === "missing" ? "missing" : "provider_unavailable" };
    body = read.body;
  }
  if (signal.aborted || !await current()) { void body.cancel().catch(() => undefined); throw new Error("system_backup_owner_unavailable"); }
  return { outcome: "available", body: abortableSystemBackupSource(body, signal), expected: { byteSize: entry.expectedByteSize, sha256: entry.expectedSha256 } };
}


import type { SystemBackupSourceV28 } from "../../shared/contracts/system-backup-v28-content";
import type { RecoveryClaim } from "./repository";
import { workerV5PublicBackupClaimFence } from "./v28-held-backup-snapshot-candidate";
import { ownWorkerV5SourceStream } from "./v5-held-r2-archive-candidate";
/** Fixed V5 public held read. Descriptor bytes do not grant an original volume:
 * every original open/pull joins the active original job and exact durable hold
 * to the canonical publication, actual native R2 profile and expected bytes. */
export async function openWorkerV5BackupSource(env:Env,source:SystemBackupSourceV28,claim:RecoveryClaim,installationId:string,
  current:()=>Promise<boolean>,signal:AbortSignal,ownClose:(dispose:()=>Promise<void>)=>void):Promise<SystemBackupSourceRead & {dispose?:()=>Promise<void>}>{
  const original=env.DB,entry=source.source;
  if(entry.storeKind!=="r2"||entry.provider!=="r2"||entry.byteAuthority!=="file_location"||!entry.storageProfileId
    ||entry.storageProfileRevision!==1||!entry.locationId||entry.initialOutcome!==null||entry.expectedByteSize===null||entry.expectedSha256===null)
    throw new Error("source_unavailable");
  async function available(){
    if(signal.aborted||env.DB!==original||!await current())throw new Error("administrator_revoked");
    await workerV5PublicBackupClaimFence(env,claim,installationId).first();
    const hold=await env.DB.prepare(`SELECT 1 FROM file_location_holds h JOIN file_locations l ON l.id=h.location_id
      JOIN file_location_publications p ON p.location_id=l.id
      WHERE h.location_id=? AND h.operation_id=? AND h.hold_kind='export' AND h.released_at IS NULL AND h.expires_at IS NULL
        AND l.storage_profile_id=? AND l.object_key=? AND p.verified_byte_size=? AND p.verified_sha256=?
        AND NOT EXISTS(SELECT 1 FROM file_location_gc_ledger g WHERE g.location_id=l.id AND g.state IN('deleting','deleted'))`)
      .bind(entry.locationId,"fp5-backup:"+claim.id,entry.storageProfileId,entry.objectKey,entry.expectedByteSize,entry.expectedSha256).first();
    if(!hold||signal.aborted||env.DB!==original||!await current())throw new Error("source_unavailable");
  }
  await available();const opened=await openShadowProfile(env,{profileId:entry.storageProfileId,configurationRevision:1},"read",{
    signal,async beforeRequest(){try{await available();return true;}catch{return false;}}});
  if(opened.storage.adapterType!=="r2")throw new Error("source_unavailable");
  const result=await opened.reader.read(entry.objectKey);
  if(result.outcome!=="available")throw new Error("source_unavailable");
  const stream=ownWorkerV5SourceStream(result.body,available);ownClose(stream.close);
  try{await available();return {outcome:"available",body:stream.body,expected:{byteSize:entry.expectedByteSize,sha256:entry.expectedSha256},dispose:stream.close};}
  catch(error){try{await stream.close();}catch(cleanup){throw new AggregateError([error,cleanup],"Original public V5 R2 open and first-close failed");}throw error;}
}
