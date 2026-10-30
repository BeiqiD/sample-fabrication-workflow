// Passive qualification observer only. No SQL, bindings, rows or errors leave it.
import { writeSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { REFERENCE_FILTERED_DEPENDENCIES_CHECK_SQL, REFERENCE_FILTERED_DEPENDENCIES_SQL,
  REFERENCE_FILTERED_MODES_SQL } from "./collaboration/reference-filtered-read-sql";

type Method = (...args: unknown[]) => unknown;
type Sample = { statement: number; method: number; category: number; sqlLength: number;
  start: number; end: number; duration: number; failed: boolean };
type Patch = { target: WeakRef<object>; name: string; before: PropertyDescriptor | undefined; wrapper: Method };

export function observeOriginalReferenceNativeSql(native: DatabaseSync) {
  let active = true, stopped = false, ordinal = 0, faults = 0, overflow = 0, unpatched = 0;
  const records: Sample[] = [], slowest: Sample[] = [], patches: Patch[] = [];
  const totals = Array.from({ length: 10 }, (_, category) => ({ category, count: 0, total: 0, max: 0, failed: 0 }));
  const phases: { phase: number; at: number }[] = [];
  function now(): number { try { return performance.now(); } catch { faults++; return 0; } }
  function emit(value: unknown): void {
    try { writeSync(2, `[Reference original native SQL] ${JSON.stringify(value)}\n`); }
    catch { faults++; }
  }
  function descriptor(target: object, name: string): PropertyDescriptor | undefined {
    let owner: object | null = target;
    for (let depth = 0; owner && depth < 8; depth++, owner = Object.getPrototypeOf(owner)) {
      const found = Object.getOwnPropertyDescriptor(owner, name);
      if (found) return found;
    }
    return undefined;
  }
  function category(sql: unknown): number {
    try {
    if (typeof sql !== "string") return 0;
    if (sql === REFERENCE_FILTERED_DEPENDENCIES_CHECK_SQL) return 4;
    if (sql === REFERENCE_FILTERED_MODES_SQL) return 5;
    if (sql === REFERENCE_FILTERED_DEPENDENCIES_SQL) return 6;
    if (sql.includes("FROM local_sessions")) return 1;
    if (sql.includes("FROM collaboration_identities i JOIN collaboration_members")) return 3;
    if (sql.includes("node_installation") || sql.includes("collaboration_control") || sql.includes("local_bootstrap")) return 2;
    if (sql.includes("current_member") || sql.includes("WITH member AS")) return 7;
    if (sql.includes("sqlite_schema") || /^\s*PRAGMA\b/i.test(sql)) return 9;
    return 8;
    } catch { faults++; return 0; }
  }
  function record(statement: number, method: number, kind: number, sqlLength: number, start: number, end: number, failed: boolean): void {
    try {
      if (!active) return;
      const sample = { statement, method, category: kind, sqlLength, start, end, duration: Math.max(0, end - start), failed };
      const total = totals[kind]!; total.count++; total.total += sample.duration; total.max = Math.max(total.max, sample.duration); total.failed += Number(failed);
      if (records.length < 256) records.push(sample); else overflow++;
      slowest.push(sample); slowest.sort((a, b) => b.duration - a.duration); if (slowest.length > 16) slowest.pop();
    } catch { faults++; }
  }
  // Only trusted original native objects are supplied. Lookup inspects data
  // descriptors, never invokes a method getter, and never changes a prototype.
  function patch(target: object, name: string, make: (original: Method) => Method): void {
    try {
      if (patches.length >= 4096) { unpatched++; return; }
      const before = Object.getOwnPropertyDescriptor(target, name), found = descriptor(target, name);
      if (!found || !("value" in found) || typeof found.value !== "function" || before?.configurable === false) { unpatched++; return; }
      const wrapper = make(found.value as Method);
      const owned = { target: new WeakRef(target), name, before, wrapper };
      patches.push(owned); // Restoration metadata is retained BEFORE mutation.
      Object.defineProperty(target, name, { value: wrapper, configurable: true,
        enumerable: before?.enumerable ?? found.enumerable ?? false, writable: before?.writable ?? found.writable ?? true });
    } catch { faults++; }
  }
  patch(native, "prepare", original => function(this: DatabaseSync, ...args: unknown[]) {
    if (!active) return Reflect.apply(original, this, args);
    const statementOrdinal = ++ordinal, start = now(); let failed = true, result: unknown;
    try { result = Reflect.apply(original, this, args); failed = false; }
    finally { const end = now(); record(statementOrdinal, 0, category(args[0]), typeof args[0] === "string" ? args[0].length : 0, start, end, failed); }
    // The SAME native Statement is returned. Instrumentation failures never
    // replace its original value, its methods' values, or the original Error.
    try {
      if (result && typeof result === "object") {
        const kind = category(args[0]), sqlLength = typeof args[0] === "string" ? args[0].length : 0;
        for (const [method, name] of ["columns", "get", "all", "run"].entries()) {
          patch(result, name, originalMethod => function(this: object, ...values: unknown[]) {
            if (!active) return Reflect.apply(originalMethod, this, values);
            const start = now(); let failed = true;
            try { const value = Reflect.apply(originalMethod, this, values); failed = false; return value; }
            finally { const end = now(); record(statementOrdinal, method + 1, kind, sqlLength, start, end, failed); }
          });
        }
      }
    } catch { faults++; }
    return result;
  });
  function phase(phase: number): void {
    try { if (active && phases.length < 32) { const sample = { phase, at: now() }; phases.push(sample); emit({ kind: 0, ...sample }); } }
    catch { faults++; }
  }
  function stop(): void {
    if (stopped) return;
    stopped = true; active = false;
    let restored = 0, collected = 0, changed = 0;
    for (let index = patches.length - 1; index >= 0; index--) {
      const owned = patches[index]!;
      try {
        const target = owned.target.deref(); if (!target) { collected++; continue; }
        const current = Object.getOwnPropertyDescriptor(target, owned.name);
        if (!current || !("value" in current) || current.value !== owned.wrapper) { changed++; continue; }
        if (owned.before) Object.defineProperty(target, owned.name, owned.before);
        else if (!Reflect.deleteProperty(target, owned.name)) { faults++; continue; }
        restored++;
      } catch { faults++; }
    }
    emit({ kind: 1, records, slowest, totals, phases, statements: ordinal, overflow, unpatched,
      faults, patches: patches.length, restored, collected, changed,
      scope: 0 }); // scope 0: original search await cut; no original close ACK.
  }
  return Object.freeze({ phase, stop });
}
