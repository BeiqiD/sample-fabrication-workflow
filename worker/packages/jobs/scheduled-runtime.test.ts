import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { futureActiveRuntimeDatabase } from "../../files/authority-runtime-test-support";
import { referenceTestDatabase, SqliteD1Database } from "../../reference-test-support";
import { runSourceScheduledWriters } from "../../recovery/maintenance";
import type { Env } from "../../types";

const mocks = vi.hoisted(() => ({ file: vi.fn(), packages: vi.fn() }));
vi.mock("../../files/jobs/worker-runtime", () => ({ dispatchFileJobs: mocks.file }));
vi.mock("./worker-runtime", () => ({ dispatchPackageJobs: mocks.packages }));
import { dispatchResearchAndFileJobs } from "./scheduled-runtime";

const databases: ReturnType<typeof referenceTestDatabase>[] = [];
const cursorSql = readFileSync(new URL("../../../migrations/0025_scheduler_fair_turn.sql", import.meta.url), "utf8");
beforeEach(() => {
  mocks.file.mockReset(); mocks.packages.mockReset();
  mocks.packages.mockResolvedValue({ jobId: "package", outcome: "file_verified" });
  mocks.file.mockResolvedValue({ jobId: "migration", outcome: "moved" });
});
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); });

function fixture(options: { cursor?: boolean; throughMigration?: string } = {}) {
  const sql = futureActiveRuntimeDatabase(undefined, { throughMigration: options.throughMigration });
  databases.push(sql);
  if (options.cursor !== false) sql.exec(cursorSql);
  sql.exec("UPDATE file_job_runtime_guard SET enabled=1,incarnation='scheduler-test'");
  const env = { DB: new SqliteD1Database(sql) as unknown as D1Database } as Env;
  return { sql, env };
}

describe("one-action durable research scheduler", () => {
  it("alternates busy queues across daily same-parity and missed invocation timestamps", async () => {
    const { env } = fixture();
    const base = Date.UTC(2026, 9, 20, 3, 17);
    const results = [];
    for (const days of [0, 1, 4, 10]) results.push(await dispatchResearchAndFileJobs(env, base + days * 86_400_000));
    expect(results.map(result => result.jobId)).toEqual(["package", "migration", "package", "migration"]);
    expect(mocks.packages).toHaveBeenCalledTimes(2); expect(mocks.file).toHaveBeenCalledTimes(2);
    expect(mocks.packages).toHaveBeenCalledWith(env, "scheduler-test");
    expect(mocks.file).toHaveBeenCalledWith(env, "scheduler-test");
  });

  it("lets only idle/unsupported first queues yield without advancing two busy actions", async () => {
    const { env, sql } = fixture();
    mocks.packages.mockResolvedValueOnce({ jobId: null, outcome: "idle" });
    expect(await dispatchResearchAndFileJobs(env, 0)).toEqual({ jobId: "migration", outcome: "moved" });
    expect(mocks.file).toHaveBeenCalledTimes(1);
    expect(sql.prepare("SELECT next_queue FROM file_job_runtime_guard").get()!.next_queue).toBe("migration");
    mocks.file.mockResolvedValueOnce({ jobId: null, outcome: "unsupported" });
    expect(await dispatchResearchAndFileJobs(env, 0)).toEqual({ jobId: "package", outcome: "file_verified" });
    expect(mocks.packages).toHaveBeenCalledTimes(2);
  });

  it.each(["disabled", "cleaned", "paused", "reconfigured"])("keeps one action after %s and rotates the following turn", async outcome => {
    const { env } = fixture();
    mocks.packages.mockResolvedValue({ jobId: null, outcome });
    expect(await dispatchResearchAndFileJobs(env, 0)).toEqual({ jobId: null, outcome });
    expect(mocks.file).not.toHaveBeenCalled();
    expect(await dispatchResearchAndFileJobs(env, 0)).toEqual({ jobId: "migration", outcome: "moved" });
  });

  it("does not let a failed queue monopolize subsequent invocations", async () => {
    const { env } = fixture();
    const failure = new Error("original execution owner did not drain");
    mocks.packages.mockRejectedValueOnce(failure);
    await expect(dispatchResearchAndFileJobs(env, 0)).rejects.toBe(failure);
    expect(mocks.file).not.toHaveBeenCalled();
    expect(await dispatchResearchAndFileJobs(env, 0)).toEqual({ jobId: "migration", outcome: "moved" });
  });

  it("retains File-only execution for historical installations without the Package schema", async () => {
    const { env } = fixture({ cursor: false, throughMigration: "0019_fp3_file_jobs.sql" });
    expect(await dispatchResearchAndFileJobs(env, 0)).toEqual({ jobId: "migration", outcome: "moved" });
    expect(mocks.file).toHaveBeenCalledWith(env); expect(mocks.packages).not.toHaveBeenCalled();
  });

  it("reports dual-queue schemas without the cursor as unsupported instead of pretending to provide fairness", async () => {
    const { env } = fixture({ cursor: false });
    expect(await dispatchResearchAndFileJobs(env, 0)).toEqual({ jobId: null, outcome: "unsupported" });
    expect(mocks.file).not.toHaveBeenCalled(); expect(mocks.packages).not.toHaveBeenCalled();
  });

  it("does not dispatch or move the preference while execution is disabled", async () => {
    const { env, sql } = fixture();
    sql.exec("UPDATE file_job_runtime_guard SET enabled=0,incarnation=NULL");
    expect(await dispatchResearchAndFileJobs(env, 0)).toEqual({ jobId: null, outcome: "disabled" });
    expect(sql.prepare("SELECT next_queue FROM file_job_runtime_guard").get()!.next_queue).toBe("package");
    expect(mocks.file).not.toHaveBeenCalled(); expect(mocks.packages).not.toHaveBeenCalled();
  });

  it("keeps the scheduler and cursor behind the existing source maintenance fence", async () => {
    const { env, sql } = fixture();
    sql.exec("UPDATE system_recovery_maintenance SET state='fenced'");
    await runSourceScheduledWriters(env, 0, () => dispatchResearchAndFileJobs(env, 0));
    expect(sql.prepare("SELECT next_queue FROM file_job_runtime_guard").get()!.next_queue).toBe("package");
    expect(sql.prepare("SELECT count(*) n FROM system_recovery_write_leases").get()!.n).toBe(0);
    expect(mocks.file).not.toHaveBeenCalled(); expect(mocks.packages).not.toHaveBeenCalled();
  });
});
