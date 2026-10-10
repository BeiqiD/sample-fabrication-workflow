import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { JobSqlDatabase, JobSqlStatement } from "../worker/files/jobs/sql-repository";
import type { ReadinessDatabase } from "../worker/runtime/sql";

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
  const records = new WeakMap<SqliteStatement, { sql: string; values: SQLInputValue[] }>();
  let closed = false, inBatch = false;
  const active = () => {
    if (closed || !database.isOpen) throw new Error("SQLite capability is closed");
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
  const statement = (sql: string, values: SQLInputValue[] = []): SqliteStatement => {
    active(); checkedSql(sql);
    const wrapped: SqliteStatement = {
      bind(...bindings) { return statement(sql, bindings.map(input)); },
      async first() { return execute(wrapped).results[0] ?? null; },
      async all() { return execute(wrapped); },
      async run() { return execute(wrapped); },
    };
    records.set(wrapped, { sql, values }); return wrapped;
  };
  const capability: SqliteCapability = {
    prepare: statement,
    async batch(statements) {
      active();
      if (!Array.isArray(statements) || statements.some(item => !records.has(item))) throw new Error("Foreign SQLite statement");
      if (!statements.length) return [];
      database.exec("BEGIN IMMEDIATE"); inBatch = true;
      try {
        // No await: provider/object I/O cannot occur inside this transaction.
        const results = statements.map(execute);
        database.exec("COMMIT"); return results;
      } catch (error) {
        try { database.exec("ROLLBACK"); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], "Batch and rollback failed"); }
        throw error;
      } finally { inBatch = false; }
    },
    primary() { active(); return capability; },
    close() { if (!closed) { active(); database.close(); closed = true; } },
  };
  return capability;
}

/** Exact cells remain in the core. The existing job domain expects safe Number
 * integers, so this explicit compatibility view checks every conversion. */
export function asJobSqlDatabase(core: SqliteCapability): JobSqlDatabase {
  const statements = new WeakMap<JobSqlStatement, SqliteStatement>();
  const safeRow = (value: SqliteRow) => Object.fromEntries(Object.entries(value).map(([key, cell]) =>
    [key, typeof cell === "bigint" ? checkedSafeInteger(cell, `Column ${key}`) : cell]));
  const wrap = (native: SqliteStatement): JobSqlStatement => {
    const wrapped: JobSqlStatement = {
      bind(...values) { return wrap(native.bind(...values)); },
      async first<T>() { const value = await native.first(); return value === null ? null : safeRow(value) as T; },
      async all<T>() { return { results: (await native.all()).results.map(safeRow) as T[] }; },
      run() { return native.run(); },
    };
    statements.set(wrapped, native); return wrapped;
  };
  const view: JobSqlDatabase = {
    prepare(sql) { return wrap(core.prepare(sql)); },
    async batch(items) {
      return core.batch(items.map(item => {
        const native = statements.get(item); if (!native) throw new Error("Foreign JobSqlDatabase statement"); return native;
      }));
    },
    primary() { core.primary(); return view; },
  };
  return view;
}

export function asReadinessDatabase(core: SqliteCapability): ReadinessDatabase {
  return { prepare(sql) {
    const native = core.prepare(sql);
    return { async first<T>() { return await native.first() as T | null; } };
  } };
}
