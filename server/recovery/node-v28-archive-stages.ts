import type { DatabaseSync } from "node:sqlite";
import type { ReadableStreamReadResult } from "node:stream/web";
import { stableJson } from "../../shared/domain/content-addressing.ts";
import { sourceFromStream, type ArchiveEntry, type ArchiveSource, type ArchiveIndexEntry } from "../../shared/domain/research-archive.ts";
import { createSystemBackupArchiveStream, measureSystemBackupArchive, systemBackupArchiveMetadata } from "../../shared/domain/system-backup-archive.ts";
import { SYSTEM_BACKUP_MAX_ARCHIVE_BYTES, SYSTEM_BACKUP_MAX_PAYLOAD_BYTES, type SystemBackupOutcome } from "../../shared/contracts/system-backup.ts";
import { finishSystemBackupManifestV5, sourceBackupCheckpointV5, validateSystemBackupDocumentsV5, validateSystemBackupRecordsV5,
  type SystemBackupManifestV5, type SystemBackupRecordsV5, type NodeSystemBackupRecordsV5 } from "../../shared/contracts/system-backup-v5.ts";
import { validateV28SystemBackupArchiveCandidate } from "../../shared/contracts/system-backup-v5-archive-admission.ts";
import { planSystemBackupSourcesV28, type SystemBackupFileV28, type SystemBackupSourceV28 } from "../../shared/contracts/system-backup-v28-content.ts";
import { checkedStoredLocalVolumeNamespace } from "../../shared/contracts/local-volume-profile.ts";
import { checkedSystemRecoveryBackupInput, checkedSystemRecoveryPreview, type SystemRecoveryPreview } from "../../shared/contracts/system-recovery.ts";
import type { JobSqlStatement } from "../../worker/files/jobs/sql-repository.ts";
import { openStorageProfile, StorageProfileCleanupError, type OpenedStorageProfile } from "../../worker/files/storage-profile-opening.ts";
import type { RecoveryStepResult } from "../../worker/recovery/kernel.ts";
import { SystemRecoveryConflict, type jobSqlSystemRecoveryRepository, type RecoveryClaim, type RecoveryJob } from "../../worker/recovery/sql-repository.ts";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations.ts";
import { assertSqliteConnectionOwner, type SqliteCapability } from "../sqlite.ts";
import { nodeSha256 } from "../storage/node-sha256.ts";
import { assertLocalVolumeProfileOpeningV28, type LocalVolumeProfileOpening } from "../storage/local-volume-profile-opening.ts";
import { captureQuiescedNodeSystemBackupV28Candidate } from "./snapshot-v28-candidate.ts";

declare const sourceResumeVerificationBrand: unique symbol;
export interface NodeV28SourceResumeVerification { readonly [sourceResumeVerificationBrand]: true }
const resumeVerifications = new WeakMap<NodeV28SourceResumeVerification, Readonly<{
  database: SqliteCapability; nativeDatabase: DatabaseSync; opening: LocalVolumeProfileOpening; admission: ReviewedInstallationAdmission;
  request: Request; jobId: string; checkpoint: string; records: NodeSystemBackupRecordsV5; current(): void;
}>>();
/** Only an original complete byte-validation scope can issue this proof. Its
 * stored typed image is private; callers receive a clone, not a mutable grant. */
export function ownedNodeV28SourceResumeVerification(proof: NodeV28SourceResumeVerification, opening: LocalVolumeProfileOpening,
  database: SqliteCapability, nativeDatabase: DatabaseSync, admission: ReviewedInstallationAdmission, request: Request, job: RecoveryJob) {
  const original = resumeVerifications.get(proof);
  ensure(original && original.opening === opening && original.database === database && original.nativeDatabase === nativeDatabase
    && original.admission === admission && original.request === request && original.jobId === job.id && original.checkpoint === job.source_checkpoint,
    "source_resume_original_verification_required");
  original.current(); assertSqliteConnectionOwner(database, nativeDatabase); assertLocalVolumeProfileOpeningV28(opening).assertCurrent();
  return structuredClone(original.records);
}

export interface NodeV28ArchiveStagesOptions {
  database: SqliteCapability; nativeDatabase: DatabaseSync; admission: ReviewedInstallationAdmission;
  opening: LocalVolumeProfileOpening; repository: ReturnType<typeof jobSqlSystemRecoveryRepository>;
  /** The sole Recovery-only application keeps business, File, GC and other
   * schedulers absent, maintenance fenced, and original source writers settled. */
  assertQuiesced(): void;
  artifactRead(key: string, dependency?: RecoveryClaim): Promise<ReadableStream<Uint8Array> | null>;
  quarantine(error: unknown): void;
}
interface BodyOwner {
  readonly body: ReadableStream<Uint8Array>;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  readonly pending: Set<Promise<ReadableStreamReadResult<Uint8Array>>>;
  rawClose?: Promise<void>; finish?: Promise<void>;
  onClose?: () => Promise<void>;
  removeAbort?: () => void;
  ended: boolean;
}
interface ProviderOwner {
  opening?: Promise<OpenedStorageProfile<"local">>;
  adapter?: OpenedStorageProfile<"local">;
  openFailure?: unknown;
  readonly reads: Set<BodyOwner>;
  close?: Promise<void>;
}
interface Scope {
  readonly bodies: Set<BodyOwner>;
  readonly providers: Set<ProviderOwner>;
  source?: ArchiveSource;
  sourceDispose?: Promise<void>;
  close?: Promise<void>;
}
const retainedFailedStages = new Set<object>();
const encoder = new TextEncoder();
function ensure(value: unknown, reason = "archive_invalid"): asserts value {
  if (!value) throw new Error(reason);
}
function cleanupUnproven(error: unknown, seen = new Set<unknown>()): boolean {
  if (error instanceof StorageProfileCleanupError) return true;
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  return error instanceof AggregateError && error.errors.some(value => cleanupUnproven(value, seen))
    || "cause" in error && cleanupUnproven(error.cause, seen);
}

/** V28/V5 archive stages only. The host owns Request/session/administrator and
 * runtime admission and the one native/physical installation owner. Keeping the
 * whole source quiesced across every backup slot preserves the existing Node
 * capture policy. Artifact upload validation and frozen metadata previews do
 * not require a source maintenance window. This port creates no historical
 * live-source or persistent-hold grant.
 * No target import, deployment handoff, profile registration or provider write
 * is composed here. All retained byte owners keep their first close outcome. */
export function createNodeV28ArchiveStages(options: NodeV28ArchiveStagesOptions) {
  const { database, nativeDatabase, admission, opening, repository } = Object.freeze({ ...options });
  const quiesced = options.assertQuiesced.bind(options), artifactRead = options.artifactRead.bind(options), quarantine = options.quarantine.bind(options);
  const context = assertLocalVolumeProfileOpeningV28(opening);
  const installation = assertInstallationAdmission(nativeDatabase, admission);
  ensure(context.database === database && context.nativeDatabase === nativeDatabase
    && context.installationId === installation.installationId && installation.checkpointId === "portable-runtime/v28", "source_unavailable");
  const bodies = new Set<BodyOwner>(), providers = new Set<ProviderOwner>(), scopes = new Set<Scope>();
  const operations = new Set<Promise<unknown>>();
  let phase: "open" | "closing" | "closed" | "quarantined" = "open", closing: Promise<void> | undefined;
  let failed = false, failure: unknown;
  const state = { database, nativeDatabase, admission, opening, repository, bodies, providers, scopes, operations };
  function retainFailure(error: unknown): void {
    if (!failed) {
      failed = true; failure = error; phase = "quarantined"; retainedFailedStages.add(state);
      try { quarantine(error); }
      catch (notificationError) { failure = new AggregateError([error, notificationError], "Recovery quarantine notification failed"); }
    }
  }
  function base(): void {
    if (phase !== "open") throw failed ? failure : new Error("source_unavailable");
    assertSqliteConnectionOwner(database, nativeDatabase); context.assertCurrent();
    const currentInstallation = assertInstallationAdmission(nativeDatabase, admission);
    ensure(currentInstallation.installationId === installation.installationId
      && currentInstallation.checkpointId === "portable-runtime/v28", "source_checkpoint_changed");
  }
  function sourceBase(): void {
    base();
    const result: unknown = quiesced();
    ensure(result === undefined, "source_maintenance_required");
  }
  async function fence(current: () => Promise<boolean>, signal: AbortSignal, sourceWork = false): Promise<void> {
    const inspect = sourceWork ? sourceBase : base;
    inspect(); if (signal.aborted || !await current()) throw new Error("administrator_revoked");
    inspect(); if (signal.aborted) throw new Error("administrator_revoked");
  }
  function track<T>(original: Promise<T>): Promise<T> {
    operations.add(original);
    void original.then(() => operations.delete(original), () => operations.delete(original));
    return original;
  }
  function rawClose(owner: BodyOwner, reason?: unknown): Promise<void> {
    return owner.rawClose ??= Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      // Cancel first so an outstanding original read can settle; expiry alone
      // cannot stand in for its actual cancellation/FD closure acknowledgement.
      try { if (owner.reader) await owner.reader.cancel(reason); else await owner.body.cancel(reason); }
      catch (error) { errors.push(error); }
      await Promise.allSettled([...owner.pending]);
      try { owner.reader?.releaseLock(); }
      catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Original Recovery body closure failed");
    }).catch(error => { retainFailure(error); throw error; });
  }
  function finishBody(owner: BodyOwner, reason?: unknown): Promise<void> {
    if (owner.finish) return owner.finish;
    owner.ended = true; owner.removeAbort?.();
    owner.finish = Promise.resolve().then(async () => {
      await rawClose(owner, reason); await owner.onClose?.(); bodies.delete(owner);
    }).catch(error => { retainFailure(error); throw error; });
    void owner.finish.catch(() => undefined); return owner.finish;
  }
  function closeProvider(owner: ProviderOwner): Promise<void> {
    return owner.close ??= Promise.resolve().then(async () => {
      if (owner.opening) {
        try { owner.adapter = await owner.opening; }
        catch (error) {
          owner.openFailure = error;
          // The opening helper already attempted cleanup once on construction
          // rejection. Preserve its failed owner instead of invoking it again.
          if (cleanupUnproven(error)) { retainFailure(error); throw error; }
        }
      }
      const results = await Promise.allSettled([...owner.reads].map(read => rawClose(read)));
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
      if (!errors.length && owner.adapter?.dispose) {
        try { await owner.adapter.dispose(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Original Recovery provider closure failed");
      providers.delete(owner);
    }).catch(error => { retainFailure(error); throw error; });
  }
  function closeScope(scope: Scope): Promise<void> {
    return scope.close ??= Promise.resolve().then(async () => {
      if (scope.source && !scope.sourceDispose) scope.sourceDispose = Promise.resolve().then(() => scope.source!.dispose?.()).then(() => undefined);
      const results = await Promise.allSettled([
        ...(scope.sourceDispose ? [scope.sourceDispose] : []),
        ...[...scope.bodies].map(body => finishBody(body)),
        ...[...scope.providers].map(provider => closeProvider(provider)),
      ]);
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
      if (errors.length) throw new AggregateError(errors, "Original Recovery archive scope closure failed");
      scopes.delete(scope);
    }).catch(error => { retainFailure(error); throw error; });
  }
  function scope(): Scope {
    const value: Scope = { bodies: new Set(), providers: new Set() }; scopes.add(value); return value;
  }
  async function withinScope<T>(operation: (value: Scope) => Promise<T>): Promise<T> {
    const owned = scope(); let failed = false, originalFailure: unknown, value!: T;
    try { value = await operation(owned); } catch (error) { failed = true; originalFailure = error; }
    try { await closeScope(owned); }
    catch (cleanup) {
      if (failed) throw new AggregateError([originalFailure, cleanup], "Recovery stage and first closure failed");
      throw cleanup;
    }
    if (failed) throw originalFailure; return value;
  }
  async function ownedBody(body: ReadableStream<Uint8Array>, current: () => Promise<boolean>, signal: AbortSignal,
    value?: Scope, provider?: ProviderOwner, onClose?: () => Promise<void>, sourceWork = false): Promise<ReadableStream<Uint8Array>> {
    const owner: BodyOwner = { body, pending: new Set(), ended: false,
      ...(onClose ? { onClose } : provider ? { onClose: () => closeProvider(provider) } : {}) };
    bodies.add(owner); value?.bodies.add(owner); provider?.reads.add(owner);
    try { owner.reader = body.getReader(); await fence(current, signal, sourceWork); }
    catch (error) {
      try { await finishBody(owner, error); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Recovery body admission and first closure failed"); }
      throw error;
    }
    let output: ReadableStreamDefaultController<Uint8Array>;
    const abort = () => {
      if (owner.ended) return;
      try { output.error(signal.reason ?? new Error("execution_budget_exhausted")); } catch { /* Delivery has already ended. */ }
      void finishBody(owner, signal.reason).catch(() => undefined);
    };
    owner.removeAbort = () => signal.removeEventListener("abort", abort);
    return new ReadableStream<Uint8Array>({
      start(controller) { output = controller; signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); },
      async pull(controller) {
        let original: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
        try {
          await fence(current, signal, sourceWork); if (owner.ended) return;
          original = owner.reader!.read(); owner.pending.add(original);
          const next = await original; owner.pending.delete(original); await fence(current, signal, sourceWork);
          if (owner.ended) return;
          if (next.done) { await finishBody(owner); controller.close(); }
          else { ensure(next.value instanceof Uint8Array); controller.enqueue(next.value); }
        } catch (error) {
          if (original) owner.pending.delete(original);
          let deliveredError = error;
          try { await finishBody(owner, error); }
          catch (cleanup) { deliveredError = new AggregateError([error, cleanup], "Recovery read and first closure failed"); }
          try { controller.error(deliveredError); } catch { /* The original abort already fenced delivery. */ }
        }
      },
      cancel(reason) { return finishBody(owner, reason); },
    }, { highWaterMark: 0 });
  }
  function localTuple(item: SystemBackupSourceV28, sourceWork = true) {
    const source = item.source;
    ensure(source.provider === "local" && source.storeKind === "file" && source.storageProfileId
      && source.storageProfileRevision === 1 && "namespace" in source, "source_unavailable");
    if (sourceWork) sourceBase(); else base();
    const authority = context.captureProfileAuthority({ profileId: source.storageProfileId, configurationRevision: 1 }, "read");
    ensure(authority.profile.adapterType === "local"
      && stableJson(source.namespace) === stableJson(checkedStoredLocalVolumeNamespace(authority.profile.namespaceIdentity)), "source_unavailable");
    return { source, authority };
  }
  async function readLocal(item: SystemBackupSourceV28, value: Scope, current: () => Promise<boolean>, signal: AbortSignal, sourceWork = true) {
    await fence(current, signal, sourceWork); const { source, authority } = localTuple(item, sourceWork);
    const provider: ProviderOwner = { reads: new Set() }; providers.add(provider); value.providers.add(provider);
    provider.opening = openStorageProfile(opening.capabilities, { profileId: source.storageProfileId!, configurationRevision: 1 }, "read", {
      // The retained body owner cancels and awaits this actual local reader.
      // Its private stage signal fences every request/pull without first
      // replacing the underlying reader's cancellation ACK with an error.
      async beforeRequest(operation) {
        await fence(current, signal, sourceWork); const live = localTuple(item, sourceWork);
        return ["GET", "HEAD"].includes(operation.method) && operation.key === source.objectKey
          && live.authority.profile.namespaceIdentity === authority.profile.namespaceIdentity;
      },
    });
    try {
      provider.adapter = await provider.opening; await fence(current, signal, sourceWork); localTuple(item, sourceWork);
      ensure(provider.adapter.storage.namespaceIdentity === authority.profile.namespaceIdentity, "source_unavailable");
      const result = await provider.adapter.reader.read(source.objectKey);
      // Capture the transferred body BEFORE any late authorization/tuple check.
      if (result.outcome === "available") return { outcome: "available" as const,
        body: await ownedBody(result.body as ReadableStream<Uint8Array>, current, signal, value, provider, undefined, sourceWork) };
      await fence(current, signal, sourceWork); await closeProvider(provider);
      return { outcome: result.outcome === "missing" ? "missing" as const : "download_failed" as const };
    } catch (error) {
      try { await closeProvider(provider); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Recovery provider read and first closure failed"); }
      throw error;
    }
  }
  async function inventory(item: SystemBackupSourceV28, value: Scope, current: () => Promise<boolean>, signal: AbortSignal): Promise<SystemBackupFileV28> {
    await fence(current, signal, true);
    const unavailable = (outcome: SystemBackupOutcome): SystemBackupFileV28 => ({ ...item, path: null, byteSize: null, sha256: null, outcome });
    if (item.source.provider !== "local" || item.source.storeKind !== "file") return unavailable("provider_unavailable");
    if (item.source.initialOutcome !== null) return unavailable(item.source.initialOutcome === "missing" ? "missing"
      : item.source.initialOutcome === "provider_unavailable" ? "provider_unavailable" : "metadata_unavailable");
    const read = await readLocal(item, value, current, signal);
    if (read.outcome !== "available") return unavailable(read.outcome);
    const reader = read.body.getReader(), hash = nodeSha256(); let bytes = 0;
    try {
      while (true) {
        await fence(current, signal, true); const next = await reader.read(); await fence(current, signal, true);
        if (next.done) break; bytes += next.value.byteLength;
        ensure(bytes <= SYSTEM_BACKUP_MAX_PAYLOAD_BYTES, "archive_budget"); await hash.write(next.value);
      }
      const digest = await hash.finish(); await fence(current, signal, true);
      if (item.source.expectedByteSize !== null && item.source.expectedByteSize !== bytes) return unavailable("size_mismatch");
      if (item.source.expectedSha256 !== null && item.source.expectedSha256.toLowerCase() !== digest) return unavailable("hash_mismatch");
      return { ...item, path: `files/${item.id}`, byteSize: bytes, sha256: digest, outcome: "packaged" };
    } finally {
      try { await reader.cancel(); } finally { reader.releaseLock(); await hash.abort(); }
    }
  }
  async function records(jobId: string, sourceWork = false): Promise<SystemBackupRecordsV5> {
    const inspect = sourceWork ? sourceBase : base;
    inspect(); const frozen = await repository.metadata(jobId, "records"); inspect();
    const checked = await validateSystemBackupRecordsV5(frozen); inspect(); return checked;
  }
  async function documents(jobId: string, sourceWork = false) {
    const inspect = sourceWork ? sourceBase : base;
    const frozen = await records(jobId, sourceWork); inspect();
    const manifest = await repository.metadata(jobId, "manifest"); inspect();
    const checked = await validateSystemBackupDocumentsV5(manifest, frozen); inspect(); return checked;
  }
  function fileStatements(claim: RecoveryClaim, sources: readonly SystemBackupSourceV28[]): JobSqlStatement[] {
    const groups: Array<Array<{ id: string; ordinal: number; json: string }>> = []; let group: Array<{ id: string; ordinal: number; json: string }> = [];
    sources.forEach((source, ordinal) => {
      const row = { id: source.id, ordinal, json: stableJson(source) };
      if (encoder.encode(row.json).byteLength > 65536) throw new SystemRecoveryConflict("metadata_budget");
      if (group.length && encoder.encode(stableJson([...group, row])).byteLength > 83 * 1024) { groups.push(group); group = []; }
      group.push(row);
      if (encoder.encode(stableJson(group)).byteLength > 83 * 1024) throw new SystemRecoveryConflict("metadata_budget");
    });
    if (group.length) groups.push(group);
    return groups.map(rows => repository.db().prepare(`INSERT INTO system_recovery_files(job_id,id,ordinal,outcome,file_json)
      SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.ordinal'),'pending',json_extract(value,'$.json') FROM json_each(?)`)
      .bind(claim.id, stableJson(rows)));
  }
  function boundedStatements(statements: JobSqlStatement[]): JobSqlStatement[] {
    if (statements.length + 2 > 128) throw new SystemRecoveryConflict("metadata_budget"); return statements;
  }
  function sourceCheckpointStatements(claim: RecoveryClaim, checkpoint: string): JobSqlStatement[] {
    const accepted: unknown = JSON.parse(claim.checkpoint_json ?? "null");
    ensure(accepted && typeof accepted === "object" && !Array.isArray(accepted), "source_checkpoint_changed");
    const window = (accepted as { sourceWindow?: unknown }).sourceWindow;
    ensure(window && typeof window === "object" && !Array.isArray(window), "source_checkpoint_changed");
    const { generation, token } = window as { generation?: unknown; token?: unknown };
    ensure(Number.isSafeInteger(generation) && Number(generation) >= 0
      && (token === null || typeof token === "string" && token.length > 0 && token.length <= 128), "source_checkpoint_changed");
    const db = repository.db(), matches = `singleton=1 AND state='fenced' AND generation=? AND token IS ?
      AND (backup_job_id IS NULL OR backup_job_id=?) AND (checkpoint_sha256 IS NULL OR checkpoint_sha256=?)`;
    // These statements join the original shared finish batch: exact claim,
    // source window, frozen metadata and final checkpoint commit together.
    // A failed guard rolls the whole batch back; historical mode calls neither.
    return [db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_maintenance WHERE ${matches})
      AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
      THEN 1 ELSE json('Source final checkpoint window changed or writers remain unsettled') END`)
      .bind(generation, token, claim.id, checkpoint),
    db.prepare(`UPDATE system_recovery_maintenance SET backup_job_id=?,checkpoint_sha256=?,updated_at=? WHERE ${matches}`)
      .bind(claim.id, checkpoint, repository.now().toISOString(), generation, token, claim.id, checkpoint)];
  }
  async function prepared(claim: RecoveryClaim) {
    sourceBase(); const frozen = await records(claim.id, true); sourceBase();
    const rows = await repository.files(claim.id); sourceBase();
    ensure(rows.every(row => row.outcome !== "pending"));
    const manifest = await finishSystemBackupManifestV5(frozen, rows.map(row => JSON.parse(row.file_json) as SystemBackupFileV28));
    sourceBase(); await validateSystemBackupDocumentsV5(manifest, frozen); sourceBase();
    ensure(!claim.source_checkpoint || claim.source_checkpoint === manifest.sourceCheckpoint, "source_checkpoint_changed");
    const metadata = await systemBackupArchiveMetadata(manifest, frozen, manifest); sourceBase();
    return { frozen, manifest, metadata };
  }
  function payload(manifest: SystemBackupManifestV5, value: Scope, current: () => Promise<boolean>, signal: AbortSignal) {
    return async (entry: ArchiveEntry): Promise<ReadableStream<Uint8Array>> => {
      await fence(current, signal, true);
      const file = manifest.files.find(file => file.path === entry.path && file.outcome === "packaged");
      ensure(file && file.byteSize === entry.byteSize && file.sha256 === entry.sha256);
      const read = await readLocal(file, value, current, signal); ensure(read.outcome === "available", "source_unavailable");
      return read.body;
    };
  }
  async function uploadSource(claim: RecoveryJob, value: Scope, current: () => Promise<boolean>, signal: AbortSignal, dependency?: RecoveryClaim): Promise<ArchiveSource> {
    await fence(current, signal);
    const held = dependency !== undefined && dependency.kind === "recovery" && dependency.source_upload_job_id === claim.id
      && dependency.actor === claim.actor && await repository.current(dependency);
    ensure(claim.artifact_key && claim.archive_byte_size && claim.archive_sha256 && claim.expires_at
      && (Date.parse(claim.expires_at) > Date.now() || held));
    const attempts = await repository.attempts(claim.id); await fence(current, signal);
    ensure(attempts.some(attempt => attempt.object_key === claim.artifact_key && attempt.state === "verified"
      && attempt.expected_byte_size === claim.archive_byte_size && attempt.expected_sha256 === claim.archive_sha256));
    const stream = sourceFromStream(claim.archive_byte_size, async () => {
      await fence(current, signal); const body = await artifactRead(claim.artifact_key!, dependency);
      ensure(body, "source_unavailable"); return ownedBody(body, current, signal, value);
    });
    let disposed: Promise<void> | undefined;
    const closeCursors = async () => {
      stream.close();
      const results = await Promise.allSettled([...value.bodies].map(body => finishBody(body)));
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
      if (errors.length) throw new AggregateError(errors, "Original upload archive cursor closure failed");
    };
    const source: ArchiveSource = { byteSize: stream.byteSize,
      read: (offset, length, readSignal) => stream.read(offset, length, readSignal),
      open: (offset, length, readSignal) => stream.open!(offset, length, readSignal),
      close: closeCursors,
      dispose() { return disposed ??= Promise.resolve().then(closeCursors); },
    };
    value.source = source; return source;
  }
  function step(claim: RecoveryClaim, current: () => Promise<boolean>, signal: AbortSignal): Promise<RecoveryStepResult<JobSqlStatement>> {
    const sourceWork = claim.kind === "backup", stageFence = () => fence(current, signal, sourceWork);
    if (sourceWork) sourceBase(); else base();
    return track(withinScope<RecoveryStepResult<JobSqlStatement>>(async value => {
      await stageFence();
      if (claim.kind === "backup" && claim.phase === "snapshot") {
        const input = checkedSystemRecoveryBackupInput(JSON.parse(claim.input_json));
        const frozen = await captureQuiescedNodeSystemBackupV28Candidate(database, nativeDatabase, { backupId: claim.id, createdAt: claim.accepted_at });
        await stageFence(); const sources = planSystemBackupSourcesV28(frozen.content), checkpoint = await sourceBackupCheckpointV5(frozen);
        await stageFence();
        return { patch: { state: "queued", phase: "inventory", source_checkpoint: checkpoint, total_files: sources.length },
          statements: boundedStatements([...(input.mode === "planned" ? sourceCheckpointStatements(claim, checkpoint) : []),
            ...repository.metadataStatements(claim.id, "records", frozen), ...fileStatements(claim, sources)]), outcome: "snapshot" };
      }
      if (claim.kind === "backup" && claim.phase === "inventory") {
        const frozen = await records(claim.id, true); await stageFence();
        const sources = planSystemBackupSourcesV28(frozen.content), rows = await repository.files(claim.id);
        await stageFence(); ensure(rows.length === sources.length && rows.every((row, ordinal) => row.ordinal === ordinal && row.id === sources[ordinal]!.id));
        const pending = rows.find(row => row.outcome === "pending");
        if (!pending) return { patch: { state: "queued", phase: "measure" }, outcome: "inventoried" };
        const source = sources[pending.ordinal]!; ensure(stableJson(JSON.parse(pending.file_json)) === stableJson(source));
        const file = await inventory(source, value, current, signal); await stageFence();
        const packaged = rows.filter(row => row.outcome === "packaged").reduce((sum, row) => sum + ((JSON.parse(row.file_json) as SystemBackupFileV28).byteSize ?? 0), 0) + (file.byteSize ?? 0);
        ensure(packaged <= SYSTEM_BACKUP_MAX_PAYLOAD_BYTES, "archive_budget");
        return { patch: { state: "queued", phase: rows.filter(row => row.outcome === "pending").length === 1 ? "measure" : "inventory",
          completed_files: claim.completed_files + 1, bytes_total: packaged },
          statements: [repository.db().prepare("UPDATE system_recovery_files SET outcome=?,file_json=? WHERE job_id=? AND id=? AND outcome='pending'")
            .bind(file.outcome, stableJson(file), claim.id, file.id)], outcome: "source_measured" };
      }
      if (claim.kind === "backup" && claim.phase === "measure") {
        const { manifest, metadata } = await prepared(claim); await stageFence();
        const measured = await measureSystemBackupArchive(metadata, payload(manifest, value, current, signal), { signal, createHash: nodeSha256 });
        await stageFence(); ensure(measured.byteSize <= SYSTEM_BACKUP_MAX_ARCHIVE_BYTES, "archive_budget");
        return { patch: { state: "queued", phase: "write", archive_byte_size: measured.byteSize, archive_sha256: measured.sha256 },
          statements: boundedStatements([...repository.metadataStatements(claim.id, "manifest", manifest), ...repository.metadataStatements(claim.id, "index", measured.entries)]), outcome: "measured" };
      }
      if (claim.kind === "upload" && claim.phase === "validate") {
        const source = await uploadSource(claim, value, current, signal);
        const validated = await validateV28SystemBackupArchiveCandidate(source, { expectedSha256: claim.archive_sha256!, signal, createHash: nodeSha256 });
        await stageFence();
        return { patch: { state: "preview", phase: "done", source_checkpoint: validated.manifest.sourceCheckpoint,
          total_files: validated.manifest.files.length, completed_files: validated.manifest.counts.packagedFiles,
          bytes_total: validated.manifest.counts.bytes, bytes_done: validated.manifest.counts.bytes },
          statements: boundedStatements([...repository.metadataStatements(claim.id, "records", validated.records),
            ...repository.metadataStatements(claim.id, "manifest", validated.manifest), ...repository.metadataStatements(claim.id, "index", validated.entries)]), outcome: "preview" };
      }
      throw new Error("target_unavailable");
    }));
  }
  function exportBody(claim: RecoveryClaim, current: () => Promise<boolean>, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    sourceBase(); ensure(claim.kind === "backup" && claim.phase === "write");
    const value = scope();
    const original = (async () => {
      try {
        await fence(current, signal, true); const checked = await documents(claim.id, true); await fence(current, signal, true);
        const rebuilt = await prepared(claim);
        ensure(stableJson(checked.manifest) === stableJson(rebuilt.manifest)); await fence(current, signal, true);
        // Abort belongs to the retained outer body. A signal-driven error on
        // the raw formatter stream would hide its generator.return ACK from
        // reader.cancel, even when the original generator eventually settles.
        const stream = createSystemBackupArchiveStream(rebuilt.metadata, payload(rebuilt.manifest, value, current, signal), { createHash: nodeSha256 });
        // The outer stream is globally retained but not part of its own child
        // scope. EOF/cancel closes those children before acknowledging output.
        return await ownedBody(stream, current, signal, undefined, undefined, () => closeScope(value), true);
      } catch (error) {
        try { await closeScope(value); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Recovery export construction and first closure failed"); }
        throw error;
      }
    })();
    return track(original);
  }
  function preview(job: RecoveryJob): Promise<SystemRecoveryPreview> {
    base(); ensure(job.kind === "backup" && job.state === "completed" || job.kind === "upload" && job.state === "preview");
    return track((async () => {
      const { records: frozen, manifest } = await documents(job.id); base();
      ensure(job.archive_byte_size && job.archive_sha256);
      const profileId = (file: SystemBackupFileV28) => file.source.storageProfileId ?? `legacy:${file.source.storeKind}:${file.source.provider}`;
      const profiles = [...new Set(manifest.files.map(profileId))].map(id => {
        const file = manifest.files.find(file => profileId(file) === id)!, profile = frozen.content.tables.storage_profiles.find(row => row.id === id);
        return { id, adapterType: String(profile?.adapter_type ?? file.source.provider), namespaceIdentity: String(profile?.namespace_identity ?? id) };
      });
      const snapshot = manifest.sourceSnapshotClock.replace(" ", "T"), recoveryPoint = new Date(/Z$|[+-]\d\d:\d\d$/.test(snapshot) ? snapshot : `${snapshot}Z`).toISOString();
      const complete = manifest.completeness === "complete", expired = !job.expires_at || Date.parse(job.expires_at) <= Date.now();
      const mode = job.kind === "backup" ? checkedSystemRecoveryBackupInput(JSON.parse(job.input_json)).mode : "historical";
      const value: SystemRecoveryPreview = { schema: "system-recovery-preview/1",
        archive: { schema: manifest.schema, byteSize: job.archive_byte_size, sha256: job.archive_sha256, complete, legacy: false, recoveryPoint },
        counts: { tables: manifest.counts.tables, rows: manifest.counts.rows, files: manifest.counts.sources, bytes: manifest.counts.bytes,
          availableFiles: manifest.counts.packagedFiles, unavailableFiles: manifest.counts.unavailableFiles },
        files: manifest.files.map(file => ({ id: file.id, purpose: file.purposes.join(",") || "unknown", byteSize: file.byteSize ?? file.source.expectedByteSize ?? 0,
          status: file.outcome, reason: file.outcome === "packaged" ? null : file.outcome, sourceProfileId: profileId(file) })), profiles,
        protectedSettings: { included: frozen.protectedConfiguration.status === "included_encrypted",
          credentialRecovery: frozen.protectedConfiguration.status === "included_encrypted" ? "quarantined" : "excluded",
          warnings: [...(frozen.protectedConfiguration.keyIds.length ? ["separate_root_keys_required"] : []),
            "protected_local_accounts_disabled_offline_bootstrap_required", "local_profiles_require_fresh_destination_binding"] },
        oldJobs: { paused: (frozen.content.tables.file_migration_jobs?.length ?? 0) + (frozen.content.tables.research_package_jobs?.length ?? 0), automaticReplay: false },
        target: { id: null, available: false, reason: "target_unavailable" },
        source: { maintenanceRequired: true, checkpoint: manifest.sourceCheckpoint, mode }, canRecover: false, canCutover: false,
        reasons: [...(!complete ? ["partial_backup"] : []), ...(expired ? ["upload_expired"] : []), "target_unavailable"] };
      base(); return checkedSystemRecoveryPreview(value);
    })());
  }
  function close(): Promise<void> {
    if (closing) return closing;
    if (phase === "open") phase = "closing";
    closing = Promise.resolve().then(async () => {
      // Stop outstanding delivered streams first; then retain every original
      // stage, opening, provider and first disposer outcome before parent close.
      const initial = await Promise.allSettled([...bodies].map(body => finishBody(body)));
      await Promise.allSettled([...operations]);
      const rest = await Promise.allSettled([...scopes].map(value => closeScope(value)).concat([...providers].map(value => closeProvider(value))));
      const errors = [...initial, ...rest].flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
      if (failed || errors.length) throw failed ? failure : new AggregateError(errors, "Original Recovery archive stages did not drain");
      phase = "closed";
    }).catch(error => { retainFailure(error); throw error; });
    void closing.catch(() => undefined); return closing;
  }
  function withRecoveryArchive<T>(claim: RecoveryClaim, current: () => Promise<boolean>, signal: AbortSignal,
    operation: (source: ArchiveSource, index: readonly ArchiveIndexEntry[]) => Promise<T>): Promise<T> {
    base(); return track(withinScope(async value => {
      await fence(current, signal);
      const upload = claim.source_upload_job_id ? await repository.job(claim.source_upload_job_id) : null;
      ensure(claim.kind === "recovery" && upload && upload.kind === "upload" && upload.state === "preview"
        && upload.actor === claim.actor && claim.source_checkpoint === upload.source_checkpoint, "archive_invalid");
      await fence(current, signal); const source = await uploadSource(upload, value, current, signal, claim);
      const index = await repository.metadata(upload.id, "index") as ArchiveIndexEntry[] | null;
      ensure(Array.isArray(index) && index.length <= 256, "archive_invalid");
      await fence(current, signal); return operation(source, index);
    }));
  }
  async function recoveryDocuments(upload: RecoveryJob) {
    base(); ensure(upload.kind === "upload" && upload.state === "preview", "archive_invalid");
    const value = await documents(upload.id); base();
    ensure(upload.source_checkpoint === value.manifest.sourceCheckpoint, "archive_invalid");
    return { records: value.records, manifest: value.manifest };
  }
  /** Read-only validation for the separate Recovery-only explicit source
   * resume action. Its host proves released OPEN source, stopped executors,
   * current administrator and no other original work at every awaited boundary.
   * All existing backup reads retain sourceWork=true and their fenced window. */
  function assertDrained(): void {
    base(); if (bodies.size || providers.size || scopes.size || operations.size)
      throw new Error("Original Recovery archive work has not acknowledged its drain");
  }
  function verifySourceResume(job: RecoveryJob, current: () => Promise<boolean>, signal: AbortSignal, request: Request) {
    assertDrained(); ensure(request instanceof Request);
    return track(withinScope(async value => {
      await fence(current, signal);
      ensure(job.kind === "backup" && job.state === "completed" && job.phase === "done", "source_resume_backup_required");
      const original = await documents(job.id); await fence(current, signal);
      ensure(original.records.sourceMigrationLedger.kind === "node-reviewed-migrations/1"
        && original.records.sourceMigrationLedger.installationId === installation.installationId
        && original.manifest.completeness === "complete" && job.source_checkpoint === original.manifest.sourceCheckpoint,
        "source_resume_original_installation_required");
      const fresh = await captureQuiescedNodeSystemBackupV28Candidate(database, nativeDatabase,
        { backupId: job.id, createdAt: job.accepted_at });
      await fence(current, signal);
      ensure(await sourceBackupCheckpointV5(fresh) === job.source_checkpoint, "source_resume_metadata_changed");
      await fence(current, signal);
      const sources = planSystemBackupSourcesV28(fresh.content);
      ensure(sources.length === original.manifest.files.length, "source_resume_inventory_changed");
      for (const source of sources) {
        const expected = original.manifest.files.find(file => file.id === source.id);
        ensure(expected && expected.outcome === "packaged" && expected.byteSize !== null && expected.sha256 !== null
          && stableJson(expected.source) === stableJson(source.source) && stableJson(expected.bindings) === stableJson(source.bindings)
          && source.source.provider === "local" && source.source.storeKind === "file", "source_resume_publication_changed");
        // Resume admits only a current installation-owned writable LOCAL
        // primary. A restored/read-only profile never becomes a write grant.
        const writable = context.captureProfileAuthority({ profileId: source.source.storageProfileId!, configurationRevision: 1 }, "write");
        ensure(writable.profile.runtimeState === "read_write" && writable.profile.adapterType === "local", "source_resume_writable_local_required");
        const read = await readLocal(source, value, current, signal, false); await fence(current, signal);
        ensure(read.outcome === "available", "source_resume_payload_unavailable");
        const reader = read.body.getReader(), hash = nodeSha256(); let bytes = 0;
        let failed = false, failure: unknown, cleanupFailed = false, cleanupFailure: unknown;
        try {
          for (;;) {
            const next = await reader.read(); await fence(current, signal);
            if (next.done) break;
            bytes += next.value.byteLength; ensure(bytes <= expected.byteSize && bytes <= SYSTEM_BACKUP_MAX_PAYLOAD_BYTES, "source_resume_payload_budget");
            await hash.write(next.value); await fence(current, signal);
          }
        } catch (error) { failed = true; failure = error; }
        try { await reader.cancel(); reader.releaseLock(); }
        catch (error) { cleanupFailed = true; cleanupFailure = error; }
        if (cleanupFailed) throw failed ? new AggregateError([failure, cleanupFailure], "Source resume read and first close failed") : cleanupFailure;
        if (failed) throw failure;
        ensure(bytes === expected.byteSize && await hash.finish() === expected.sha256, "source_resume_payload_changed");
        await fence(current, signal);
      }
      await fence(current, signal);
      // The proof remains private until every original body/provider first
      // close acknowledges. withinScope completes that custody before return.
      const proof = Object.freeze({}) as NodeV28SourceResumeVerification;
      return { proof, original: Object.freeze({ database, nativeDatabase, opening, admission, request,
        jobId: job.id, checkpoint: job.source_checkpoint!, records: structuredClone(fresh), current: base }) };
    })).then(verified => {
      resumeVerifications.set(verified.proof, verified.original); return verified.proof;
    });
  }
  base(); return Object.freeze({ step, exportBody, preview, recoveryDocuments, withRecoveryArchive, assertDrained, verifySourceResume, close });
}
