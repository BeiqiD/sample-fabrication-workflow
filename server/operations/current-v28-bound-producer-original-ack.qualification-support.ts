// Qualification-only observation. No product factory/configuration imports this.
import { afterEach, vi } from "vitest";
import fileSystem, { open, type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import * as localBytes from "../storage/local-byte-storage.ts";
import * as profiles from "../../worker/files/storage-profile-opening.ts";

interface ProbeOwner {
  originalOpen?: Promise<FileHandle>; probe?: FileHandle; originalClose?: Promise<void>; closeAcknowledged: boolean;
}
const probes = new Set<ProbeOwner>();
afterEach(() => {
  if (probes.size) throw new Error("Original bound-producer diagnostic prototype probe close remains unproven");
});
type OriginalCall = (this: unknown, ...args: unknown[]) => unknown;
interface Observed {
  id: number; phase: string; operation: string; startedAt: number; fd?: number;
  settledAt?: number; outcome?: "acknowledged" | "rejected"; error?: { name: string; message: string };
}
const object = (value: unknown): value is object => value !== null && (typeof value === "object" || typeof value === "function");
function errorFact(error: unknown) {
  if (!(error instanceof Error)) return { name: "non-Error", message: typeof error };
  const code = (error as Error & { code?: unknown }).code;
  // Original errors remain unchanged. The private fact selects only the class
  // and a closed OS code; no original message/stack/path is copied here.
  return { name: error.name.slice(0, 80), message: typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "original-error-text-omitted" };
}

/** The one extra private FD establishes the genuine FileHandle prototype and
 * completes its original close BEFORE instrumentation. An uncertain first
 * open/close stays owned; no retry or closed-looking heuristic is used. */
export async function observeBoundProducerOriginalAcks(root: string) {
  const probeOwner: ProbeOwner = { closeAcknowledged: false }; probes.add(probeOwner);
  probeOwner.originalOpen = open(join(root, ".bound-ack-prototype-" + randomUUID()), "wx", 0o600);
  void probeOwner.originalOpen.catch(() => undefined);
  const probe = probeOwner.probe = await probeOwner.originalOpen;
  const prototype: object = Object.getPrototypeOf(probe);
  probeOwner.originalClose = probe.close(); void probeOwner.originalClose.catch(() => undefined);
  await probeOwner.originalClose; probeOwner.closeAcknowledged = true; probes.delete(probeOwner);

  let phase = "installed", phaseStartedAt = Date.now(), sequence = 0, restored = false;
  const phaseHistory: Array<{ phase: string; startedAt: number }> = [];
  const pending = new Map<number, Observed>(), originalPromises = new Map<number, Promise<unknown>>(), recent: Observed[] = [];
  const synchronousCalls: Array<{ phase: string; operation: string; startedAt: number; elapsedMs: number; outcome: string }> = [];
  const promiseIds = new WeakMap<object, number>(), installed = new WeakMap<object, Set<string>>();
  const readers = new WeakSet<object>(), bodies = new WeakSet<object>();
  const restorers: Array<() => void> = [], issues: Array<{ operation: string; error: { name: string; message: string } }> = [];
  const counts: Record<string, { calls: number; originalPromises: number; acknowledged: number; rejected: number }> = {};
  const synchronousCounts: Record<string, { calls: number; totalMs: number; maximumMs: number }> = {};
  function issue(operation: string, error: unknown) {
    if (issues.length < 16) issues.push({ operation, error: errorFact(error) });
  }
  function finish(observation: Observed, outcome: "acknowledged" | "rejected", error?: unknown) {
    pending.delete(observation.id); originalPromises.delete(observation.id);
    observation.settledAt = Date.now(); observation.outcome = outcome;
    if (outcome === "rejected") observation.error = errorFact(error);
    counts[observation.operation][outcome]++;
    recent.push(observation); if (recent.length > 32) recent.shift();
  }
  function observe(operation: string, value: unknown, receiver?: unknown): void {
    const count = counts[operation] ??= { calls: 0, originalPromises: 0, acknowledged: 0, rejected: 0 }; count.calls++;
    if (!object(value) || typeof (value as { then?: unknown }).then !== "function") return;
    // The map records actual promise identity, including memoized first closes.
    // No Promise.resolve, async forwarding wrapper or replacement goes back to
    // the original caller. Its then reaction is observation only.
    if (promiseIds.has(value)) return;
    if (sequence >= 8192) { issue(operation, new Error("Original observation inventory exceeded")); return; }
    const fd = object(receiver) ? (receiver as { fd?: unknown }).fd : undefined;
    const observation: Observed = { id: ++sequence, phase, operation, startedAt: Date.now(),
      ...(typeof fd === "number" ? { fd } : {}) };
    promiseIds.set(value, observation.id); pending.set(observation.id, observation); count.originalPromises++;
    const original = value as Promise<unknown>; originalPromises.set(observation.id, original);
    const reaction = original.then(() => finish(observation, "acknowledged"), error => finish(observation, "rejected", error));
    void reaction.catch(error => issue(operation + ".observer", error));
  }
  function returned(value: unknown, callback: (value: unknown) => void, operation: string) {
    if (!object(value) || typeof (value as { then?: unknown }).then !== "function") { callback(value); return; }
    const reaction = (value as Promise<unknown>).then(callback, () => undefined);
    void reaction.catch(error => issue(operation + ".observer", error));
  }
  function method(target: object, name: string, operation: string,
    before?: (args: unknown[]) => void, after?: (value: unknown) => void) {
    const names = installed.get(target) ?? new Set<string>();
    if (names.has(name)) return; names.add(name); installed.set(target, names);
    if (restorers.length >= 8192) { issue(operation + ".instrumentation", new Error("Original method observation inventory exceeded")); return; }
    try {
      const record = target as Record<string, OriginalCall>, original = record[name];
      if (typeof original !== "function") return;
      const spy = vi.spyOn(record, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
        if (before) try { before(args); } catch (error) { issue(operation + ".before-observer", error); }
        let fd: unknown;
        try { fd = object(this) ? (this as { fd?: unknown }).fd : undefined; }
        catch (error) { issue(operation + ".receiver-observer", error); }
        let value: unknown; const calledAt = Date.now();
        function synchronous(outcome: string) {
          const elapsedMs = Date.now() - calledAt, count = synchronousCounts[operation] ??= { calls: 0, totalMs: 0, maximumMs: 0 };
          count.calls++; count.totalMs += elapsedMs; count.maximumMs = Math.max(count.maximumMs, elapsedMs);
          if (elapsedMs) {
            synchronousCalls.push({ phase, operation, startedAt: calledAt, elapsedMs, outcome });
            synchronousCalls.sort((left, right) => right.elapsedMs - left.elapsedMs);
            if (synchronousCalls.length > 32) synchronousCalls.pop();
          }
        }
        try { value = Reflect.apply(original, this, args); synchronous("returned"); }
        catch (error) { synchronous("original-synchronous-rejection"); issue(operation + ".original-synchronous-rejection", error); throw error; }
        try { observe(operation, value, typeof fd === "number" ? { fd } : undefined); }
        catch (error) { issue(operation + ".promise-observer", error); }
        if (after) try { returned(value, after, operation); }
        catch (error) { issue(operation + ".return-observer", error); }
        return value;
      });
      restorers.push(() => spy.mockRestore());
    } catch (error) { issue(operation + ".instrumentation", error); }
  }
  function body(value: unknown, label: string) {
    if (!object(value)) return;
    const selected = (value as { body?: unknown }).body;
    if (!object(selected) || bodies.has(selected)) return; bodies.add(selected);
    method(selected, "getReader", label + ".getReader", undefined, value => {
      if (!object(value) || readers.has(value)) return; readers.add(value);
      method(value, "read", label + ".reader.read");
      method(value, "cancel", label + ".reader.cancel");
      method(value, "releaseLock", label + ".reader.releaseLock");
      observe(label + ".reader.closed", (value as { closed?: unknown }).closed);
    });
    method(selected, "cancel", label + ".body.cancel");
  }
  function adapter(value: unknown, label: string, close: string) {
    if (!object(value)) return;
    const reader = (value as { reader?: unknown }).reader, writer = (value as { writer?: unknown }).writer;
    if (object(reader)) {
      method(reader, "read", label + ".read", undefined, value => body(value, label + ".read-body"));
      method(reader, "stat", label + ".stat");
    }
    if (object(writer)) method(writer, "write", label + ".write");
    method(value, close, label + "." + close);
  }
  // FileHandle.close is an instance-owned arrow. Observe each actual open's
  // exact returned handle before its original caller resumes and binds close.
  // The mutable built-in default is synchronized to its real named bindings;
  // every open still returns the same original promise and native handle.
  method(fileSystem, "open", "native-file.open", undefined, value => {
    if (!object(value) || Object.getPrototypeOf(value) !== prototype) {
      issue("native-file.open.handle", new Error("Original native FileHandle prototype differs")); return;
    }
    for (const name of ["sync", "read", "write", "stat", "close"])
      method(value, name, "native-file-handle." + name);
  });
  for (const name of ["rename", "lstat", "realpath", "readdir", "mkdtemp"])
    method(fileSystem, name, "native-file." + name);
  syncBuiltinESMExports();
  method(localBytes, "openLocalByteStorage", "local-byte.open", args => {
    const fence = args[1];
    if (object(fence)) {
      method(fence, "beforeMutation", "local-byte.beforeMutation");
      method(fence, "assertCurrent", "local-byte.assertCurrent");
    }
  }, value => adapter(value, "local-byte", "close"));
  method(profiles, "openStorageProfile", "profile.open", args => {
    const lifecycle = args[3];
    if (object(lifecycle)) method(lifecycle, "beforeRequest", "profile.beforeRequest");
  }, value => adapter(value, "profile", "dispose"));

  function snapshot() {
    const now = Date.now();
    return { schema: "bound-producer-original-ack-observation/2", phase, phaseStartedAt, phaseElapsedMs: now - phaseStartedAt,
      phaseHistory, prototypeProbeOriginalCloseAcknowledged: probeOwner.closeAcknowledged,
      originalCallsForwardedOnceWithSameReceiverArgumentsAndReturn: true, originalBudgetsAndCleanupUnchanged: true,
      counts, synchronousCounts, slowestSynchronousCalls: synchronousCalls, pendingOriginalTotal: pending.size,
      pending: [...pending.values()].slice(0, 64).map(value => ({ ...value, elapsedMs: now - value.startedAt })), recent,
      observationIssues: issues, restorationIsNotIoSettlement: true };
  }
  return Object.freeze({
    phase(name: string) {
      phase = name; phaseStartedAt = Date.now(); phaseHistory.push({ phase, startedAt: phaseStartedAt });
      if (phaseHistory.length > 32) phaseHistory.shift();
    },
    database(native: object) {
      method(native, "prepare", "native-sqlite.prepare", undefined, value => {
        if (object(value)) for (const name of ["get", "all", "run", "columns"])
          method(value, name, "native-sqlite.statement." + name);
      });
      method(native, "exec", "native-sqlite.exec");
    },
    async joinAlreadyIssuedOriginals() {
      // Join only already-issued actual promises. This does not issue a read,
      // timer, cancel, disposer, close, replay or new admission. Their exact
      // work/rejection remains with the original caller and its retained owner.
      // Continue across late child promises from those original operations.
      while (originalPromises.size) await Promise.allSettled([...originalPromises.values()]);
    },
    report(event: string) {
      try { console.error("Original bound producer ACK observation: " + JSON.stringify({ event, ...snapshot() })); }
      catch (error) { issue("report", error); }
    },
    restore() {
      if (restored) return; restored = true;
      // Restore methods only. Never cancel/close an observed provider/body/FD,
      // retry its first promise, or claim the original parent settled from this.
      for (const restore of restorers.reverse()) try { restore(); } catch (error) { issue("restore", error); }
      try { syncBuiltinESMExports(); } catch (error) { issue("restore-built-in-bindings", error); }
    },
  });
}
