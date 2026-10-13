// Explicit SOURCE-only V5 held native R2 archive owner. No default route mounts it.
import type { Env } from "../types";
import { primaryD1 } from "../d1-primary";
import { openShadowProfile } from "../files/shadow-profile";
import { cloudflareSha256 } from "../files/storage-adapters/cloudflare-sha256";
import { verifyByteStream } from "../files/byte-verification";
import { finishSystemBackupManifestV5, validateSystemBackupDocumentsV5, type SystemBackupRecordsV5, type SystemBackupManifestV5 } from "../../shared/contracts/system-backup-v5";
import { planSystemBackupSourcesV28, type SystemBackupSourceV28, type SystemBackupFileV28 } from "../../shared/contracts/system-backup-v28-content";
import { systemBackupArchiveMetadata, measureSystemBackupArchive, createSystemBackupArchiveStream,
  type SystemBackupArchiveMetadata } from "../../shared/domain/system-backup-archive";
import { RESEARCH_ARCHIVE_MAX_FILES, RESEARCH_ARCHIVE_PAYLOAD_MAX_BYTES,
  type ArchiveEntry, type MeasuredStoreArchive } from "../../shared/domain/research-archive";
import { captureHeldWorkerV28SystemBackupCandidate, V28_HELD_SOURCE_INERT_SQL_CANDIDATE } from "./v28-held-backup-snapshot-candidate";
import { stableJson } from "../../shared/domain/content-addressing";

function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error("worker_v5_held_archive_" + reason); }
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.values(value).forEach(child => freeze(child)); Object.freeze(value); } return value; }
export interface WorkerV5HeldArchiveCandidate {
  kind: "worker-v5-held-native-r2-archive/1"; backupId: string; sourceInstallationId: string;
  manifest: SystemBackupManifestV5; records: SystemBackupRecordsV5;
  sourceCheckpoint: "portable-runtime/v28"; sourceLedger: "observed-reviewed-construction";
  migrationExecutionClaimed: false; executionEnabled: false; recoveryReady: false;
}
export interface WorkerV5OriginalSourceStream {
  body: ReadableStream<Uint8Array>; done: Promise<void>; close(): Promise<void>;
}
type OriginalStream=WorkerV5OriginalSourceStream;
const originalSourceStreams=new WeakSet<object>();
/** Exact original factory identity: copied objects/callbacks issue no close proof. */
export function assertWorkerV5OriginalSourceStream(stream:WorkerV5OriginalSourceStream):void{
  ensure(originalSourceStreams.has(stream),"unissued_original_stream");
}
interface Owner {
  backupId: string; expectedId: string; current: () => Promise<boolean>; signal?: AbortSignal;
  streams: Set<OriginalStream>; work: Promise<unknown>[]; holds?: readonly string[];
  preparation?: Promise<WorkerV5HeldArchiveCandidate>; prepared?: WorkerV5HeldArchiveCandidate;
  metadata?: SystemBackupArchiveMetadata; measurement?: Promise<MeasuredStoreArchive>; archive?: OriginalStream;
  closing: boolean; close?: Promise<void>;
}
/** Capture, verify and stream only a cold source's admitted held R2 tuples.
 * This grants no original LOCAL volume/provider access and no restored job or
 * runtime activation. The enclosing original operation owns authorization. */
export function createWorkerV5HeldR2ArchiveCandidate(env: Env) {
  const binding = env.DB, db = primaryD1(binding), owners = new Set<Owner>();
  const issued = new WeakMap<WorkerV5HeldArchiveCandidate, Owner>();
  let firstOwner: Owner | undefined, closingAll: Promise<void> | undefined;
  function original<T>(owner: Owner, operation: () => Promise<T>): Promise<T> {
    const work = Promise.resolve().then(operation); owner.work.push(work); void work.catch(() => undefined); return work;
  }
  async function available(owner: Owner, closing = false) {
    ensure((closing || !owner.closing) && !owner.signal?.aborted && env.DB === binding && await owner.current() === true
      && !owner.signal?.aborted && env.DB === binding, "current_source_authority");
    await db.prepare(V28_HELD_SOURCE_INERT_SQL_CANDIDATE).bind(owner.expectedId).first();
    ensure((closing || !owner.closing) && !owner.signal?.aborted && env.DB === binding && await owner.current() === true
      && !owner.signal?.aborted && env.DB === binding, "current_source_authority");
  }
  function ownedStream(owner: Owner,input: ReadableStream<Uint8Array>,before?:()=>Promise<void>):OriginalStream {
    const stream=ownWorkerV5SourceStream(input,before);owner.streams.add(stream);return stream;
  }
  async function actualHold(owner: Owner, source: SystemBackupSourceV28) {
    await available(owner); const entry = source.source;
    ensure(entry.storeKind === "r2" && entry.provider === "r2" && entry.byteAuthority === "file_location"
      && entry.storageProfileId !== null && entry.storageProfileRevision === 1 && entry.locationId !== null,
      "explicit_current_native_r2_source");
    ensure(owner.holds && owner.holds.length > 0 && await db.prepare(`SELECT 1 FROM file_location_holds h
      JOIN file_locations l ON l.id=h.location_id JOIN file_location_publications p ON p.location_id=l.id
      WHERE h.location_id=? AND h.operation_id=? AND h.hold_kind='export' AND h.released_at IS NULL AND h.expires_at IS NULL
        AND h.id IN(SELECT value FROM json_each(?)) AND l.storage_profile_id=? AND l.object_key=?
        AND p.verified_byte_size=? AND p.verified_sha256=?
        AND NOT EXISTS(SELECT 1 FROM file_location_gc_ledger g WHERE g.location_id=l.id AND g.state IN('deleting','deleted'))`)
      .bind(entry.locationId, "fp5-backup:" + owner.backupId, stableJson(owner.holds), entry.storageProfileId, entry.objectKey,
        entry.expectedByteSize, entry.expectedSha256).first(), "original_export_hold_changed");
    await available(owner);
  }
  function openSource(owner: Owner, source: SystemBackupSourceV28): Promise<ReadableStream<Uint8Array>> {
    return original(owner, async () => {
      await actualHold(owner, source); const entry = source.source;
      ensure(entry.storageProfileId !== null && entry.storageProfileRevision === 1, "source_profile");
      const opened = await openShadowProfile(env, { profileId: entry.storageProfileId, configurationRevision: 1 }, "read", {
        signal: owner.signal, beforeRequest: async () => { try { await actualHold(owner, source); return true; } catch { return false; } },
      });
      ensure(opened.storage.adapterType === "r2", "source_provider");
      const result = await opened.reader.read(entry.objectKey); ensure(result.outcome === "available", "held_source_unavailable");
      const stream = ownedStream(owner, result.body, () => actualHold(owner, source));
      try { await actualHold(owner, source); return stream.body; }
      catch (error) { try { await stream.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Original held R2 opening and close failed"); } throw error; }
    });
  }
  function own(prepared: WorkerV5HeldArchiveCandidate) { const owner = issued.get(prepared); ensure(owner && owner.prepared === prepared, "unissued_capsule"); return owner; }
  async function prepareOwned(owner: Owner) {
    const records = await captureHeldWorkerV28SystemBackupCandidate(env, { backupId: owner.backupId, expectedInstallationId: owner.expectedId,
      current: () => owner.current(), signal: owner.signal, onHoldsInstalled(ids) { ensure(!owner.holds, "hold_observation_repeated"); owner.holds = ids; } });
    const sources = planSystemBackupSourcesV28(records.content), files: SystemBackupFileV28[] = [];
    ensure(sources.length <= RESEARCH_ARCHIVE_MAX_FILES, "archive_source_budget");
    let expectedBytes = 0;
    for (const source of sources) {
      ensure(source.source.expectedByteSize !== null, "full_source_expectation");
      expectedBytes += source.source.expectedByteSize;
      ensure(Number.isSafeInteger(expectedBytes) && expectedBytes <= RESEARCH_ARCHIVE_PAYLOAD_MAX_BYTES, "archive_source_budget");
    }
    for (const source of sources) {
      const size = source.source.expectedByteSize, hash = source.source.expectedSha256;
      ensure(size !== null && hash !== null, "full_source_expectation");
      const verified = await verifyByteStream(await openSource(owner, source), { byteSize: size, sha256: hash }, cloudflareSha256, "source");
      files.push({ ...source, outcome: "packaged", path: "files/" + source.id, byteSize: verified.byteSize, sha256: verified.sha256 });
    }
    const manifest = await finishSystemBackupManifestV5(records, files); await validateSystemBackupDocumentsV5(manifest, records);
    const prepared = freeze<WorkerV5HeldArchiveCandidate>({ kind: "worker-v5-held-native-r2-archive/1", backupId: owner.backupId,
      sourceInstallationId: owner.expectedId, manifest, records, sourceCheckpoint: "portable-runtime/v28",
      sourceLedger: "observed-reviewed-construction", migrationExecutionClaimed: false, executionEnabled: false, recoveryReady: false });
    owner.metadata = await systemBackupArchiveMetadata(manifest, records, manifest); owner.prepared = prepared;
    issued.set(prepared, owner); await available(owner); return prepared;
  }
  function prepare(options: { expectedInstallationId: string; current(): Promise<boolean>; signal?: AbortSignal }) {
    if (firstOwner) return firstOwner.preparation!;
    ensure(!closingAll && owners.size === 0, "another_original_owner_retained_or_closed");
    const owner: Owner = { backupId: crypto.randomUUID(), expectedId: options.expectedInstallationId, current: options.current, signal: options.signal,
      streams: new Set(), work: [], closing: false }; owners.add(owner); firstOwner = owner;
    return owner.preparation = original(owner, () => prepareOwned(owner));
  }
  function payload(owner: Owner, entry: ArchiveEntry) {
    ensure(owner.prepared, "source_capsule"); const file = owner.prepared.manifest.files.find(file => file.path === entry.path);
    ensure(file && entry.kind === "payload" && entry.byteSize === file.byteSize && entry.sha256 === file.sha256, "admitted_archive_member");
    return openSource(owner, file);
  }
  function measure(prepared: WorkerV5HeldArchiveCandidate) {
    const owner = own(prepared); ensure(owner.metadata && !owner.closing, "archive_owner_closed");
    return owner.measurement ??= original(owner, async () => freeze(await measureSystemBackupArchive(owner.metadata!, entry => payload(owner, entry),
      { signal: owner.signal, createHash: cloudflareSha256 })));
  }
  function stream(prepared: WorkerV5HeldArchiveCandidate): OriginalStream {
    const owner = own(prepared); ensure(owner.metadata && !owner.closing, "archive_owner_closed");
    return owner.archive ??= ownedStream(owner, createSystemBackupArchiveStream(owner.metadata, entry => payload(owner, entry),
      { signal: owner.signal, createHash: cloudflareSha256 }));
  }
  function close(owner: Owner): Promise<void> {
    return owner.close ??= (async () => {
      owner.closing = true; const failures: unknown[] = [];
      // Stop the original archive first, then join opening/measurement/preparation
      // and every original provider body. No timer/error flag releases holds.
      if (owner.archive) try { await owner.archive.close(); } catch (error) { failures.push(error); }
      // A measurement may be waiting on a provider read. Cancel already opened
      // bodies before joining it, then join any opening that finishes later.
      for (const stream of [...owner.streams]) try { await stream.close(); } catch (error) { failures.push(error); }
      await Promise.allSettled(owner.work);
      for (const stream of owner.streams) try { await stream.close(); await stream.done; } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Original held archive/provider close remains unproven");
      if (owner.holds) {
        await available(owner, true);
        const results = await db.batch([db.prepare(V28_HELD_SOURCE_INERT_SQL_CANDIDATE).bind(owner.expectedId),
          db.prepare(`SELECT CASE WHEN (SELECT count(*) FROM file_location_holds WHERE operation_id=? AND id IN(SELECT value FROM json_each(?)))=?
            THEN 1 ELSE json('Original held source ownership changed') END`).bind("fp5-backup:" + owner.backupId, stableJson(owner.holds), owner.holds.length),
          db.prepare("UPDATE file_location_holds SET released_at=? WHERE operation_id=? AND id IN(SELECT value FROM json_each(?)) AND released_at IS NULL")
            .bind(new Date().toISOString(), "fp5-backup:" + owner.backupId, stableJson(owner.holds))]);
        ensure(results.every(result => result.success), "original_hold_release_failed");
        await available(owner, true);
      }
      owners.delete(owner);
    })();
  }
  function closeAll(): Promise<void> {
    return closingAll ??= (async () => {
      const results = await Promise.allSettled([...owners].map(close)), failures = results.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
      if (failures.length) throw new AggregateError(failures, "Original held capture cleanup failed");
    })();
  }
  return Object.freeze({ prepare, measure, stream, closeAll });
}

// The exact original body/first-close implementation is shared with public V5
// byte reads. This owns a supplied body only; it issues no provider/actor grant.
export function ownWorkerV5SourceStream(input: ReadableStream<Uint8Array>, before?: () => Promise<void>): OriginalStream {
    const reader = input.getReader(); let ended = false, closing: Promise<void> | undefined;
    let resolveDone!: () => void, rejectDone!: (error: unknown) => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; }); void done.catch(() => undefined);
    async function closeOriginal() {
      return closing ??= (async () => {
        if (ended) return await done;
        try { await reader.cancel(); await reader.closed; ended = true; reader.releaseLock(); resolveDone(); }
        catch (error) { rejectDone(error); throw error; }
      })();
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (ended) return;
        try {
          await before?.(); const next = await reader.read(); await before?.();
          if (ended) return;
          if (next.done) { await reader.closed; ended = true; reader.releaseLock(); resolveDone(); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) {
          let failure = error;
          try { await closeOriginal(); } catch (cleanup) { failure = new AggregateError([error, cleanup], "Original held source read and close failed"); }
          controller.error(failure);
        }
      },
      async cancel() { await closeOriginal(); },
    }, { highWaterMark: 0 });
    const original=Object.freeze({ body, done, close: closeOriginal });originalSourceStreams.add(original);return original;
  }
