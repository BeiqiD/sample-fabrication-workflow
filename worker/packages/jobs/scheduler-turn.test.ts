import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { futureActiveRuntimeDatabase } from "../../files/authority-runtime-test-support";
import { dispatchFileJobs } from "../../files/jobs/worker-runtime";
import { SqliteD1Database } from "../../reference-test-support";
import type { Env } from "../../types";
import { claimResearchSchedulerTurn } from "./scheduler-turn";
import { dispatchPackageJobs } from "./worker-runtime";

const databases: DatabaseSync[] = [];
let directory = "", pristine = "", childPath = "", nextFixture = 0;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "research-scheduler-turn-"));
  pristine = join(directory, "pristine.sqlite");
  const sql = futureActiveRuntimeDatabase(undefined, { throughMigration: "0024_rt3_local_volume_profiles.sql" });
  try {
    sql.exec(readFileSync(new URL("../../../migrations/0025_scheduler_fair_turn.sql", import.meta.url), "utf8"));
    sql.exec("UPDATE file_job_runtime_guard SET enabled=1,incarnation='scheduler-test'");
    await backup(sql, pristine);
  } finally { sql.close(); }
  const helperPath = join(directory, "scheduler-turn.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("./scheduler-turn.ts", import.meta.url))], outfile: helperPath,
    bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  childPath = join(directory, "claim-once.mjs");
  writeFileSync(childPath, `import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { claimResearchSchedulerTurn } from './scheduler-turn.mjs';
const sql = new DatabaseSync(process.argv[2]);
const db = { prepare(query) { const statement = sql.prepare(query); return {
  first: async () => statement.get() ?? null,
  bind(...values) { return { first: async () => statement.get(...values) ?? null }; }
}; } };
try { writeFileSync(process.argv[3], JSON.stringify({ pid: process.pid, result: await claimResearchSchedulerTurn(db) })); }
finally { sql.close(); }
`);
});
afterEach(() => {
  databases.splice(0).forEach(sql => sql.close());
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const path = join(directory, `scenario-${nextFixture++}.sqlite`);
  copyFileSync(pristine, path);
  const sql = new DatabaseSync(path); databases.push(sql);
  sql.exec("PRAGMA foreign_keys=ON");
  const database = new SqliteD1Database(sql), db = database as unknown as D1Database;
  return { sql, path, database, db };
}

function mutateAfterRuntimeRead(database: SqliteD1Database, mutate: () => void) {
  const prepare = database.prepare.bind(database);
  vi.spyOn(database, "prepare").mockImplementation(query => {
    const statement = prepare(query);
    if (query.startsWith("SELECT j.enabled,j.incarnation")) {
      const first = statement.first.bind(statement);
      vi.spyOn(statement, "first").mockImplementation(async () => {
        const row = await first(); mutate(); return row;
      });
    }
    return statement;
  });
}

describe("installation-local durable scheduler preference", () => {
  it("arbitrates overlapping claims on separate SQLite connections without lost turns", async () => {
    const f = fixture(), other = new DatabaseSync(f.path); databases.push(other);
    const second = new SqliteD1Database(other) as unknown as D1Database;
    const guardBefore = f.sql.prepare("SELECT * FROM file_job_runtime_guard").get()!;
    const turns = await Promise.all(Array.from({ length: 12 }, (_, index) => claimResearchSchedulerTurn(index % 2 ? second : f.db)));
    expect(turns.map(turn => turn.outcome)).toEqual(Array(12).fill("selected"));
    expect(turns.filter(turn => turn.outcome === "selected" && turn.queue === "package")).toHaveLength(6);
    expect(turns.filter(turn => turn.outcome === "selected" && turn.queue === "migration")).toHaveLength(6);
    expect(f.sql.prepare("SELECT * FROM file_job_runtime_guard").get()).toEqual(guardBefore);
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("continues the selected order across actual child-process termination and restart", () => {
    const f = fixture();
    const receipts = Array.from({ length: 4 }, (_, index) => {
      const resultPath = join(directory, `process-${index}.json`);
      execFileSync(process.execPath, [childPath, f.path, resultPath], { stdio: ["ignore", "pipe", "pipe"] });
      return JSON.parse(readFileSync(resultPath, "utf8"));
    });
    expect(new Set(receipts.map(receipt => receipt.pid)).size).toBe(4);
    expect(receipts.map(receipt => receipt.result)).toEqual(["package", "migration", "package", "migration"]
      .map(queue => ({ outcome: "selected", queue, incarnation: "scheduler-test" })));
  });

  it.each(["disabled", "authority", "incarnation"] as const)("does not claim after %s changes during the primary read", async change => {
    const f = fixture();
    mutateAfterRuntimeRead(f.database, () => {
      f.sql.exec(change === "disabled" ? "UPDATE file_job_runtime_guard SET enabled=0,incarnation=NULL"
        : change === "authority" ? "UPDATE file_authority_runtime_guard SET enabled=0"
          : "UPDATE file_job_runtime_guard SET incarnation='replacement'");
    });
    expect(await claimResearchSchedulerTurn(f.db)).toEqual({ outcome: "reconfigured" });
    expect(f.sql.prepare("SELECT next_queue FROM file_job_runtime_guard").get()!.next_queue).toBe("package");
  });

  it("does not consume a turn while File authority is disabled", async () => {
    const f = fixture(); f.sql.exec("UPDATE file_authority_runtime_guard SET enabled=0");
    expect(await claimResearchSchedulerTurn(f.db)).toEqual({ outcome: "paused" });
    expect(f.sql.prepare("SELECT next_queue FROM file_job_runtime_guard").get()!.next_queue).toBe("package");
  });

  it("does not retry a committed cursor UPDATE whose acknowledgement is lost", async () => {
    const f = fixture(), prepare = f.database.prepare.bind(f.database);
    const failure = new Error("lost cursor acknowledgement");
    vi.spyOn(f.database, "prepare").mockImplementation(query => {
      const statement = prepare(query);
      if (query.startsWith("UPDATE file_job_runtime_guard")) {
        const bind = statement.bind.bind(statement);
        vi.spyOn(statement, "bind").mockImplementation((...values) => {
          const bound = bind(...values), first = bound.first.bind(bound);
          vi.spyOn(bound, "first").mockImplementationOnce(async () => { await first(); throw failure; });
          return bound;
        });
      }
      return statement;
    });
    await expect(claimResearchSchedulerTurn(f.db)).rejects.toBe(failure);
    expect(f.sql.prepare("SELECT next_queue FROM file_job_runtime_guard").get()!.next_queue).toBe("migration");
    vi.restoreAllMocks();
    expect(await claimResearchSchedulerTurn(f.db)).toEqual({ outcome: "selected", queue: "migration", incarnation: "scheduler-test" });
  });

  it("rejects a scheduler's stale incarnation before either real dispatcher performs maintenance or updates heartbeat", async () => {
    const f = fixture();
    vi.stubGlobal("FixedLengthStream", class extends TransformStream {});
    const env = { DB: f.db, AUTH_MODE: "disabled" } as Env;
    const original = f.sql.prepare("SELECT * FROM file_job_runtime_guard").get();
    expect(await dispatchPackageJobs(env, "previous-incarnation")).toEqual({ jobId: null, outcome: "reconfigured" });
    expect(await dispatchFileJobs(env, "previous-incarnation")).toEqual({ jobId: null, outcome: "reconfigured" });
    expect(f.sql.prepare("SELECT * FROM file_job_runtime_guard").get()).toEqual(original);
  });

  it("reports an installation without File runtime tables as unsupported without creating anything", async () => {
    const sql = new DatabaseSync(":memory:"); databases.push(sql);
    expect(await claimResearchSchedulerTurn(new SqliteD1Database(sql) as unknown as D1Database)).toEqual({ outcome: "unsupported" });
    expect(sql.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
  });
});
