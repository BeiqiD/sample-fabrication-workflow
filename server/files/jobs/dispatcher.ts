import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { closeFileJobExecutions, FileJobExecutionDrainError } from "../../../worker/files/jobs/execution-lifetime";
import { runFileJobCleanupStep, runFileJobStep } from "../../../worker/files/jobs/migration-kernel";
import type { FileJobCapabilities } from "../../../worker/files/jobs/types";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../../operations/writer-lease";
import { ownedJobPrincipalAuthority, type InstalledJobPrincipalAuthority } from "./principal-authority";
import { createOwnedNodeFileJobPort } from "./repository";

export interface NodeFileJobDispatchResult { jobId: string | null; outcome: string }
export interface InstalledNodeFileJobDispatcher {
  /** One explicit durable action; no cadence, enablement or startup replay. */
  dispatchOnce(): Promise<NodeFileJobDispatchResult>;
  /** Synchronously refuse new invocations, then await original owned work. */
  stopAdmissionAndDrain(): Promise<void>;
}
export class NodeFileJobDispatcherDrainError extends FileJobExecutionDrainError {
  constructor(errors: readonly unknown[], owners: readonly unknown[]) {
    super(errors, owners); this.name = "NodeFileJobDispatcherDrainError";
  }
}
type Phase = "open" | "stopping" | "closed" | "quarantined";
interface Invocation {
  readonly capabilities: FileJobCapabilities;
  settlement: Promise<NodeFileJobDispatchResult>;
}
interface InstalledOwnerState {
  phase: Phase;
  readonly owners: readonly unknown[];
  readonly invocations: Set<Invocation>;
  failure?: NodeFileJobDispatcherDrainError;
}
const installedOwners = new WeakMap<DatabaseSync, InstalledOwnerState>();
// Installation lifetime is independent of a caller retaining its dispatcher
// or promise. Failed close keeps these exact owners until explicit host repair.
const retainedInstallations = new Set<InstalledOwnerState>();
const unavailableStorage: FileJobCapabilities["openStorage"] = async () => {
  throw new Error("Node File job storage is not composed");
};

/** Private installed V25 background host. The same actual native connection,
 * factory-issued authority and Linux lease own one nonoverlapping dispatcher.
 * Storage is a trusted composition input, not a structural transport grant;
 * absent storage is genuinely unavailable. This does not mount HTTP or enable
 * File/jobs, widen adapter types, implement recurring cadence, or close another
 * host's SQL/physical lease. Future recurring slots retain the mature 120s
 * advertisement; this API never calls the legacy 10s invocation loop. */
export function createInstalledNodeFileJobDispatcher(options: {
  authority: InstalledJobPrincipalAuthority;
  writerLease: LinuxWriterLease;
  incarnation: string;
  openStorage?: FileJobCapabilities["openStorage"];
  now?: () => Date;
  randomId?: () => string;
}): InstalledNodeFileJobDispatcher {
  const { authority, writerLease, incarnation } = options;
  const owner = ownedJobPrincipalAuthority(authority);
  const assertCurrent = () => {
    owner.assertCurrent();
    assertLinuxWriterLeaseBinding(writerLease, owner.database, owner.nativeDatabase);
  };
  assertCurrent();
  const previous = installedOwners.get(owner.nativeDatabase);
  if (previous && previous.phase !== "closed") throw new Error("Node File job dispatcher installation already owned");
  const now = options.now ?? (() => new Date()), randomId = options.randomId ?? randomUUID;
  const port = createOwnedNodeFileJobPort({ authority, incarnation, now, randomId });
  const openStorage = options.openStorage?.bind(options) ?? unavailableStorage;
  const state: InstalledOwnerState = { phase: "open", owners: Object.freeze([
    authority, writerLease, owner.database, owner.nativeDatabase, owner,
  ]), invocations: new Set() };
  let active: Invocation | undefined, draining: Promise<void> | undefined;
  let failure: NodeFileJobDispatcherDrainError | undefined;
  // Keep rejected invocations and their captured provider/native/lease owners
  // strongly retained. No automatic cleanup retry or guessed early release.
  const retainFailure = (error: unknown, invocation?: Invocation) => {
    if (invocation) state.invocations.add(invocation);
    if (!failure) failure = new NodeFileJobDispatcherDrainError([error], [...state.owners, ...state.invocations]);
    state.failure = failure;
    state.phase = "quarantined";
    return failure;
  };

  const dispatcher: InstalledNodeFileJobDispatcher = Object.freeze({
    dispatchOnce(): Promise<NodeFileJobDispatchResult> {
      if (state.phase !== "open") return Promise.reject(failure ?? new Error("Node File job dispatcher is closed"));
      if (active) return Promise.reject(new Error("Node File job dispatcher is busy"));
      try { assertCurrent(); } catch (error) { return Promise.reject(retainFailure(error)); }
      // Each invocation has one exact lifetime-registry identity. A completed
      // registry is sealed; later explicit slots create their own fresh owner.
      const capabilities: FileJobCapabilities = Object.freeze({
        repository: port.repository, incarnation, openStorage, now, randomId,
        authorizeAdministrator: port.authorizeAdministrator,
        authorizeSystemCleanup: port.authorizeSystemCleanup,
      });
      const original = writerLease.withWriter(async () => {
        let originalFailed = false, originalFailure: unknown;
        try {
          assertCurrent();
          const cleanup = await runFileJobCleanupStep(capabilities);
          if (!["idle", "disabled"].includes(cleanup.outcome)) return { jobId: null, outcome: cleanup.outcome };
          return await runFileJobStep(capabilities);
        } catch (error) {
          originalFailed = true; originalFailure = error; throw error;
        } finally {
          // The step's bounded response is not transport settlement. Keep the
          // WHOLE original kernel plus every retained late operation/disposer
          // inside this same genuine withWriter before acknowledgement.
          try { await closeFileJobExecutions(capabilities); assertCurrent(); }
          catch (closeError) {
            if (originalFailed) throw new AggregateError([originalFailure, closeError], "Node File job invocation and close failed");
            throw closeError;
          }
        }
      });
      const invocation: Invocation = { capabilities, settlement: original };
      active = invocation; state.invocations.add(invocation);
      invocation.settlement = original.then(result => {
        if (active === invocation) active = undefined;
        state.invocations.delete(invocation);
        return result;
      }, error => {
        if (active === invocation) active = undefined;
        throw retainFailure(error, invocation);
      });
      // The caller still gets this exact rejecting promise. Retain and observe
      // late failures even if it abandoned a request-shaped wait.
      void invocation.settlement.catch(() => undefined);
      return invocation.settlement;
    },
    stopAdmissionAndDrain(): Promise<void> {
      if (draining) return draining;
      if (state.phase === "open") state.phase = "stopping";
      const invocation = active;
      draining = (async () => {
        if (invocation) {
          const [settled] = await Promise.allSettled([invocation.settlement]);
          if (settled?.status === "rejected") throw retainFailure(settled.reason, invocation);
        }
        if (failure) throw failure;
        try { assertCurrent(); } catch (error) { throw retainFailure(error, invocation); }
        state.phase = "closed";
        retainedInstallations.delete(state);
      })();
      void draining.catch(() => undefined);
      return draining;
    },
  });
  installedOwners.set(owner.nativeDatabase, state);
  retainedInstallations.add(state);
  return dispatcher;
}
