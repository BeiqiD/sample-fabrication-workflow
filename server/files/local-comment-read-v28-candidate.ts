import { HTTPException } from "hono/http-exception";
import type { ReviewedInstallationAdmission } from "../migrations";
import type { SqliteBatchAdmission } from "../sqlite";
import { ownedLocalVolumeProfileContextV28Candidate, type LocalVolumeProfileOpeningV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate";
import { createLocalCommentPermissionV28Candidate, type LocalCommentReadV28Candidate,
  type LocalCommentReadConsumerV28Candidate, type LocalCommentReadDescriptionV28Candidate,
  type LocalCommentSampleProjectionSnapshotV28Candidate,
  MAX_LOCAL_COMMENT_SAMPLE_ATTACHMENT_PROOFS_V28_CANDIDATE } from "./local-comment-permission-v28-candidate";
export { MAX_LOCAL_COMMENT_SAMPLE_ATTACHMENT_PROOFS_V28_CANDIDATE,
  MAX_LOCAL_COMMENT_SAMPLE_ATTACHMENT_GUARD_BYTES_V28_CANDIDATE } from "./local-comment-permission-v28-candidate";
import { createLocalUploadExecutionV28Candidate } from "./local-upload-execution";
import type { OwnedPublishedFileRead } from "../../worker/files/authority-reader-core";
import { StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";

declare const sampleAttachmentReadPortBrand: unique symbol;
declare const sampleAttachmentProofBrand: unique symbol;
export interface LocalCommentSampleAttachmentReadPortV28Candidate { readonly [sampleAttachmentReadPortBrand]: true }
export interface LocalCommentSampleAttachmentProofV28Candidate { readonly [sampleAttachmentProofBrand]: true }
export type LocalCommentSampleAttachmentProbeV28Candidate = Readonly<{
  description: LocalCommentReadDescriptionV28Candidate; available: boolean; proof: LocalCommentSampleAttachmentProofV28Candidate }>;
export type LocalCommentSampleAttachmentPortBindingV28Candidate = Readonly<
  Pick<ReturnType<typeof ownedLocalVolumeProfileContextV28Candidate>, "database" | "nativeDatabase" | "writerLease">
  & { admission: ReviewedInstallationAdmission; authentication: object }>;
type RegisteredReadFacade = Readonly<{ opening: LocalVolumeProfileOpeningV28Candidate;
  assertBinding(binding: LocalCommentSampleAttachmentPortBindingV28Candidate): void;
  probe(request: Request, itemId: string): Promise<LocalCommentSampleAttachmentProbeV28Candidate>;
  finalAdmission(request: Request, proofs: readonly LocalCommentSampleAttachmentProofV28Candidate[]): SqliteBatchAdmission }>;
const readFacades = new WeakMap<object, RegisteredReadFacade>();
const sampleAttachmentPorts = new WeakMap<LocalCommentSampleAttachmentReadPortV28Candidate, RegisteredReadFacade>();

/** Composer-only provenance, not a structural method bag or grant callback.
 * The exact actual factory/opening is required; caller-provided reads cannot
 * fabricate availability, a provider, or permission for another Sample. */
export function createLocalCommentSampleAttachmentReadPortV28Candidate(readFacade: object,
  opening: LocalVolumeProfileOpeningV28Candidate): LocalCommentSampleAttachmentReadPortV28Candidate {
  const owner = readFacades.get(readFacade);
  if (!owner || owner.opening !== opening) throw new HTTPException(403, { message: "Original canonical Comment read owner is required." });
  const port = Object.freeze({}) as LocalCommentSampleAttachmentReadPortV28Candidate;
  sampleAttachmentPorts.set(port, owner); return port;
}
/** The Sample projection constructor and each original native batch recheck
 * use this void assertion. No native/provider/owner or grant is returned. */
export function assertLocalCommentSampleAttachmentReadPortV28Candidate(port: LocalCommentSampleAttachmentReadPortV28Candidate,
  binding: LocalCommentSampleAttachmentPortBindingV28Candidate): void {
  const owner = sampleAttachmentPorts.get(port);
  if (!owner || !binding || Object.keys(binding).sort().join(",") !== "admission,authentication,database,nativeDatabase,writerLease")
    throw new HTTPException(403, { message: "Original canonical attachment projection binding is required." });
  owner.assertBinding(binding);
}

/** One fixed consumer only: the same original Sample GET and an actual
 * canonical attachment item. The private factory owns the original read body,
 * first disposal and source execution ACK; no provider/body/SQL escapes here. */
export function probeLocalCommentSampleAttachmentV28Candidate(request: Request,
  port: LocalCommentSampleAttachmentReadPortV28Candidate, selector: Readonly<{ itemId: string }>) {
  const owner = sampleAttachmentPorts.get(port);
  if (!owner || !(request instanceof Request) || request.method !== "GET" || !selector
    || Object.keys(selector).join(",") !== "itemId" || typeof selector.itemId !== "string")
    throw new HTTPException(403, { message: "Original canonical attachment consumer is required." });
  const url = new URL(request.url), itemId = selector.itemId;
  if (!/^\/api\/samples\/[^/]+$/.test(url.pathname) || [...url.searchParams.keys()].length)
    throw new HTTPException(403, { message: "The original Sample attachment consumer is required." });
  return owner.probe(request, itemId);
}

/** Exactly one genuine opaque File guard, composed with the Sample owner's
 * original five guards in one native BEGIN. The caller receives no checks/SQL,
 * provider/native/row or authorization callback, and cannot serialize a proof. */
export function createLocalCommentSampleAttachmentFinalAdmissionV28Candidate(request: Request,
  port: LocalCommentSampleAttachmentReadPortV28Candidate, proofs: readonly LocalCommentSampleAttachmentProofV28Candidate[]): SqliteBatchAdmission {
  const owner = sampleAttachmentPorts.get(port);
  if (!owner || !(request instanceof Request) || request.method !== "GET" || !Array.isArray(proofs) || !proofs.length)
    throw new HTTPException(403, { message: "Original canonical attachment proofs are required." });
  if (proofs.length > MAX_LOCAL_COMMENT_SAMPLE_ATTACHMENT_PROOFS_V28_CANDIDATE)
    throw new HTTPException(413, { message: "Canonical attachment projection exceeds the supported bound." });
  if (Object.getOwnPropertyNames(proofs).length !== proofs.length + 1 || Object.getOwnPropertySymbols(proofs).length)
    throw new HTTPException(403, { message: "An exact canonical attachment proof array is required." });
  const selected: LocalCommentSampleAttachmentProofV28Candidate[] = [];
  for (let index = 0; index < proofs.length; index++) {
    const field = Object.getOwnPropertyDescriptor(proofs, String(index));
    if (!field || !("value" in field))
      throw new HTTPException(403, { message: "An exact canonical attachment proof array is required." });
    selected.push(field.value);
  }
  const url = new URL(request.url);
  if (!/^\/api\/samples\/[^/]+$/.test(url.pathname) || [...url.searchParams.keys()].length)
    throw new HTTPException(403, { message: "The original Sample attachment consumer is required." });
  return owner.finalAdmission(request, Object.freeze(selected));
}

/** Only the exact actual attachment download/export Request can select this
 * typed published File and purpose. The complete original read owns the body,
 * provider, location hold and cleanup. Its parent waits that first ACK before
 * settling the same original execution/native/physical lease. */
export function createLocalCommentReadV28Candidate(options: {
  opening: LocalVolumeProfileOpeningV28Candidate; authentication: object; admission: ReviewedInstallationAdmission;
}) {
  const { opening, authentication, admission } = options;
  const permissions = createLocalCommentPermissionV28Candidate(options);
  const physical = ownedLocalVolumeProfileContextV28Candidate(opening);
  const consumed = new WeakSet<LocalCommentReadV28Candidate>();
  const captures = new Set<Promise<LocalCommentReadV28Candidate>>();
  const descriptions = new Set<Promise<LocalCommentReadDescriptionV28Candidate>>();
  const scopes = new Set<ReturnType<typeof createLocalUploadExecutionV28Candidate>>();
  const delivered = new Set<Promise<OwnedPublishedFileRead>>(), reads = new Set<OwnedPublishedFileRead>();
  const deliveredScopes = new WeakMap<OwnedPublishedFileRead, ReturnType<typeof createLocalUploadExecutionV28Candidate>>();
  const probes = new Set<Promise<LocalCommentSampleAttachmentProbeV28Candidate>>();
  const proofs = new WeakMap<LocalCommentSampleAttachmentProofV28Candidate,
    Readonly<{ request: Request; snapshot: LocalCommentSampleProjectionSnapshotV28Candidate; available: boolean }>>();
  let closed = false, closing: Promise<void> | undefined;
  const service = Object.freeze({
    capture(request: Request) {
      if (closed) return Promise.reject(new HTTPException(403, { message: "The original Comment read owner has closed." }));
      const original = physical.writerLease.withWriter(() => permissions.captureCommentRead(request));
      captures.add(original); original.then(() => captures.delete(original), () => captures.delete(original)); return original;
    },
    captureConsumer(request: Request, consumer: LocalCommentReadConsumerV28Candidate) {
      if (closed) return Promise.reject(new HTTPException(403, { message: "The original Comment read owner has closed." }));
      const frozen = Object.freeze({ ...consumer });
      const original = physical.writerLease.withWriter(() => permissions.captureConsumerRead(request, frozen));
      captures.add(original); original.then(() => captures.delete(original), () => captures.delete(original)); return original;
    },
    describe(request: Request, token: LocalCommentReadV28Candidate) {
      if (closed) return Promise.reject(new HTTPException(403, { message: "The original Comment read owner has closed." }));
      const original = physical.writerLease.withWriter(() => permissions.describeRead(request, token));
      descriptions.add(original); original.then(() => descriptions.delete(original), () => descriptions.delete(original)); return original;
    },
    read(request: Request, token: LocalCommentReadV28Candidate): Promise<OwnedPublishedFileRead> {
      if (closed || consumed.has(token)) throw new HTTPException(403, { message: "The original Comment read was already consumed." });
      const selection = permissions.readSelection(request, token), permission = permissions.readExecutionPermission(request, token);
      const actor = permissions.actor(request, permission); consumed.add(token);
      const scope = createLocalUploadExecutionV28Candidate({ opening, authentication, admission, request, actor, permission });
      scopes.add(scope);
      let resolve!: (read: OwnedPublishedFileRead) => void, reject!: (error: unknown) => void;
      const result = new Promise<OwnedPublishedFileRead>((yes, no) => { resolve = yes; reject = no; });
      delivered.add(result);
      result.then(() => delivered.delete(result), () => delivered.delete(result));
      const original = scope.run(async execution => {
        const read = await execution.openRead({ fileId: selection.fileId, purpose: selection.purpose });
        deliveredScopes.set(read, scope); reads.add(read); resolve(read);
        if (closed) await read.dispose();
        await read.settled; reads.delete(read);
      });
      original.then(() => undefined, reject);
      scope.settled.then(() => scopes.delete(scope), error => {
        if (!(error instanceof StorageProfileCleanupError)) scopes.delete(scope);
      });
      return result;
    },
    close() {
      if (closing) return closing; closed = true;
      closing = (async () => {
        const probeOutcomes = await Promise.allSettled([...probes]);
        await Promise.allSettled([...captures]);
        await Promise.allSettled([...descriptions]);
        // Every original opening must return or reject before selecting its
        // cached body disposer. Late delivery observes closed and closes itself.
        await Promise.allSettled([...delivered]);
        const bodies = await Promise.allSettled([...reads].map(read => read.dispose()));
        const originals = await Promise.allSettled([...scopes].map(scope => scope.dispose()));
        const failures = [...bodies, ...originals].flatMap(result => result.status === "rejected" ? [result.reason] : []);
        // Ordinary denied projections settle without owned transport. Typed
        // failed original cleanup remains a real parent/native barrier.
        for (const result of probeOutcomes) if (result.status === "rejected" && result.reason instanceof StorageProfileCleanupError)
          failures.push(result.reason);
        if (failures.length) throw new AggregateError(failures, "Original Comment read cleanup remains unresolved");
        permissions.discard();
      })();
      closing.then(() => undefined, () => undefined); return closing;
    },
  });
  readFacades.set(service, Object.freeze({ opening,
    assertBinding(binding: LocalCommentSampleAttachmentPortBindingV28Candidate): void {
      if (closed || binding.database !== physical.database || binding.nativeDatabase !== physical.nativeDatabase
        || binding.writerLease !== physical.writerLease || binding.admission !== admission || binding.authentication !== authentication)
        throw new HTTPException(403, { message: "Original canonical attachment projection binding changed." });
      physical.assertCurrent();
    },
    finalAdmission(request: Request, selected: readonly LocalCommentSampleAttachmentProofV28Candidate[]): SqliteBatchAdmission {
      if (closed || !selected.length || new Set(selected).size !== selected.length)
        throw new HTTPException(403, { message: "Original unique canonical attachment proofs are required." });
      physical.assertCurrent();
      const snapshots = selected.map(proof => {
        const record = proofs.get(proof);
        if (!record || record.request !== request || !record.available)
          throw new HTTPException(403, { message: "Original available canonical attachment proofs are required." });
        return record.snapshot;
      });
      return permissions.sampleProjectionFinalAdmission(request, snapshots);
    },
    probe(request: Request, itemId: string): Promise<LocalCommentSampleAttachmentProbeV28Candidate> {
      if (closed) return Promise.reject(new HTTPException(403, { message: "The original Comment read owner has closed." }));
      // This whole genuine original continuation is counted by the actual
      // installed physical writer lease, including gaps between owned reads.
      const original = physical.writerLease.withWriter(async () => {
        let read: OwnedPublishedFileRead | undefined, failed = false, workError: unknown;
        let token: LocalCommentReadV28Candidate | undefined, available = false;
        let snapshot: LocalCommentSampleProjectionSnapshotV28Candidate | undefined;
        try {
          token = await service.captureConsumer(request, Object.freeze({ kind: "canonical-comment-attachment", itemId }));
          // Capture the actual publication/profile-role tuple before byte I/O;
          // an earlier read cannot be relabelled with a later valid tuple.
          snapshot = (await permissions.captureSampleProjectionSnapshot(request, token)).snapshot;
          read = await service.read(request, token);
          available = read.result.outcome === "available";
        } catch (error) { failed = true; workError = error; }
        if (read) {
          // Save and await the original cached body and execution outcomes,
          // never select a second cancel, provider or source release attempt.
          let cleanupFailed = false, cleanupError: unknown;
          try {
            await read.dispose(); await read.settled;
            const source = deliveredScopes.get(read);
            if (!source) throw new Error("Original delivered Comment read execution is unavailable");
            await source.settled;
          } catch (error) { cleanupFailed = true; cleanupError = error; }
          if (cleanupFailed) {
            if (!failed && cleanupError instanceof StorageProfileCleanupError) throw cleanupError;
            const ordered = failed ? new AggregateError([workError, cleanupError], "Original canonical attachment projection and cleanup failed") : undefined;
            let retained!: Promise<void>;
            const failure = new StorageProfileCleanupError(ordered, cleanupError, {
              owner: Object.freeze({ request, opening, read, token, workError, cleanupError }), dispose: () => retained,
            });
            retained = Promise.reject(failure); retained.then(() => undefined, () => undefined); throw failure;
          }
        }
        if (failed) throw workError;
        // The actual same-token native permission and typed File checks run
        // again after original body/provider/hold/source ACK. Metadata is not a
        // hash verification claim and this port creates no image byte URL.
        const description = await permissions.confirmSampleProjectionSnapshot(request, snapshot!);
        const proof = Object.freeze({}) as LocalCommentSampleAttachmentProofV28Candidate;
        proofs.set(proof, Object.freeze({ request, snapshot: snapshot!, available }));
        return Object.freeze({ description, available, proof });
      });
      probes.add(original);
      original.then(() => probes.delete(original), error => {
        if (!(error instanceof StorageProfileCleanupError)) probes.delete(original);
      });
      return original;
    },
  }));
  return service;
}
