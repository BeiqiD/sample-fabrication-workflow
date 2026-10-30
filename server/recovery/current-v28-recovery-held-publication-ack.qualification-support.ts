import { constants } from 'node:fs';
import { open, readlink, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, vi } from 'vitest';

export interface CurrentRecoveryHeldPublicationAck {
  readonly reached: Promise<void>;
  releaseAndRestore(): Promise<void>;
  selectedCalls(): number;
}
interface SyncInvocation {
  readonly handle: FileHandle;
  readonly fd: number;
  original?: Promise<void>;
  wrapped?: Promise<void>;
}
interface AckOwner {
  readonly objectsPath: string;
  readonly calls: Set<SyncInvocation>;
  probeAttempted: boolean;
  originalOpen?: Promise<FileHandle>;
  probe?: FileHandle;
  originalProbeCloser?: () => Promise<void>;
  originalProbeClose?: Promise<void>;
  spyAttempted: boolean;
  spy?: { mockRestore(): void };
  restoreAttempted: boolean;
  restored: boolean;
  released: boolean;
  held: boolean;
  selected: number;
  failed: boolean;
  failure?: unknown;
  finishing?: Promise<void>;
}
const owners = new Set<AckOwner>();
function ensure(value: unknown): asserts value {
  if (!value) throw new Error('Original private Recovery publication ACK ownership is unavailable');
}
function combine(errors: readonly unknown[], message: string): unknown {
  const distinct = [...new Set(errors)]; return distinct.length === 1 ? distinct[0] : new AggregateError(distinct, message);
}
afterEach(() => {
  if (owners.size) throw new AggregateError([...owners].map(owner => owner.finishing
    ?? (owner.failed ? owner.failure : owner.originalProbeClose ?? owner.originalOpen)),
  'Original Recovery publication ACK hook ownership remains retained');
});

/** Qualification-only acknowledgement delay. Real LOCAL publication has
 * already renamed the immutable object before opened[1].handle.sync() runs.
 * Every native sync is invoked unchanged; only the first positively settled
 * ACK on the exact private objects directory waits for the caller's release.
 * No provider result, durable attempt, clock or production budget is invented.
 */
export async function holdCurrentRecoveryPublicationAck(artifactRoot: string): Promise<CurrentRecoveryHeldPublicationAck> {
  ensure(process.platform === 'linux' && typeof process.geteuid === 'function' && owners.size === 0
    && typeof artifactRoot === 'string' && isAbsolute(artifactRoot) && resolve(artifactRoot) === artifactRoot);
  const objectsPath = join(artifactRoot, 'objects');
  const owner: AckOwner = { objectsPath, calls: new Set(), probeAttempted: false, spyAttempted: false,
    restoreAttempted: false, restored: false, released: false, held: false, selected: 0, failed: false };
  owners.add(owner);
  let release!: () => void, notifyReached!: () => void, rejectReached!: (error: unknown) => void;
  const gate = new Promise<void>(done => { release = done; });
  const reached = new Promise<void>((done, fail) => { notifyReached = done; rejectReached = fail; });
  void reached.catch(() => undefined);
  const remember = (error: unknown): void => {
    if (!owner.failed) { owner.failed = true; owner.failure = error; }
  };
  function closeProbe(): Promise<void> {
    if (owner.originalProbeClose) return owner.originalProbeClose;
    ensure(owner.probe && owner.originalProbeCloser);
    owner.originalProbeClose = Promise.resolve().then(owner.originalProbeCloser);
    void owner.originalProbeClose.catch(() => undefined); return owner.originalProbeClose;
  }
  function releaseAndRestore(): Promise<void> {
    if (owner.finishing) return owner.finishing;
    // Release before awaiting intercepted originals, so the selected ACK can
    // settle. The cached finish exists before any original cleanup callback.
    owner.released = true; release();
    owner.finishing = Promise.resolve().then(async () => {
      const failures: unknown[] = [], joined = new Set<SyncInvocation>();
      for (;;) {
        // A released writer can issue another sync while prior wrappers settle.
        // Join those original invocations too; do not snapshot once and guess.
        const batch = [...owner.calls].filter(call => !joined.has(call));
        if (!batch.length) break;
        for (const call of batch) { joined.add(call); ensure(call.original && call.wrapped); }
        const results = await Promise.allSettled(batch.flatMap(call => [call.original!, call.wrapped!]));
        failures.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []));
      }
      if (owner.probe) {
        try { await closeProbe(); } catch (error) { failures.push(error); }
      } else if (owner.probeAttempted) failures.push(owner.failed ? owner.failure : new Error('Original Recovery directory probe has no returned handle'));
      if (owner.spy) {
        if (!owner.restoreAttempted) {
          owner.restoreAttempted = true;
          try { owner.spy.mockRestore(); owner.restored = true; } catch (error) { failures.push(error); }
        }
        if (!owner.restored) failures.push(new Error('Original Recovery sync spy restoration is unproven'));
      } else if (owner.spyAttempted) failures.push(new Error('Original Recovery sync spy constructor has no returned owner'));
      if (failures.length || owner.failed) {
        const error = combine([...(owner.failed ? [owner.failure] : []), ...failures], 'Original Recovery publication ACK hook could not finish');
        remember(error); throw error;
      }
      owners.delete(owner);
    }).catch(error => { remember(error); throw error; });
    void owner.finishing.catch(() => undefined); return owner.finishing;
  }
  try {
    ensure(await realpath(artifactRoot) === artifactRoot && await realpath(objectsPath) === objectsPath);
    owner.probeAttempted = true;
    const originalOpen = open(objectsPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    owner.originalOpen = originalOpen; void originalOpen.catch(() => undefined);
    owner.probe = await originalOpen;
    owner.originalProbeCloser = owner.probe.close.bind(owner.probe);
    const stat = await owner.probe.stat({ bigint: true });
    ensure(stat.isDirectory() && stat.uid === BigInt(process.geteuid()) && (stat.mode & 0o077n) === 0n
      && await readlink(`/proc/self/fd/${owner.probe.fd}`) === objectsPath);
    const prototype = Object.getPrototypeOf(owner.probe) as Pick<FileHandle, 'sync'>;
    const originalSync = prototype.sync; ensure(typeof originalSync === 'function');
    // This actual probe is never part of the injected ACK. Its first native
    // close must be positively acknowledged before production work can begin.
    await closeProbe();
    owner.spyAttempted = true;
    owner.spy = vi.spyOn(prototype, 'sync').mockImplementation(function (this: FileHandle): Promise<void> {
      const call: SyncInvocation = { handle: this, fd: this.fd }; owner.calls.add(call);
      try { call.original = originalSync.call(this); }
      catch (error) { call.original = Promise.reject(error); }
      void call.original.catch(() => undefined);
      call.wrapped = Promise.resolve().then(async () => {
        await call.original;
        const path = await readlink(`/proc/self/fd/${call.fd}`);
        if (path === objectsPath) {
          owner.selected++;
          if (!owner.held && !owner.released) {
            owner.held = true; notifyReached(); await gate;
          }
        }
      }).catch(error => { remember(error); rejectReached(error); throw error; });
      void call.wrapped.catch(() => undefined); return call.wrapped;
    });
    return Object.freeze({ reached, releaseAndRestore, selectedCalls: () => owner.selected });
  } catch (error) {
    remember(error); rejectReached(error);
    try { await releaseAndRestore(); }
    catch (cleanup) { throw combine([error, cleanup], 'Recovery publication ACK hook construction and original cleanup failed'); }
    throw error;
  }
}
