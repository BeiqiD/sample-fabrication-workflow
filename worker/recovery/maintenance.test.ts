import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { SqliteD1Database } from "../reference-test-support";
import { acquireSourceWriteLease, controlSourceMaintenance, readSourceMaintenance, recordSourceCheckpoint,
  releaseSourceWriteLease, runSourceScheduledWriters, sourceMaintenanceAdmission, sourceMaintenanceReceipt, verifySourceCheckpoint } from "./maintenance";
import { maintenanceRoutes } from "./maintenance-routes";

const databases: DatabaseSync[] = [], actor = "admin@example.test", sha = "a".repeat(64);
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.useRealTimers(); });
function fixture() {
  const sql = new DatabaseSync(":memory:"); databases.push(sql);
  sql.exec(readFileSync(new URL("../../migrations/0021_fp5_system_recovery.sql", import.meta.url), "utf8"));
  for (const table of ["file_shadow_attempts", "file_migration_attempts", "research_package_attempts"]) sql.exec(`CREATE TABLE ${table}(state TEXT)`);
  for (const table of ["r2_upload_requests", "metrology_reference_upload_requests", "comment_submission_acceptances", "import_file_acceptances"]) sql.exec(`CREATE TABLE ${table}(status TEXT)`);
  sql.exec("CREATE TABLE system_storage_candidate_checks(status TEXT,cleanup_outcome TEXT,write_outcome TEXT)");
  const env = { DB: new SqliteD1Database(sql), RECOVERY_TARGET_ID: "isolated-target", AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: actor } as unknown as Env;
  const request = (action: "enter" | "finalize" | "release", generation: number, requestId = crypto.randomUUID()) => ({ requestId, action, expectedGeneration: generation });
  return { sql, env, request };
}

describe("source maintenance admission, drainage and exact receipts", () => {
  it("keeps an expired but unsettled HTTP writer fenced out of final capture", async () => {
    const f = fixture(), lease = await acquireSourceWriteLease(f.env, actor, "http");
    f.sql.exec("UPDATE system_recovery_write_leases SET expires_at='2000-01-01T00:00:00.000Z'");
    const enter = await controlSourceMaintenance(f.env, actor, f.request("enter", 0));
    expect(enter.status).toMatchObject({ state: "draining", generation: 1, activeWriters: 1 });
    await expect(acquireSourceWriteLease(f.env, actor, "http")).rejects.toMatchObject({ status: 503 });
    await expect(controlSourceMaintenance(f.env, actor, f.request("finalize", 1))).rejects.toMatchObject({ status: 409 });
    await releaseSourceWriteLease(f.env, lease);
    expect((await controlSourceMaintenance(f.env, actor, f.request("finalize", 1))).status.state).toBe("fenced");
  });
  it("reconciles a lost acceptance by exact request even after a later window and rejects reuse", async () => {
    const f = fixture(), input = f.request("enter", 0), first = await controlSourceMaintenance(f.env, actor, input);
    await controlSourceMaintenance(f.env, actor, f.request("release", 1));
    await controlSourceMaintenance(f.env, actor, f.request("enter", 2));
    expect(await sourceMaintenanceReceipt(f.env, actor, input.requestId)).toEqual(first);
    expect(await controlSourceMaintenance(f.env, actor, input)).toEqual(first);
    await expect(controlSourceMaintenance(f.env, actor, { ...input, action: "release" })).rejects.toMatchObject({ status: 409 });
    await expect(controlSourceMaintenance(f.env, actor, f.request("release", 1))).rejects.toMatchObject({ status: 409 });
    expect((await readSourceMaintenance(f.env)).generation).toBe(3);
  });
  it("requires settlement of each preaccepted provider write and never treats timeout as settlement", async () => {
    const f = fixture(); await controlSourceMaintenance(f.env, actor, f.request("enter", 0));
    for (const table of ["file_shadow_attempts", "file_migration_attempts", "research_package_attempts"]) {
      f.sql.exec(`INSERT INTO ${table} VALUES('unknown')`);
      await expect(controlSourceMaintenance(f.env, actor, f.request("finalize", 1))).rejects.toMatchObject({ status: 409 });
      f.sql.exec(`DELETE FROM ${table}`);
    }
    for (const table of ["r2_upload_requests", "metrology_reference_upload_requests", "comment_submission_acceptances", "import_file_acceptances"]) {
      f.sql.exec(`INSERT INTO ${table} VALUES('pending')`);
      await expect(controlSourceMaintenance(f.env, actor, f.request("finalize", 1))).rejects.toMatchObject({ status: 409 });
      f.sql.exec(`DELETE FROM ${table}`);
    }
    for (const check of [["running","pending","pending"],["failed","running","acknowledged"],["interrupted","absence_observed","unknown"]]) {
      f.sql.prepare("INSERT INTO system_storage_candidate_checks VALUES(?,?,?)").run(...check);
      await expect(controlSourceMaintenance(f.env, actor, f.request("finalize", 1))).rejects.toMatchObject({ status: 409 });
      f.sql.exec("DELETE FROM system_storage_candidate_checks");
    }
    expect((await controlSourceMaintenance(f.env, actor, f.request("finalize", 1))).status.state).toBe("fenced");
  });
  it("invalidates the final checkpoint after changed source evidence or maintenance release", async () => {
    const f = fixture(); await controlSourceMaintenance(f.env, actor, f.request("enter", 0));
    await controlSourceMaintenance(f.env, actor, f.request("finalize", 1));
    await recordSourceCheckpoint(f.env, "backup", sha);
    expect((await verifySourceCheckpoint(f.env, "backup", sha)).backupJobId).toBe("backup");
    await expect(verifySourceCheckpoint(f.env, "backup", "b".repeat(64))).rejects.toMatchObject({ status: 409 });
    await expect(recordSourceCheckpoint(f.env, "other-backup", sha)).rejects.toMatchObject({ status: 409 });
    await controlSourceMaintenance(f.env, actor, f.request("release", 1));
    await expect(verifySourceCheckpoint(f.env, "backup", sha)).rejects.toMatchObject({ status: 409 });
  });
  it("keeps a restored target fenced after ordinary binding activation without a secondary recovery target", async () => {
    const f = fixture(); await controlSourceMaintenance(f.env, actor, f.request("enter", 0));
    await controlSourceMaintenance(f.env, actor, f.request("finalize", 1));
    const deployed = { ...f.env, RECOVERY_TARGET_ID: undefined, RECOVERY_DB: undefined };
    expect((await readSourceMaintenance(deployed)).state).toBe("fenced");
    await expect(acquireSourceWriteLease(deployed, actor, "http")).rejects.toMatchObject({ status: 503 });
    const scheduled = vi.fn(); await runSourceScheduledWriters(deployed, 3, scheduled); expect(scheduled).not.toHaveBeenCalled();
    await controlSourceMaintenance(deployed, actor, f.request("release", 1));
    const lease = await acquireSourceWriteLease(deployed, actor, "http"); expect(lease).not.toBeNull();
    await releaseSourceWriteLease(deployed, lease);
  });
  it("preserves pre-FP5 admission but fails closed when a configured target lacks maintenance metadata", async () => {
    const sql = new DatabaseSync(":memory:"); databases.push(sql);
    const old = { DB: new SqliteD1Database(sql) } as unknown as Env;
    expect(await acquireSourceWriteLease(old, actor, "http")).toBeNull();
    await expect(acquireSourceWriteLease({ ...old, RECOVERY_TARGET_ID: "configured" }, actor, "http")).rejects.toMatchObject({ status: 503 });
  });
  it("admits reads while pausing HTTP mutations and scheduled writers; settles failing callbacks", async () => {
    const f = fixture(), app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
    app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); }); app.use("*", sourceMaintenanceAdmission);
    f.sql.exec("CREATE TABLE fixture_business_effects(value TEXT)");
    const mutation = vi.fn(() => "written"); app.get("/api/items", c => c.text("read")); app.post("/api/items", async c => {
      await c.env.DB.prepare("INSERT INTO fixture_business_effects VALUES('actual source mutation')").run();return c.text(mutation());});
    await expect(runSourceScheduledWriters(f.env, 1, async () => { throw new Error("writer failed"); })).rejects.toThrow("writer failed");
    expect((await readSourceMaintenance(f.env)).activeWriters).toBe(0);
    await controlSourceMaintenance(f.env, actor, f.request("enter", 0));
    expect((await app.request("/api/items", {}, f.env)).status).toBe(200);
    expect((await app.request("/api/items", { method: "POST" }, f.env)).status).toBe(503); expect(mutation).not.toHaveBeenCalled();
    expect(f.sql.prepare("SELECT count(*) n FROM fixture_business_effects").get()!.n).toBe(0);
    const scheduled = vi.fn(); await runSourceScheduledWriters(f.env, 2, scheduled); expect(scheduled).not.toHaveBeenCalled();
  });
  it("denies disabled-auth administrators and bounds streamed control bodies before parsing", async () => {
    const f = fixture(); await expect(controlSourceMaintenance({ ...f.env, AUTH_MODE: "disabled" }, actor, f.request("enter", 0))).rejects.toMatchObject({ status: 403 });
    const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>(); app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); }); app.route("/api", maintenanceRoutes);
    let pulls = 0; const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(4097)); } });
    const response = await app.fetch(new Request("https://example.test/api/system-recovery/maintenance", { method: "POST", headers: { "Content-Type": "application/json" }, body, duplex: "half" } as RequestInit), f.env);
    expect(response.status).toBe(400); expect(pulls).toBeLessThanOrEqual(2); expect((await readSourceMaintenance(f.env)).state).toBe("open");
  });
  it("keeps one exact lease until detached binding I/O settles and preserves original sessions, batches and bindings", async () => {
    const f = fixture(), native = f.env.DB;
    f.sql.exec("CREATE TABLE fixture_business_effects(value TEXT)");
    const database = { prepare: native.prepare.bind(native), batch: native.batch.bind(native), withSession: () => native } as unknown as D1Database;
    let started!: () => void, settle!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const transport = new Promise<void>(resolve => { settle = resolve; });
    const bucket = { put: vi.fn(async function (this: unknown) { expect(this).toBe(bucket); started(); await transport; }) } as unknown as R2Bucket;
    const env = { ...f.env, DB: database, ASSETS: bucket, R2_BOOTSTRAP_NAMESPACE: "untouched namespace" };
    const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
    app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); });
    app.use("*", sourceMaintenanceAdmission);
    let lateWrite!: () => Promise<unknown>;
    app.post("/api/items", async c => {
      const session = c.env.DB.withSession("first-primary");
      await session.batch([session.prepare("INSERT INTO fixture_business_effects VALUES(?)").bind("actual admitted write")]);
      void c.env.ASSETS.put("private fixture", "bytes").catch(() => undefined);
      lateWrite = () => c.env.ASSETS.put("late request reuse", "bytes");
      return c.json({ accepted: true });
    });
    const pending = app.request("/api/items", { method: "POST" }, env);
    await entered;
    expect(f.sql.prepare("SELECT count(*) n FROM system_recovery_write_leases").get()!.n).toBe(1);
    expect((await controlSourceMaintenance(env, actor, f.request("enter", 0))).status.activeWriters).toBe(1);
    await expect(controlSourceMaintenance(env, actor, f.request("finalize", 1))).rejects.toMatchObject({ status: 409 });
    settle();
    expect((await pending).status).toBe(200);
    expect((await readSourceMaintenance(env)).activeWriters).toBe(0);
    expect(f.sql.prepare("SELECT owner,kind,released_at FROM system_recovery_write_leases").get()).toMatchObject({ owner: actor, kind: "http", released_at: expect.any(String) });
    expect(f.sql.prepare("SELECT value FROM fixture_business_effects").get()!.value).toBe("actual admitted write");
    expect(env.DB).toBe(database); expect(env.ASSETS).toBe(bucket); expect(env.R2_BOOTSTRAP_NAMESPACE).toBe("untouched namespace");
    await expect(lateWrite()).rejects.toMatchObject({ status: 503 });
    expect(bucket.put).toHaveBeenCalledTimes(1);
    expect((await controlSourceMaintenance(env, actor, f.request("finalize", 1))).status.state).toBe("fenced");
  });
  it("denies provider-first PUT before actual I/O and surfaces its detached rejection instead of apparent success", async () => {
    const f = fixture(), original = f.env.DB;
    await controlSourceMaintenance(f.env, actor, f.request("enter", 0));
    const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
    app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); });
    app.use("*", sourceMaintenanceAdmission);
    const bucket = { put: vi.fn(async () => { throw new Error("Denied provider must never be called"); }) } as unknown as R2Bucket;
    const env = { ...f.env, ASSETS: bucket };
    app.post("/api/items", c => {
      void c.env.ASSETS.put("unissued key", "unissued body").catch(() => undefined);
      return c.json({ accepted: true });
    });
    const response = await app.request("/api/items", { method: "POST" }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Source mutations are paused for system recovery" });
    expect(f.sql.prepare("SELECT count(*) n FROM system_recovery_write_leases").get()!.n).toBe(0);
    expect(bucket.put).not.toHaveBeenCalled(); expect(env.ASSETS).toBe(bucket);
    expect(f.env.DB).toBe(original);
  });
});
