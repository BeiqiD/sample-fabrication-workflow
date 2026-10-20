import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRunTrashService, type RunTrashService } from "../worker/execution/run-trash-service";
import { createRunTrashHandlers, createRunTrashSurface } from "../worker/execution/run-trash-surface";
import type { ConfigurationSqlDatabase } from "../worker/runtime/configuration-sql";
import { CURRENT_NODE_INSTALLATION_CATALOG } from "./installation-catalog";
import { installReviewedSqliteCatalog } from "./migrations";
import { createSqliteCapability, type SqliteCapability } from "./sqlite";
import { asStorageConfigurationSqlDatabase } from "./storage-configuration-sql";
import { createNodeHttpServer } from "./http";

// UNEXECUTED source candidate. Actual current23 core/SQLite/HTTP fixtures,
// not installed auth, physical writer lease, media/provider or mounted app.
const actor = "local-account:run_trash_fixture", sampleId = "reference-sample-a", runId = "reference-run-a";
let directory = "", pristine = "", sequence = 0;
const cores: SqliteCapability[] = [], listeners: Server[] = [];
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "rt1-run-trash-")); pristine = join(directory, "pristine.sqlite");
  console.info("Retained private Run trash fixtures:", directory);
  const native = new DatabaseSync(pristine, { allowExtension: false, enableForeignKeyConstraints: true });
  try {
    native.exec("PRAGMA journal_mode=WAL");
    expect(native.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(installReviewedSqliteCatalog(native, CURRENT_NODE_INSTALLATION_CATALOG).checkpointId).toBe("portable-runtime/v25");
    expect(native.prepare("SELECT COUNT(*) n FROM node_migrations").get()?.n).toBe(23);
    native.exec("BEGIN IMMEDIATE");
    try { native.exec(readFileSync(new URL("../worker/fixtures/reference-graph.sql", import.meta.url), "utf8")); native.exec("COMMIT"); }
    catch (error) { native.exec("ROLLBACK"); throw error; }
  } finally { native.close(); }
  // The last genuine connection is closed before copying only the main file.
  expect(existsSync(pristine + "-wal")).toBe(false);
  expect(existsSync(pristine + "-shm")).toBe(false);
}, 30_000);
afterEach(async () => {
  for (const server of listeners.splice(0)) {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const core of cores.splice(0)) core.close();
});
function fixture() {
  const filename = join(directory, `${++sequence}.sqlite`); copyFileSync(pristine, filename);
  const native = new DatabaseSync(filename, { allowExtension: false, enableForeignKeyConstraints: true });
  const core = createSqliteCapability(native); cores.push(core);
  expect(native.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
  expect(native.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
  expect(native.isTransaction).toBe(false);
  return { filename, native, core, sql: asStorageConfigurationSqlDatabase(core) };
}
function service(database: ConfigurationSqlDatabase, admit: (actor: string) => Promise<void> = async current => {
  if (current !== actor) throw new HTTPException(403, { message: "Fixture actor denied" });
}) {
  return createRunTrashService({ database: () => database, admit,
    now: () => Date.parse("2026-08-01T00:00:00.000Z"), randomId: randomUUID });
}
function revision(native: DatabaseSync) {
  const value = native.prepare("SELECT updated_at FROM samples WHERE id=?").get(sampleId)?.updated_at;
  if (typeof value !== "string") throw new Error("Invalid actual Sample revision");
  return { expectedSampleUpdatedAt: value };
}
function snapshot(native: DatabaseSync) {
  return native.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => {
    if (typeof row.name !== "string") throw new Error("Invalid fixture table");
    const statement = native.prepare(`SELECT * FROM "${row.name.replaceAll('"', '""')}" ORDER BY 1`);
    statement.setReadBigInts(true); return [row.name, statement.all()];
  });
}
function audits(native: DatabaseSync) {
  return native.prepare("SELECT body,metadata_json,actor_email FROM events WHERE json_extract(metadata_json,'$.action') IN ('run_deleted','run_restored') ORDER BY created_at,id").all();
}
function addRun(native: DatabaseSync, id: string, status: "active" | "complete", predecessor: string | null = null, kind: "process" | "metrology" = "process", sequenceNo = 2) {
  const metrology = kind === "metrology";
  native.prepare(`INSERT INTO runs(id,sample_id,recipe_family_id,template_version_id,predecessor_run_id,sequence_no,run_group_id,
    template_name_snapshot,template_type_snapshot,template_version_snapshot,status,created_at,run_kind)
    VALUES(?,?,?,?,?,?,'fixture-group','Fixture',?,?,?,'2026-08-02T00:00:00.000Z',?)`)
    .run(id, sampleId, metrology ? "reference-metrology-family" : "reference-process-family",
      metrology ? "reference-metrology-template" : "reference-process-template", predecessor, sequenceNo,
      metrology ? "module" : "process", metrology ? 2 : 3, status, kind);
}
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
function application(current: RunTrashService) {
  type Bindings = { service: RunTrashService };
  const app = new Hono<{ Bindings: Bindings; Variables: { userEmail: string } }>();
  app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: "Unexpected server error" }, 500));
  app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); });
  app.route("/api", createRunTrashSurface<Bindings>((_request, bindings) => bindings.service));
  return { app, bindings: { service: current } };
}

describe("shared Run trash on genuine current23 Node SQLite: six finite scopes", () => {
  it("uses both real HTTP methods with monotonic revisions, stable actor audits and preserved shared Comments/assets", async () => {
    const f = fixture(), current = service(f.sql), { app, bindings } = application(current);
    const retainedTables = ["run_steps", "run_step_assets", "run_step_comments", "comment_submissions", "comment_submission_targets", "comment_submission_items", "assets", "metrology_template_references"];
    const retained = retainedTables.map(table => [table, f.native.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]);
    const server = createNodeHttpServer(request => app.fetch(request, bindings), { publicOrigin: "http://run-fixture.test" });
    listeners.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected actual loopback");
    const url = `http://127.0.0.1:${address.port}/api/samples/${sampleId}/runs/${runId}`;
    const before = revision(f.native).expectedSampleUpdatedAt;
    const response = await fetch(url, { method: "DELETE", headers: { "content-type": "application/json", "cf-access-authenticated-user-email": "forged-admin@example.test" }, body: JSON.stringify(revision(f.native)) });
    expect(response.status).toBe(200); const removed = await response.json();
    const first = new Date(Date.parse(before) + 1).toISOString(); expect(removed).toEqual({ ok: true, updatedAt: first });
    expect(f.native.prepare("SELECT deleted_at,deleted_by FROM runs WHERE id=?").get(runId)).toEqual({ deleted_at: first, deleted_by: actor });
    expect(f.native.prepare("SELECT status FROM samples WHERE id=?").get(sampleId)?.status).toBe("stored");
    const restore = await fetch(url + "/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(revision(f.native)) });
    expect(restore.status).toBe(200); expect(await restore.json()).toEqual({ ok: true, updatedAt: new Date(Date.parse(first) + 1).toISOString() });
    expect(f.native.prepare("SELECT deleted_at,deleted_by FROM runs WHERE id=?").get(runId)).toEqual({ deleted_at: null, deleted_by: null });
    expect(f.native.prepare("SELECT status FROM samples WHERE id=?").get(sampleId)?.status).toBe("active");
    const events = audits(f.native); expect(events).toHaveLength(2);
    expect(events.map(event => event.actor_email)).toEqual([actor, actor]);
    expect(JSON.parse(String(events[0].metadata_json))).toEqual({ action: "run_deleted", deletedRunId: runId, runKind: "process", sequenceNo: 1, templateName: "Reference process", templateVersion: 3, recoverable: true });
    expect(JSON.parse(String(events[1].metadata_json))).toEqual({ action: "run_restored", restoredRunId: runId, runKind: "process", sequenceNo: 1, templateName: "Reference process", templateVersion: 3 });
    expect(retainedTables.map(table => [table, f.native.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()])).toEqual(retained);
    expect(f.native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("preserves malformed, missing, association, stale and deleted-ancestor errors without selecting SQL for invalid input", async () => {
    const f = fixture(); let selected = 0, admitted = 0;
    const current = createRunTrashService({ database: () => { selected++; return f.sql; }, admit: async () => { admitted++; }, now: Date.now, randomId: randomUUID });
    for (const value of [null, [], {}, { expectedSampleUpdatedAt: 1 }]) {
      await expect(current.remove(sampleId, runId, value, actor)).rejects.toMatchObject({ status: 400, message: "The current sample revision is required" });
      await expect(current.restore(sampleId, runId, value, actor)).rejects.toMatchObject({ status: 400 });
    }
    expect(selected).toBe(0); expect(admitted).toBe(0);
    const before = snapshot(f.native), input = revision(f.native);
    for (const [sample, run] of [[sampleId, "missing"], ["reference-sample-b", runId], [sampleId + "' OR 1=1 --", runId]]) {
      await expect(current.remove(sample, run, input, actor)).rejects.toMatchObject({ status: 404 });
    }
    await expect(current.restore(sampleId, runId, input, actor)).rejects.toMatchObject({ status: 404 });
    await expect(current.remove(sampleId, runId, { expectedSampleUpdatedAt: "stale" }, actor)).rejects.toMatchObject({ status: 409 });
    expect(snapshot(f.native)).toEqual(before);
    f.native.prepare("UPDATE samples SET deleted_at='2026-08-03T00:00:00.000Z' WHERE id=?").run(sampleId);
    const hidden = snapshot(f.native);
    await expect(current.remove(sampleId, runId, input, actor)).rejects.toMatchObject({ status: 404 });
    expect(snapshot(f.native)).toEqual(hidden);
  });

  it("retains active/newer/successor restore conflicts, safe numeric policy and metrology status semantics", async () => {
    for (const status of ["active", "complete"] as const) {
      const f = fixture(), current = service(f.sql);
      await current.remove(sampleId, runId, revision(f.native), actor); addRun(f.native, "replacement", status);
      const before = snapshot(f.native);
      await expect(current.restore(sampleId, runId, revision(f.native), actor)).rejects.toMatchObject({ status: 409, message: status === "active"
        ? "Finish or move the current active process run to trash before restoring this run."
        : "An active process run can only be restored when it is the latest visible process run." });
      expect(snapshot(f.native)).toEqual(before);
    }
    const f = fixture(), current = service(f.sql);
    f.native.prepare("UPDATE runs SET status='complete' WHERE id=?").run(runId);
    addRun(f.native, "removed-successor", "complete", runId); await current.remove(sampleId, "removed-successor", revision(f.native), actor);
    addRun(f.native, "visible-successor", "complete", runId, "process", 3); const before = snapshot(f.native);
    await expect(current.restore(sampleId, "removed-successor", revision(f.native), actor)).rejects.toMatchObject({ status: 409, message: "Another visible run already succeeds this run's predecessor." });
    expect(snapshot(f.native)).toEqual(before);
    const exact = fixture(); exact.native.prepare("UPDATE runs SET template_version_snapshot=? WHERE id=?").run(9007199254740993n, runId);
    const preserved = snapshot(exact.native);
    await expect(service(exact.sql).remove(sampleId, runId, revision(exact.native), actor)).rejects.toThrow("Run trash template_version_snapshot");
    expect(snapshot(exact.native)).toEqual(preserved);
    const metro = fixture(); metro.native.prepare("UPDATE runs SET status='complete' WHERE id=?").run(runId);
    addRun(metro.native, "metrology", "active", null, "metrology"); const metrology = service(metro.sql);
    await metrology.remove(sampleId, "metrology", revision(metro.native), actor);
    expect(metro.native.prepare("SELECT status FROM samples WHERE id=?").get(sampleId)?.status).toBe("stored");
    await metrology.restore(sampleId, "metrology", revision(metro.native), actor);
    expect(metro.native.prepare("SELECT status FROM samples WHERE id=?").get(sampleId)?.status).toBe("active");
  });

  it("rolls real audit failures back and preserves accepted data after lost/incomplete ACK without duplicate replay", async () => {
    const denied = fixture();
    denied.native.exec("CREATE TRIGGER run_trash_audit_failure BEFORE INSERT ON events WHEN json_extract(NEW.metadata_json,'$.action')='run_deleted' BEGIN SELECT RAISE(ABORT,'fixture Run audit denied'); END");
    const before = snapshot(denied.native);
    await expect(service(denied.sql).remove(sampleId, runId, revision(denied.native), actor)).rejects.toThrow("fixture Run audit denied");
    expect(snapshot(denied.native)).toEqual(before); expect(denied.native.isTransaction).toBe(false);
    for (const lost of [true, false]) {
      const f = fixture(), input = revision(f.native), loss = new Error("Fixture Run ACK lost");
      const unreliable: ConfigurationSqlDatabase = { ...f.sql, async batch(statements) { await f.sql.batch(statements); if (lost) throw loss; return []; } };
      if (lost) await expect(service(unreliable).remove(sampleId, runId, input, actor)).rejects.toBe(loss);
      else await expect(service(unreliable).remove(sampleId, runId, input, actor)).rejects.toThrow("Incomplete Run trash batch acknowledgement");
      expect(audits(f.native)).toHaveLength(1); const accepted = snapshot(f.native);
      await expect(service(f.sql).remove(sampleId, runId, input, actor)).rejects.toMatchObject({ status: 404 });
      expect(snapshot(f.native)).toEqual(accepted);
    }
  });

  it("captures the original streamed Request before a bodyLimit clone and freezes revision before awaited admission", async () => {
    const f = fixture(), selected: Request[] = []; type Bindings = { service: RunTrashService };
    const app = new Hono<{ Bindings: Bindings; Variables: { userEmail: string } }>();
    app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); });
    const handlers = createRunTrashHandlers<Bindings>((request, bindings) => { selected.push(request); return bindings.service; });
    let parsedRequest: Request | undefined;
    app.delete("/samples/:sampleId/runs/:runId", handlers.captureIngressRequest, bodyLimit({ maxSize: 8192 }), async (c, next) => { parsedRequest = c.req.raw; await next(); }, handlers.remove);
    const bytes = new TextEncoder().encode(JSON.stringify(revision(f.native)));
    const original = new Request(`http://127.0.0.1/samples/${sampleId}/runs/${runId}`, { method: "DELETE", headers: { "content-type": "application/json" },
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), duplex: "half" } as RequestInit & { duplex: "half" });
    const response = await app.fetch(original, { service: service(f.sql) });
    expect(response.status).toBe(200); expect(parsedRequest).not.toBe(original); expect(selected).toEqual([original]);
    const retained = snapshot(f.native);
    expect((await app.request(original.url, { method: "GET" }, { service: service(f.sql) })).status).toBe(404);
    expect(selected).toEqual([original]); expect(snapshot(f.native)).toEqual(retained);
    const isolated = fixture(), entered = gate(), resume = gate(), input = revision(isolated.native); let checks = 0;
    const pending = service(isolated.sql, async () => { if (++checks === 1) { entered.release(); await resume.promise; } }).remove(sampleId, runId, input, actor);
    await entered.promise; input.expectedSampleUpdatedAt = "forged-after-await"; resume.release();
    expect(await pending).toMatchObject({ ok: true }); expect(audits(isolated.native)).toHaveLength(1);
  });

  it("rechecks principal/control before batch and before ACK, and fences CAS against a genuine second native writer", async () => {
    const denied = fixture(), before = snapshot(denied.native); let checks = 0;
    await expect(service(denied.sql, async () => { if (++checks === 2) throw new HTTPException(503, { message: "Fixture control fenced" }); })
      .remove(sampleId, runId, revision(denied.native), actor)).rejects.toMatchObject({ status: 503 });
    expect(snapshot(denied.native)).toEqual(before);
    const accepted = fixture(); checks = 0;
    await expect(service(accepted.sql, async () => { if (++checks === 3) throw new HTTPException(401, { message: "Fixture session revoked" }); })
      .remove(sampleId, runId, revision(accepted.native), actor)).rejects.toMatchObject({ status: 401 });
    expect(audits(accepted.native)).toHaveLength(1); expect(accepted.native.prepare("SELECT deleted_at FROM runs WHERE id=?").get(runId)?.deleted_at).toEqual(expect.any(String));
    const concurrent = fixture(), entered = gate(), resume = gate(); checks = 0;
    const pending = service(concurrent.sql, async () => { if (++checks === 2) { entered.release(); await resume.promise; } })
      .remove(sampleId, runId, revision(concurrent.native), actor);
    const rejected = expect(pending).rejects.toMatchObject({ status: 409 }); await entered.promise;
    const writer = new DatabaseSync(concurrent.filename, { allowExtension: false, enableForeignKeyConstraints: true });
    try { expect(writer.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal"); writer.prepare("UPDATE samples SET title='Winner',updated_at='2026-08-04T00:00:00.000Z' WHERE id=?").run(sampleId); }
    finally { writer.close(); }
    const written = snapshot(concurrent.native); resume.release(); await rejected;
    expect(snapshot(concurrent.native)).toEqual(written); expect(audits(concurrent.native)).toEqual([]);
  });
});
