import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerApplication } from "../../application";
import { SqliteD1Database } from "../../reference-test-support";
import { packageSqlDatabase } from "./worker-runtime";
import { SqlPackageRepository } from "./sql-repository";
import type { PackageJob } from "./types";
import type { ResearchJobStatus } from "../../../shared/contracts/research-package-api";
import type { Env } from "../../types";

const actor = "local-development", at = "2026-10-20T00:00:00.000Z", expires = "2026-10-21T00:00:00.000Z";
let sql: DatabaseSync, database: SqliteD1Database, repository: SqlPackageRepository;
let maximumBindings: number;
beforeEach(() => {
  // Isolate the read projection with real SQLite statements. Publication
  // eligibility is supplied as the same view-shaped input the reader consumes;
  // package-repository.test.ts separately exercises the migrated publication guards.
  sql = new DatabaseSync(":memory:");
  sql.exec(`CREATE TABLE research_package_jobs(id TEXT PRIMARY KEY,request_id TEXT,actor TEXT,kind TEXT,state TEXT,phase TEXT,
    accepted_at TEXT,updated_at TEXT,reason TEXT,package_id TEXT,result_json TEXT,expires_at TEXT);
    CREATE TABLE research_package_files(job_id TEXT,logical_file_id TEXT,entry_kind TEXT,state TEXT,byte_size INTEGER,
      sha256 TEXT,archive_path TEXT,result_file_id TEXT,PRIMARY KEY(job_id,logical_file_id));
    CREATE TABLE file_usable_publications(file_id TEXT PRIMARY KEY,purpose TEXT);
    CREATE TABLE file_holds(file_id TEXT,operation_id TEXT,released_at TEXT);`);
  database = new SqliteD1Database(sql);
  maximumBindings = 0;
  const prepare = database.prepare.bind(database);
  vi.spyOn(database, "prepare").mockImplementation(query => {
    const statement = prepare(query), bind = statement.bind.bind(statement);
    statement.bind = (...values) => {
      maximumBindings = Math.max(maximumBindings, values.length);
      if (values.length > 100) throw new Error("D1 binding limit exceeded");
      return bind(...values);
    };
    return statement;
  });
  repository = new SqlPackageRepository(packageSqlDatabase(database as unknown as D1Database));
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
});
afterEach(() => { vi.restoreAllMocks(); sql.close(); });

function job(id: string, values: Partial<PackageJob> = {}) {
  const row = { id, request_id: `request:${id}`, actor, kind: "data_package", state: "queued", phase: "snapshot",
    accepted_at: at, updated_at: at, reason: null, package_id: `package:${id}`, result_json: null, expires_at: null, ...values };
  sql.prepare("INSERT INTO research_package_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(...Object.values(row));
  return row;
}
function file(id: string, logical: string, state = "pending", bytes = 4, artifact = false) {
  const result = artifact ? `output:${id}` : null;
  sql.prepare("INSERT INTO research_package_files VALUES(?,?,?,?,?,?,?,?)")
    .run(id, logical, artifact ? "artifact" : "payload", state, bytes, "a".repeat(64), logical, result);
  return result!;
}
async function request(path = "/api/packages/jobs") {
  return createWorkerApplication().fetch(new Request(`https://fixture.test${path}`),
    { DB: database as unknown as D1Database, AUTH_MODE: "disabled" } as Env);
}
async function jobs() {
  const response = await request();
  expect(response.status).toBe(200);
  return (await response.json() as { jobs: ResearchJobStatus[] }).jobs;
}

describe("bounded Package status reads", () => {
  it.each([0, 1, 9, 10, 100, 105])("reads %i jobs through the complete Worker list path with a constant query budget", async count => {
    for (let index = 0; index < count; index++) {
      const id = `job:${String(index).padStart(3, "0")}`;
      job(id, { state: "completed", phase: "done", expires_at: expires });
      // A list must return summaries, even with the maximum file inventory.
      for (let item = 0; item < 100; item++) file(id, `file:${item}`);
      const output = file(id, "@archive", "published", 32, true);
      sql.prepare("INSERT INTO file_usable_publications VALUES(?,'job_output')").run(output);
      sql.prepare("INSERT INTO file_holds VALUES(?,?,NULL)").run(output, `fp4-output:${id}`);
    }
    job("other-account", { actor: "another@example.test", accepted_at: expires });
    database.resetQueryCount();
    const result = await jobs();
    expect(database.queryCount).toBe(1);
    expect(maximumBindings).toBeLessThanOrEqual(2);
    expect(result.map(row => row.id)).toEqual(Array.from({ length: Math.min(count, 100) }, (_, index) =>
      `job:${String(count - index - 1).padStart(3, "0")}`));
    for (const row of result) {
      expect(row.progress).toEqual({ totalFiles: 100, completedFiles: 100, bytesTotal: 400, bytesDone: 400 });
      expect(row.output?.available).toBe(true);
    }
    database.resetQueryCount();
    expect(await repository.list(actor)).toHaveLength(Math.min(count, 100));
    expect(database.queryCount).toBe(1);
  });

  it("preserves progress across upload, import and measured export phases and agrees with individual public statuses", async () => {
    const cases = [
      { id: "data:snapshot", kind: "data_package", phase: "snapshot", progress: [3, 1, 28, 8] },
      { id: "data:measure", kind: "data_package", phase: "measure", progress: [3, 1, 28, 8] },
      { id: "data:write", kind: "data_package", phase: "write", progress: [3, 3, 28, 28] },
      { id: "report:done", kind: "report", phase: "done", progress: [3, 3, 28, 28] },
      { id: "upload:preview", kind: "upload", phase: "preview", progress: [4, 2, 60, 40] },
      { id: "import:done", kind: "import", phase: "done", progress: [3, 1, 28, 8] },
    ] as const;
    for (const item of cases) {
      job(item.id, { kind: item.kind, phase: item.phase });
      file(item.id, "pending", "pending", 4); file(item.id, "verified", "verified", 8);
      file(item.id, "failed", "failed", 16); file(item.id, "@archive", "published", 32, true);
    }
    job("empty");
    const result = await jobs();
    expect(result.find(row => row.id === "empty")?.progress)
      .toEqual({ totalFiles: 0, completedFiles: 0, bytesTotal: 0, bytesDone: 0 });
    for (const item of cases) {
      const row = result.find(row => row.id === item.id)!;
      const [totalFiles, completedFiles, bytesTotal, bytesDone] = item.progress;
      expect(row.progress).toEqual({ totalFiles, completedFiles, bytesTotal, bytesDone });
      const response = await request(`/api/packages/jobs/${item.id}`);
      expect(response.status).toBe(200); expect(await response.json()).toEqual(row);
    }
    // The repository's older internal DTO intentionally excludes artifacts
    // and keeps its existing download-URL rules.
    for (const row of await repository.list(actor)) expect(row).toEqual(await repository.status(row.id, actor));
  });

  it.each(["retained", "no_publication", "wrong_purpose", "wrong_hold", "released", "expired", "boundary", "queued", "unpublished", "no_expiry"] as const)
    ("preserves output retention, metadata and expiry for %s", async scenario => {
      job("output", { state: scenario === "queued" ? "queued" : "completed", phase: "done",
        expires_at: scenario === "no_expiry" ? null : scenario === "expired" ? "2026-10-19T00:00:00.000Z" : scenario === "boundary" ? at : expires });
      const output = file("output", "@archive", scenario === "unpublished" ? "verified" : "published", 32, true);
      if (scenario !== "no_publication") sql.prepare("INSERT INTO file_usable_publications VALUES(?,?)")
        .run(output, scenario === "wrong_purpose" ? "research_source" : "job_output");
      sql.prepare("INSERT INTO file_holds VALUES(?,?,?)").run(output,
        scenario === "wrong_hold" ? "fp4-output:another-job" : "fp4-output:output", scenario === "released" ? at : null);
      // Another hold must neither satisfy the operation check nor multiply progress.
      sql.prepare("INSERT INTO file_holds VALUES(?,'another-operation',NULL)").run(output);
      const [row] = await jobs();
      expect(row.output).toEqual(scenario === "no_expiry" ? null : {
        available: scenario === "retained", byteSize: 32, sha256: "a".repeat(64),
        expiresAt: scenario === "expired" ? "2026-10-19T00:00:00.000Z" : scenario === "boundary" ? at : expires,
      });
      expect(row.progress.totalFiles).toBe(0);
    });

  it("keeps another actor's individual status private and reads current holds afresh", async () => {
    job("private", { actor: "another@example.test" });
    const response = await request("/api/packages/jobs/private");
    expect(response.status).toBe(404);
    job("visible", { state: "completed", phase: "done", expires_at: expires });
    const output = file("visible", "@archive", "published", 32, true);
    sql.prepare("INSERT INTO file_usable_publications VALUES(?,'job_output')").run(output);
    sql.prepare("INSERT INTO file_holds VALUES(?,'fp4-output:visible',NULL)").run(output);
    expect((await jobs())[0].output?.available).toBe(true);
    sql.prepare("UPDATE file_holds SET released_at=?").run(at);
    expect((await jobs())[0].output?.available).toBe(false);
  });
});
