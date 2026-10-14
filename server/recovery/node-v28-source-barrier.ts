import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http.ts";
import { captureInstalledIdentityExecutionOwnerV28Candidate, type InstalledIdentityExecutionOwnerV28Candidate } from "../auth/installed-identity-execution-owner-v28-candidate.ts";
import { createLocalVolumeIdentityGuardV28Candidate, ownedLocalVolumeProfileContext,
  type LocalVolumeProfileOpening } from "../storage/local-volume-profile-opening.ts";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations.ts";
import { assertSqliteConnectionOwner, type SqliteCapability } from "../sqlite.ts";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease.ts";

export interface NodeV28SourceWindow { readonly generation: number; readonly token: string | null }
export interface NodeV28OriginalSourceOwner { close(): Promise<void> }
interface Frame { readonly owner: object; active: boolean }
interface OriginalOwner { readonly closeOriginal: () => Promise<void>; close?: Promise<void> }
const contexts = new AsyncLocalStorage<Frame>(), retained = new Set<object>(), claimed = new WeakMap<DatabaseSync, object>();
interface BarrierBinding {
  readonly database: SqliteCapability; readonly nativeDatabase: DatabaseSync;
  readonly writerLease: LinuxWriterLease; readonly authentication: object;
  readonly admission: ReviewedInstallationAdmission; readonly identity: Readonly<InstalledIdentityExecutionOwnerV28Candidate>;
  assertCurrent(): void; assertPhysicalCurrent(): void;
}
const issued = new WeakMap<object, Readonly<BarrierBinding>>();
/** Validate the genuine reusable SOURCE child against the parent. This check
 * issues no Request/resource grant and accepts no caller assert callback. */
export function assertNodeV28SourceBarrierBinding(barrier: object, database: SqliteCapability,
  nativeDatabase: DatabaseSync, writerLease: LinuxWriterLease, authentication: object): void {
  const owner = issued.get(barrier);
  if (!owner || owner.database !== database || owner.nativeDatabase !== nativeDatabase
    || owner.writerLease !== writerLease || owner.authentication !== authentication)
    throw new Error("Original V28 source barrier binding is unavailable");
  owner.assertCurrent();
}
/** Concrete borrowed Recovery composition only. The actual private SOURCE
 * binding derives every core/Native/lease/auth/admission field. The opening and
 * Recovery owners must pass the original registered immutable tuple equality;
 * every invocation then performs one fresh complete original identity proof.
 * No caller callback, observed success or asynchronous proof is accepted. */
export function createNodeV28BorrowedRecoveryGuard(options: {
  barrier: object; opening: LocalVolumeProfileOpening; identity: Readonly<InstalledIdentityExecutionOwnerV28Candidate>;
}): Readonly<{ assertCurrent(): void }> {
  if (Object.keys(options).sort().join(",") !== "barrier,identity,opening")
    throw new Error("Original V28 borrowed Recovery guard is unavailable");
  const { barrier, opening, identity } = options;
  const selected = issued.get(barrier), physical = ownedLocalVolumeProfileContext(opening);
  if (!selected || physical.database !== selected.database || physical.nativeDatabase !== selected.nativeDatabase
    || physical.writerLease !== selected.writerLease || physical.installationCheckpointId !== "portable-runtime/v28")
    throw new Error("Original V28 borrowed Recovery guard binding is unavailable");
  selected.assertPhysicalCurrent();
  const group = createLocalVolumeIdentityGuardV28Candidate(opening, selected.authentication, selected.admission,
    [selected.identity, identity]);
  return Object.freeze({ assertCurrent() {
    // Keep the actual barrier's private lifetime/auth/native/physical checks.
    // The opening guard also retains its original closed state and sentinel.
    selected.assertPhysicalCurrent(); group.assertCurrent();
  } });
}
function sameWindow(left: NodeV28SourceWindow, right: NodeV28SourceWindow): boolean {
  return left.generation === right.generation && left.token === right.token;
}

/** Reusable SOURCE-only barrier for the fixed combined V28 application. The
 * composer wraps only actual business/File/Package source invocations here;
 * authentication and maintenance/Recovery control never enter this set. The
 * original domain SQL still owns same-BEGIN session/member/root admission.
 * This child does not change persisted maintenance, executor flags or jobs,
 * and never stops/closes/releases the parent's Native or physical lease. */
export function createNodeV28SourceBarrier(options: {
  database: SqliteCapability; nativeDatabase: DatabaseSync; admission: ReviewedInstallationAdmission;
  writerLease: LinuxWriterLease; authentication: object; quarantine(error: unknown): void;
}) {
  const captured = Object.freeze({ ...options });
  const { database, nativeDatabase, admission, writerLease, authentication } = captured;
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  const auth = localAuthenticationIdentityAuthority(authentication);
  const identity = captureInstalledIdentityExecutionOwnerV28Candidate(auth.identity, database, nativeDatabase, admission);
  if (assertInstallationAdmission(nativeDatabase, admission).checkpointId !== "portable-runtime/v28" || claimed.has(nativeDatabase))
    throw new Error("V28 source ownership is unavailable");
  const operations = new Set<Promise<unknown>>(), owners = new Set<OriginalOwner>();
  const invocations = new WeakMap<NodeV28OriginalSourceOwner, Readonly<{ original: OriginalOwner; exposed: NodeV28OriginalSourceOwner }>>();
  let phase: "open" | "paused" | "stopping" | "closed" | "quarantined" = "open";
  let failed = false, failure: unknown, closing: Promise<void> | undefined;
  let window: Readonly<NodeV28SourceWindow> | undefined, sourceDrain: Promise<void> | undefined, drained = false;
  const state = { captured, auth, identity, operations, owners }; retained.add(state); claimed.set(nativeDatabase, state);
  function physical(): void {
    assertSqliteConnectionOwner(database, nativeDatabase); assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    identity.assertCurrent();
    if (localAuthenticationIdentityAuthority(authentication) !== auth) throw new Error("Original V28 source identity changed");
  }
  function notifyFailure(error: unknown): void {
    if (failed) return;
    failed = true; failure = error; phase = "quarantined";
    try { captured.quarantine(error); }
    catch (notificationError) { failure = new AggregateError([error, notificationError], "V28 source quarantine notification failed"); }
  }
  function maintenance(): Readonly<{ state: string; generation: bigint; token: string | null }> {
    physical(); const selected = nativeDatabase.prepare("SELECT state,generation,token FROM system_recovery_maintenance WHERE singleton=1");
    selected.setReadBigInts(true); const row = selected.get();
    if (!row || !["open", "draining", "fenced"].includes(String(row.state)) || typeof row.generation !== "bigint"
      || row.generation < 0n || row.generation > BigInt(Number.MAX_SAFE_INTEGER)
      || !(row.token === null || typeof row.token === "string")) throw new Error("Actual V28 source window is unavailable");
    return Object.freeze({ state: String(row.state), generation: row.generation, token: row.token });
  }
  function actualWindow(expected: NodeV28SourceWindow, states: readonly string[]): void {
    if (!expected || !Number.isSafeInteger(expected.generation) || expected.generation < 0
      || !(expected.token === null || typeof expected.token === "string" && expected.token.length > 0 && expected.token.length <= 128))
      throw new Error("Accepted V28 source window is unavailable");
    const row = maintenance();
    if (!states.includes(row.state) || row.generation !== BigInt(expected.generation) || row.token !== expected.token)
      throw new Error("Accepted V28 source window changed");
  }
  function closeOwner(owner: OriginalOwner): Promise<void> {
    if (owner.close) return owner.close;
    owner.close = Promise.resolve().then(owner.closeOriginal).then(() => { owners.delete(owner); }, error => {
      notifyFailure(error); throw error;
    });
    void owner.close.catch(() => undefined); return owner.close;
  }
  function runSource<T>(operation: () => T | Promise<T>): Promise<T> {
    if (phase !== "open") return Promise.reject(failed ? failure : new Error("Source mutations are paused for system recovery"));
    const original = Promise.resolve().then(() => writerLease.withWriter(async () => {
      physical();
      if (phase !== "open" || maintenance().state !== "open") throw new Error("Source mutations are paused for system recovery");
      const frame: Frame = { owner: state, active: true };
      try { return await contexts.run(frame, operation); }
      finally { frame.active = false; }
    }));
    operations.add(original);
    void original.then(() => operations.delete(original), () => operations.delete(original));
    return original;
  }
  function retainInvocation(owner: NodeV28OriginalSourceOwner): NodeV28OriginalSourceOwner {
    physical(); const frame = contexts.getStore();
    if (!frame || frame.owner !== state || !frame.active || !owner || typeof owner.close !== "function")
      throw new Error("Original admitted V28 source invocation is required");
    const previous = invocations.get(owner); if (previous) return previous.exposed;
    // Capture before a late body/provider can be delivered, including after
    // maintenance stopped new ingress. Only an already admitted frame can add.
    const original: OriginalOwner = { closeOriginal: owner.close.bind(owner) }; owners.add(original);
    const exposed = Object.freeze({ close: () => closeOwner(original) });
    invocations.set(owner, Object.freeze({ original, exposed }));
    if (phase !== "open") void closeOwner(original).catch(() => undefined);
    return exposed;
  }
  async function drainOriginals(): Promise<void> {
    const results = await Promise.allSettled([...owners].map(closeOwner));
    await Promise.allSettled([...operations]);
    // Already admitted continuations register before transfer; registrations
    // made while paused close immediately and retain the same original ACK.
    const late = await Promise.allSettled([...owners].map(closeOwner));
    const errors = [...results, ...late].flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
    if (failed || errors.length) throw failed ? failure : new AggregateError(errors, "Original V28 source owners did not drain");
    if (operations.size || owners.size) throw new Error("Original V28 source work remains held");
    physical();
  }
  function beginMaintenance(expected: NodeV28SourceWindow): Promise<void> {
    if (window) {
      if (!sameWindow(window, expected)) return Promise.reject(new Error("A different V28 source window owns the drain"));
      return sourceDrain!;
    }
    if (phase !== "open") return Promise.reject(failed ? failure : new Error("V28 source admission is closed"));
    // The maintenance CAS/receipt precedes this call. New source invocation
    // admission closes synchronously, without stopping the physical parent.
    actualWindow(expected, ["draining", "fenced"]); phase = "paused"; window = Object.freeze({ ...expected });
    sourceDrain = Promise.resolve().then(drainOriginals).then(() => { actualWindow(window!, ["draining", "fenced"]); drained = true; })
      .catch(error => { notifyFailure(error); throw error; });
    void sourceDrain.catch(() => undefined); return sourceDrain;
  }
  function assertDrained(expected: NodeV28SourceWindow): void {
    if (failed) throw failure;
    if (phase !== "paused" || !window || !sameWindow(window, expected) || !drained || operations.size || owners.size)
      throw new Error("Original V28 source work has not acknowledged its drain");
    actualWindow(expected, ["draining", "fenced"]);
    const statement = nativeDatabase.prepare(`SELECT 1 admitted WHERE
      NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM file_shadow_attempts WHERE state IN('write_started','unknown'))
      AND NOT EXISTS(SELECT 1 FROM file_migration_attempts WHERE state IN('write_started','unknown'))
      AND NOT EXISTS(SELECT 1 FROM research_package_attempts WHERE state IN('write_started','unknown'))
      AND NOT EXISTS(SELECT 1 FROM r2_upload_requests WHERE status='pending')
      AND NOT EXISTS(SELECT 1 FROM metrology_reference_upload_requests WHERE status='pending')
      AND NOT EXISTS(SELECT 1 FROM comment_submission_acceptances WHERE status='pending')
      AND NOT EXISTS(SELECT 1 FROM import_file_acceptances WHERE status='pending')
      AND NOT EXISTS(SELECT 1 FROM system_storage_candidate_checks WHERE status='running' OR cleanup_outcome='running' OR write_outcome='unknown')
      AND NOT EXISTS(SELECT 1 FROM file_migration_jobs WHERE state IN('queued','running'))
      AND NOT EXISTS(SELECT 1 FROM research_package_jobs WHERE state IN('queued','running'))
      AND EXISTS(SELECT 1 FROM file_authority_runtime_guard WHERE singleton=1 AND enabled=0)
      AND EXISTS(SELECT 1 FROM file_shadow_runtime_guard WHERE singleton=1 AND enabled=0)
      AND EXISTS(SELECT 1 FROM file_job_runtime_guard WHERE singleton=1 AND enabled=0)`);
    if (!statement.get()) throw new Error("Unsettled V28 source writes remain held");
  }
  function resumeAfterRelease(expected: NodeV28SourceWindow): void {
    if (failed) throw failure;
    if (phase !== "paused" || !window || !sameWindow(window, expected) || !drained || operations.size || owners.size)
      throw new Error("Original V28 source release is unavailable");
    const row = maintenance();
    if (row.state !== "open" || row.generation !== BigInt(expected.generation) + 1n || row.token !== null)
      throw new Error("Actual V28 maintenance release is unavailable");
    // Resume ingress only. Persisted flags/history remain exactly as the
    // explicit maintenance/executor controls left them.
    phase = "open"; window = undefined; sourceDrain = undefined; drained = false;
  }
  function close(): Promise<void> {
    if (closing) return closing;
    if (phase === "open" || phase === "paused") phase = "stopping";
    closing = Promise.resolve().then(async () => {
      if (sourceDrain) await sourceDrain;
      await drainOriginals(); phase = "closed"; retained.delete(state);
      if (claimed.get(nativeDatabase) === state) claimed.delete(nativeDatabase);
    }).catch(error => { notifyFailure(error); throw error; });
    void closing.catch(() => undefined); return closing;
  }
  const surface = Object.freeze({ runSource, retainInvocation, beginMaintenance, assertDrained, resumeAfterRelease, close,
    state() { return Object.freeze({ phase, pendingSourceOperations: operations.size, retainedSourceOwners: owners.size, drained }); } });
  issued.set(surface, Object.freeze({ database, nativeDatabase, writerLease, authentication, admission, identity,
    assertCurrent() { if (phase === "closed") throw new Error("Original V28 source barrier binding is closed"); physical(); },
    assertPhysicalCurrent() {
      if (phase === "closed") throw new Error("Original V28 source barrier binding is closed");
      assertSqliteConnectionOwner(database, nativeDatabase); assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
      if (localAuthenticationIdentityAuthority(authentication) !== auth) throw new Error("Original V28 source identity changed");
    } }));
  return surface;
}
