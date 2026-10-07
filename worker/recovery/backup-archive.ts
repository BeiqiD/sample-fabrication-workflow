import type { Env } from "../types";
import { openShadowProfile } from "../files/shadow-profile";
import { legacyByteReader } from "../files/legacy-byte-reader";
import { RECOVERY_SCHEMA_SHA256, RECOVERY_TABLES } from "../../shared/contracts/system-recovery-catalog";
import { finishSystemBackupManifest, validateSystemBackupDocuments, type SystemBackupFile, type SystemBackupRecordsV1, type SystemBackupSource } from "../../shared/contracts/system-backup";
import { systemBackupArchiveMetadata } from "../../shared/domain/system-backup-archive";
export { validateSystemBackupArchive } from "../../shared/contracts/system-backup-archive-admission";

export async function prepareSystemBackupArchive(records: SystemBackupRecordsV1, files: readonly SystemBackupFile[]) {
  const manifest = await finishSystemBackupManifest(records, files);
  await validateSystemBackupDocuments(manifest, records, { schemaSha256: RECOVERY_SCHEMA_SHA256, tables: RECOVERY_TABLES });
  return { manifest, records, ...await systemBackupArchiveMetadata(manifest, records, manifest) };
}
export type SystemBackupSourceRead = { outcome: "available"; body: ReadableStream<Uint8Array>; expected: { byteSize: number | null; sha256: string | null } }
  | { outcome: "missing" | "provider_unavailable" | "metadata_unavailable" };
function abortableSource(body: ReadableStream<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
  const reader = body.getReader(); let ended = false, output: ReadableStreamDefaultController<Uint8Array>;
  const release = () => { signal.removeEventListener("abort", abort); try { reader.releaseLock(); } catch { /* Pending cancelled read settles separately. */ } };
  const abort = () => { if (!ended) { ended = true; output.error(signal.reason ?? new Error("System backup read interrupted")); void reader.cancel().catch(() => undefined); release(); } };
  return new ReadableStream<Uint8Array>({
    start(controller) { output = controller; signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); },
    async pull(controller) { try { const next = await reader.read(); if (ended) return; if (next.done) { ended = true; release(); controller.close(); } else controller.enqueue(next.value); }
      catch (error) { if (!ended) { ended = true; release(); controller.error(error); } } },
    cancel(reason) { if (ended) return; ended = true; void reader.cancel(reason).catch(() => undefined); release(); },
  }, { highWaterMark: 0 });
}
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
  return { outcome: "available", body: abortableSource(body, signal), expected: { byteSize: entry.expectedByteSize, sha256: entry.expectedSha256 } };
}
