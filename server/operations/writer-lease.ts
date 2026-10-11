import { AsyncLocalStorage } from 'node:async_hooks';
import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { assertSqliteConnectionOwner, type SqliteCapability } from '../sqlite';

export class WriterLeaseError extends Error {
  readonly code: 'unavailable' | 'busy' | 'closed' | 'database_open' | 'capacity';
  constructor(code: WriterLeaseError['code']) {
    super(code === 'busy' ? 'The installation writer is already owned.' : 'Installation writer ownership is unavailable.');
    this.name = 'WriterLeaseError'; this.code = code;
  }
}
export interface LinuxWriterLease {
  readonly kind: 'private-linux-writer-lease/1';
  assertHeld(): void;
  bind(database: SqliteCapability, nativeDatabase: DatabaseSync): void;
  /** Track the ORIGINAL operation promise, never the transport deadline race.
   * Drain rejects new admission; only a still-live original of this issued
   * lease may retain its nested provider continuation. */
  withWriter<T>(operation: () => T | Promise<T>): Promise<T>;
  stopAdmissionAndDrain(): Promise<void>;
  /** Closed actual SQLite owners are required. A DB-open refusal keeps the
   * kernel lock and permits another release attempt after the owner closes it. */
  release(): Promise<void>;
}
interface FileIdentity { dev: bigint; ino: bigint; uid: bigint; gid: bigint; mode: bigint; nlink: bigint }
interface DirectoryIdentity { path: string; identity: FileIdentity }
interface ChildOutcome { code: number | null; signal: NodeJS.Signals | null; failed: boolean }
interface Attempt { fd: number; child?: ChildProcess; quarantined: boolean; cleanupFailed: boolean }
interface DescriptorOwner { fd: number; bindings: Map<DatabaseSync, FileIdentity>; cleanupFailed: boolean }
const attempts = new Set<Attempt>();
const heldDescriptors = new Set<DescriptorOwner>();
const issuedLeases = new WeakMap<LinuxWriterLease, DescriptorOwner>();
// Private original-operation context; no caller object, actor or Request can
// manufacture inheritance. A settled original cannot admit a late child.
const originalWriterOperations = new AsyncLocalStorage<{ lease: LinuxWriterLease; active: boolean }>();
// Includes unresolved quarantined helpers/cleanup. A failed host cannot spawn
// an unbounded stream of uncertain descriptor owners in this process.
const MAX_OUTSTANDING_ACQUISITIONS = 2;
const HELPER_DEADLINE_MS = 5000, KILL_PROOF_DEADLINE_MS = 1000;
function fail(code: WriterLeaseError['code'] = 'unavailable'): never { throw new WriterLeaseError(code); }
function fileIdentity(stat: BigIntStats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode, nlink: stat.nlink };
}
function same(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink;
}
function sameDirectory(a: FileIdentity, b: FileIdentity): boolean {
  // Directory child creation may change nlink. Device/inode/ownership/mode of
  // the traversed path itself must remain fixed through ordinary filesystem I/O.
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
}
function privateFile(stat: BigIntStats, owner: bigint, empty: boolean): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== owner || stat.nlink !== 1n
    || (stat.mode & 0o7777n) !== 0o600n || empty && stat.size !== 0n) fail();
}
function ancestors(path: string, owner: bigint, rootOwner: bigint): DirectoryIdentity[] {
  const result: DirectoryIdentity[] = []; let directory = dirname(path);
  while (true) {
    const stat = lstatSync(directory, { bigint: true }), parent = dirname(directory), atRoot = parent === directory;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022n) !== 0n
      || (atRoot ? stat.uid !== rootOwner : stat.uid !== owner && stat.uid !== 0n)) fail();
    result.push({ path: directory, identity: fileIdentity(stat) });
    if (atRoot) return result; directory = parent;
  }
}
function canonical(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) fail();
}
function closeAttempt(attempt: Attempt): void {
  if (attempt.cleanupFailed) return;
  try { closeSync(attempt.fd); attempts.delete(attempt); }
  catch { attempt.cleanupFailed = true; attempt.quarantined = true; }
}
async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** Redacted process-level diagnostic. Pending quarantine never counts as a
 * completed shutdown, and its strong FD ownership is not garbage-collected. */
export function writerLeaseProcessState(): Readonly<{ pendingAcquisitions: number; quarantinedAcquisitions: number; failedCleanups: number }> {
  return Object.freeze({ pendingAcquisitions: attempts.size,
    quarantinedAcquisitions: [...attempts].filter(value => value.quarantined).length,
    failedCleanups: [...attempts].filter(value => value.cleanupFailed).length
      + [...heldDescriptors].filter(value => value.cleanupFailed).length });
}

/** A runtime composer requires the factory-issued lease and this exact actual
 * native/core owner binding, rather than trusting a fabricated assert callback. */
export function assertLinuxWriterLeaseBinding(lease: LinuxWriterLease, database: SqliteCapability, nativeDatabase: DatabaseSync): void {
  const owner = issuedLeases.get(lease);
  if (!owner || !owner.bindings.has(nativeDatabase)) fail();
  assertSqliteConnectionOwner(database, nativeDatabase); lease.assertHeld();
}

/** Trusted Linux/local-filesystem operator composition. A private canonical
 * database and its EMPTY private600 one-link `${databasePath}.writer-lock`
 * already exist; acquisition never provisions, truncates, replaces or deletes
 * either path. Every normal runtime/offline writer uses this same derived path.
 * Advisory locks do not stop malicious same-UID/administrator code or a mount
 * replacement. The absolute preinstalled util-linux executable is trusted host
 * code; no PATH lookup, shell command, fcntl fallback or PID-file takeover.
 * SOURCE CANDIDATE ONLY until actual inherited-FD/crash/kill/process qualification. */
export async function acquireLinuxWriterLease(options: {
  databasePath: string; filesystemRootOwnerUid?: number;
}): Promise<LinuxWriterLease> {
  const databasePath = options?.databasePath;
  const configuredRoot = options?.filesystemRootOwnerUid === undefined ? 0 : options.filesystemRootOwnerUid;
  if (process.platform !== 'linux' || typeof process.geteuid !== 'function'
    || !options || Object.keys(options).some(key => !['databasePath', 'filesystemRootOwnerUid'].includes(key))
    || typeof databasePath !== 'string' || !databasePath || databasePath.length > 4000 || databasePath.includes('\0')
    || !Number.isSafeInteger(configuredRoot) || configuredRoot < 0 || configuredRoot > 0xffff_ffff) fail();
  const owner = BigInt(process.geteuid()), rootOwner = BigInt(configuredRoot), lockPath = `${databasePath}.writer-lock`;
  if (attempts.size + [...heldDescriptors].filter(value => value.cleanupFailed).length >= MAX_OUTSTANDING_ACQUISITIONS) fail('capacity');
  let attempt: Attempt | undefined, childClosed: Promise<ChildOutcome> | undefined, outcome: ChildOutcome | undefined;
  try {
    canonical(databasePath); const databaseBefore = lstatSync(databasePath, { bigint: true }); privateFile(databaseBefore, owner, false);
    const databaseIdentity = fileIdentity(databaseBefore);
    canonical(lockPath); const before = lstatSync(lockPath, { bigint: true }); privateFile(before, owner, true);
    const directories = ancestors(lockPath, owner, rootOwner);
    const fd = openSync(lockPath, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    attempt = { fd, quarantined: false, cleanupFailed: false }; attempts.add(attempt);
    const opened = fstatSync(fd, { bigint: true }); privateFile(opened, owner, true);
    if (!same(fileIdentity(before), fileIdentity(opened))) fail();
    const lockIdentity = fileIdentity(opened);
    // stdio3 is a dup of this parent descriptor: Linux flock locks the shared
    // open file description. Successful helper exit closes only its duplicate;
    // the private parent FD retains the lock. No child server/IPC stays alive.
    const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'],
      { stdio: ['ignore', 'ignore', 'ignore', fd], env: { LANG: 'C', LC_ALL: 'C' }, windowsHide: true });
    attempt.child = child;
    childClosed = new Promise<ChildOutcome>(resolve => {
      let failed = false; child.once('error', () => { failed = true; });
      child.once('close', (code, signal) => { outcome = { code, signal, failed }; resolve(outcome); });
    });
    const result = await bounded(childClosed, HELPER_DEADLINE_MS);
    if (!result) {
      try { child.kill('SIGKILL'); } catch { /* Still require actual close proof. */ }
      if (!await bounded(childClosed, KILL_PROOF_DEADLINE_MS)) {
        // A late helper could still acquire this inherited OFD. Keep the parent
        // FD strongly quarantined until real child close; never mint authority.
        attempt.quarantined = true;
        const uncertain = attempt; void childClosed.then(() => closeAttempt(uncertain));
      }
      fail();
    }
    if (result.failed || result.signal || result.code !== 0) fail(result.code === 73 ? 'busy' : 'unavailable');
    function assertPaths(): void {
      canonical(databasePath); const currentDatabase = lstatSync(databasePath, { bigint: true });
      privateFile(currentDatabase, owner, false);
      if (!same(databaseIdentity, fileIdentity(currentDatabase))) fail();
      canonical(lockPath); const current = lstatSync(lockPath, { bigint: true }), handle = fstatSync(fd, { bigint: true });
      privateFile(current, owner, true); privateFile(handle, owner, true);
      if (!same(lockIdentity, fileIdentity(current)) || !same(lockIdentity, fileIdentity(handle))) fail();
      const currentDirectories = ancestors(lockPath, owner, rootOwner);
      if (directories.length !== currentDirectories.length || directories.some((value, index) =>
        value.path !== currentDirectories[index]!.path || !sameDirectory(value.identity, currentDirectories[index]!.identity))) fail();
    }
    assertPaths(); // Recheck after the real helper exit, before minting any lease.
    type Phase = 'held' | 'draining' | 'releasing' | 'released' | 'faulted';
    let phase: Phase = 'held', workers = 0, releasing: Promise<void> | undefined;
    const drainWaiters = new Set<() => void>();
    const bindings = new Map<DatabaseSync, FileIdentity>();
    const descriptorOwner: DescriptorOwner = { fd, bindings, cleanupFailed: false }; heldDescriptors.add(descriptorOwner);
    const assertHeld = () => {
      if (phase !== 'held' && phase !== 'draining') fail('closed');
      try {
        assertPaths(); const stat = lstatSync(databasePath, { bigint: true });
        for (const [native, identity] of bindings) if (native.isOpen && !same(identity, fileIdentity(stat))) fail();
      } catch { fail(); }
    };
    const stopAdmissionAndDrain = async () => {
      if (phase === 'held') phase = 'draining';
      if (phase !== 'draining') fail('closed');
      if (workers) await new Promise<void>(resolve => { drainWaiters.add(resolve); });
    };
    const lease: LinuxWriterLease = Object.freeze({ kind: 'private-linux-writer-lease/1' as const, assertHeld,
      bind(database: SqliteCapability, nativeDatabase: DatabaseSync) {
        if (phase !== 'held') fail('closed'); assertHeld();
        assertSqliteConnectionOwner(database, nativeDatabase);
        const rows = nativeDatabase.prepare('PRAGMA database_list').all();
        const main = rows.filter(value => value.name === 'main');
        if (main.length !== 1 || main[0]!.file !== databasePath || rows.some(value => value.name !== 'main' && value.name !== 'temp')) fail();
        bindings.set(nativeDatabase, fileIdentity(lstatSync(databasePath, { bigint: true })));
      },
      async withWriter<T>(operation: () => T | Promise<T>): Promise<T> {
        const ancestor = originalWriterOperations.getStore();
        // Stop genuinely new admissions while allowing the still-live original
        // of THIS issued lease to open/settle its own nested provider work.
        if (phase !== 'held' && !(phase === 'draining' && ancestor?.lease === lease && ancestor.active)) fail('closed');
        assertHeld(); workers++;
        const original = { lease, active: true };
        try { return await originalWriterOperations.run(original, operation); }
        finally {
          original.active = false;
          if (--workers === 0) { for (const done of drainWaiters) done(); drainWaiters.clear(); }
        }
      },
      stopAdmissionAndDrain,
      release(): Promise<void> {
        if (phase === 'released') return Promise.resolve();
        if (releasing) return releasing;
        const operation = async () => {
          await stopAdmissionAndDrain();
          if ([...bindings.keys()].some(native => native.isOpen)) fail('database_open');
          phase = 'releasing';
          try { closeSync(fd); phase = 'released'; heldDescriptors.delete(descriptorOwner); }
          catch { phase = 'faulted'; descriptorOwner.cleanupFailed = true; fail(); }
        };
        // Reset in-flight ownership after a DB-open refusal; retry after genuine
        // native closure remains possible, with the same physical lock retained.
        releasing = operation().finally(() => { releasing = undefined; }); return releasing;
      },
    });
    issuedLeases.set(lease, descriptorOwner);
    attempts.delete(attempt); attempt = undefined; return lease;
  } catch (error) {
    if (attempt && !attempt.quarantined) {
      // A thrown spawn has no child. Otherwise preserve ownership until the
      // actual close event proves no inherited reference can acquire late.
      if (attempt.child && !outcome && childClosed) {
        try { attempt.child.kill('SIGKILL'); } catch { /* No optimistic cleanup. */ }
        if (!await bounded(childClosed, KILL_PROOF_DEADLINE_MS)) {
          attempt.quarantined = true; const uncertain = attempt;
          void childClosed.then(() => closeAttempt(uncertain));
        }
      }
      if (!attempt.quarantined) closeAttempt(attempt);
    }
    if (error instanceof WriterLeaseError) throw error;
    fail();
  }
}
