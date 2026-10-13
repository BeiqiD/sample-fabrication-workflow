import type { FileJobCapabilities, JobBoundStorage } from "./types";
import type { PackageCapabilities } from "../../packages/jobs/types";
type OriginalJobCapabilities = FileJobCapabilities | PackageCapabilities;
import { StorageProfileCleanupError } from "../storage-profile-opening";

interface ExecutionEntry {
  settlement: Promise<void>;
  /** Retain the captured owners when cleanup fails; no implicit retry. */
  disposers: (() => Promise<void>)[];
  cleanupFailed: boolean;
}
interface ExecutionState {
  entries: Set<ExecutionEntry>;
  sealed: boolean;
  quarantined: boolean;
  draining?: Promise<void>;
  failure?: FileJobExecutionDrainError;
}
/** Original provider cleanup failed. Hosts must retain the SQL/lease owner;
 * this signal cannot be replaced by a successful paused status. */
export class FileJobExecutionDrainError extends AggregateError {
  /** Retain actual owners/closures for host quarantine; never invoke them as
   * an automatic cleanup retry after an uncertain close. */
  declare readonly retainedOwners: readonly unknown[];
  constructor(errors: readonly unknown[], retainedOwners: readonly unknown[] = []) {
    super(errors, "File job execution owner could not drain");
    this.name = "FileJobExecutionDrainError";
    Object.defineProperty(this, "retainedOwners", { value: Object.freeze([...retainedOwners]),
      enumerable: false, writable: false, configurable: false });
  }
}
/** Preserve typed ownership failures through a scheduler's original aggregate
 * reasons. An error message/name supplied by a caller is not this capability. */
export function requiresFileJobExecutionQuarantine(error: unknown): boolean {
  const seen = new Set<unknown>(), pending = [error];
  while (pending.length) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    if (current instanceof FileJobExecutionDrainError || current instanceof StorageProfileCleanupError) return true;
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
  return false;
}
const executions = new WeakMap<object, ExecutionState>();
function stateFor(capabilities: object): ExecutionState {
  let state = executions.get(capabilities);
  if (!state) { state = { entries: new Set(), sealed: false, quarantined: false }; executions.set(capabilities, state); }
  return state;
}

/** The exact capabilities object identifies one runtime owner. A shallow copy
 * is another owner and cannot be used to drain an existing invocation. */
export function assertFileJobExecutionsOpen(capabilities: OriginalJobCapabilities): void { assertOriginalExecutionsOpen(capabilities); }
function assertOriginalExecutionsOpen(capabilities: object):void {
  const state = stateFor(capabilities);
  if (state.sealed || state.draining || state.quarantined) throw new Error("File job execution owner is closed or draining");
}

export interface FileJobExecutionScope {
  /** Called immediately after a successful open, including partial/late opens.
   * An already admitted operation can acquire its result during owner drain. */
  own(storage: JobBoundStorage): JobBoundStorage;
  /** One original ingress cleanup, retained alongside actual provider owners. */
  ownCleanup(dispose: () => Promise<void>): void;
}
export interface RetainedFileJobExecution<T> {
  /** Original business result, without provider disposal changing its deadline. */
  result: Promise<T>;
  /** The same original result after owned provider cleanup has completed. */
  completed: Promise<T>;
}

/** Keep the original operation and its captured provider cleanup independently
 * of a caller's deadline race. Cleanup is not positive byte-write settlement
 * and never writes a migration attempt's io_settled_at. Ordinary operation
 * failures remain the kernel's status decision; cleanup failures quarantine
 * the owner and are surfaced by drain/close. */
export function retainFileJobExecution<T>(capabilities: OriginalJobCapabilities,
  operation: (scope: FileJobExecutionScope) => Promise<T>,
  afterSettled?: () => Promise<void>,
): RetainedFileJobExecution<T> { return retainOriginalExecution(capabilities,operation,afterSettled); }
function retainOriginalExecution<T>(capabilities:object,operation:(scope:FileJobExecutionScope)=>Promise<T>,afterSettled?:()=>Promise<void>):RetainedFileJobExecution<T>{
  assertOriginalExecutionsOpen(capabilities);
  const state = stateFor(capabilities), owners = new Set<JobBoundStorage>();
  const entry: ExecutionEntry = { settlement: Promise.resolve(), disposers: [], cleanupFailed: false };
  let cleaning = false;
  const scope: FileJobExecutionScope = { own(storage) {
    if (cleaning) throw new Error("File job operation has already settled");
    if (!owners.has(storage)) {
      owners.add(storage);
      const dispose = storage.dispose;
      if (dispose !== undefined) {
        if (typeof dispose !== "function") throw new Error("Invalid File job storage disposer");
        entry.disposers.push(dispose.bind(storage));
      }
    }
    return storage;
  }, ownCleanup(dispose) {
    if (cleaning || typeof dispose !== "function") throw new Error("Invalid original job cleanup owner");
    entry.disposers.push(dispose);
  } };
  const cleanup = async () => {
    cleaning = true;
    try {
      const results = await Promise.allSettled(entry.disposers.map(dispose => Promise.resolve().then(dispose)));
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
      if (failures.length) throw new AggregateError(failures, "File job provider disposal failed");
      // A verification hold stays retained if the provider cannot close.
      if (!entry.cleanupFailed) await afterSettled?.();
    } catch (error) { entry.cleanupFailed = true; state.quarantined = true; throw error; }
  };
  // Register before invoking the real operation, including an opener that
  // returns only after the bounded caller has already timed out.
  state.entries.add(entry);
  const original = Promise.resolve().then(() => operation(scope));
  const result = original.then(async value => { await cleanup(); return value; },
    async error => {
      // An opener may have acquired a provider and failed its invalid-open
      // cleanup before a descriptor could be returned to scope.own().
      if (requiresFileJobExecutionQuarantine(error)) { entry.cleanupFailed = true; state.quarantined = true; }
      try { await cleanup(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "File job operation and provider cleanup failed"); }
      throw error;
    });
  entry.settlement = result.then(() => { state.entries.delete(entry); }, error => {
    if (entry.cleanupFailed) throw error;
    state.entries.delete(entry);
  });
  // The deadline caller may have returned before this tail rejects. Retain the
  // same rejected promise for drain, without an unhandled rejection or retry.
  void entry.settlement.catch(() => undefined);
  return { result: original, completed: result };
}

/** Wait for actual original operation promises and every provider disposer.
 * New invocations are refused while draining. A failed cleanup keeps its owner
 * closures retained and makes this runtime unavailable until the host repairs
 * it; neither this function nor close retries an uncertain provider close. */
export function drainFileJobExecutions(capabilities: OriginalJobCapabilities): Promise<void> { return drainOriginalExecutions(capabilities); }
function drainOriginalExecutions(capabilities:object):Promise<void>{
  const state = stateFor(capabilities);
  if (state.failure) return Promise.reject(state.failure);
  if (state.draining) return state.draining;
  const draining = (async () => {
    const results = await Promise.allSettled([...state.entries].map(entry => entry.settlement));
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
    if (failures.length) {
      state.failure = new FileJobExecutionDrainError(failures, [capabilities, ...state.entries]);
      throw state.failure;
    }
  })();
  state.draining = draining;
  void draining.then(() => { state.draining = undefined; }, () => { state.draining = undefined; });
  return draining;
}

/** After awaiting the top-level kernel/loop invocation, seal the same runtime
 * before its host closes native SQL or releases its writer lease. This byte
 * lifetime registry does not admit concurrent shutdown during SQL preflight.
 * Rejection requires host quarantine, not optimistic close. */
export function closeFileJobExecutions(capabilities: OriginalJobCapabilities): Promise<void> {
  stateFor(capabilities).sealed = true;
  return drainFileJobExecutions(capabilities);
}


// Reuse this exact original invocation/provider first-close registry for the
// fixed Worker V5 Recovery lane. These receipts issue lifetime ownership only,
// never an actor, job claim, SQL predicate, destination or provider grant.
const workerRecoveryOwners=new WeakMap<object,object>();
const workerRecoveryScopes=new WeakMap<object,FileJobExecutionScope>();
const workerRecoveryPending=new WeakSet<object>();
const workerRecoveryOriginalResults=new WeakMap<object,Promise<boolean>>();
export function registerWorkerRecoveryExecutionOwner(capabilities:object):void{
  assertOriginalExecutionsOpen(capabilities);workerRecoveryOwners.set(capabilities,capabilities);
}
export function retainWorkerRecoveryInvocation<T>(original:object,operation:()=>Promise<T>):Promise<T>{
  const owner=workerRecoveryOwners.get(original);
  if(!owner)return operation();
  if(workerRecoveryPending.has(original))throw new Error("Original Worker Recovery invocation is busy");
  workerRecoveryPending.add(original);
  try{
    const retained=retainOriginalExecution(owner,async scope=>{
      workerRecoveryScopes.set(original,scope);
      try{return await operation();}finally{workerRecoveryScopes.delete(original);}
    });
    workerRecoveryOriginalResults.set(original,retained.result.then(()=>true,()=>false));
    void retained.completed.then(()=>workerRecoveryPending.delete(original),()=>workerRecoveryPending.delete(original));
    return retained.result;
  }catch(error){workerRecoveryPending.delete(original);throw error;}
}
export function ownWorkerRecoveryBodyClose(original:object,dispose:()=>Promise<void>):void{
  const scope=workerRecoveryScopes.get(original);
  if(!workerRecoveryOwners.has(original)||!scope)throw new Error("Original Worker Recovery body owner is unavailable");
  scope.ownCleanup(dispose);
}

/** Only the exact privately registered Worker owner can use this neutral
 * lifetime close. No Worker/D1/Env types flow into Node's shared byte registry. */
export function closeWorkerRecoveryExecutionOwner(original:object):Promise<void>{
  const owner=workerRecoveryOwners.get(original);
  if(!owner)throw new Error("Original Worker Recovery execution owner is unavailable");
  stateFor(owner).sealed=true;return drainOriginalExecutions(owner);
}

/** Read only the SAME privately retained original business promise. Successful
 * disposer drain alone cannot turn a rejected snapshot/source call into proof. */
export function workerRecoveryOriginalInvocationSucceeded(original:object):Promise<boolean>{
  const outcome=workerRecoveryOriginalResults.get(original);
  if(!workerRecoveryOwners.has(original)||!outcome)throw new Error("Original Worker Recovery invocation outcome is unavailable");
  return outcome;
}
