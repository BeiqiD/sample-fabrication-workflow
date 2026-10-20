import type { DatabaseSync } from "node:sqlite";
import { FileJobExecutionDrainError, requiresFileJobExecutionQuarantine } from "../../../worker/files/jobs/execution-lifetime";
import { assertLinuxWriterLeaseBinding } from "../../operations/writer-lease";
import { shutdownQuiescedSqliteDatabase, type SqliteCheckpointReceipt } from "../../sqlite-backup";
import { createInstalledNodeFileJobDispatcher, type NodeFileJobDispatchResult } from "./dispatcher";
import { ownedJobPrincipalAuthority } from "./principal-authority";

export interface NodeFileJobHostCloseReceipt {
  readonly checkpoint: Readonly<SqliteCheckpointReceipt>;
  readonly nativeClosed: true;
  readonly writerLeaseReleased: true;
}
export interface InstalledNodeFileJobHost {
  dispatchOnce(): Promise<NodeFileJobDispatchResult>;
  /** Refuse ingress synchronously; acknowledge only real drain/native/FD close. */
  stopAdmissionAndClose(): Promise<NodeFileJobHostCloseReceipt>;
}
export class NodeFileJobHostDrainError extends FileJobExecutionDrainError {
  constructor(errors: readonly unknown[], owners: readonly unknown[]) {
    super(errors, owners); this.name = "NodeFileJobHostDrainError";
  }
}
interface HostState {
  phase: "open" | "closing" | "closed" | "quarantined";
  readonly owners: readonly unknown[];
  failure?: NodeFileJobHostDrainError;
  writerDrain?: Promise<void>;
}
// An abandoned caller/object is not permission to drop a native/provider/FD
// owner. Only the fully successful ordered close removes this installation.
const retainedHosts = new Set<HostState>();
const installedHosts = new WeakMap<DatabaseSync, HostState>();

/** Explicit private V25 Job host composition. All installed writers sharing
 * this physical lease must enter its original withWriter boundary. This host
 * mounts no application HTTP ingress and enables no executor/File/provider.
 * A future application composer must close its own ingress before this seam
 * and honor its rejection before any native close or physical release. */
export function createInstalledNodeFileJobHost(
  options: Parameters<typeof createInstalledNodeFileJobDispatcher>[0],
): InstalledNodeFileJobHost {
  const { authority, writerLease } = options;
  const owner = ownedJobPrincipalAuthority(authority);
  assertLinuxWriterLeaseBinding(writerLease, owner.database, owner.nativeDatabase);
  const previous = installedHosts.get(owner.nativeDatabase);
  if (previous && previous.phase !== "closed") throw new Error("Node File job host installation already owned");
  // Do not accept a caller-shaped dispatcher or close callback as evidence.
  const dispatcher = createInstalledNodeFileJobDispatcher(options);
  const state: HostState = { phase: "open", owners: Object.freeze([
    dispatcher, authority, writerLease, owner.database, owner.nativeDatabase, owner,
  ]) };
  let closing: Promise<NodeFileJobHostCloseReceipt> | undefined;
  const stopWriters = () => {
    if (!state.writerDrain) {
      state.writerDrain = writerLease.stopAdmissionAndDrain();
      void state.writerDrain.catch(() => undefined);
    }
    return state.writerDrain;
  };
  const quarantine = (error: unknown) => {
    if (!state.failure) state.failure = new NodeFileJobHostDrainError([error], state.owners);
    state.phase = "quarantined";
    stopWriters(); // Stop physical writer admission; retain its original drain.
    return state.failure;
  };
  const host: InstalledNodeFileJobHost = Object.freeze({
    dispatchOnce() {
      if (state.phase !== "open") return Promise.reject(state.failure ?? new Error("Node File job host is closed"));
      return dispatcher.dispatchOnce().catch(error => {
        if (requiresFileJobExecutionQuarantine(error)) throw quarantine(error);
        throw error;
      });
    },
    stopAdmissionAndClose() {
      if (closing) return closing;
      state.phase = "closing"; // Refuse host ingress before the first await.
      const originalDispatcherDrain = dispatcher.stopAdmissionAndDrain();
      const originalWriterDrain = stopWriters();
      closing = (async (): Promise<NodeFileJobHostCloseReceipt> => {
        // Both exact original drains must settle. A status, abort, retained
        // reference, or bounded response cannot replace provider settlement.
        const outcomes = await Promise.allSettled([originalDispatcherDrain, originalWriterDrain]);
        const failures = outcomes.flatMap(value => value.status === "rejected" ? [value.reason as unknown] : []);
        if (failures.length) throw new AggregateError(failures, "Node File job host original drain failed");
        owner.assertCurrent();
        assertLinuxWriterLeaseBinding(writerLease, owner.database, owner.nativeDatabase);
        // The mature quiesced checkpoint owns the real native close. Busy or
        // uncertain native close leaves the physical lock retained; no finally
        // block guesses that it is now safe to release or retries disposal.
        const checkpoint = shutdownQuiescedSqliteDatabase(owner.nativeDatabase);
        if (owner.nativeDatabase.isOpen) throw new Error("Node File job host native close is unproven");
        owner.database.close(); // Retire the same core after actual native close.
        authority.close();
        await writerLease.release(); // Genuine API independently refuses open bound owners.
        state.phase = "closed";
        retainedHosts.delete(state);
        return Object.freeze({ checkpoint: Object.freeze({ ...checkpoint }), nativeClosed: true, writerLeaseReleased: true });
      })().catch(error => { throw quarantine(error); });
      void closing.catch(() => undefined);
      return closing;
    },
  });
  retainedHosts.add(state);
  installedHosts.set(owner.nativeDatabase, state);
  return host;
}
