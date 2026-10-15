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
import { createMetrologyWriteService, type MetrologyWriteService } from "../worker/execution/metrology-write-service";
import { createMetrologyWriteHandlers, createMetrologyWriteSurface } from "../worker/execution/metrology-write-surface";
import type { ConfigurationSqlDatabase } from "../worker/runtime/configuration-sql";
import { CURRENT_NODE_INSTALLATION_CATALOG } from "./installation-catalog";
import { installReviewedSqliteCatalog } from "./migrations";
import { createSqliteCapability, type SqliteCapability } from "./sqlite";
import { asStorageConfigurationSqlDatabase } from "./storage-configuration-sql";
import { createNodeHttpServer } from "./http";
// UNEXECUTED source candidate. Actual current23 core/SQLite/HTTP fixtures,
// not installed auth, physical writer lease, media/provider or mounted app.
const actor = "local-account:metrology_write_fixture", sampleId = "reference-sample-a", runId = "reference-run-a";
let directory = "", pristine = "", sequence = 0;
const cores: SqliteCapability[] = [], listeners: Server[] = [];
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "rt1-metrology-write-")); pristine = join(directory, "pristine.sqlite");
  console.info("Retained private Metrology write fixtures:", directory);
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
  return createMetrologyWriteService({ database: () => database, admit,
    now: () => Date.parse("2026-08-03T00:00:00.000Z"), randomId: randomUUID });
}
function snapshot(native: DatabaseSync) {
  return native.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => {
    if (typeof row.name !== "string") throw new Error("Invalid fixture table");
    const statement = native.prepare(`SELECT * FROM "${row.name.replaceAll('"', '""')}" ORDER BY 1`);
    statement.setReadBigInts(true); return [row.name, statement.all()];
  });
}
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
function application(current: MetrologyWriteService) {
  type Bindings = { service: MetrologyWriteService };
  const app = new Hono<{ Bindings: Bindings; Variables: { userEmail: string } }>();
  app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: "Unexpected server error" }, 500));
  app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); });
  app.route("/api", createMetrologyWriteSurface<Bindings>((_request, bindings) => bindings.service));
  return { app, bindings: { service: current } };
}

const templateId = "reference-metrology-template", input = () => ({ templateVersionId: templateId });
function seedFollowing(native: DatabaseSync, at = 1) {
  native.prepare(`INSERT INTO run_steps(id,run_id,previous_step_id,position,origin,definition_hash,title,status,entry_kind,created_at,updated_at)
    VALUES('following',?,'reference-step-a',?,'ad_hoc','reference-step-definition','Following','pending','fabrication','2026-08-01T02:00:00.000Z','2026-08-01T02:00:00.000Z')`).run(runId, at);
}
function audits(native: DatabaseSync) {
  return native.prepare("SELECT metadata_json,actor_email FROM events WHERE json_extract(metadata_json,'$.action') IN ('metrology_added','metrology_run_started') ORDER BY created_at,id").all();
}

describe("shared Metrology metadata on genuine current23 Node: six finite scopes", () => {
  it("serves both real HTTP methods with fractional adjacency, authentic template snapshots and preserved File/Comment metadata", async () => {
    const f = fixture(); seedFollowing(f.native);
    const { app, bindings } = application(service(f.sql));
    const server = createNodeHttpServer(request => app.fetch(request, bindings), { publicOrigin: "http://metrology-fixture.test" });
    listeners.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected actual loopback");
    const invoke = (path: string, value: unknown) => fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      method: "POST", headers: { "content-type": "application/json", "cf-access-authenticated-user-email": "forged-owner@example.test" }, body: JSON.stringify(value) });
    const retainedTables = ["run_step_assets", "assets", "metrology_template_references", "run_step_comments", "comment_submissions", "comment_submission_items"];
    const retained = retainedTables.map(table => [table, f.native.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]);
    const originalStep = f.native.prepare("SELECT * FROM run_steps WHERE id='reference-step-a'").get();
    const added = await invoke(`/samples/${sampleId}/runs/${runId}/metrology`, { ...input(), afterStepId: "reference-step-a" });
    expect(added.status).toBe(201); const { id: addedId } = await added.json() as { id: string };
    expect(f.native.prepare("SELECT position,previous_step_id,entry_kind,origin,template_step_id,logical_step_key,definition_hash,status,actualized_at,updated_by FROM run_steps WHERE id=?").get(addedId))
      .toEqual({ position: 0.5, previous_step_id: "reference-step-a", entry_kind: "metrology", origin: "ad_hoc", template_step_id: "reference-metrology-template-step", logical_step_key: "reference:sem", definition_hash: "reference-metrology-definition", status: "pending", actualized_at: "2026-08-03T00:00:00.000Z", updated_by: actor });
    expect(f.native.prepare("SELECT previous_step_id FROM run_steps WHERE id='following'").get()).toEqual({ previous_step_id: addedId });
    expect(f.native.prepare("SELECT * FROM run_steps WHERE id='reference-step-a'").get()).toEqual(originalStep);
    const started = await invoke(`/samples/${sampleId}/metrology-runs`, input()); expect(started.status).toBe(201);
    const { id: metroId } = await started.json() as { id: string };
    expect(f.native.prepare("SELECT sample_id,run_kind,sequence_no,status,template_version_id,template_name_snapshot,template_type_snapshot,template_version_snapshot,created_by FROM runs WHERE id=?").get(metroId))
      .toEqual({ sample_id: sampleId, run_kind: "metrology", sequence_no: 2, status: "active", template_version_id: templateId, template_name_snapshot: "Reference SEM", template_type_snapshot: "module", template_version_snapshot: 2, created_by: actor });
    expect(f.native.prepare("SELECT entry_kind,origin,position,actualized_at,definition_hash FROM run_steps WHERE run_id=?").get(metroId))
      .toEqual({ entry_kind: "metrology", origin: "template", position: 1000, actualized_at: null, definition_hash: "reference-metrology-definition" });
    const sample = f.native.prepare("SELECT status,updated_by,updated_at FROM samples WHERE id=?").get(sampleId);
    expect(sample).toEqual({ status: "active", updated_by: actor, updated_at: "2026-08-03T00:00:00.001Z" });
    expect(audits(f.native)).toHaveLength(2); expect(audits(f.native).every(row => row.actor_email === actor)).toBe(true);
    expect(JSON.parse(String(audits(f.native)[0].metadata_json))).toEqual({ runId, stepId: addedId, action: "metrology_added", templateVersionId: templateId, afterStepId: "reference-step-a" });
    expect(retainedTables.map(table => [table, f.native.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()])).toEqual(retained);
    expect(f.native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("preserves zero-SQL malformed inputs and current Sample/Run/template/single-step availability errors", async () => {
    const f = fixture(); let selected = 0, admitted = 0;
    const current = createMetrologyWriteService({ database: () => { selected++; return f.sql; }, admit: async () => { admitted++; }, now: Date.now, randomId: randomUUID });
    for (const value of [null, [], {}, { templateVersionId: 12 }, { templateVersionId: "" }]) {
      await expect(current.addEntry(sampleId, runId, value, actor)).rejects.toMatchObject({ status: 400 });
      await expect(current.startRun(sampleId, value, actor)).rejects.toMatchObject({ status: 400 });
    }
    await expect(current.addEntry(sampleId, runId, { ...input(), afterStepId: 12 }, actor)).rejects.toMatchObject({ status: 400 });
    expect(selected).toBe(0); expect(admitted).toBe(0);
    const before = snapshot(f.native);
    await expect(current.addEntry("reference-sample-b", runId, input(), actor)).rejects.toMatchObject({ status: 404, message: "Active process run not found" });
    await expect(current.startRun("missing", input(), actor)).rejects.toMatchObject({ status: 404, message: "Sample not found" });
    await expect(current.addEntry(sampleId, runId, { templateVersionId: "reference-process-template" }, actor)).rejects.toMatchObject({ status: 404, message: "Metrology template not found" });
    await expect(current.addEntry(sampleId, runId, { ...input(), afterStepId: "missing" }, actor)).rejects.toMatchObject({ status: 404, message: "Insertion point not found" });
    expect(snapshot(f.native)).toEqual(before);
    for (const sql of ["UPDATE template_versions SET archived_at='2026-08-02T00:00:00.000Z' WHERE id='reference-metrology-template'",
      "UPDATE template_versions SET deleted_at='2026-08-02T00:00:00.000Z' WHERE id='reference-metrology-template'",
      "INSERT INTO template_steps(id,template_version_id,logical_step_key,position,definition_hash) VALUES('duplicate','reference-metrology-template','duplicate',1,'reference-metrology-definition')"]) {
      const isolated = fixture(); isolated.native.exec(sql); const saved = snapshot(isolated.native), guarded = service(isolated.sql);
      await expect(guarded.addEntry(sampleId, runId, input(), actor)).rejects.toMatchObject({ status: 404 });
      await expect(guarded.startRun(sampleId, input(), actor)).rejects.toMatchObject({ status: 404 });
      expect(snapshot(isolated.native)).toEqual(saved);
    }
  });

  it("rolls an actual audit failure back and keeps accepted writes after lost/incomplete ACK without manufacturing idempotent retries", async () => {
    for (const method of ["addEntry", "startRun"] as const) {
      const f = fixture(); f.native.exec("CREATE TRIGGER metrology_fixture_audit_failure BEFORE INSERT ON events WHEN json_extract(NEW.metadata_json,'$.action') IN ('metrology_added','metrology_run_started') BEGIN SELECT RAISE(ABORT,'fixture Metrology audit denied'); END");
      const before = snapshot(f.native), current = service(f.sql);
      const work = method === "addEntry" ? current.addEntry(sampleId, runId, input(), actor) : current.startRun(sampleId, input(), actor);
      await expect(work).rejects.toThrow("fixture Metrology audit denied"); expect(snapshot(f.native)).toEqual(before); expect(f.native.isTransaction).toBe(false);
    }
    for (const lost of [true, false]) {
      const f = fixture(), loss = new Error("Fixture Metrology ACK lost");
      const unreliable: ConfigurationSqlDatabase = { ...f.sql, async batch(statements) { await f.sql.batch(statements); if (lost) throw loss; return []; } };
      const work = service(unreliable).startRun(sampleId, input(), actor);
      if (lost) await expect(work).rejects.toBe(loss); else await expect(work).rejects.toThrow("Incomplete Metrology Run batch acknowledgement");
      expect(audits(f.native)).toHaveLength(1); expect(f.native.prepare("SELECT COUNT(*) n FROM runs WHERE run_kind='metrology'").get()?.n).toBe(1);
      // Existing input has no operation ID/revision: a deliberate subsequent
      // request is a NEW run, not a claimed exact retry or recovery receipt.
    }
  });

  it("fences template/Sample/adjacent-step races against a real second native writer without partial insertion", async () => {
    for (const action of ["adjacency", "sample", "archive"] as const) {
      const f = fixture(); seedFollowing(f.native); let checks = 0; const entered = gate(), resume = gate();
      const current = service(f.sql, async () => { if (++checks === 2) { entered.release(); await resume.promise; } });
      const pending = action === "sample" ? current.startRun(sampleId, input(), actor) : current.addEntry(sampleId, runId, { ...input(), afterStepId: "reference-step-a" }, actor);
      const rejected = expect(pending).rejects.toMatchObject({ status: 409 }); await entered.promise;
      const writer = new DatabaseSync(f.filename, { allowExtension: false, enableForeignKeyConstraints: true });
      try {
        expect(writer.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
        if (action === "adjacency") writer.prepare("UPDATE run_steps SET position=2,updated_at='2026-08-04T00:00:00.000Z' WHERE id='following'").run();
        else if (action === "sample") writer.prepare("UPDATE samples SET updated_at='2026-08-04T00:00:00.000Z' WHERE id=?").run(sampleId);
        else writer.prepare("UPDATE template_versions SET archived_at='2026-08-04T00:00:00.000Z' WHERE id=?").run(templateId);
      } finally { writer.close(); }
      const written = snapshot(f.native); resume.release(); await rejected;
      expect(snapshot(f.native)).toEqual(written); expect(audits(f.native)).toEqual([]);
    }
  });

  it("captures original streamed ingress, freezes template/insertion identity, and rejects unsafe consumed numeric cells before publication", async () => {
    const f = fixture(); type Bindings = { service: MetrologyWriteService }; const selected: Request[] = [];
    const app = new Hono<{ Bindings: Bindings; Variables: { userEmail: string } }>();
    app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); });
    const handlers = createMetrologyWriteHandlers<Bindings>((request, bindings) => { selected.push(request); return bindings.service; });
    let parsed: Request | undefined;
    app.post("/samples/:sampleId/metrology-runs", handlers.captureIngressRequest, bodyLimit({ maxSize: 8192 }), async (c, next) => { parsed = c.req.raw; await next(); }, handlers.startRun);
    const bytes = new TextEncoder().encode(JSON.stringify(input()));
    const request = new Request(`http://127.0.0.1/samples/${sampleId}/metrology-runs`, { method: "POST", headers: { "content-type": "application/json" }, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), duplex: "half" } as RequestInit & { duplex: "half" });
    expect((await app.fetch(request, { service: service(f.sql) })).status).toBe(201); expect(parsed).not.toBe(request); expect(selected).toEqual([request]);
    const isolated = fixture(), entered = gate(), resume = gate(), value = { ...input(), afterStepId: "reference-step-a" }; let checks = 0;
    const pending = service(isolated.sql, async () => { if (++checks === 1) { entered.release(); await resume.promise; } }).addEntry(sampleId, runId, value, actor);
    await entered.promise; value.templateVersionId = "missing"; value.afterStepId = "missing"; resume.release(); expect(await pending).toMatchObject({ id: expect.any(String) });
    const unsafe = fixture(); unsafe.native.prepare("UPDATE runs SET sequence_no=? WHERE id=?").run(9007199254740991n, runId);
    const before = snapshot(unsafe.native); await expect(service(unsafe.sql).startRun(sampleId, input(), actor)).rejects.toThrow("Metrology next sequence_no"); expect(snapshot(unsafe.native)).toEqual(before);
    const consumed = fixture(); consumed.native.prepare("UPDATE run_steps SET position=? WHERE id='reference-step-a'").run(9007199254740993n);
    const retained = snapshot(consumed.native); await expect(service(consumed.sql).addEntry(sampleId, runId, input(), actor)).rejects.toThrow("Metrology step position"); expect(snapshot(consumed.native)).toEqual(retained);
  });

  it("requires live principal/control prebatch and postcommit while retaining accepted SQL on denied ACK", async () => {
    for (const method of ["addEntry", "startRun"] as const) {
      for (const deniedCheck of [2, 3]) {
        const f = fixture(), before = snapshot(f.native); let checks = 0;
        const current = service(f.sql, async () => { if (++checks === deniedCheck) throw new HTTPException(403, { message: "Fixture current authority revoked" }); });
        const work = method === "addEntry" ? current.addEntry(sampleId, runId, input(), actor) : current.startRun(sampleId, input(), actor);
        await expect(work).rejects.toMatchObject({ status: 403 });
        if (deniedCheck === 2) expect(snapshot(f.native)).toEqual(before); else expect(audits(f.native)).toHaveLength(1);
      }
    }
  });
});
