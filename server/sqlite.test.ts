import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqlFileJobRepository } from "../worker/files/jobs/sql-repository";
import { checkDatabaseReadiness } from "../worker/platform/readiness";
import { asJobSqlDatabase, asReadinessDatabase, checkedSafeInteger, createSqliteCapability, type SqliteCapability } from "./sqlite";

const fixtures: Array<{ directory: string; database: DatabaseSync; core: SqliteCapability }> = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    if (f.database.isOpen) {
      if (f.database.isTransaction) f.database.exec("ROLLBACK");
      expect(f.database.prepare("PRAGMA quick_check").get()!.quick_check).toBe("ok");
      expect(f.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      f.core.close();
    }
    rmSync(f.directory, { recursive: true });
  }
});
function fixture(timeout = 100) {
  const directory = mkdtempSync(join(tmpdir(), "rt2-sqlite-core-"));
  const path = join(directory, "application.sqlite");
  const database = new DatabaseSync(path, { allowExtension: false });
  const core = createSqliteCapability(database, { busyTimeoutMs: timeout });
  database.exec(`CREATE TABLE business(id INTEGER PRIMARY KEY,value TEXT UNIQUE,stamp INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE audit(value TEXT); CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES business(id));`);
  const result = { directory, path, database, core }; fixtures.push(result); return result;
}

describe("exact file-backed SQLite capability", () => {
  it("enforces actual WAL, foreign-key and bounded timeout policy without enabling extensions", () => {
    const f = fixture();
    expect(f.database.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("wal");
    expect(f.database.prepare("PRAGMA foreign_keys").get()!.foreign_keys).toBe(1);
    expect(f.database.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(100);
    expect(() => f.database.enableLoadExtension(true)).toThrow();
    for (const timeout of [0, -1, 5001, 1.5, NaN]) expect(() => createSqliteCapability(f.database, { busyTimeoutMs: timeout })).toThrow(RangeError);
  });

  it("rejects a memory connection and an existing unowned transaction", () => {
    const memory = new DatabaseSync(":memory:", { allowExtension: false });
    try { expect(() => createSqliteCapability(memory)).toThrow("File-backed SQLite WAL"); }
    finally { memory.close(); }
    const f = fixture(); f.database.exec("BEGIN IMMEDIATE");
    expect(() => createSqliteCapability(f.database)).toThrow("without an active transaction");
    expect(() => f.core.primary()).toThrow("unowned transaction");
    expect(f.database.isTransaction).toBe(true); f.database.exec("ROLLBACK");
  });

  it("preserves exact integer, real, text, null and snapshotted byte cells", async () => {
    const f = fixture(), bytes = new Uint8Array([0, 1, 255]);
    const statement = f.core.prepare("SELECT ? AS wide,? AS real,? AS text,? AS empty,? AS bytes")
      .bind(9_007_199_254_740_993n, 2.5, "验证", null, bytes);
    bytes.fill(9);
    expect(await statement.first()).toEqual({ wide: 9_007_199_254_740_993n, real: 2.5, text: "验证", empty: null, bytes: new Uint8Array([0, 1, 255]) });
    expect(await f.core.prepare("SELECT CAST(? AS TEXT) AS decimal").bind(9_223_372_036_854_775_807n).first())
      .toEqual({ decimal: "9223372036854775807" });
    expect(() => checkedSafeInteger(9_007_199_254_740_993n)).toThrow(RangeError);
    expect(checkedSafeInteger(42n)).toBe(42);
  });

  it.each([undefined, true, {}, [], Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, 2n ** 63n, -(2n ** 63n) - 1n])(
    "rejects unsupported or unsafe binding %# before execution", async value => {
      const f = fixture();
      expect(() => f.core.prepare("INSERT INTO business(id,value) VALUES(1,?)").bind(value)).toThrow();
      expect(await f.core.prepare("SELECT count(*) AS n FROM business").first()).toEqual({ n: 0n });
    });

  it("keeps bound statements immutable when a sibling replaces its bindings", async () => {
    const f = fixture(), base = f.core.prepare("SELECT ? AS value");
    const a = base.bind("first"), b = a.bind("second");
    expect(await a.first()).toEqual({ value: "first" }); expect(await b.first()).toEqual({ value: "second" });
  });

  it("preserves trigger-inclusive counts separately from direct INSERT and UPDATE counts", async () => {
    const f = fixture();
    f.database.exec(`CREATE TRIGGER business_insert AFTER INSERT ON business BEGIN INSERT INTO audit VALUES('insert-a'); INSERT INTO audit VALUES('insert-b'); END;
      CREATE TRIGGER business_update AFTER UPDATE ON business BEGIN INSERT INTO audit VALUES('update-a'); INSERT INTO audit VALUES('update-b'); END;`);
    const insert = await f.core.prepare("INSERT INTO business(id,value) VALUES(1,'initial') RETURNING id,value").run();
    expect(insert.results).toEqual([{ id: 1n, value: "initial" }]); expect(insert.meta).toEqual({ directChanges: 1, totalChanges: 3 });
    const update = await f.core.prepare("UPDATE business SET value='updated' WHERE id=1 RETURNING id,value").all();
    expect(update.results).toEqual([{ id: 1n, value: "updated" }]); expect(update.meta).toEqual({ directChanges: 1, totalChanges: 3 });
    expect(await f.core.prepare("SELECT count(*) AS n FROM audit").first()).toEqual({ n: 4n });
  });

  it("reports zero direct changes when a BEFORE trigger writes and then ignores the business write", async () => {
    const f = fixture();
    f.database.exec("CREATE TRIGGER business_ignore BEFORE INSERT ON business BEGIN INSERT INTO audit VALUES('ignored'); SELECT RAISE(IGNORE); END");
    const result = await f.core.prepare("INSERT INTO business VALUES(1,'ignored',0) RETURNING id").run();
    expect(result.results).toEqual([]); expect(result.meta).toEqual({ directChanges: 0, totalChanges: 1 });
    expect(await f.core.prepare("SELECT count(*) n FROM business").first()).toEqual({ n: 0n });
  });

  it("does not inherit a previous mutation count for a read or a guarded zero-row UPDATE", async () => {
    const f = fixture(); await f.core.prepare("INSERT INTO business VALUES(1,'first',0)").run();
    expect((await f.core.prepare("SELECT * FROM business").all()).meta).toEqual({ directChanges: 0, totalChanges: 0 });
    const guarded = await f.core.prepare("UPDATE business SET value='wrong' WHERE id=99 RETURNING id").run();
    expect(guarded.results).toEqual([]); expect(guarded.meta).toEqual({ directChanges: 0, totalChanges: 0 });
  });

  it("fully consumes RETURNING while preserving its pre-AFTER-trigger field semantics", async () => {
    const f = fixture();
    f.database.exec("CREATE TRIGGER business_stamp AFTER INSERT ON business BEGIN UPDATE business SET stamp=1 WHERE id=NEW.id; END");
    const result = await f.core.prepare("INSERT INTO business VALUES(1,'first',0) RETURNING id,stamp").first();
    expect(result).toEqual({ id: 1n, stamp: 0n });
    expect(await f.core.primary().prepare("SELECT stamp FROM business WHERE id=1").first()).toEqual({ stamp: 1n });
  });

  it("does not publish last_insert_rowid as the identity of an unrelated UPDATE", async () => {
    const f = fixture();
    f.database.exec("INSERT INTO business VALUES(1,'first',0); CREATE TABLE receipt(id INTEGER PRIMARY KEY); INSERT INTO receipt VALUES(42)");
    const update = await f.core.prepare("UPDATE business SET value='second' WHERE id=1 RETURNING id").run();
    expect(update.results).toEqual([{ id: 1n }]); expect(Object.keys(update.meta)).toEqual(["directChanges", "totalChanges"]);
    expect(await f.core.prepare("SELECT last_insert_rowid() n").first()).toEqual({ n: 42n });
  });

  it.each(["unique", "foreign key"])("rolls back earlier business and trigger effects on a late %s failure", async kind => {
    const f = fixture();
    f.database.exec("CREATE TRIGGER business_audit AFTER INSERT ON business BEGIN INSERT INTO audit VALUES('attempt'); END");
    const first = f.core.prepare("INSERT INTO business VALUES(1,'first',0)");
    const failed = kind === "unique" ? f.core.prepare("INSERT INTO business VALUES(2,'first',0)") : f.core.prepare("INSERT INTO child VALUES(1,99)");
    await expect(f.core.batch([first, failed])).rejects.toThrow();
    expect(f.database.isTransaction).toBe(false);
    expect(await f.core.prepare("SELECT count(*) n FROM business").first()).toEqual({ n: 0n });
    expect(await f.core.prepare("SELECT count(*) n FROM audit").first()).toEqual({ n: 0n });
    // Native total_changes still includes attempted effects after rollback;
    // no successful batch metadata or publication receipt was returned.
    expect(f.database.prepare("SELECT total_changes() n").get()!.n).toBeGreaterThan(0);
  });

  it("rejects foreign statements before opening a transaction", async () => {
    const a = fixture(), b = fixture();
    await expect(a.core.batch([a.core.prepare("INSERT INTO business VALUES(1,'first',0)"), b.core.prepare("SELECT 1")])).rejects.toThrow("Foreign SQLite statement");
    expect(a.database.isTransaction).toBe(false);
    expect(await a.core.prepare("SELECT count(*) n FROM business").first()).toEqual({ n: 0n });
  });

  it("rejects embedded transaction/connection control and multiple statements while preserving quoted semicolons", async () => {
    const f = fixture();
    for (const sql of ["BEGIN", "-- leading comment\nCOMMIT", "/* comment */ SAVEPOINT a", "PRAGMA foreign_keys=OFF", "ATTACH 'other' AS extra", "SELECT 1; COMMIT", "SELECT 1; SELECT 2"]) {
      expect(() => f.core.prepare(sql)).toThrow(TypeError);
    }
    expect(await f.core.prepare("SELECT 'literal;COMMIT' AS value; /* trailing */").first()).toEqual({ value: "literal;COMMIT" });
    expect(await f.core.prepare("SELECT 1 AS [semi;literal]").first()).toEqual({ "semi;literal": 1n });
    expect(f.database.isTransaction).toBe(false);
  });

  it("commits a synchronous batch before returning its Promise and reconciles a lost caller acknowledgement", async () => {
    const f = fixture();
    const pending = f.core.batch([f.core.prepare("INSERT INTO business VALUES(1,'receipt',0) RETURNING id")]);
    expect(f.database.isTransaction).toBe(false);
    expect(f.database.prepare("SELECT value FROM business").get()!.value).toBe("receipt");
    await expect(pending.then(() => { throw new Error("Caller acknowledgement lost"); })).rejects.toThrow("acknowledgement lost");
    expect(await f.core.primary().prepare("SELECT id,value FROM business").first()).toEqual({ id: 1n, value: "receipt" });
    const other = new DatabaseSync(f.path, { readOnly: true, allowExtension: false });
    try { expect(other.prepare("SELECT value FROM business").get()!.value).toBe("receipt"); } finally { other.close(); }
  });

  it("retains durable identity across actual connection restart and rejects closed statements", async () => {
    const f = fixture(), statement = f.core.prepare("SELECT * FROM business");
    await f.core.prepare("INSERT INTO business VALUES(1,'persisted',0)").run(); f.core.close();
    await expect(statement.first()).rejects.toThrow("closed"); expect(() => f.core.prepare("SELECT 1")).toThrow("closed");
    const database = new DatabaseSync(f.path, { allowExtension: false });
    const reopened = createSqliteCapability(database, { busyTimeoutMs: 100 });
    try { expect(await reopened.prepare("SELECT id,value FROM business").first()).toEqual({ id: 1n, value: "persisted" }); }
    finally { reopened.close(); }
  });

  it("exposes the existing readiness port without creating a Cloudflare environment", async () => {
    const f = fixture(); await expect(checkDatabaseReadiness(asReadinessDatabase(f.core))).resolves.toBeUndefined();
  });

  it("bounds contention against another real process and observes its fresh committed state", async () => {
    const f = fixture(); f.database.exec("INSERT INTO business VALUES(1,'initial',0)");
    const code = `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1],{allowExtension:false});
      db.exec("PRAGMA busy_timeout=100;BEGIN IMMEDIATE;UPDATE business SET value='child' WHERE id=1");
      process.stdout.write('locked\\n');process.stdin.once('data',()=>{db.exec('COMMIT');db.close();process.exit(0)});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, f.path], { stdio: ["pipe", "pipe", "pipe"] });
    const completed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    try {
      await new Promise<void>((resolve, reject) => {
        let received = "";
        const cleanup = () => {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          child.off("exit", onExit);
          child.off("error", onError);
        };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onExit = () => onError(new Error("Lock owner exited before handshake"));
        const onData = (data: Buffer) => {
          received += data.toString();
          const newline = received.indexOf("\n");
          if (newline < 0) return;
          if (received.slice(0, newline) !== "locked") {
            onError(new Error("Unexpected child handshake")); return;
          }
          cleanup(); resolve();
        };
        const timer = setTimeout(() => onError(new Error("Lock owner handshake timed out")), 5000);
        child.stdout.on("data", onData);
        child.once("exit", onExit);
        child.once("error", onError);
      });
      expect(await f.core.primary().prepare("SELECT value FROM business").first()).toEqual({ value: "initial" });
      const started = performance.now();
      await expect(f.core.prepare("UPDATE business SET value='blocked' WHERE id=1").run()).rejects.toThrow(/locked|busy/i);
      const duration = performance.now() - started; expect(duration).toBeGreaterThanOrEqual(50); expect(duration).toBeLessThan(2000);
      child.stdin.end("release\n"); expect(await completed).toBe(0);
      expect(await f.core.primary().prepare("SELECT value FROM business").first()).toEqual({ value: "child" });
      expect((await f.core.prepare("UPDATE business SET value='settled' WHERE id=1").run()).meta.directChanges).toBe(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await completed; }
    }
  }, 15_000);
});

describe("checked existing JobSqlDatabase compatibility view", () => {
  it("keeps exact BigInts in the core and safe Numbers in the actual File job repository", async () => {
    const f = fixture();
    f.database.exec("CREATE TABLE file_job_runtime_guard(singleton INTEGER PRIMARY KEY,enabled INTEGER,incarnation TEXT,last_heartbeat_at TEXT);INSERT INTO file_job_runtime_guard VALUES(1,1,'fixture-incarnation',NULL)");
    const sql = asJobSqlDatabase(f.core), at = new Date("2026-10-10T14:00:00.000Z");
    const repository = new SqlFileJobRepository(sql, () => at, () => "fixture-id");
    expect(await repository.executorStatus()).toMatchObject({ enabled: true, stale: true, cadenceSeconds: 120, maxFilesPerStep: 1, maxStepMs: 60_000 });
    await repository.heartbeat("fixture-incarnation");
    expect(await repository.executorStatus()).toMatchObject({ enabled: true, stale: false, lastHeartbeatAt: at.toISOString() });
    expect(await f.core.prepare("SELECT enabled FROM file_job_runtime_guard").first()).toEqual({ enabled: 1n });
    expect(await sql.prepare("SELECT enabled FROM file_job_runtime_guard").first()).toEqual({ enabled: 1 });
    await expect(sql.prepare("SELECT CAST('9007199254740993' AS INTEGER) wide").first()).rejects.toThrow("exact JavaScript integer range");
  });

  it("keeps view statement ownership and atomic batches tied to their actual connection", async () => {
    const a = fixture(), b = fixture(), first = asJobSqlDatabase(a.core), second = asJobSqlDatabase(b.core);
    await expect(first.batch([first.prepare("INSERT INTO business VALUES(1,'first',0)"), second.prepare("SELECT 1")])).rejects.toThrow("Foreign JobSqlDatabase statement");
    expect(a.database.isTransaction).toBe(false);
    expect(await first.primary().prepare("SELECT count(*) n FROM business").first()).toEqual({ n: 0 });
    await expect(first.batch([first.prepare("INSERT INTO business VALUES(1,'first',0)"), first.prepare("INSERT INTO business VALUES(2,'first',0)")])).rejects.toThrow();
    expect(await first.prepare("SELECT count(*) n FROM business").first()).toEqual({ n: 0 });
  });
});
