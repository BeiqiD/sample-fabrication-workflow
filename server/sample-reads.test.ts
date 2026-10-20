import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SampleDetail, SampleSummary } from "../shared/types";
import { createSampleReadService, type SampleReadService } from "../worker/samples/read-service";
import { createSampleReadSurface } from "../worker/samples/read-surface";
import { createSampleMetadataService } from "../worker/samples/metadata-service";
import { createSampleMetadataHandlers } from "../worker/samples/metadata-surface";
import { createNodeHttpServer } from "./http";
import { createSqliteCapability, type SqliteCapability } from "./sqlite";
import { asStorageConfigurationSqlDatabase } from "./storage-configuration-sql";

const actor = "local-account:local_reads_fixture", timestamp = "2026-08-01T10:00:00.000Z";
let directory = "", pristine = "", sequence = 0;
const cores: SqliteCapability[] = [], servers: Server[] = [];
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "rt1-sample-reads-")); pristine = join(directory, "pristine.sqlite");
  const database = new DatabaseSync(pristine, { allowExtension: false });
  try {
    const migrations = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) database.exec(readFileSync(new URL(name, migrations), "utf8"));
  } finally { database.close(); }
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const core of cores.splice(0)) core.close();
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const filename = join(directory, `${++sequence}.sqlite`); copyFileSync(pristine, filename);
  const database = new DatabaseSync(filename, { allowExtension: false }), core = createSqliteCapability(database);
  cores.push(core); const sql = asStorageConfigurationSqlDatabase(core);
  // Trusted deterministic read-admission witness, not a local session/login or
  // production installation fence. No actor/header spelling grants a capability.
  const admit = vi.fn(async (selected: string) => { if (selected !== actor) throw new HTTPException(403, { message: "Fixture account denied" }); });
  const selectDatabase = vi.fn(() => sql);
  const service = createSampleReadService({ database: selectDatabase, admit });
  return { database, core, sql, service, admit, selectDatabase };
}
function seed(database: DatabaseSync) {
  const sample = database.prepare(`INSERT INTO samples(id,code,title,status,location,pinned,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`);
  sample.run("parent", "PARENT", "Parent wafer", "stored", "Box 2", 0, timestamp, timestamp);
  sample.run("active", "READ-A", "AFM preparation", "active", "Box 1", 1, timestamp, timestamp);
  sample.run("complete", "READ-B", "Completed preparation", "stored", "Box 2", 0, timestamp, timestamp);
  sample.run("cancelled", "READ-C", "Cancelled preparation", "stored", "Box 3", 0, timestamp, timestamp);
  sample.run("deleted", "READ-D", "Deleted sample", "stored", "Hidden Box", 0, timestamp, timestamp);
  database.exec(`UPDATE samples SET parent_id='parent' WHERE id='active';
    UPDATE samples SET deleted_at='2026-08-02T00:00:00.000Z' WHERE id='deleted';
    INSERT INTO recipe_families(id,name,template_type,created_at) VALUES('family','AFM process','process','${timestamp}');
    INSERT INTO step_definitions(hash,name,canonical_json,created_at) VALUES('definition','Etch','{}','${timestamp}');
    INSERT INTO state_representations(hash,content_json,created_at) VALUES('state','{}','${timestamp}');
    INSERT INTO template_versions(id,recipe_family_id,name,template_type,version,manifest_hash,content_json,created_at)
      VALUES('template','family','AFM process','process',2,'manifest','{}','${timestamp}');
    INSERT INTO template_steps(id,template_version_id,logical_step_key,position,definition_hash,expected_state_hash,raw_json)
      VALUES('template-done','template','done',0.25,'definition','state','{}'),
        ('template-pending','template','pending',1.75,'definition',NULL,'{}');
    INSERT INTO runs(id,sample_id,recipe_family_id,template_version_id,sequence_no,run_group_id,
      template_name_snapshot,template_type_snapshot,template_version_snapshot,status,initial_state_hash,created_at)
      VALUES('run-active','active','family','template',2,'group','AFM process','process',2,'active','state','${timestamp}'),
        ('run-complete','complete','family','template',1,'group-complete','AFM process','process',2,'complete',NULL,'${timestamp}'),
        ('run-cancelled','cancelled','family','template',1,'group-cancelled','AFM process','process',2,'cancelled',NULL,'${timestamp}');
    INSERT INTO run_steps(id,run_id,template_step_id,logical_step_key,definition_hash,expected_state_hash,position,status,created_at,updated_at)
      VALUES('done','run-active','template-done','done','definition','state',1000.5,'done','${timestamp}','${timestamp}'),
        ('pending','run-active','template-pending','pending','definition',NULL,2000.125,'pending','${timestamp}','${timestamp}'),
        ('trashed','run-active',NULL,'trashed','definition',NULL,3000.25,'pending','${timestamp}','${timestamp}');
    UPDATE run_steps SET deleted_at='2026-08-02T00:00:00.000Z' WHERE id='trashed';
    INSERT INTO run_plan_revisions(id,run_id,revision_no,template_version_id,created_at)
      VALUES('revision','run-active',7,'template','${timestamp}');
    UPDATE runs SET current_plan_revision_id='revision' WHERE id='run-active';
    INSERT INTO run_step_plan_links(run_plan_revision_id,template_step_id,run_step_id,created_at)
      VALUES('revision','template-done','done','${timestamp}'),('revision','template-pending','pending','${timestamp}');
    INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,created_at)
      VALUES('image','read/image.png','image.png','image/png',4,'ready','${timestamp}');
    INSERT INTO state_representation_assets(state_hash,asset_id,position) VALUES('state','image',0);
    INSERT INTO run_step_assets(id,run_step_id,asset_id,role,position,created_at)
      VALUES('execution-image','done','image','execution',0,'${timestamp}');
    INSERT INTO run_step_comments(id,run_step_id,scope,legacy_body,created_at)
      VALUES('legacy-comment','done','individual','Retained text','${timestamp}');
    INSERT INTO state_verifications(id,sample_id,after_run_step_id,run_plan_revision_id,result,created_at)
      VALUES('verification','active','done','revision','matched','${timestamp}');
    INSERT INTO state_verification_steps(verification_id,run_step_id,ordinal)
      VALUES('verification','done',9007199254740993),('verification','pending',9007199254740994);
    INSERT INTO comment_submissions(id,context_kind,sample_id,scope,body,status,created_at,updated_at)
      VALUES('sample-draft','sample','active',NULL,'Draft observation','draft','${timestamp}','${timestamp}'),
        ('sample-cancelled','sample','active',NULL,'Must be hidden','cancelled','${timestamp}','${timestamp}'),
        ('step-draft','run_steps',NULL,'common','Pending step observation','draft','${timestamp}','${timestamp}');
    INSERT INTO comment_submission_items(id,submission_id,kind,status,position,filename,mime_type,byte_size,original_byte_size,created_at,updated_at)
      VALUES('draft-image','sample-draft','comment_image','pending',0,'draft.png','image/png',4,8,'${timestamp}','${timestamp}');
    INSERT INTO comment_submission_targets(submission_id,sample_id,run_id,run_step_id,expected_updated_at)
      VALUES('step-draft','active','run-active','pending','${timestamp}');
    INSERT INTO events(id,sample_id,kind,body,asset_key,metadata_json,created_at)
      VALUES('hidden-image','active','image','Removed image','read/image.png',
        '{"action":"sample_record","assetDeletedAt":"2026-08-02T00:00:00.000Z","thumbnailKey":"read/image.png"}','${timestamp}');`);
}
const query = (values: Record<string, string> = {}) => (key: string) => values[key];
async function listen(app: Pick<Hono<{ Bindings: { service: SampleReadService }; Variables: { userEmail: string } }>, "fetch">, service: SampleReadService) {
  const server = createNodeHttpServer(request => app.fetch(request, { service }), { publicOrigin: "https://read-fixture.test" });
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected private loopback listener");
  return (path: string) => fetch(`http://127.0.0.1:${address.port}/api${path}`);
}
async function listening(service: SampleReadService) {
  const app = new Hono<{ Bindings: { service: SampleReadService }; Variables: { userEmail: string } }>().basePath("/api");
  app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: "Unexpected server error" }, 500));
  app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); });
  app.route("/", createSampleReadSurface<{ service: SampleReadService }>((_request, bindings) => bindings.service));
  return listen(app, service);
}

describe("bounded Samples read projections on actual Node SQLite", () => {
  it("serves real HTTP pagination, matching-run/relevance filters, options and number-valued versions/counts", async () => {
    const f = fixture(); seed(f.database); const get = await listening(f.service);
    const response = await get("/samples?page=2&pageSize=1&sort=code-asc");
    expect(response.status).toBe(200); expect(response.headers.get("server-timing")).toMatch(/^d1;dur=\d+\.\d, serialize;dur=\d+\.\d$/);
    const payload = await response.json() as { samples: SampleSummary[]; pagination: { page: number; pageSize: number; total: number } };
    expect(payload).toMatchObject({ samples: [{ id: "parent", pinned: false }], pagination: { page: 2, pageSize: 1, total: 4 } });
    const matching = await (await get("/samples?runFamily=family&runKind=process&runStatus=active")).json() as { samples: SampleSummary[] };
    expect(matching.samples).toMatchObject([{ id: "active", latestWorkflowVersion: 2, latestRunStatus: "active" }]);
    const filtered = await (await get("/samples?q=AFM&parent=PARENT&location=Box%201&sort=relevance")).json() as { samples: SampleSummary[] };
    expect(filtered.samples.map(sample => sample.id)).toEqual(["active"]);
    const options = await get("/sample-directory-options"); expect(options.headers.get("server-timing")).toMatch(/^d1;dur=\d+\.\d$/);
    expect(await options.json()).toEqual({ locations: ["Box 1", "Box 2", "Box 3"], parents: [{ id: "parent", code: "PARENT", title: "Parent wafer" }], workflows: ["AFM process"] });
  });
  it("preserves Processing facets, thumbnail/current-step state, ordering and omitted detail sections", async () => {
    const f = fixture(); seed(f.database); const get = await listening(f.service);
    const result = await (await get("/samples?view=processing&status=all")).json() as { samples: SampleSummary[]; facets: Record<string, number>; pagination: { total: number } };
    expect(result.facets).toEqual({ active: 1, complete: 1, cancelled: 1, all: 4 }); expect(result.pagination.total).toBe(4);
    expect(result.samples[0]).toMatchObject({ id: "active", currentStepTitle: "Etch", currentStateStepTitle: "Etch", currentStateThumbnailKey: "read/image.png" });
    const complete = await (await get("/samples?view=processing&status=complete")).json() as { samples: SampleSummary[] };
    expect(complete.samples.map(sample => sample.id)).toEqual(["complete"]);
    const detail = await (await get("/samples/active?view=processing")).json() as Record<string, unknown>;
    expect(detail).not.toHaveProperty("parent"); expect(detail).not.toHaveProperty("children"); expect(detail).not.toHaveProperty("events");
  });
  it("applies matching-run filters to Processing rows, facet counts and pagination together", async () => {
    const f = fixture(); seed(f.database); const get = await listening(f.service);
    for (const runStatus of ["active", "complete", "cancelled"] as const) {
      for (const status of ["all", "active", "complete", "cancelled"] as const) {
        const response = await get(`/samples?view=processing&status=${status}&runFamily=family&runKind=process&runStatus=${runStatus}`);
        expect(response.status).toBe(200);
        const payload = await response.json() as { samples: SampleSummary[]; facets: Record<string, number>; pagination: { total: number } };
        const expected = { all: 1, active: Number(runStatus === "active"), complete: Number(runStatus === "complete"), cancelled: Number(runStatus === "cancelled") };
        expect(payload.facets).toEqual(expected); expect(payload.pagination.total).toBe(expected[status]);
        expect(payload.samples.map(sample => sample.id)).toEqual(expected[status] ? [runStatus === "active" ? "active" : runStatus] : []);
      }
    }
    const absent = await get("/samples?view=processing&status=all&runFamily=absent&runKind=process&runStatus=active");
    expect(absent.status).toBe(200); expect(await absent.json()).toMatchObject({ samples: [], facets: { all: 0, active: 0, complete: 0, cancelled: 0 }, pagination: { total: 0 } });
  });
  it("keeps decimal positions, exact unused ordinals, canonical comments, trash filtering and hidden media without writes", async () => {
    const f = fixture(); seed(f.database); const get = await listening(f.service);
    await f.sql.batch([f.sql.prepare("UPDATE samples SET rowid=?,pinned=? WHERE id='active'").bind(9007199254740993n, 9223372036854775807n)]);
    const before = await f.sql.prepare("SELECT total_changes() n").first();
    const response = await get("/samples/active"); expect(response.status).toBe(200); const detail = await response.json() as SampleDetail;
    expect(detail.parent).toEqual({ id: "parent", code: "PARENT", title: "Parent wafer" }); expect(detail.pinned).toBe(true);
    expect(detail.runs[0]).toMatchObject({ id: "run-active", sequenceNo: 2, planRevisionNumber: 7, templateVersion: 2,
      initialStateImageKeys: ["read/image.png"], steps: [{ id: "done", position: 1000.5, planPosition: 0.25 }, { id: "pending", position: 2000.125, planPosition: 1.75 }] });
    expect(detail.runs[0].steps).toHaveLength(2); expect(detail.runs[0].steps[0].executionImageKeys).toEqual(["read/image.png"]);
    expect(detail.runs[0].steps[0].comments).toMatchObject([{ id: "legacy-comment", body: "Retained text", status: "ready" }]);
    expect(detail.runs[0].steps[1].comments).toMatchObject([{ id: "submission:step-draft:pending", body: "Pending step observation", status: "draft", operationGroupId: "step-draft" }]);
    expect(detail.stateVerifications[0].coveredRunStepIds).toEqual(["done", "pending"]);
    expect(detail.comments).toMatchObject([{ id: "sample-draft", body: "Draft observation", images: [{ byteSize: 4, originalByteSize: 8, status: "pending" }] }]);
    const event = detail.events.find(entry => entry.id === "hidden-image")!;
    expect(event.assetKey).toBeNull(); expect(event.metadata).not.toHaveProperty("thumbnailKey"); expect(event).not.toHaveProperty("assetUrl"); expect(event).not.toHaveProperty("thumbnailUrl");
    expect(await f.sql.prepare("SELECT rowid,pinned FROM samples WHERE id='active'").first()).toEqual({ rowid: 9007199254740993n, pinned: 9223372036854775807n });
    expect(await f.sql.prepare("SELECT ordinal FROM state_verification_steps ORDER BY ordinal").all()).toEqual({ results: [{ ordinal: 9007199254740993n }, { ordinal: 9007199254740994n }] });
    expect(await f.sql.prepare("SELECT total_changes() n").first()).toEqual(before);
    expect(f.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    await f.sql.batch([f.sql.prepare("UPDATE samples SET deleted_at=? WHERE id='parent'").bind(timestamp)]);
    const detached = await f.service.detail("active", query(), actor);
    expect("parent" in detached ? detached.parent : undefined).toBeNull();
    await expect(f.service.detail("deleted", query(), actor)).rejects.toMatchObject({ status: 404, message: "Sample not found" });
  });
  it("rejects invalid matching-run filters before database/admission and rechecks current read admission before ACK", async () => {
    const f = fixture(); seed(f.database);
    const invalid: Record<string, string>[] = [{ runKind: "process" }, { runFamily: "family", runKind: "bad", runStatus: "active" }, { runFamily: "x".repeat(201), runKind: "process", runStatus: "active" }];
    for (const value of invalid) {
      await expect(f.service.directory(query(value), actor)).rejects.toMatchObject({ status: 400, message: "Invalid matching-run filter" });
    }
    expect(f.admit).not.toHaveBeenCalled(); expect(f.selectDatabase).not.toHaveBeenCalled();
    await expect(f.service.directoryOptions("forged-actor")).rejects.toMatchObject({ status: 403 }); expect(f.selectDatabase).not.toHaveBeenCalled();
    let admissions = 0;
    const guarded = createSampleReadService({ database: () => f.sql, admit: async selected => {
      expect(selected).toBe(actor); if (++admissions === 2) throw new HTTPException(503, { message: "Fixture source fenced" });
    } });
    await expect(guarded.directory(query(), actor)).rejects.toMatchObject({ status: 503, message: "Fixture source fenced" });
    admissions = 0; await expect(guarded.detail("active", query(), actor)).rejects.toMatchObject({ status: 503 });
    admissions = 0; await expect(guarded.directoryOptions(actor)).rejects.toMatchObject({ status: 503 });
  });
  it("rejects unsafe named wire revisions and byte sizes while unrelated exact cells remain intact", async () => {
    const f = fixture(); seed(f.database);
    await f.sql.batch([f.sql.prepare("UPDATE runs SET sequence_no=? WHERE id='run-active'").bind(9223372036854775807n)]);
    expect((await f.service.directory(query(), actor)).payload.samples.find(sample => sample.id === "active")?.latestWorkflowVersion).toBe(2);
    await expect(f.service.detail("active", query(), actor)).rejects.toThrow("sample.run.sequence_no");
    expect(await f.sql.prepare("SELECT sequence_no FROM runs WHERE id='run-active'").first()).toEqual({ sequence_no: 9223372036854775807n });
    await f.sql.batch([f.sql.prepare("UPDATE runs SET sequence_no=2 WHERE id='run-active'"),
      f.sql.prepare("UPDATE comment_submission_items SET byte_size=? WHERE id='draft-image'").bind(9223372036854775807n)]);
    await expect(f.service.detail("active", query(), actor)).rejects.toThrow("comment_item.byte_size");
    expect(await f.sql.prepare("SELECT byte_size FROM comment_submission_items WHERE id='draft-image'").first()).toEqual({ byte_size: 9223372036854775807n });
  });
  it("fails partial File schema with existing 503 while ordinary lightweight directory remains available", async () => {
    const f = fixture(); seed(f.database); f.database.exec("DROP TABLE file_authority_control");
    await expect(f.service.directory(query({ view: "processing" }), actor)).rejects.toMatchObject({ status: 503, message: "Sample File metadata is unavailable" });
    await expect(f.service.detail("active", query(), actor)).rejects.toMatchObject({ status: 503, message: "Sample File metadata is unavailable" });
    expect((await f.service.directory(query(), actor)).payload.pagination.total).toBe(4);
  });
  it("retains the exact original transport Request through actual chunked bodyLimit clones and scopes capture to owned methods", async () => {
    const f = fixture();
    type Bindings = { marker: string; parsed?: Request };
    const owned = new WeakSet<Request>(), selected: Array<{ original: Request; parsed: Request; marker: string }> = [];
    const app = new Hono<{ Bindings: Bindings; Variables: { userEmail: string } }>().basePath("/api");
    app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: "Unexpected server error" }, 500));
    app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); });
    const handlers = createSampleMetadataHandlers<Bindings>((original, bindings) => {
      if (!bindings.parsed) throw new Error("Expected parsed request");
      selected.push({ original, parsed: bindings.parsed, marker: bindings.marker });
      return createSampleMetadataService({ database: () => f.sql, now: () => Date.parse(timestamp), randomId: () => crypto.randomUUID(),
        admit: async selectedActor => { if (selectedActor !== actor || !owned.has(original)) throw new HTTPException(503, { message: "Original ingress unavailable" }); } });
    });
    app.post("/samples", handlers.captureIngressRequest, bodyLimit({ maxSize: 4096 }), async (c, next) => {
      c.env = { marker: "current-request-binding", parsed: c.req.raw }; await next();
    }, handlers.create);
    app.post("/unrelated", c => c.json({ ok: true }));
    const server = createNodeHttpServer(request => { owned.add(request); return app.fetch(request, { marker: "original-binding" }); }, { publicOrigin: "https://ingress-fixture.test" });
    servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected loopback listener");
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"code":"INGRESS",')); controller.enqueue(new TextEncoder().encode('"title":"Original Request"}')); controller.close();
    } });
    const response = await fetch(`http://127.0.0.1:${address.port}/api/samples`, { method: "POST", headers: { "content-type": "application/json" }, body,
      duplex: "half" } as RequestInit & { duplex: "half" });
    expect(response.status).toBe(201); expect(selected).toHaveLength(1);
    expect(selected[0].original).not.toBe(selected[0].parsed); expect(owned.has(selected[0].original)).toBe(true); expect(owned.has(selected[0].parsed)).toBe(false);
    expect(selected[0].marker).toBe("current-request-binding");
    const unrelated = await fetch(`http://127.0.0.1:${address.port}/api/unrelated`, { method: "POST" });
    expect(unrelated.status).toBe(200); expect(selected).toHaveLength(1);
  });
});
