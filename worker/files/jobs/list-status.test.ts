import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteD1Database } from "../../reference-test-support";
import { migrationRoutes } from "../migration-routes";
import { d1FileJobRepository } from "./d1-repository";
import type { FileJobStatus } from "../../../shared/contracts/file-jobs";
import type { Env } from "../../types";

const actor = "administrator@example.test", at = "2026-10-20T00:00:00.000Z";
let sql: DatabaseSync, database: SqliteD1Database;
beforeEach(() => {
  // Real SQLite executes the bounded read over focused status/cleanup inputs.
  // Native migration tests separately exercise the actual schema and writers.
  sql = new DatabaseSync(":memory:");
  sql.exec(`CREATE TABLE file_migration_jobs(id TEXT PRIMARY KEY,actor TEXT,state TEXT,target_profile_id TEXT,
    target_configuration_revision INTEGER,accepted_at TEXT,updated_at TEXT,reason TEXT);
    CREATE TABLE file_migration_items(job_id TEXT,file_id TEXT,state TEXT,source_location_id TEXT,hold_operation_id TEXT,
      PRIMARY KEY(job_id,file_id));
    CREATE TABLE file_migration_attempts(job_id TEXT,file_id TEXT,state TEXT,write_started_at TEXT,location_id TEXT);
    CREATE TABLE file_location_gc_ledger(location_id TEXT,state TEXT);
    CREATE TABLE file_location_holds(location_id TEXT,operation_id TEXT,released_at TEXT);`);
  database = new SqliteD1Database(sql);
});
afterEach(() => sql.close());
function job(id: string, acceptedAt = at, owner = actor) {
  sql.prepare("INSERT INTO file_migration_jobs VALUES(?,?,'queued','profile:destination',1,?,?,NULL)").run(id, owner, acceptedAt, acceptedAt);
}
function item(id: string, state: string, deletedSource = false, jobId = "job:mixed") {
  const source = `source:${id}`, operation = `operation:${id}`;
  sql.prepare("INSERT INTO file_migration_items VALUES(?,?,?,?,?)").run(jobId, id, state, source, operation);
  if (deletedSource) sql.prepare("INSERT INTO file_location_gc_ledger VALUES(?,'deleted')").run(source);
  return { id, operation, jobId };
}
function attempt(input: ReturnType<typeof item>, suffix: string, options: { written?: boolean; deleted?: boolean; hold?: "active" | "released" | "wrong"; published?: boolean } = {}) {
  const location = `attempt:${input.id}:${suffix}`;
  sql.prepare("INSERT INTO file_migration_attempts VALUES(?,?,?,?,?)")
    .run(input.jobId, input.id, options.published ? "published" : "failed", options.written ? at : null, location);
  if (options.deleted) sql.prepare("INSERT INTO file_location_gc_ledger VALUES(?,'deleted')").run(location);
  if (options.hold) sql.prepare("INSERT INTO file_location_holds VALUES(?,?,?)")
    .run(location, options.hold === "wrong" ? "different-operation" : input.operation, options.hold === "released" ? at : null);
}
async function request(administrator = true) {
  const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
  app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); });
  app.route("/api", migrationRoutes);
  return app.fetch(new Request("https://fixture.test/api/files/migrations"), {
    DB: database as unknown as D1Database, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: administrator ? actor : "other@example.test",
  } as Env);
}
async function jobs() {
  const response = await request(); expect(response.status).toBe(200);
  return (await response.json() as { jobs: FileJobStatus[] }).jobs;
}

describe("bounded Migration status reads", () => {
  it.each([0, 1, 50, 100, 105])("reads %i jobs with one SQL statement and preserves global administrator history", async count => {
    for (let index = 0; index < count; index++) {
      const id = `job:${String(index).padStart(3, "0")}`;
      job(id, at, index % 2 ? "another-administrator@example.test" : actor);
      item(`file:${index}`, "pending", false, id);
    }
    database.resetQueryCount();
    const result = await jobs();
    expect(database.queryCount).toBe(1);
    expect(result.map(row => row.id)).toEqual(Array.from({ length: Math.min(count, 100) }, (_, index) =>
      `job:${String(count - index - 1).padStart(3, "0")}`));
    for (const row of result) expect(row).toMatchObject({ moved: 0, remaining: 1, failed: 0, cleanupPending: 0 });
  });

  it("counts cleanup per item across sources, multiple attempts, publication, GC and exact holds", async () => {
    job("job:mixed");
    item("moved-retained", "moved"); item("moved-deleted", "moved", true);
    item("stale-retained", "stale"); item("stale-deleted", "stale", true);
    item("pending-untouched", "pending");
    const copying = item("copying-multiple", "copying");
    attempt(copying, "1", { written: true, hold: "active" });
    attempt(copying, "2", { written: true, hold: "active" });
    const held = item("failed-held", "failed");
    attempt(held, "1", { written: true, deleted: true, hold: "active" });
    const published = item("cancelled-published", "cancelled");
    attempt(published, "1", { written: true, published: true, hold: "active" });
    const wrong = item("failed-wrong-hold", "failed"); attempt(wrong, "1", { hold: "wrong" });
    const cleaned = item("pending-cleaned", "pending");
    attempt(cleaned, "1", { written: true, deleted: true, hold: "released" });
    const cancelled = item("cancelled-written", "cancelled"); attempt(cancelled, "1", { written: true });
    const [result] = await jobs();
    expect(result).toEqual({ id: "job:mixed", actor, state: "queued",
      target: { profileId: "profile:destination", configurationRevision: 1 }, acceptedAt: at, updatedAt: at, reason: null,
      moved: 2, remaining: 3, failed: 4, cleanupPending: 5 });
    expect(await d1FileJobRepository(database as unknown as D1Database).status("job:mixed")).toEqual(result);
  });

  it("keeps zero-item jobs and rereads cleanup changes without a cached result", async () => {
    job("empty"); job("job:mixed", "2026-10-20T01:00:00.000Z");
    item("source", "moved");
    const first = await jobs();
    expect(first.find(row => row.id === "empty")).toMatchObject({ moved: 0, remaining: 0, failed: 0, cleanupPending: 0 });
    expect(first[0]).toMatchObject({ id: "job:mixed", cleanupPending: 1 });
    sql.prepare("INSERT INTO file_location_gc_ledger VALUES('source:source','deleted')").run();
    expect((await jobs())[0].cleanupPending).toBe(0);
  });

  it("rejects unauthorized list reads before any database query", async () => {
    job("private"); database.resetQueryCount();
    expect((await request(false)).status).toBe(403);
    expect(database.queryCount).toBe(0);
  });
});
