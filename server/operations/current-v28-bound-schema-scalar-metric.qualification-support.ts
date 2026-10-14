// Qualification-only observer for the actual fixed prepared schema scalar.
// No production module imports this and no provider/body/SQL row is observed.
import type { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { afterEach } from "vitest";

type Call = (this: unknown, ...args: unknown[]) => unknown;
export interface SchemaScalarMetric {
  matchingPrepares: number; trackedStatements: number; getCalls: number;
  getMs: number; maximumGetMs: number; getFailures: number;
  unavailablePatches: number; restorationFailures: number;
}
interface OriginalObserverOwner { native: DatabaseSync; restorers: Array<() => void>; failure?: AggregateError }
const originalObservers = new Set<OriginalObserverOwner>();
afterEach(() => {
  if (originalObservers.size) throw new AggregateError([...originalObservers].map(owner => owner.failure),
    "Original schema scalar observer method restoration remains unproven");
});
export function observeOriginalSchemaScalar(native: DatabaseSync) {
  const metric: SchemaScalarMetric = { matchingPrepares: 0, trackedStatements: 0, getCalls: 0,
    getMs: 0, maximumGetMs: 0, getFailures: 0, unavailablePatches: 0, restorationFailures: 0 };
  const attempted = new WeakSet<object>(), selected = new WeakSet<object>(), prototypes = new WeakSet<object>();
  const restorers: Array<() => void> = [];
  const owner: OriginalObserverOwner = { native, restorers }; originalObservers.add(owner);
  let restored = false;
  function measured(original: Call, receiver: unknown, args: unknown[]): unknown {
    const started = performance.now(); let failed = false;
    try { return Reflect.apply(original, receiver, args); }
    catch (error) { failed = true; throw error; }
    finally {
      const elapsed = performance.now() - started;
      metric.getCalls++; metric.getMs += elapsed; metric.maximumGetMs = Math.max(metric.maximumGetMs, elapsed);
      if (failed) metric.getFailures++;
    }
  }
  function patch(target: object, name: string, replacement: Call): boolean {
    const prior = Object.getOwnPropertyDescriptor(target, name);
    try {
      // Keep original flags. A writable, nonconfigurable Native data method can
      // change value without vi.spyOn redefining its descriptor attributes.
      Object.defineProperty(target, name, prior ? { ...prior, value: replacement }
        : { value: replacement, writable: true, configurable: true, enumerable: false });
      restorers.push(() => {
        if (prior) Object.defineProperty(target, name, prior);
        else if (!Reflect.deleteProperty(target, name)) throw new Error("Original schema observer method restoration failed");
      });
      return true;
    } catch { return false; }
  }
  function instrument(statement: object): void {
    if (attempted.has(statement)) return;
    attempted.add(statement);
    const original = Reflect.get(statement, "get") as unknown;
    if (typeof original !== "function") { metric.unavailablePatches++; return; }
    const call = original as Call;
    // If this inherited method was already wrapped on the prototype, select
    // the new statement there; never wrap that observer inside another one.
    if (!Object.hasOwn(statement, "get")) {
      let existing: object | null = Object.getPrototypeOf(statement);
      while (existing && !Object.hasOwn(existing, "get")) existing = Object.getPrototypeOf(existing);
      if (existing && prototypes.has(existing)) { selected.add(statement); metric.trackedStatements++; return; }
    }
    if (patch(statement, "get", function (this: unknown, ...args: unknown[]) { return measured(call, this, args); })) {
      selected.add(statement); metric.trackedStatements++; return;
    }
    // An unextensible instance may inherit the genuine method. Patch that one
    // original prototype only; every unselected statement forwards untouched.
    // An own immutable method cannot be replaced through its prototype.
    if (Object.hasOwn(statement, "get")) { metric.unavailablePatches++; return; }
    let prototype: object | null = Object.getPrototypeOf(statement);
    while (prototype && !Object.hasOwn(prototype, "get")) prototype = Object.getPrototypeOf(prototype);
    if (!prototype) { metric.unavailablePatches++; return; }
    selected.add(statement);
    if (!prototypes.has(prototype)) {
      const prototypeOriginal = Reflect.get(prototype, "get") as unknown;
      if (typeof prototypeOriginal !== "function" || !patch(prototype, "get", function (this: unknown, ...args: unknown[]) {
        return this !== null && (typeof this === "object" || typeof this === "function") && selected.has(this)
          ? measured(prototypeOriginal as Call, this, args) : Reflect.apply(prototypeOriginal as Call, this, args);
      })) { metric.unavailablePatches++; return; }
      prototypes.add(prototype);
    }
    metric.trackedStatements++;
  }
  const originalPrepare = native.prepare;
  if (!patch(native, "prepare", function (this: unknown, ...args: unknown[]) {
    // The original Native method is invoked once, with exact receiver/args, and
    // its exact original StatementSync is always returned without a proxy.
    const statement: unknown = Reflect.apply(originalPrepare, this, args);
    const sql = args[0];
    if (typeof sql === "string" && sql.startsWith("SELECT 1 AS admitted WHERE")
      && sql.includes("count(DISTINCT name COLLATE BINARY)") && sql.includes("FROM sqlite_schema")) {
      metric.matchingPrepares++;
      if (statement !== null && typeof statement === "object") {
        try { instrument(statement); } catch { metric.unavailablePatches++; }
      } else metric.unavailablePatches++;
    }
    return statement;
  })) metric.unavailablePatches++;
  return Object.freeze({
    snapshot(): Readonly<SchemaScalarMetric> { return Object.freeze({ ...metric }); },
    restore(): void {
      if (restored) { if (owner.failure) throw owner.failure; return; } restored = true;
      // Restore methods only. This is never a Native/provider/body close ACK.
      // Failed first restoration retains its actual Native/prototype closures;
      // hooks refuse another qualification rather than retrying or forgetting it.
      const failures: unknown[] = [];
      for (const restore of restorers.reverse()) try { restore(); }
      catch (error) { metric.restorationFailures++; failures.push(error); }
      if (failures.length) {
        owner.failure = new AggregateError(failures, "Original schema scalar method restoration failed");
        throw owner.failure;
      }
      originalObservers.delete(owner);
    },
  });
}
