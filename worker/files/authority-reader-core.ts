import type { FilePurpose } from "../../shared/contracts/files";
import { configurationSqlInteger } from "../runtime/configuration-sql";
import type { FileAuthoritySqlDatabase, FileAuthoritySqlResult } from "../runtime/file-authority-sql";
import { FileAuthorityUnavailableError } from "./authority-mode";
import type { AuthorityProfileOpener } from "./authority-profile-opening";
import type { ByteReadResult } from "./byte-reader";
import type { Sha256Factory } from "./byte-verification";
import { ownedProviderLifetime } from "./provider-lifetime";
import { StorageProfileCleanupError, type OpenedStorageProfile } from "./storage-profile-opening";

export const FILE_READ_MAX_LIFETIME_MS = 2 * 60_000;
export const FILE_READ_HOLD_MS = 15 * 60_000;

/** Internal ownership accompanies the unchanged public byte result. A trusted
 * host retains this scope until settled, including failed cleanup. It cannot
 * obtain provider authority, retry permission, or a new hold from this record. */
export interface OwnedPublishedFileRead {
  readonly result: ByteReadResult;
  readonly settled: Promise<void>;
  readonly dispose: () => Promise<void>;
  /** Available reads expose only the selected provider's hash implementation,
   * so replay verification does not select a different runtime's factory. */
  readonly createHash?: Sha256Factory;
}

function emptyRead(result: ByteReadResult): OwnedPublishedFileRead {
  const settled = Promise.resolve();
  return Object.freeze({ result, settled, dispose: () => settled });
}

/** The caller authorizes the business occurrence. This is the mature primary
 * hold/pointer read through a neutral SQL/profile seam, with the original read
 * deadline and conservative durable hold. No upload destination is consulted. */
export async function readPublishedFileOwned(
  capabilities: Readonly<{ database: FileAuthoritySqlDatabase; openProfile: AuthorityProfileOpener;
    /** Trusted owned cleanup only. The core supplies its freshly allocated hold
     * and release timestamp; the callback cannot acquire a hold or select bytes.
     * Existing CF callers retain their original same-database release. */
    releaseHold?: (holdId: string, releasedAt: string) => Promise<FileAuthoritySqlResult> }>,
  input: { fileId: string | null; purpose: FilePurpose },
): Promise<OwnedPublishedFileRead> {
  if (!input.fileId) return emptyRead({ outcome: "missing" });
  const database = capabilities.database, openProfile = capabilities.openProfile.bind(capabilities);
  const releaseHold = capabilities.releaseHold?.bind(capabilities);
  const fileId = input.fileId, purpose = input.purpose;
  const holdId = crypto.randomUUID(), acquired = Date.now();
  const deadline = acquired + FILE_READ_MAX_LIFETIME_MS;
  const abort = new AbortController();
  const requestTimer = setTimeout(() => abort.abort(), FILE_READ_MAX_LIFETIME_MS);
  (requestTimer as unknown as { unref?: () => void }).unref?.();
  let acquiredHold = false;
  let profile: OpenedStorageProfile<string> | undefined;
  let profileDispose: (() => Promise<void>) | undefined;
  const lifetime = ownedProviderLifetime(Object.freeze({ database, holdId }), abort.signal);
  let cleanup: Promise<void> | undefined;
  let originalRelease: Promise<FileAuthoritySqlResult> | undefined;
  let releaseCompletion: Promise<void> | undefined;

  function release(validationCause?: unknown): Promise<void> {
    if (releaseCompletion) return releaseCompletion;
    clearTimeout(requestTimer);
    if (!acquiredHold) { releaseCompletion = Promise.resolve(); return releaseCompletion; }
    // Capture the one actual UPDATE promise before returning. A committed SQL
    // write can lose its ACK: no fallback branch may dispatch another release.
    try {
      originalRelease = releaseHold ? releaseHold(holdId, new Date().toISOString())
        : database.primary().prepare("UPDATE file_location_holds SET released_at=? WHERE id=? AND released_at IS NULL")
          .bind(new Date().toISOString(), holdId).run();
    } catch (error) { originalRelease = Promise.reject(error); }
    releaseCompletion = originalRelease.then(() => undefined, cleanupCause => {
      throw new StorageProfileCleanupError(validationCause, cleanupCause, {
        owner: Object.freeze({ database, holdId, profile, lifetime, originalRelease }), dispose: () => release(),
      });
    });
    releaseCompletion.then(() => undefined, () => undefined);
    return releaseCompletion;
  }
  function closeProvider(validationCause?: unknown): Promise<void> {
    if (cleanup) return cleanup;
    cleanup = (async () => {
      const causes: unknown[] = [];
      try { await lifetime.dispose(); } catch (error) { causes.push(error); }
      if (profileDispose) {
        try { await profileDispose(); } catch (error) { causes.push(error); }
      }
      if (causes.length) {
        throw new StorageProfileCleanupError(validationCause,
          new AggregateError(causes, "Published File provider cleanup is incomplete"), {
            owner: Object.freeze({ database, holdId, profile, lifetime }), dispose: closeProvider,
          });
      }
    })();
    cleanup.then(() => undefined, () => undefined);
    return cleanup;
  }

  try {
    // Capture the active pointer and acquire its exact location hold in one
    // primary command. Existing native guards arbitrate a GC deletion claim.
    await database.primary().prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at,expires_at)
      SELECT ?,f.active_location_id,'read',?,'Published File read',?,? FROM file_usable_publications f
      JOIN file_authority_control a ON a.singleton=1 AND a.mode='active'
      WHERE f.file_id=? AND f.purpose=? AND f.access_scope='system'`)
      .bind(holdId, holdId, new Date(acquired).toISOString(), new Date(acquired + FILE_READ_HOLD_MS).toISOString(), fileId, purpose).run();
    acquiredHold = true;
    const row = await database.primary().prepare(`
      SELECT l.storage_profile_id, l.object_key, p.configuration_revision
      FROM file_location_holds h
      JOIN file_location_publications l ON l.location_id=h.location_id
      JOIN storage_profiles p ON p.id=l.storage_profile_id
      WHERE h.id=? AND h.released_at IS NULL AND julianday(h.expires_at)>julianday('now')
    `).bind(holdId).first();
    if (!row) { await closeProvider(); await release(); return emptyRead({ outcome: "missing" }); }
    const profileId = row.storage_profile_id, objectKey = row.object_key;
    if (typeof profileId !== "string" || !profileId || profileId.length > 256 || profileId.includes("\0")
      || typeof objectKey !== "string" || !objectKey || objectKey.length > 4096 || objectKey.includes("\0")) throw new Error();
    const configurationRevision = configurationSqlInteger(row.configuration_revision, "publishedFile.configurationRevision");
    if (configurationRevision !== 1) throw new Error();
    profile = await openProfile(Object.freeze({ profileId, configurationRevision }), "read", {
      signal: abort.signal, beforeRequest: async () => !abort.signal.aborted && Date.now() < deadline,
    });
    const disposeMethod = profile.dispose;
    if (typeof disposeMethod === "function") profileDispose = disposeMethod.bind(profile);
    const selected = profile;
    const createHash = selected.createHash.bind(selected);
    const read = await lifetime.run(() => selected.reader.read(objectKey));
    if (read.outcome !== "available") {
      await closeProvider(); await release(); return emptyRead(read);
    }
    // Register the selected raw stream before getReader can fail. Lifetime
    // retains its one actual cancellation, including a locked-stream failure.
    const body = lifetime.ownBody(read.body);
    if (Date.now() >= deadline || abort.signal.aborted) {
      await closeProvider(); await release(); return emptyRead({ outcome: "unavailable" });
    }
    const reader = body.getReader();
    let ended = false;
    let completion: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const reads = new Set<ReturnType<typeof reader.read>>();
    let resolveSettled!: () => void, rejectSettled!: (error: unknown) => void;
    const settled = new Promise<void>((resolve, reject) => { resolveSettled = resolve; rejectSettled = reject; });
    settled.then(() => undefined, () => undefined);

    function finish(cancel: boolean, reason?: unknown): Promise<void> {
      if (completion) return completion;
      ended = true;
      clearTimeout(timer); clearTimeout(requestTimer);
      const originals = [...reads];
      // Capture this original cancellation immediately; never await a pull or
      // this finish bookkeeping promise from itself.
      const cancellation = cancel ? lifetime.cleanup(reader, () => reader.cancel(reason)) : undefined;
      completion = (async () => {
        if (cancellation) await Promise.allSettled([cancellation]);
        await Promise.allSettled(originals);
        try { reader.releaseLock(); } catch (error) { lifetime.cleanupFailed(reader, error); }
        await closeProvider(reason);
        // Failed native/provider release leaves the durable hold conservative.
        // A release ACK failure is retained, never converted to successful EOF.
        try { await release(reason); }
        catch (error) {
          if (error instanceof StorageProfileCleanupError) throw error;
          throw new StorageProfileCleanupError(reason, error, {
            owner: Object.freeze({ database, holdId, profile, lifetime, reader }), dispose: () => finish(true),
          });
        }
      })();
      completion.then(resolveSettled, rejectSettled);
      return completion;
    }
    const held = new ReadableStream<Uint8Array>({
      start(output) {
        controller = output;
        timer = setTimeout(() => {
          if (!ended) {
            const error = new FileAuthorityUnavailableError();
            controller?.error(error);
            finish(true, error);
          }
        }, Math.max(0, deadline - Date.now()));
      },
      async pull(output) {
        if (ended) return;
        const original = reader.read();
        reads.add(original);
        original.then(() => reads.delete(original), error => { reads.delete(original); lifetime.operationFailed(error); });
        try {
          const next = await original;
          if (ended) return;
          if (Date.now() >= deadline) {
            const error = new FileAuthorityUnavailableError();
            output.error(error); await finish(true, error); return;
          }
          if (next.done) { await finish(false); output.close(); }
          else output.enqueue(next.value);
        } catch (error) {
          output.error(error);
          await finish(true, error);
        }
      },
      cancel(reason) { return finish(true, reason); },
    }, { highWaterMark: 0 });
    return Object.freeze({ result: { ...read, body: held }, settled, dispose: () => finish(true), createHash });
  } catch (error) {
    clearTimeout(requestTimer);
    // A rejected opener already owns its one uncertain cleanup. No extra
    // provider close or durable hold release may conceal that quarantine.
    if (error instanceof StorageProfileCleanupError) throw error;
    lifetime.operationFailed(error);
    await closeProvider(error);
    try { await release(error); }
    catch (cleanupCause) {
      if (cleanupCause instanceof StorageProfileCleanupError) throw cleanupCause;
      throw new StorageProfileCleanupError(error, cleanupCause, {
        owner: Object.freeze({ database, holdId, profile, lifetime }), dispose: closeProvider,
      });
    }
    return emptyRead({ outcome: "unavailable" });
  }
}
