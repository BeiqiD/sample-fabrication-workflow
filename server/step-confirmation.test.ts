import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RunStepTarget } from "../shared/types";
import { createStepConfirmationService, type StepConfirmationService } from "../worker/execution/confirmation-service";
import { createStepConfirmationHandlers } from "../worker/execution/confirmation-surface";
import type { StepConfirmationDatabase } from "../worker/execution/confirmation-sql";
import { CURRENT_NODE_INSTALLATION_CATALOG } from "./installation-catalog";
import { installReviewedSqliteCatalog } from "./migrations";
import { asStepConfirmationDatabase } from "./step-confirmation-sql";
import { createSqliteCapability, type SqliteCapability } from "./sqlite";

// SOURCE CANDIDATE: genuine installed SQLite/SQL and Hono, not a mounted Node
// runtime, principal/session, physical lease or provider/media qualification.
const actor = "local-account:confirmation_fixture", originalTime = "2026-08-01T02:00:00.000Z";
let directory = "", pristine = "", sequence = 0;
const cores: SqliteCapability[] = [];
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "rt1-step-confirmation-")); pristine = join(directory, "pristine.sqlite");
  console.info("Retained private confirmation fixtures:", directory);
  const native = new DatabaseSync(pristine, { allowExtension: false, enableForeignKeyConstraints: true });
  try {
    native.exec("PRAGMA journal_mode=WAL");
    expect(native.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(installReviewedSqliteCatalog(native, CURRENT_NODE_INSTALLATION_CATALOG).checkpointId).toBe("portable-runtime/v25");
    expect(native.prepare("SELECT COUNT(*) AS n FROM node_migrations").get()?.n).toBe(23);
    native.exec("BEGIN IMMEDIATE");
    try { native.exec(readFileSync(new URL("../worker/fixtures/reference-graph.sql", import.meta.url), "utf8")); native.exec("COMMIT"); }
    catch (error) { native.exec("ROLLBACK"); throw error; }
  } finally { native.close(); }
  // The last genuine connection is closed before copying only the main file.
  expect(existsSync(pristine + "-wal")).toBe(false);
  expect(existsSync(pristine + "-shm")).toBe(false);
});
afterEach(() => { for (const core of cores.splice(0)) core.close(); });
function fixture() {
  const filename = join(directory, `${++sequence}.sqlite`); copyFileSync(pristine, filename);
  const native = new DatabaseSync(filename, { allowExtension: false, enableForeignKeyConstraints: true });
  const core = createSqliteCapability(native); cores.push(core);
  expect(native.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
  expect(native.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
  expect(native.isTransaction).toBe(false);
  return { filename, native, core, sql: asStepConfirmationDatabase(core) };
}
function targets(): RunStepTarget[] {
  return ["a", "b"].map(suffix => ({ sampleId: `reference-sample-${suffix}`, runId: `reference-run-${suffix}`,
    stepId: `reference-step-${suffix}`, expectedUpdatedAt: originalTime }));
}
function service(database: StepConfirmationDatabase, admit: (actor: string) => Promise<void> = async selected => {
  if (selected !== actor) throw new HTTPException(403, { message: "Fixture principal denied" });
}) {
  return createStepConfirmationService({ database: () => database, admit,
    now: () => Date.parse(originalTime) - 1000, randomId: randomUUID });
}
function snapshot(native: DatabaseSync) {
  const tables = native.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return tables.map(row => {
    if (typeof row.name !== "string") throw new Error("Invalid fixture table name");
    const statement = native.prepare(`SELECT * FROM "${row.name.replaceAll('"', '""')}" ORDER BY 1`);
    statement.setReadBigInts(true); return [row.name, statement.all()];
  });
}
function stepEvents(native: DatabaseSync) { return native.prepare("SELECT * FROM events WHERE kind='step' ORDER BY sample_id,id").all(); }
function gate() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), release: () => resolve() };
}

describe("Processing confirmation over the genuine Node core: six finite scopes (unexecuted candidate)", () => {
  it("accepts one atomic cross-Sample group, preserves prior actualization and exact audit/sample/trigger effects", async () => {
    const f = fixture();
    f.native.prepare("UPDATE run_steps SET status='in_progress',actualized_at=? WHERE id='reference-step-b'").run(originalTime);
    const unaffected = ["run_step_comments", "run_step_assets", "assets", "projects", "comment_submissions"]
      .map(table => [table, f.native.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]);
    const statusEventsBefore = Number(f.native.prepare("SELECT COUNT(*) n FROM events WHERE kind='status'").get()?.n);
    expect(await service(f.sql).confirm({ targets: targets() }, actor)).toEqual({ ok: true, confirmed: 2 });
    const next = "2026-08-01T02:00:00.001Z";
    const rows = f.native.prepare("SELECT id,status,actualized_at,updated_at,updated_by,last_mutation_id FROM run_steps ORDER BY id").all();
    const group = rows[0].last_mutation_id; expect(typeof group).toBe("string");
    expect(group).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows).toEqual([
      { id: "reference-step-a", status: "done", actualized_at: next, updated_at: next, updated_by: actor, last_mutation_id: group },
      { id: "reference-step-b", status: "done", actualized_at: originalTime, updated_at: next, updated_by: actor, last_mutation_id: group },
    ]);
    const audits = stepEvents(f.native); expect(audits).toHaveLength(2);
    for (const [index, event] of audits.entries()) {
      expect(event).toMatchObject({ sample_id: targets()[index].sampleId, body: "Confirmed 1 step as done", actor_email: actor, created_at: next });
      expect(JSON.parse(String(event.metadata_json))).toEqual({ action: "confirmed_done", operationGroupId: group, stepIds: [targets()[index].stepId] });
    }
    expect(f.native.prepare("SELECT id,status,updated_at,updated_by FROM samples ORDER BY id").all()).toEqual([
      { id: "reference-sample-a", status: "stored", updated_at: next, updated_by: actor },
      { id: "reference-sample-b", status: "stored", updated_at: next, updated_by: actor },
    ]);
    expect(f.native.prepare("SELECT status FROM runs ORDER BY id").all()).toEqual([{ status: "complete" }, { status: "complete" }]);
    expect(Number(f.native.prepare("SELECT COUNT(*) n FROM events WHERE kind='status'").get()?.n)).toBe(statusEventsBefore + 2);
    expect(unaffected).toEqual(["run_step_comments", "run_step_assets", "assets", "projects", "comment_submissions"]
      .map(table => [table, f.native.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
    expect(f.native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const boundary = fixture(), dozen = targets();
    const insert = boundary.native.prepare(`INSERT INTO run_steps(id,run_id,position,definition_hash,title,status,created_at,updated_at)
      VALUES(?,'reference-run-a',?,'reference-step-definition','Boundary step','pending',?,?)`);
    boundary.native.exec("BEGIN IMMEDIATE");
    try {
      for (let i = 1; i <= 10; i++) {
        const id = `boundary-step-${i}`; insert.run(id, i, originalTime, originalTime);
        dozen.push({ ...targets()[0], stepId: id });
      }
      boundary.native.exec("COMMIT");
    } catch (error) { boundary.native.exec("ROLLBACK"); throw error; }
    expect(await service(boundary.sql).confirm({ targets: dozen }, actor)).toEqual({ ok: true, confirmed: 12 });
    expect(boundary.native.prepare("SELECT COUNT(*) n FROM run_steps WHERE status='done'").get()?.n).toBe(12);
    expect(stepEvents(boundary.native).map(event => event.body)).toEqual(["Confirmed 11 steps as done", "Confirmed 1 step as done"]);
    expect(boundary.native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("rejects invalid/duplicate/13 targets and stale, foreign, deleted or completed members without any partial research write", async () => {
    const f = fixture(), confirm = service(f.sql);
    for (const input of [null, {}, { targets: [] }, { targets: [targets()[0], targets()[0]] },
      { targets: [...Array(13)].map((_, i) => ({ ...targets()[0], stepId: `step-${i}` })) }]) {
      const before = snapshot(f.native); await expect(confirm.confirm(input, actor)).rejects.toMatchObject({ status: 400 });
      expect(snapshot(f.native)).toEqual(before);
    }
    for (const alternate of [
      { ...targets()[1], expectedUpdatedAt: "stale" }, { ...targets()[1], sampleId: targets()[0].sampleId },
      { ...targets()[1], runId: targets()[0].runId },
    ]) {
      const before = snapshot(f.native);
      await expect(confirm.confirm({ targets: [targets()[0], alternate] }, actor)).rejects.toMatchObject({ status: 409 });
      expect(snapshot(f.native)).toEqual(before);
    }
    for (const sql of ["UPDATE samples SET deleted_at='deleted' WHERE id='reference-sample-b'",
      "UPDATE runs SET deleted_at='deleted' WHERE id='reference-run-b'",
      "UPDATE run_steps SET deleted_at='deleted' WHERE id='reference-step-b'",
      "UPDATE run_steps SET status='done' WHERE id='reference-step-b'"]) {
      const isolated = fixture(); isolated.native.exec(sql); const before = snapshot(isolated.native);
      await expect(service(isolated.sql).confirm({ targets: targets() }, actor)).rejects.toMatchObject({ status: 409 });
      expect(snapshot(isolated.native)).toEqual(before);
    }
  });
  it("retains exact cells and recursive ownership, and rolls the genuine transaction back when an audit INSERT fails", async () => {
    const f = fixture(), other = fixture();
    const statement = f.sql.prepare("SELECT ? AS exact,0.25 AS fraction,x'00ff' AS bytes,NULL AS absent").bind(1n).bind(9007199254740993n);
    expect(Object.keys(statement)).toEqual(["bind"]);
    expect((await f.sql.atomicBatch([statement]))[0].results).toEqual([{ exact: 9007199254740993n, fraction: 0.25, bytes: new Uint8Array([0, 255]), absent: null }]);
    const before = snapshot(f.native);
    await expect(f.sql.atomicBatch([other.sql.prepare("UPDATE samples SET title='wrong'")])).rejects.toThrow("Foreign Step confirmation statement");
    await expect(f.sql.atomicBatch([asStepConfirmationDatabase(f.core).prepare("SELECT 1")])).rejects.toThrow("Foreign Step confirmation statement");
    await expect(f.sql.atomicBatch([])).rejects.toThrow("Empty Step confirmation batch");
    expect(() => statement.bind(Number.MAX_SAFE_INTEGER + 1)).toThrow(/inexact/);
    expect(() => f.sql.prepare("SELECT 1; DELETE FROM samples")).toThrow("Only one SQL statement");
    expect(snapshot(f.native)).toEqual(before);
    f.native.exec("CREATE TRIGGER confirmation_fixture_audit_failure BEFORE INSERT ON events WHEN NEW.kind='step' BEGIN SELECT RAISE(ABORT,'fixture audit denied'); END");
    const guarded = snapshot(f.native);
    await expect(service(f.sql).confirm({ targets: targets() }, actor)).rejects.toThrow("fixture audit denied");
    expect(snapshot(f.native)).toEqual(guarded); expect(f.native.isTransaction).toBe(false);
    expect(f.native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("retains accepted SQL after a lost acknowledgement and conflicts on an unchanged-timestamp retry without duplicate audits", async () => {
    const f = fixture(), lost = new Error("Fixture response acknowledgement lost");
    const uncertain: StepConfirmationDatabase = { prepare: sql => f.sql.prepare(sql), async atomicBatch(statements) {
      await f.sql.atomicBatch(statements); throw lost;
    } };
    await expect(service(uncertain).confirm({ targets: targets() }, actor)).rejects.toBe(lost);
    expect(f.native.prepare("SELECT status FROM run_steps ORDER BY id").all()).toEqual([{ status: "done" }, { status: "done" }]);
    expect(stepEvents(f.native)).toHaveLength(2); const accepted = snapshot(f.native);
    await expect(service(f.sql).confirm({ targets: targets() }, actor)).rejects.toMatchObject({ status: 409 });
    expect(snapshot(f.native)).toEqual(accepted); expect(stepEvents(f.native)).toHaveLength(2);
  });
  it("uses the original chunked ingress Request and immutable targets despite a body-limit clone and an awaited admission", async () => {
    const f = fixture(), selected: Request[] = [];
    type Bindings = { service: StepConfirmationService };
    const app = new Hono<{ Bindings: Bindings; Variables: { userEmail: string } }>();
    app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: "Unexpected error" }, 500));
    app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); });
    const handlers = createStepConfirmationHandlers<Bindings>((request, bindings) => { selected.push(request); return bindings.service; });
    let parsedRequest: Request | undefined;
    app.post("/api/run-steps/confirm", handlers.captureIngressRequest, bodyLimit({ maxSize: 8192 }), async (c, next) => {
      parsedRequest = c.req.raw; await next();
    }, handlers.confirm);
    const bytes = new TextEncoder().encode(JSON.stringify({ targets: targets() }));
    const init: RequestInit & { duplex: "half" } = { method: "POST", headers: { "content-type": "application/json" },
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), duplex: "half" };
    const original = new Request("http://127.0.0.1/api/run-steps/confirm", init);
    const response = await app.fetch(original, { service: service(f.sql) });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, confirmed: 2 });
    expect(parsedRequest).not.toBe(original); expect(selected).toEqual([original]);
    const unchanged = snapshot(f.native);
    expect((await app.request("http://127.0.0.1/api/run-steps/confirm", { method: "GET" }, { service: service(f.sql) })).status).toBe(404);
    expect(snapshot(f.native)).toEqual(unchanged); expect(selected).toEqual([original]);
    const isolated = fixture(), entered = gate(), release = gate(), input = { targets: targets() };
    let calls = 0;
    const pending = service(isolated.sql, async () => { if (++calls === 1) { entered.release(); await release.promise; } }).confirm(input, actor);
    await entered.promise; input.targets[0].stepId = "forged-after-capture"; input.targets.splice(1, 1); release.release();
    expect(await pending).toEqual({ ok: true, confirmed: 2 }); expect(stepEvents(isolated.native)).toHaveLength(2);
  });
  it("rechecks current admission before SQL and after commitment, and retains all-or-none CAS against a real second writer", async () => {
    const denied = fixture(), before = snapshot(denied.native); let checks = 0;
    const rejecting = service(denied.sql, async () => { if (++checks === 2) throw new HTTPException(403, { message: "Fixture grant revoked" }); });
    await expect(rejecting.confirm({ targets: targets() }, actor)).rejects.toMatchObject({ status: 403 });
    expect(snapshot(denied.native)).toEqual(before);
    const accepted = fixture(); checks = 0;
    const afterCommit = service(accepted.sql, async () => { if (++checks === 3) throw new HTTPException(403, { message: "Fixture grant revoked" }); });
    await expect(afterCommit.confirm({ targets: targets() }, actor)).rejects.toMatchObject({ status: 403 });
    expect(stepEvents(accepted.native)).toHaveLength(2); expect(accepted.native.prepare("SELECT status FROM run_steps ORDER BY id").all())
      .toEqual([{ status: "done" }, { status: "done" }]);
    const concurrent = fixture(), entered = gate(), resume = gate(); checks = 0;
    const pending = service(concurrent.sql, async () => { if (++checks === 2) { entered.release(); await resume.promise; } })
      .confirm({ targets: targets() }, actor);
    const rejected = expect(pending).rejects.toMatchObject({ status: 409 });
    await entered.promise;
    const writer = new DatabaseSync(concurrent.filename, { allowExtension: false, enableForeignKeyConstraints: true });
    try { expect(writer.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal"); writer.prepare("UPDATE run_steps SET updated_at='2026-08-01T02:00:00.002Z' WHERE id='reference-step-b'").run(); }
    finally { writer.close(); }
    const written = snapshot(concurrent.native); resume.release(); await rejected;
    expect(snapshot(concurrent.native)).toEqual(written); expect(stepEvents(concurrent.native)).toEqual([]);
  });
});
