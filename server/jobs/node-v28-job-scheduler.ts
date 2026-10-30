import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http.ts";
import { captureInstalledIdentityExecutionOwnerV28Candidate } from "../auth/installed-identity-execution-owner-v28-candidate.ts";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations.ts";
import { assertSqliteConnectionOwner, type SqliteCapability } from "../sqlite.ts";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease.ts";
import { ownedNodeV28JobCursor, type NodeV28JobCursorOwner } from "./node-v28-job-cursor.ts";

export const NODE_V28_JOB_CADENCE_MS = 120_000;
export type NodeV28JobFamily = "file" | "package" | "recovery";
export interface NodeV28JobResult { readonly jobId: string | null; readonly outcome: string }
export interface NodeV28OwnedJobPort {
  /** A deny-only preflight. Actual claims retain their native/kernel checks. */
  eligible(): Promise<boolean>;
  /** One original action AND its first provider/body/source drain ACK. This
   * must not be a two-family dispatcher or a kernel promise alone. */
  runAndDrain(): Promise<NodeV28JobResult>;
  /** Deny genuinely new work; the admitted original retains its cleanup path. */
  stopAdmission(): void;
  drain(): Promise<void>;
}
export interface NodeV28SchedulerCursor {
  readonly nextFamily: NodeV28JobFamily;
  readonly consumedSlots: number;
}
const families: readonly NodeV28JobFamily[] = Object.freeze(["file", "package", "recovery"]);
const claimed = new WeakMap<DatabaseSync, object>(), retained = new Set<object>();
interface SchedulerBinding {
  readonly database: SqliteCapability; readonly nativeDatabase: DatabaseSync;
  readonly writerLease: LinuxWriterLease; readonly authentication: object; assertCurrent(): void;
}
const issued = new WeakMap<object, Readonly<SchedulerBinding>>();
/** Concrete composers require the original factory-issued child and exact
 * parent tuple. A structural scheduler method bag is not an owned child. */
export function assertNodeV28JobSchedulerBinding(scheduler: object, database: SqliteCapability,
  nativeDatabase: DatabaseSync, writerLease: LinuxWriterLease, authentication: object): void {
  const owner = issued.get(scheduler);
  if (!owner || owner.database !== database || owner.nativeDatabase !== nativeDatabase
    || owner.writerLease !== writerLease || owner.authentication !== authentication)
    throw new Error("Original V28 scheduler binding is unavailable");
  owner.assertCurrent();
}

/** An uncomposed scheduler child for the explicit same-app V28 owner. It never
 * listens, opens/closes Native, enables an executor, resumes a job or grants
 * actor/profile authority. Concrete borrowed ports must own the original
 * kernels and cleanup. Its privately issued same-parent cursor durably reserves
 * before action and publishes only after original cleanup. No caller cursor
 * data or callback bag can stand in for the original checkpoint owner. */
export function createNodeV28JobScheduler(options: {
  database: SqliteCapability; nativeDatabase: DatabaseSync; admission: ReviewedInstallationAdmission;
  writerLease: LinuxWriterLease; authentication: object;
  file: NodeV28OwnedJobPort; package: NodeV28OwnedJobPort; recovery: NodeV28OwnedJobPort;
  cursorOwner: NodeV28JobCursorOwner;
  quarantine(error: unknown): void;
}) {
  const captured = Object.freeze({ ...options });
  const { database, nativeDatabase, admission, writerLease, authentication } = captured;
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  const auth = localAuthenticationIdentityAuthority(authentication);
  const identity = captureInstalledIdentityExecutionOwnerV28Candidate(auth.identity, database, nativeDatabase, admission);
  const installation = assertInstallationAdmission(nativeDatabase, admission);
  if (installation.checkpointId !== "portable-runtime/v28" || claimed.has(nativeDatabase)) throw new Error("V28 scheduler ownership is unavailable");
  const ports = Object.freeze(Object.fromEntries(families.map(family => {
    const port = captured[family];
    if (!port || typeof port.eligible !== "function" || typeof port.runAndDrain !== "function"
      || typeof port.stopAdmission !== "function" || typeof port.drain !== "function") throw new Error("Owned V28 Job port is unavailable");
    return [family, Object.freeze({ eligible: port.eligible.bind(port), runAndDrain: port.runAndDrain.bind(port),
      stopAdmission: port.stopAdmission.bind(port), drain: port.drain.bind(port) })];
  }))) as Readonly<Record<NodeV28JobFamily, NodeV28OwnedJobPort>>;
  const cursorOwner = ownedNodeV28JobCursor(captured.cursorOwner, database, nativeDatabase, writerLease, authentication);
  const initial = cursorOwner.cursor();
  let index = families.indexOf(initial.nextFamily), consumedSlots = initial.consumedSlots;
  let phase: "open" | "stopping" | "closed" | "quarantined" = "open";
  let failed = false, failure: unknown, timer: ReturnType<typeof setTimeout> | undefined;
  let server: Server | undefined, listening: (() => void) | undefined, anchor: number | undefined;
  let active: Promise<NodeV28JobResult> | undefined, activeFamily: NodeV28JobFamily | undefined;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<NodeV28JobResult>>();
  const stopped = new Set<NodeV28JobFamily>();
  const state = { captured, auth, identity, ports, pending };
  claimed.set(nativeDatabase, state); retained.add(state);
  function physical(): void {
    assertSqliteConnectionOwner(database, nativeDatabase); assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    identity.assertCurrent();
    if (localAuthenticationIdentityAuthority(authentication) !== auth) throw new Error("Original V28 scheduler identity changed");
  }
  function notifyFailure(error: unknown): void {
    if (failed) return;
    failed = true; failure = error; phase = "quarantined";
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    if (server && listening) server.removeListener("listening", listening);
    const stopErrors = stopPorts();
    if (stopErrors.length) failure = new AggregateError([failure, ...stopErrors], "Original Job admission stop failed");
    try { captured.quarantine(failure); }
    catch (notificationError) { failure = new AggregateError([failure, notificationError], "V28 scheduler quarantine notification failed"); }
  }
  function stopPorts(): unknown[] {
    const errors: unknown[] = [];
    for (const family of families) {
      if (stopped.has(family)) continue;
      // The first stop outcome belongs to this owner, including rejection.
      stopped.add(family);
      try { ports[family].stopAdmission(); } catch (error) { errors.push(error); }
    }
    return errors;
  }
  const yielded = (result: NodeV28JobResult) => result.jobId === null
    && ["idle", "disabled", "unsupported", "ineligible"].includes(result.outcome);
  function dispatchOnce(): Promise<NodeV28JobResult> {
    if (phase !== "open") return Promise.reject(failed ? failure : new Error("V28 scheduler admission is closed"));
    if (active) return Promise.reject(new Error("V28 scheduler is busy"));
    const original = Promise.resolve().then(() => writerLease.withWriter(async () => {
      physical();
      // Visit each fixed family once. Receipt acknowledgements update the
      // next dispatch's cursor without changing this dispatch's cycle.
      const firstChoice = index;
      for (let offset = 0; offset < families.length; offset++) {
        if (phase !== "open") throw failed ? failure : new Error("V28 scheduler admission is closed");
        const selected = (firstChoice + offset) % families.length, family = families[selected]!, port = ports[family];
        if (await port.eligible() !== true) { physical(); continue; }
        physical(); activeFamily = family;
        const reserved = await cursorOwner.reserve(family); physical();
        const result = await port.runAndDrain(); physical();
        if (!result || !(result.jobId === null || typeof result.jobId === "string") || typeof result.outcome !== "string")
          throw new Error("Original V28 Job result is unavailable");
        const acknowledged = await cursorOwner.complete(reserved, !yielded(result)); physical();
        index = families.indexOf(acknowledged.nextFamily); consumedSlots = acknowledged.consumedSlots;
        if (yielded(result)) { activeFamily = undefined; continue; }
        return Object.freeze({ ...result });
      }
      return Object.freeze({ jobId: null, outcome: "idle" });
    }));
    active = original; pending.add(original);
    void original.then(() => {
      if (active === original) { active = undefined; activeFamily = undefined; }
      pending.delete(original);
    }, error => {
      if (active === original) { active = undefined; activeFamily = undefined; }
      notifyFailure(error); // Rejected original promises remain in pending.
    });
    return original;
  }
  function schedule(): void {
    if (phase !== "open" || timer !== undefined || anchor === undefined) return;
    const now = Date.now(), slot = Math.max(1, Math.floor((now - anchor) / NODE_V28_JOB_CADENCE_MS) + 1);
    const due = anchor + slot * NODE_V28_JOB_CADENCE_MS;
    timer = setTimeout(() => {
      timer = undefined;
      if (phase !== "open") return;
      // Skip a busy/missed slot. Never overlap or replay catch-up invocations.
      if (active) { schedule(); return; }
      const original = dispatchOnce();
      void original.then(() => schedule(), error => notifyFailure(error));
    }, Math.max(0, due - Date.now()));
    timer.unref();
  }
  function stopAdmission(): void {
    if (phase === "open") phase = "stopping";
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    if (server && listening) server.removeListener("listening", listening);
    const errors = stopPorts();
    if (errors.length) notifyFailure(new AggregateError(errors, "Original V28 Job admission stop failed"));
  }
  function drain(): Promise<void> {
    if (closing) return closing;
    stopAdmission();
    closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...pending]);
      const results = await Promise.allSettled(families.map(family => ports[family].drain()));
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
      if (failed || errors.length) throw failed ? failure : new AggregateError(errors, "Original V28 Job ports did not drain");
      physical(); phase = "closed"; retained.delete(state);
      if (claimed.get(nativeDatabase) === state) claimed.delete(nativeDatabase);
    }).catch(error => { notifyFailure(error); throw error; });
    void closing.catch(() => undefined); return closing;
  }
  const surface = Object.freeze({ cadenceMs: NODE_V28_JOB_CADENCE_MS, dispatchOnce, stopAdmission, drain,
    cursor(): Readonly<NodeV28SchedulerCursor> { return Object.freeze({ nextFamily: families[index]!, consumedSlots }); },
    state() { return Object.freeze({ phase, activeFamily: activeFamily ?? null, consumedSlots, timerArmed: timer !== undefined }); },
    startOnListening(actualServer: Server): void {
      if (phase !== "open" || server) throw new Error("Original V28 scheduler transport is already bound");
      physical(); server = actualServer;
      listening = () => {
        if (phase !== "open") return;
        try { physical(); anchor = Date.now(); schedule(); } catch (error) { notifyFailure(error); }
      };
      if (actualServer.listening) listening(); else actualServer.once("listening", listening);
    },
  });
  issued.set(surface, Object.freeze({ database, nativeDatabase, writerLease, authentication,
    assertCurrent() { if (phase === "closed") throw new Error("Original V28 scheduler binding is closed"); physical(); } }));
  return surface;
}
