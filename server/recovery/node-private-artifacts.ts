import { createHash } from "node:crypto";
import { stableJson } from "../../shared/domain/content-addressing.ts";
import { validateByteExpectation, type ByteExpectation } from "../../worker/files/byte-verification.ts";
import { StorageProfileCleanupError, type FileByteOperation } from "../../worker/files/storage-profile-opening.ts";
import type { RecoveryJob } from "../../worker/recovery/sql-repository.ts";
import { openLocalByteStorage, type LocalByteBinding, type LocalByteNamespace, type LocalByteStorage } from "../storage/local-byte-storage.ts";

export type NodePrivateRecoveryArtifactAccess = "put" | "read" | "delete";
export type NodePrivateRecoveryArtifactMutation = Readonly<{ method: "PUT" | "DELETE"; key: string }>;
export interface NodePrivateRecoveryArtifactIdentity {
  readonly kind: "node-private-system-recovery-artifacts/1";
  readonly installationId: string;
  readonly rootBindingId: string;
  readonly namespace: Readonly<LocalByteNamespace>;
  readonly sha256: string;
}
export interface NodePrivateRecoveryArtifactOptions {
  readonly binding: LocalByteBinding;
  /** Original config/installation/Native/core/lease and current caller owner. */
  assertCurrent(): void;
  /** Host rechecks current claim or eligible explicit cleanup before mutation. */
  beforeMutation(operation: NodePrivateRecoveryArtifactMutation): Promise<boolean>;
  /** Host validates the exact durable attempt, job namespace and current actor.
   * Delete access additionally requires the host's explicit cleanup eligibility. */
  expectation(key: string, access: NodePrivateRecoveryArtifactAccess): Promise<ByteExpectation>;
  /** Conservative issued evidence, before native mutation; not a commit ACK. */
  markIssued(key: string, method: "PUT" | "DELETE"): void;
  /** Retain the actual failed cleanup owner; never discharge it by retry. */
  quarantine(error: unknown): void;
}
export interface NodePrivateRecoveryArtifacts {
  readonly identity: Readonly<NodePrivateRecoveryArtifactIdentity>;
  checkpoint(): Readonly<{ artifactNamespace: Readonly<NodePrivateRecoveryArtifactIdentity> }>;
  assertJob(job: Pick<RecoveryJob, "checkpoint_json">): void;
  put(key: string, body: ReadableStream<Uint8Array>, byteSize: number): Promise<void>;
  read(key: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
  close(): Promise<void>;
}
export class NodePrivateRecoveryArtifactError extends Error {
  constructor(readonly reason: "artifact_namespace_changed" | "artifact_namespace_unavailable" | "archive_invalid" | "source_unavailable",
    options?: ErrorOptions) {
    super(reason, options); this.name = "NodePrivateRecoveryArtifactError";
  }
}
interface MutationOwner {
  readonly operation: NodePrivateRecoveryArtifactMutation;
  readonly expected: Readonly<ByteExpectation>;
  issued: boolean;
}
interface StreamOwner { stop(reason: unknown): Promise<void> }
const failedArtifactOwners = new Set<object>();
function failure(reason: NodePrivateRecoveryArtifactError["reason"]): never { throw new NodePrivateRecoveryArtifactError(reason); }
function privateKey(key: string): void {
  if (typeof key !== "string" || !/^fp5-system\/[A-Za-z0-9-]{1,128}\/[A-Za-z0-9-]{1,128}$/.test(key)) failure("artifact_namespace_changed");
}
function sameExpectation(left: ByteExpectation, right: ByteExpectation): boolean {
  return left.byteSize === right.byteSize && left.sha256 === right.sha256;
}
function cleanupFailure(errors: readonly unknown[], message: string): unknown {
  const distinct = [...new Set(errors)]; return distinct.length === 1 ? distinct[0] : new AggregateError(distinct, message);
}
function synchronous(work: () => void): void {
  const result: unknown = work();
  if (result !== undefined) {
    if (result instanceof Promise) void result.catch(() => undefined);
    failure("artifact_namespace_unavailable");
  }
}

/** Recovery-only concrete transport. The actual host owns installation/actor/
 * claim/cleanup admission and the durable attempt ledger. No storage profile,
 * role, File, executor, binding or restored grant is created here.
 *
 * The operator must already provision an absolute private root, private
 * objects/ and staging/ directories, and namespace.json containing exactly
 * {format:"local-byte-namespace-v1", namespace:{volumeId:installationId,
 * rootId:rootBindingId,profileId:"system-recovery-private",namespaceRevision:1}}.
 * Failed stages are retained by the primitive; there is no directory sweep.
 */
export async function openNodePrivateRecoveryArtifacts(options: NodePrivateRecoveryArtifactOptions): Promise<NodePrivateRecoveryArtifacts> {
  const input = options.binding;
  if (!input || !input.namespace || input.namespace.profileId !== "system-recovery-private"
    || input.namespace.namespaceRevision !== 1 || typeof options.assertCurrent !== "function"
    || typeof options.beforeMutation !== "function" || typeof options.expectation !== "function"
    || typeof options.markIssued !== "function" || typeof options.quarantine !== "function") failure("artifact_namespace_unavailable");
  const caller = Object.freeze({ assertCurrent: options.assertCurrent.bind(options), beforeMutation: options.beforeMutation.bind(options),
    expectation: options.expectation.bind(options), markIssued: options.markIssued.bind(options), quarantine: options.quarantine.bind(options) });
  const namespace = Object.freeze({ volumeId: input.namespace.volumeId, rootId: input.namespace.rootId,
    profileId: "system-recovery-private", namespaceRevision: 1 });
  const binding = Object.freeze({ root: input.root, namespace });
  const descriptor = Object.freeze({ kind: "node-private-system-recovery-artifacts/1" as const,
    installationId: namespace.volumeId, rootBindingId: namespace.rootId, namespace });
  // The path is covered by the binding hash, never exposed in the checkpoint.
  const identity = Object.freeze({ ...descriptor,
    sha256: createHash("sha256").update(stableJson({ ...descriptor, root: binding.root })).digest("hex") });
  const checkpoint = Object.freeze({ artifactNamespace: identity });
  const pending = new Set<Promise<unknown>>(), streams = new Set<StreamOwner>(), mutations = new Map<string, MutationOwner>();
  const cleanupErrors = new Set<unknown>();
  let storage: LocalByteStorage | undefined, closed = false, closing: Promise<void> | undefined;
  const owner = { binding, identity, pending, streams, mutations, cleanupErrors, close: () => close() };
  function retain(error: unknown): void {
    cleanupErrors.add(error); failedArtifactOwners.add(owner);
    try { synchronous(() => caller.quarantine(error)); }
    catch (callbackError) { cleanupErrors.add(callbackError); }
  }
  function current(): void {
    if (closed || cleanupErrors.size) failure("artifact_namespace_unavailable");
    synchronous(() => caller.assertCurrent());
  }
  async function expected(key: string, access: NodePrivateRecoveryArtifactAccess): Promise<Readonly<ByteExpectation>> {
    privateKey(key); current();
    const value = await caller.expectation(key, access); current();
    validateByteExpectation(value, access === "put" ? "source" : "destination");
    return Object.freeze({ byteSize: value.byteSize, sha256: value.sha256 });
  }
  function mutation(operation: FileByteOperation): MutationOwner {
    current(); privateKey(operation.key);
    const selected = mutations.get(operation.key);
    if (!selected || selected.operation.method !== operation.method) failure("artifact_namespace_unavailable");
    return selected;
  }
  try {
    current();
    storage = await openLocalByteStorage(binding, {
      async beforeMutation(operation) {
        const selected = mutation(operation), access = selected.operation.method === "PUT" ? "put" : "delete";
        const fresh = await expected(operation.key, access);
        if (!sameExpectation(selected.expected, fresh)) failure("archive_invalid");
        if (await caller.beforeMutation(selected.operation) !== true) return false;
        current();
        const final = await expected(operation.key, access);
        if (!sameExpectation(selected.expected, final)) failure("archive_invalid");
        return true;
      },
      assertCurrent(operation) {
        const selected = mutation(operation);
        if (!selected.issued) {
          synchronous(() => caller.markIssued(operation.key, selected.operation.method));
          selected.issued = true;
        }
        current();
      },
    });
    current();
  } catch (error) {
    if (error instanceof StorageProfileCleanupError) retain(error);
    if (storage) {
      try { await storage.close(); }
      catch (cleanup) { retain(cleanup); throw cleanupFailure([error, cleanup], "Private recovery artifact opening and first close failed"); }
    }
    throw error;
  }
  if (!storage) failure("artifact_namespace_unavailable");
  const originalStorage = storage;
  function operation<T>(work: () => Promise<T>): Promise<T> {
    try { current(); } catch (error) { return Promise.reject(error); }
    const original = Promise.resolve().then(work); pending.add(original);
    void original.then(() => { pending.delete(original); }, () => { pending.delete(original); });
    return original;
  }
  function ownStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    let ended = false, release: Promise<void> | undefined;
    let output: ReadableStreamDefaultController<Uint8Array>;
    const streamOwner: StreamOwner = { stop(reason) {
      if (!ended) { ended = true; try { output.error(reason); } catch (error) { retain(error); } }
      return finish(true, reason);
    } };
    function finish(cancel: boolean, reason?: unknown): Promise<void> {
      return release ??= Promise.resolve().then(async () => {
        try {
          if (cancel) await reader.cancel(reason);
          reader.releaseLock(); streams.delete(streamOwner);
        } catch (error) { retain(error); throw error; }
      });
    }
    streams.add(streamOwner);
    return new ReadableStream<Uint8Array>({
      start(controller) { output = controller; },
      async pull(controller) {
        let finishing = false;
        try {
          current(); const next = await reader.read();
          if (ended) return;
          current();
          if (next.done) { ended = true; finishing = true; await finish(false); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) {
          if (ended && !finishing) return;
          ended = true;
          try { await finish(true, error); }
          catch (cleanup) { controller.error(cleanupFailure([error, cleanup], "Private recovery artifact read and first close failed")); return; }
          controller.error(error);
        }
      },
      cancel(reason) { ended = true; return finish(true, reason); },
    }, { highWaterMark: 0 });
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      // Cancel already-issued bodies first so a stalled upload cannot deadlock
      // the pending operation drain. An opening read remains in pending until
      // its exact body is registered/cancelled; take a second complete snapshot.
      // Response bodies remain owned after read() returns.
      const issued = await Promise.allSettled([...streams].map(value => value.stop(new NodePrivateRecoveryArtifactError("artifact_namespace_unavailable"))));
      for (const result of issued) if (result.status === "rejected") retain(result.reason);
      await Promise.allSettled([...pending]);
      const results = await Promise.allSettled([...streams].map(value => value.stop(new NodePrivateRecoveryArtifactError("artifact_namespace_unavailable"))));
      for (const result of results) if (result.status === "rejected") retain(result.reason);
      try { await originalStorage.close(); } catch (error) { retain(error); }
      if (cleanupErrors.size) throw cleanupFailure([...cleanupErrors], "Private recovery artifact original ownership could not close");
    })();
    void closing.catch(() => undefined); return closing;
  }
  return Object.freeze({ identity,
    checkpoint: () => { current(); return checkpoint; },
    assertJob(job: Pick<RecoveryJob, "checkpoint_json">) {
      current();
      try {
        const value: unknown = job.checkpoint_json ? JSON.parse(job.checkpoint_json) : null;
        if (!value || typeof value !== "object" || Array.isArray(value)
          || stableJson((value as { artifactNamespace?: unknown }).artifactNamespace) !== stableJson(identity)) failure("artifact_namespace_changed");
      } catch (error) {
        if (error instanceof NodePrivateRecoveryArtifactError) throw error;
        throw new NodePrivateRecoveryArtifactError("artifact_namespace_changed", { cause: error });
      }
    },
    put(key: string, body: ReadableStream<Uint8Array>, byteSize: number) { return operation(async () => {
      const value = await expected(key, "put");
      if (value.byteSize !== byteSize || mutations.has(key)) failure("archive_invalid");
      const selected: MutationOwner = { operation: Object.freeze({ method: "PUT", key }), expected: value, issued: false };
      mutations.set(key, selected);
      try {
        const forwarded = ownStream(body);
        await originalStorage.writer.write({ key, body: forwarded, ...value, contentType: "application/zip", filename: "system-recovery.zip" });
      }
      finally { mutations.delete(key); }
    }); },
    read(key: string) { return operation(async () => {
      await expected(key, "read");
      const result = await originalStorage.reader.read(key);
      if (result.outcome === "missing") { current(); return null; }
      if (result.outcome !== "available") failure("source_unavailable");
      const body = ownStream(result.body as ReadableStream<Uint8Array>);
      // If admission changed while opening, preserve/cancel this exact body.
      try { current(); return body; }
      catch (error) { try { await body.cancel(error); } catch (cleanup) { throw cleanupFailure([error, cleanup], "Private recovery artifact admission and first close failed"); } throw error; }
    }); },
    delete(key: string) { return operation(async () => {
      const value = await expected(key, "delete");
      if (mutations.has(key)) failure("artifact_namespace_unavailable");
      const selected: MutationOwner = { operation: Object.freeze({ method: "DELETE", key }), expected: value, issued: false };
      mutations.set(key, selected);
      try { if ((await originalStorage.deleter.delete(key)).outcome !== "acknowledged") failure("artifact_namespace_unavailable"); }
      finally { mutations.delete(key); }
    }); },
    close,
  });
}
