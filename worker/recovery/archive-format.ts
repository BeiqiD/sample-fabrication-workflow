import { finishSystemBackupManifestV3, validateSystemBackupDocumentsV3 } from "../../shared/contracts/system-backup-v3";
import { RECOVERY_SCHEMA_SHA256, RECOVERY_TABLES } from "../../shared/contracts/system-recovery-catalog";
import { finishSystemBackupManifest, validateSystemBackupDocuments, type SystemBackupFile } from "../../shared/contracts/system-backup";
import { systemBackupArchiveMetadata } from "../../shared/domain/system-backup-archive";
import { finishSystemBackupManifestV2, validateSystemBackupDocumentsV2 } from "../../shared/contracts/system-backup-v2";
import { selectReviewedRecoveryCatalog, type VersionedRecoveryRecords } from "./versioned-catalog";
export { validateVersionedSystemBackupArchive as validateSystemBackupArchive } from "../../shared/contracts/system-backup-versioned-admission";

export async function prepareSystemBackupArchive(records: VersionedRecoveryRecords, files: readonly SystemBackupFile[]) {
  selectReviewedRecoveryCatalog(records);
  if (records.schema === "system-backup-records/3") {
    const manifest = await finishSystemBackupManifestV3(records, files);
    await validateSystemBackupDocumentsV3(manifest, records);
    return { manifest, records, ...await systemBackupArchiveMetadata(manifest, records, manifest) };
  }
  if (records.schema === "system-backup-records/2") {
    const manifest = await finishSystemBackupManifestV2(records, files);
    const checked = await validateSystemBackupDocumentsV2(manifest, records);
    return { ...checked, ...await systemBackupArchiveMetadata(checked.manifest, checked.records, checked.manifest) };
  }
  const manifest = await finishSystemBackupManifest(records, files);
  await validateSystemBackupDocuments(manifest, records, { schemaSha256: RECOVERY_SCHEMA_SHA256, tables: RECOVERY_TABLES });
  return { manifest, records, ...await systemBackupArchiveMetadata(manifest, records, manifest) };
}
export type SystemBackupSourceRead = { outcome: "available"; body: ReadableStream<Uint8Array>; expected: { byteSize: number | null; sha256: string | null }; dispose?: () => Promise<void> }
  | { outcome: "missing" | "provider_unavailable" | "metadata_unavailable" };
export function abortableSystemBackupSource(body: ReadableStream<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
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


import { finishSystemBackupManifestV5, validateSystemBackupDocumentsV5 } from "../../shared/contracts/system-backup-v5";
import { planSystemBackupSourcesV28 } from "../../shared/contracts/system-backup-v28-content";
import { stableJson } from "../../shared/domain/content-addressing";
import type { WorkerRecoveryRecords, WorkerRecoveryFile } from "./versioned-catalog";
export { validateWorkerSystemBackupArchive } from "../../shared/contracts/system-backup-versioned-admission";
function oldFile(file: WorkerRecoveryFile): file is SystemBackupFile { return file.source.provider !== "local"; }
export async function prepareWorkerSystemBackupArchive(records: WorkerRecoveryRecords, files: readonly WorkerRecoveryFile[]) {
  if (records.schema !== "system-backup-records/5") {
    if (!files.every(oldFile)) throw new Error("system_backup_version_pair");
    return prepareSystemBackupArchive(records,files);
  }
  const expected = planSystemBackupSourcesV28(records.content);
  if (expected.length !== files.length || new Set(files.map(file => file.id)).size !== files.length) throw new Error("system_backup_file_inventory");
  const ownedFiles = expected.map(source => {
    const file = files.find(file => file.id === source.id);
    if (!file || stableJson(source) !== stableJson({id:file.id,source:file.source,fileIds:file.fileIds,purposes:file.purposes,bindings:file.bindings}))
      throw new Error("system_backup_file_inventory");
    return {...source,path:file.path,outcome:file.outcome,byteSize:file.byteSize,sha256:file.sha256};
  });
  const manifest = await finishSystemBackupManifestV5(records,ownedFiles);
  const checked = await validateSystemBackupDocumentsV5(manifest,records);
  return {...checked,...await systemBackupArchiveMetadata(checked.manifest,checked.records,checked.manifest)};
}
