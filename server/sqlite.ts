import { originalNodeV28RecoverySqlPreparation, originalNodeV28RecoverySqlAdmission } from "./recovery/node-system-recovery-v28-application.ts";
import { ownedLocalPackageV28JobSqlScope, type LocalPackageV28JobSqlScope,
  type LocalUploadExecution } from "./files/local-upload-execution";
import type { LocalVolumeProfileOpening } from "./storage/local-volume-profile-opening";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { JobSqlDatabase, JobSqlStatement } from "../worker/files/jobs/sql-repository";
import type { ReadinessDatabase } from "../worker/runtime/sql";
import type { OfflineWriterFence } from "./auth/identity";

export type SqliteValue = null | string | number | bigint | Uint8Array;
export type SqliteRow = Record<string, SqliteValue>;
export interface SqliteResult {
  success: true;
  results: SqliteRow[];
  /** Native top-level and trigger-inclusive counts; neither is publication proof. */
  meta: { directChanges: number; totalChanges: number };
}
export interface SqliteStatement {
  bind(...values: unknown[]): SqliteStatement;
  first(): Promise<SqliteRow | null>;
  all(): Promise<SqliteResult>;
  run(): Promise<SqliteResult>;
}
export interface SqliteCapability {
  prepare(sql: string): SqliteStatement;
  batch(statements: readonly SqliteStatement[]): Promise<SqliteResult[]>;
  primary(): SqliteCapability;
  close(): void;
}
const connectionOwners = new WeakMap<SqliteCapability, DatabaseSync>();
declare const sqliteBatchAdmissionBrand: unique symbol;
/** Opaque, issued only for the actual core and its owned SELECT statements. */
export interface SqliteBatchAdmission { readonly [sqliteBatchAdmissionBrand]: true }
export interface SqliteBatchAdmissionCheck { readonly statement: SqliteStatement; readonly rejection: Error }
const batchAdmissions = new WeakMap<SqliteBatchAdmission, {
  owner: SqliteCapability; checks: readonly SqliteBatchAdmissionCheck[];
}>();
const admittedBatchOwners = new WeakMap<SqliteCapability, {
  issue(checks: readonly SqliteBatchAdmissionCheck[]): SqliteBatchAdmission;
  run(statements: readonly SqliteStatement[], checks: readonly SqliteBatchAdmissionCheck[]): SqliteResult[];
  deferredForeignKeys(): SqliteStatement;
}>();

/** Trusted composer-owned predicates only. This narrows actual statement
 * ownership; it does not infer any permission from a caller's SQL spelling. */
export function createSqliteBatchAdmission(core: SqliteCapability, checks: readonly SqliteBatchAdmissionCheck[]): SqliteBatchAdmission {
  const owner = admittedBatchOwners.get(core);
  if (!owner) throw new Error("SQLite batch admission owner is unavailable");
  return owner.issue(checks);
}
/** Join exactly two genuine receipts for this same actual core. No predicate,
 * SQL spelling, callback or caller-supplied authority escapes either receipt.
 * The original issuer revalidates every owned check and retains its existing
 * max-eight/native/active/Error bounds; this does not expand admission powers. */
export function joinSqliteBatchAdmissions(core: SqliteCapability,
  admissions: readonly [SqliteBatchAdmission, SqliteBatchAdmission]): SqliteBatchAdmission {
  const owner = admittedBatchOwners.get(core);
  if (!owner || !Array.isArray(admissions) || admissions.length !== 2)
    throw new Error("SQLite admission join requires exactly two issued receipts");
  // Capture the selected original receipts once before their private records.
  const first = batchAdmissions.get(admissions[0]), second = batchAdmissions.get(admissions[1]);
  if (!first || !second || first.owner !== core || second.owner !== core)
    throw new Error("SQLite admission join was not issued for this same owner");
  return owner.issue([...first.checks, ...second.checks]);
}
export async function runSqliteAdmittedBatch(core: SqliteCapability, statements: readonly SqliteStatement[], admission: SqliteBatchAdmission): Promise<SqliteResult[]> {
  const issued = batchAdmissions.get(admission), owner = admittedBatchOwners.get(core);
  if (!issued || issued.owner !== core || !owner) throw new Error("SQLite batch admission was not issued for this owner");
  return owner.run(statements, issued.checks);
}

/** Admission and a query capability must refer to the same actual connection. */
export function assertSqliteConnectionOwner(capability: SqliteCapability, database: DatabaseSync): void {
  if (connectionOwners.get(capability) !== database || !database.isOpen) throw new Error("SQLite capability connection owner mismatch or closed");
  capability.primary();
}

export function checkedSafeInteger(value: number | bigint, description = "SQL integer"): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || typeof value === "bigint" && BigInt(number) !== value) {
    throw new RangeError(`${description} is outside the exact JavaScript integer range`);
  }
  return number;
}
function input(value: unknown): SQLInputValue {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "bigint") {
    if (value < -(2n ** 63n) || value > 2n ** 63n - 1n) throw new RangeError("SQL integer is outside int64");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new RangeError("SQL number must be finite and integers must be exact");
    }
    return value;
  }
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  throw new TypeError("Unsupported SQL binding: use null, string, finite number, bigint or Uint8Array");
}
function row(value: Record<string, unknown>): SqliteRow {
  return Object.fromEntries(Object.entries(value).map(([key, cell]) => {
    if (cell === null || typeof cell === "string" || typeof cell === "bigint") return [key, cell];
    if (typeof cell === "number" && Number.isFinite(cell)) return [key, cell];
    if (cell instanceof Uint8Array) return [key, Uint8Array.from(cell)];
    throw new TypeError(`Unsupported SQLite cell in ${key}`);
  }));
}
function skipWhitespaceAndComments(sql: string, start: number): number {
  let cursor = start;
  while (cursor < sql.length) {
    if (/\s/.test(sql[cursor]!)) { cursor++; continue; }
    if (sql.startsWith("--", cursor)) { const end = sql.indexOf("\n", cursor + 2); cursor = end < 0 ? sql.length : end + 1; continue; }
    if (sql.startsWith("/*", cursor)) {
      const end = sql.indexOf("*/", cursor + 2);
      if (end < 0) throw new TypeError("Unterminated SQL comment");
      cursor = end + 2; continue;
    }
    break;
  }
  return cursor;
}
/** Single code-owned statements only. Connection/transaction policy is not SQL input. */
function checkedSql(sql: string): string {
  if (typeof sql !== "string") throw new TypeError("SQL text is required");
  const start = skipWhitespaceAndComments(sql, 0), keyword = /^[A-Za-z]+/.exec(sql.slice(start))?.[0].toUpperCase();
  if (!keyword) throw new TypeError("SQL text is required");
  if (["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE", "PRAGMA", "ATTACH", "DETACH", "VACUUM"].includes(keyword)) {
    throw new TypeError("Connection and transaction SQL requires the privileged composer");
  }
  let quote: string | undefined;
  for (let cursor = start; cursor < sql.length; cursor++) {
    const character = sql[cursor]!;
    if (quote) {
      if (character === quote) {
        if (sql[cursor + 1] === quote && quote !== "]") cursor++;
        else quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
    if (character === "[") { quote = "]"; continue; }
    if (sql.startsWith("--", cursor)) { const end = sql.indexOf("\n", cursor + 2); cursor = end < 0 ? sql.length : end; continue; }
    if (sql.startsWith("/*", cursor)) {
      const end = sql.indexOf("*/", cursor + 2);
      if (end < 0) throw new TypeError("Unterminated SQL comment");
      cursor = end + 1; continue;
    }
    if (character === ";") {
      if (skipWhitespaceAndComments(sql, cursor + 1) !== sql.length) throw new TypeError("Only one SQL statement is allowed");
      break;
    }
  }
  return sql;
}

/** The trusted composer supplies an owned file-backed connection opened with
 * allowExtension:false. This slice does not provision paths/installation IDs,
 * register SQL functions, apply migrations, or qualify WAL backup handling. */
export function createSqliteCapability(database: DatabaseSync, options: { busyTimeoutMs?: number } = {}): SqliteCapability {
  const timeout = options.busyTimeoutMs ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 5000) throw new RangeError("Busy timeout must be bounded to 1–5000 ms");
  if (!database.isOpen || database.isTransaction) throw new Error("SQLite connection must be open without an active transaction");
  database.enableLoadExtension(false);
  database.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${timeout}`);
  const mode = database.prepare("PRAGMA journal_mode=WAL").get();
  if (mode?.journal_mode !== "wal") throw new Error("File-backed SQLite WAL is required");
  const records = new WeakMap<SqliteStatement, { sql: string; values: SQLInputValue[]; deferredForeignKeys: boolean }>();
  let closed = false, inBatch = false, quarantined = false;
  let closeAttempted = false, closeRejected = false, firstCloseFailure: unknown;
  const active = () => {
    if (closed || !database.isOpen) throw new Error("SQLite capability is closed");
    if (quarantined) throw new Error("SQLite capability is quarantined after uncertain rollback");
    if (database.isTransaction && !inBatch) throw new Error("SQLite connection has an unowned transaction");
  };
  const integer = (sql: string): bigint => {
    const native = database.prepare(sql); native.setReadBigInts(true);
    const cell = Object.values(native.get()!)[0];
    if (typeof cell !== "bigint") throw new TypeError("Expected exact SQLite integer");
    return cell;
  };
  const execute = (statement: SqliteStatement): SqliteResult => {
    active();
    const record = records.get(statement);
    if (!record) throw new Error("Foreign SQLite statement");
    if (record.deferredForeignKeys && !inBatch) throw new Error("Deferred foreign keys require the original atomic batch");
    const native = database.prepare(record.sql); native.setReadBigInts(true);
    const before = integer("SELECT total_changes()"), returnsRows = native.columns().length > 0;
    const results = returnsRows ? native.all(...record.values).map(row) : (native.run(...record.values), []);
    const total = integer("SELECT total_changes()") - before;
    // A SELECT/DDL must not inherit changes() from an earlier write. No UDFs
    // or hidden write surface is installed by this code-owned composition.
    const direct = total === 0n ? 0n : integer("SELECT changes()");
    return { success: true, results, meta: {
      directChanges: checkedSafeInteger(direct, "Direct change count"),
      totalChanges: checkedSafeInteger(total, "Total change count"),
    } };
  };
  const statement = (sql: string, values: SQLInputValue[] = [], deferredForeignKeys = false): SqliteStatement => {
    active();
    if (deferredForeignKeys) {
      if (sql !== "PRAGMA defer_foreign_keys=ON" || values.length) throw new Error("Foreign deferred-FK directive");
    } else checkedSql(sql);
    const wrapped: SqliteStatement = {
      bind(...bindings) { return statement(sql, bindings.map(input), deferredForeignKeys); },
      async first() { return execute(wrapped).results[0] ?? null; },
      async all() { return execute(wrapped); },
      async run() { return execute(wrapped); },
    };
    records.set(wrapped, { sql, values, deferredForeignKeys }); return wrapped;
  };
  const runBatch = (statements: readonly SqliteStatement[], checks: readonly SqliteBatchAdmissionCheck[]): SqliteResult[] => {
    active();
    if (!Array.isArray(statements)) throw new Error("Foreign SQLite statement");
    const originalStatements = [...statements];
    if (originalStatements.some(item => !records.has(item))) throw new Error("Foreign SQLite statement");
    const directives = originalStatements.filter(item => records.get(item)!.deferredForeignKeys);
    if (directives.length && (directives.length !== 1 || !checks.length))
      throw new Error("Deferred foreign keys require one issued directive and admission");
    if (!originalStatements.length && !checks.length) return [];
    database.exec("BEGIN IMMEDIATE"); inBatch = true;
    try {
      // The guard is INSIDE the actual transaction that excludes independent
      // SQLite writers, before any original mutation. No await or callback.
      for (const check of checks) {
        const result = execute(check.statement), selected = result.results[0];
        if (result.results.length !== 1 || !selected || Object.keys(selected).length !== 1
          || selected.admitted !== 1n) throw check.rejection;
      }
      const results = originalStatements.map(execute);
      database.exec("COMMIT"); return results;
    } catch (error) {
      try { database.exec("ROLLBACK"); }
      catch (rollbackError) {
        quarantined = true;
        throw new AggregateError([error, rollbackError], "Batch and rollback failed");
      }
      // Fixed typed guard errors retain identity after confirmed rollback.
      throw error;
    } finally { inBatch = false; }
  };
  const capability: SqliteCapability = {
    prepare(sql) { return statement(sql); },
    async batch(statements) { return runBatch(statements, []); },
    primary() { active(); return capability; },
    close() {
      if (closeAttempted) { if (closeRejected) throw firstCloseFailure; return; }
      closeAttempted = true; // Cache even close-then-throw; native state cannot erase a failed ACK.
      try {
        // A privileged maintenance owner may have closed this same native
        // before the FIRST close attempt. This existing path remains allowed.
        if (!database.isOpen) { closed = true; return; }
        if (!quarantined) active();
        database.close();
        if (database.isOpen) throw new Error("SQLite native close acknowledgement is unavailable");
        closed = true;
      } catch (error) {
        quarantined = true; closeRejected = true; firstCloseFailure = error;
        throw error; // Repeated close retains the exact first outcome; no retry.
      }
    },
  };
  connectionOwners.set(capability, database);
  admittedBatchOwners.set(capability, {
    issue(checks) {
      active();
      if (!Array.isArray(checks) || !checks.length || checks.length > 8) throw new Error("SQLite admission requires bounded owned checks");
      const captured = checks.map(check => {
        const { statement: selected, rejection } = check, record = records.get(selected);
        if (!record || !/^\s*SELECT\b/i.test(record.sql) || !(rejection instanceof Error)) throw new Error("SQLite admission requires owned code-selected read checks");
        return Object.freeze({ statement: selected, rejection });
      });
      const admission = Object.freeze({}) as SqliteBatchAdmission;
      batchAdmissions.set(admission, { owner: capability, checks: Object.freeze(captured) });
      return admission;
    },
    run: runBatch,
    deferredForeignKeys: () => statement("PRAGMA defer_foreign_keys=ON", [], true),
  });
  return capability;
}

/** Exact cells remain in the core. The existing job domain expects safe Number
 * integers, so this explicit compatibility view checks every conversion. */
export function asJobSqlDatabase(core: SqliteCapability): JobSqlDatabase {
  return jobSqlDatabase(core);
}
/** Trusted same-core package publisher adapter only. Every operation captures
 * fresh issued SQL admission; only this private view recognizes the existing
 * formatter's fixed deferred-FK directive at its declared ordinal in one atomic batch.
 * It cannot run connection PRAGMA or infer actor/provider permission from SQL. */
export function asAdmittedJobSqlDatabase(core: SqliteCapability,
  admission: () => SqliteBatchAdmission, owner: OfflineWriterFence): JobSqlDatabase {
  return jobSqlDatabase(core, admission, owner);
}
const packagePreparationOwners = new WeakMap<JobSqlDatabase,
  ReturnType<typeof ownedLocalPackageV28JobSqlScope>["preparation"]>();
/** New issuance only from the original private consumed V28 Package frame.
 * No caller core/admission/assertion callback or generic-view attachment is
 * accepted. Every actual execution and primary keeps its original full fence. */
export function asLocalPackageV28JobSqlDatabase(scope: LocalPackageV28JobSqlScope,
  execution: LocalUploadExecution, opening: LocalVolumeProfileOpening): JobSqlDatabase {
  const original = ownedLocalPackageV28JobSqlScope(scope, execution, opening);
  original.fullFence.assertHeld();
  const view = jobSqlDatabase(original.database, original.admission, original.fullFence);
  packagePreparationOwners.set(view, original.preparation); return Object.freeze(view);
}
function jobSqlDatabase(core: SqliteCapability, admission?: () => SqliteBatchAdmission,
  owner?: OfflineWriterFence): JobSqlDatabase {
  const held = owner?.assertHeld.bind(owner);
  const assertHeld = () => {
    const answer: unknown = held?.();
    if (answer !== undefined) {
      if (answer instanceof Promise) void answer.catch(() => undefined);
      throw new TypeError("Job SQL owner assertion must be synchronous");
    }
  };
  const recoveryPreparing = originalNodeV28RecoverySqlPreparation(core, admission, owner);
  const recoveryAdmitting = originalNodeV28RecoverySqlAdmission(core, admission, owner);
  const assertPreparing = () => {
    const preparation = packagePreparationOwners.get(view);
    if (!preparation && recoveryPreparing) {
      const answer: unknown = recoveryPreparing();
      if (answer !== undefined) {
        if (answer instanceof Promise) void answer.catch(() => undefined);
        throw new TypeError("Recovery SQL preparation assertion must be synchronous");
      }
      core.primary(); return;
    }
    if (!preparation) return assertHeld();
    const answer: unknown = preparation.assertHeld();
    if (answer !== undefined) {
      if (answer instanceof Promise) void answer.catch(() => undefined);
      throw new TypeError("Package SQL preparation assertion must be synchronous");
    }
    core.primary();
  };
  const execute = async (items: readonly SqliteStatement[]) => {
    let selectedAdmission: SqliteBatchAdmission | undefined;
    if (recoveryAdmitting) selectedAdmission = recoveryAdmitting();
    else { assertHeld(); selectedAdmission = admission?.(); }
    // Admission-function presence retains the original fail-closed behavior
    // even if an unregistered caller returns an invalid or missing receipt.
    const result = admission ? await runSqliteAdmittedBatch(core, items, selectedAdmission!) : await core.batch(items);
    assertHeld(); return result;
  };
  const statements = new WeakMap<JobSqlStatement, SqliteStatement>();
  const safeRow = (value: SqliteRow) => Object.fromEntries(Object.entries(value).map(([key, cell]) =>
    [key, typeof cell === "bigint" ? checkedSafeInteger(cell, `Column ${key}`) : cell]));
  const wrap = (native: SqliteStatement): JobSqlStatement => {
    const wrapped: JobSqlStatement = {
      bind(...values) {
        if (packagePreparationOwners.has(view) || recoveryPreparing) assertPreparing();
        return wrap(native.bind(...values));
      },
      async first<T>() { const value = admission ? (await execute([native]))[0]!.results[0] ?? null : await native.first(); return value === null ? null : safeRow(value) as T; },
      async all<T>() { return { results: (admission ? (await execute([native]))[0]! : await native.all()).results.map(safeRow) as T[] }; },
      run() { return admission ? execute([native]).then(results => results[0]!) : native.run(); },
    };
    statements.set(wrapped, native); return wrapped;
  };
  const view: JobSqlDatabase = {
    prepare(sql) {
      // The fixed privileged directive still takes the original full guard
      // and admission path. All other prepares only create core SQL records.
      if ((packagePreparationOwners.has(view) || recoveryPreparing) && sql !== "PRAGMA defer_foreign_keys=ON") assertPreparing();
      else assertHeld();
      if (admission && sql === "PRAGMA defer_foreign_keys=ON") {
        const receipt = batchAdmissions.get(admission()), original = admittedBatchOwners.get(core);
        if (!receipt || receipt.owner !== core || !receipt.checks.length || !original)
          throw new Error("Deferred-FK package admission is unavailable");
        return wrap(original.deferredForeignKeys());
      }
      return wrap(core.prepare(sql));
    },
    async batch(items) {
      return execute(items.map(item => {
        const native = statements.get(item); if (!native) throw new Error("Foreign JobSqlDatabase statement"); return native;
      }));
    },
    primary() {
      // Selecting the same original core records no SQL or native I/O. Only
      // the actual registered Recovery view can use its construction proof.
      if (recoveryPreparing && !packagePreparationOwners.has(view)) assertPreparing();
      else assertHeld();
      core.primary(); return view;
    },
  };
  return view;
}

export function asReadinessDatabase(core: SqliteCapability): ReadinessDatabase {
  return { prepare(sql) {
    const native = core.prepare(sql);
    return { async first<T>() { return await native.first() as T | null; } };
  } };
}
