import { FILE_JOB_STEP_MS } from "../../../shared/contracts/file-jobs";
import { verifyStoredBytes } from "../byte-verification";
import { writeVerifiedBytes } from "../byte-writer";
import type { FileJobCapabilities, MigrationAttempt, MigrationItem } from "./types";

/** A single independently invoked step. Neither an HTTP response nor a browser
 * owns the executor. Runtime, storage, persistence and administrator policy are
 * explicit capabilities; no Cloudflare Env or Node globals enter the service. */
export async function runFileJobStep(capabilities: FileJobCapabilities): Promise<{ jobId: string | null; outcome: string }> {
  const { repository } = capabilities;
  await repository.heartbeat(capabilities.incarnation);
  const claim = await repository.claim(capabilities.incarnation, capabilities.randomId(), capabilities.authorizeAdministrator);
  if (!claim) return { jobId: null, outcome: "idle" };
  let item: MigrationItem | null = null, attempt: MigrationAttempt | null = null;
  const deadline = capabilities.now().getTime() + FILE_JOB_STEP_MS;
  const abort = new AbortController();
  let expired = false, timer: ReturnType<typeof setTimeout> | undefined;
  const current = async () => !expired && capabilities.now().getTime() < deadline
    && capabilities.authorizeAdministrator(claim.actor) && await repository.owns(claim);
  try {
    if (!await current()) { await repository.pause(claim, "execution_not_authorized"); return { jobId: claim.id, outcome: "paused" }; }
    item = await repository.nextItem(claim);
    if (!item) { await repository.release(claim); return { jobId: claim.id, outcome: "settled" }; }
    attempt = await repository.attempt(item);
    const work = async () => {
      const source = await capabilities.openStorage({ profileId: item!.source_profile_id,
        configurationRevision: item!.source_configuration_revision }, "read", current, abort.signal);
      if (source.namespaceIdentity !== item!.source_namespace) throw new Error("source_namespace_unavailable");
      const destination = await capabilities.openStorage({ profileId: claim.target_profile_id,
        configurationRevision: claim.target_configuration_revision }, "write", current, abort.signal);
      if (destination.namespaceIdentity !== claim.target_namespace || !destination.writer) throw new Error("target_unavailable");
      const expected = { byteSize: item!.byte_size, sha256: item!.sha256 };
      if (attempt && item!.state !== "pending" && ["write_started", "unknown", "verified"].includes(attempt.state)) {
        // A missing candidate cannot prove a timed-out PUT stopped. Keep holds.
        if (!attempt.io_settled_at && !destination.atomicSinglePut) throw new Error("write_settlement_required");
        await verifyStoredBytes(source.reader, item!.source_object_key, expected, source.createHash);
        await verifyStoredBytes(destination.reader, attempt.object_key, expected, destination.createHash);
        if (!attempt.io_settled_at) await repository.observeSettled(attempt);
      } else {
        if (!attempt || attempt.state !== "staged") attempt = await repository.stage(claim, item!);
        if (!await current()) throw new Error("execution_not_authorized");
        const read = await source.reader.read(item!.source_object_key);
        if (read.outcome !== "available") throw new Error("source_unavailable");
        if (!await current()) { await read.body.cancel(); throw new Error("execution_not_authorized"); }
        try { await repository.startWrite(claim, attempt!); }
        catch (error) { await read.body.cancel().catch(() => undefined); throw error; }
        // writeVerifiedBytes hashes source through one backpressured stream and
        // independently hashes a complete GET of the destination candidate.
        const transport = destination.writer;
        await writeVerifiedBytes({ ...destination, writer: { accepts: transport.accepts, async write(input) {
          await transport.write(input);
          await repository.observeSettled(attempt!);
        } } }, {
          key: attempt!.object_key, body: read.body, ...expected,
          contentType: read.contentType, filename: "migration-file",
        });
        // A stale executor may record positive settlement of its own I/O. It
        // cannot certify current publication ownership or cut over the File.
        await repository.observeSettled(attempt!);
      }
      if (!await current()) throw new Error("execution_not_authorized");
      await repository.verify(claim, item!, attempt!);
      if (!await current()) throw new Error("execution_not_authorized");
      return repository.cutover(claim, item!, attempt!);
    };
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; abort.abort(); reject(new Error("execution_budget_exhausted")); }, FILE_JOB_STEP_MS);
    });
    const moved = await Promise.race([work(), timeout]);
    await repository.release(claim);
    return { jobId: claim.id, outcome: moved ? "moved" : "stale" };
  } catch (error) {
    const reason = error instanceof Error && ["execution_not_authorized", "execution_budget_exhausted", "write_settlement_required",
      "source_namespace_unavailable", "source_unavailable", "target_unavailable", "retry_limit_exhausted"].includes(error.message) ? error.message : "verification_or_storage_unavailable";
    if (item) await repository.fail(claim, item, attempt, reason);
    await repository.pause(claim, reason);
    return { jobId: claim.id, outcome: "paused" };
  } finally { if (timer) clearTimeout(timer); }
}

/** Restartable local invocation loop. Its repository is persistent and each
 * invocation is bounded; no in-memory queue holds the accepted work. */
export async function runFileJobLoop(capabilities: FileJobCapabilities,
  options: { once?: boolean; signal?: AbortSignal; intervalMs?: number } = {}) {
  do {
    if (options.signal?.aborted) return;
    const cleanup = await runFileJobCleanupStep(capabilities);
    if (["idle", "disabled"].includes(cleanup.outcome)) await runFileJobStep(capabilities);
    if (options.once) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, Math.min(60_000, Math.max(100, options.intervalMs ?? 10_000)));
      options.signal?.addEventListener("abort", finish, { once: true });
    });
  } while (!options.signal?.aborted);
}

/** Explicit accepted source cleanup releases only the migration's source hold.
 * Existing fenced File GC owns physical deletion, other holds/legacy consumers,
 * grace and uncertain DELETE reconciliation. Original actor revocation does
 * not turn a separately authorized maintenance obligation into a grant. */
export async function runFileJobCleanupStep(capabilities: FileJobCapabilities) {
  if (!capabilities.authorizeSystemCleanup()) return { outcome: "disabled" };
  const deadline = capabilities.now().getTime() + FILE_JOB_STEP_MS;
  const abort = new AbortController();
  const allowed = async (jobId?: string) => capabilities.authorizeSystemCleanup() && capabilities.now().getTime() < deadline
    && await (jobId ? capabilities.repository.cleanupGranted(jobId, capabilities.incarnation)
      : capabilities.repository.runtimeEnabled(capabilities.incarnation));
  const artifact = await capabilities.repository.cleanupArtifact(capabilities.incarnation);
  if (artifact) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!artifact.io_settled_at && artifact.state !== "staged" && !["failed", "cancelled"].includes(artifact.state)) {
        const reconcile = async () => {
          const storage = await capabilities.openStorage({ profileId: artifact.profile_id,
            configurationRevision: artifact.configuration_revision }, "read", () => allowed(artifact.job_id), abort.signal);
          if (!storage.atomicSinglePut || storage.namespaceIdentity !== artifact.namespace_identity) throw new Error("settlement_required");
          await verifyStoredBytes(storage.reader, artifact.object_key, { byteSize: artifact.byte_size, sha256: artifact.sha256 }, storage.createHash);
          await capabilities.repository.observeSettled(artifact);
        };
        await Promise.race([reconcile(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { abort.abort(); reject(new Error("cleanup_budget_exhausted")); }, FILE_JOB_STEP_MS);
        })]);
      }
      if (!await allowed(artifact.job_id)) return { outcome: "pending" };
      await capabilities.repository.releaseArtifact(artifact, capabilities.incarnation);
      return { outcome: "artifact_released_to_gc" };
    } catch { return { outcome: "pending" }; }
    finally { if (timer) clearTimeout(timer); }
  }
  if (await allowed() && await capabilities.repository.releaseUnneededSource(capabilities.incarnation)) return { outcome: "released_to_gc" };
  const copy = await capabilities.repository.cleanupCopy(capabilities.incarnation);
  if (!copy) return { outcome: "idle" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const verify = async () => {
      const storage = await capabilities.openStorage({ profileId: copy.profile_id,
        configurationRevision: copy.configuration_revision }, "read", () => allowed(copy.job_id), abort.signal);
      return verifyStoredBytes(storage.reader, copy.object_key, { byteSize: copy.byte_size, sha256: copy.sha256 }, storage.createHash);
    };
    await Promise.race([
      verify(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error("cleanup_budget_exhausted")); }, FILE_JOB_STEP_MS); }),
    ]);
    if (!await allowed(copy.job_id)) return { outcome: "paused" };
    return { outcome: await capabilities.repository.releaseCleanup(copy, capabilities.incarnation) ? "released_to_gc" : "pending" };
  } catch { return { outcome: "pending" }; }
  finally {
    if (timer) clearTimeout(timer);
    await capabilities.repository.releaseVerificationHold(copy).catch(() => undefined);
  }
}
