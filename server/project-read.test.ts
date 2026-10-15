import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_PROJECT_SAFE_INTEGER } from "../shared/project-types";
import { MAX_REFERENCE_RESOLUTION_TARGETS } from "../shared/reference-types";
import { projectReadProjectRow, projectReadDecimal } from "../worker/projects/read-decoding";
import { listProjects, readProjectSnapshot, createProjectReadService, type ProjectReadService } from "../worker/projects/read-service";
import { createProjectReadSurface } from "../worker/projects/read-surface";
import { CURRENT_NODE_INSTALLATION_CATALOG } from "./installation-catalog";
import { installReviewedSqliteCatalog } from "./migrations";
import { asProjectReadDatabase } from "./project-read-sql";
import { createSqliteCapability, type SqliteCapability } from "./sqlite";

// Explicit library qualification, not a mounted Node business runtime or an
// authentication/physical lease witness. All writes are private fixture seeds.
const actor = "local-account:project_read_fixture", now = "2026-08-01T10:00:00.000Z";
let directory = "", pristine = "", sequence = 0;
const cores: SqliteCapability[] = [], workers: Worker[] = [];
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "rt1-project-reads-")); pristine = join(directory, "pristine.sqlite");
  console.info("Private Project read fixtures:", directory);
  const native = new DatabaseSync(pristine, { allowExtension: false, enableForeignKeyConstraints: true });
  try {
    native.exec("PRAGMA journal_mode=WAL");
    expect(installReviewedSqliteCatalog(native, CURRENT_NODE_INSTALLATION_CATALOG).checkpointId).toBe("portable-runtime/v25");
    expect(native.prepare("SELECT COUNT(*) n FROM node_migrations").get()?.n).toBe(23);
  } finally { native.close(); }
});
afterEach(async () => {
  for (const worker of workers.splice(0)) await bounded(worker.terminate(), "Native writer cleanup deadline");
  for (const core of cores.splice(0)) core.close();
  // Retain every isolated database for failure diagnosis; never copy user state.
});
function fixture() {
  const filename = join(directory, `${++sequence}.sqlite`); copyFileSync(pristine, filename);
  const native = new DatabaseSync(filename, { allowExtension: false, enableForeignKeyConstraints: true });
  const core = createSqliteCapability(native); cores.push(core);
  return { filename, native, core, sql: asProjectReadDatabase(core) };
}
function project(native: DatabaseSync, id = "p", title = "Project before", revision = 1) {
  native.prepare(`INSERT INTO projects(id,title,revision,next_created_sequence,last_mutation_id,created_by,updated_by,created_at,updated_at)
    VALUES(?,?,?,200,?,?,?,?,?)`).run(id, title, revision, `create-${id}`, actor, actor, now, now);
}
function content(native: DatabaseSync, id = "c", projectId = "p", type: "markdown" | "attachment" = "markdown") {
  native.prepare(`INSERT INTO project_contents(id,project_id,content_type,markdown_source,attachment_caption,last_mutation_id,
    created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(id, projectId, type, type === "markdown" ? "# Before" : null, type === "attachment" ? "Caption" : null,
      `create-${id}`, actor, actor, now, now);
}
function item(native: DatabaseSync, id: string, sequenceNumber: number, contentId: string | null, targetId: string | null = null) {
  native.prepare(`INSERT INTO project_items(id,project_id,item_type,project_content_id,reference_target_id,created_sequence,
    last_mutation_id,created_by,updated_by,created_at,updated_at) VALUES(?,'p',?,?,?,?,?,?,?,?,?)`)
    .run(id, contentId ? "content" : "reference", contentId, targetId, sequenceNumber, `create-${id}`, actor, actor, now, now);
  native.prepare(`INSERT INTO project_map_placements(id,project_item_id,x,y,width,height,z_index,last_mutation_id,
    created_by,updated_by,created_at,updated_at) VALUES(?,?,0.25,-0.5,320.5,180.25,-2,?,?,?,?,?)`)
    .run(`place-${id}`, id, `place-${id}`, actor, actor, now, now);
}
function sampleReference(native: DatabaseSync, number: number) {
  const id = `sample-${number}`, target = `target-${number}`;
  native.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, `S-${number}`, `Sample ${number}`, now, now);
  native.prepare(`INSERT INTO reference_targets(id,target_type,target_id,first_registered_at,last_validated_at)
    VALUES(?,'sample',?,?,?)`).run(target, id, now, now);
  return target;
}
function seed(native: DatabaseSync) { project(native); content(native); item(native, "item-c", 1, "c"); }
function projectRows(native: DatabaseSync) {
  return ["projects", "project_contents", "project_content_attachments", "project_items", "project_map_placements", "project_edges", "reference_targets"]
    .map(table => [table, native.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]);
}
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

describe("Project reads over a genuine installed Node core: six finite scopes", () => {
  it("preserves list ordering and the seven-statement snapshot serializers without modifying metadata", async () => {
    const f = fixture(); seed(f.native); project(f.native, "q", "Other project");
    content(f.native, "a", "p", "attachment");
    f.native.prepare(`INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,created_at)
      VALUES('asset','private/metadata.png','metadata.png','image/png',4,'ready',?)`).run(now);
    f.native.prepare(`INSERT INTO project_content_attachments(project_content_id,asset_id,original_name,mime_type,byte_size,
      created_by,created_at,creation_operation_id) VALUES('a','asset','metadata.png','image/png',4,?,?,'attachment-a')`).run(actor, now);
    item(f.native, "item-a", 2, "a"); const target = sampleReference(f.native, 1); item(f.native, "item-ref", 3, null, target);
    f.native.prepare(`INSERT INTO project_edges(id,project_id,source_item_id,target_item_id,source_handle,target_handle,marker_start,marker_end,
      label,last_mutation_id,created_by,updated_by,created_at,updated_at)
      VALUES('edge','p','item-c','item-a','right','left','none','arrow','Linked','edge-create',?,?,?,?)`).run(actor, actor, now, now);
    const before = projectRows(f.native), batch = vi.spyOn(f.sql, "readBatch");
    expect((await listProjects(f.sql)).projects.map(row => row.id)).toEqual(["p", "q"]);
    const result = await readProjectSnapshot(f.sql, "p");
    expect(batch).toHaveBeenCalledTimes(1); expect(batch.mock.calls[0][0]).toHaveLength(7);
    expect(result.project).toMatchObject({ id: "p", title: "Project before", revision: 1 });
    expect(result.contents.map(row => row.id)).toEqual(["c", "a"]);
    expect(result.items.map(row => row.createdSequence)).toEqual([1, 2, 3]);
    expect(result.attachments).toEqual([{ projectContentId: "a", originalName: "metadata.png", mimeType: "image/png", byteSize: 4,
      createdBy: actor, createdAt: now, fileUrl: "/api/projects/p/contents/a/file" }]);
    expect(result.placements[0]).toMatchObject({ x: 0.25, y: -0.5, width: 320.5, height: 180.25, zIndex: -2 });
    expect(result.edges[0]).toMatchObject({ id: "edge", label: "Linked", markerEnd: "arrow" });
    expect(result.references[0].resolution).toMatchObject({ resolution: "resolved", target: { type: "sample", id: "sample-1" } });
    expect(projectRows(f.native)).toEqual(before);
    expect(f.native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("preserves deleted filtering, includeDeleted and missing-Project errors", async () => {
    const f = fixture(); seed(f.native); project(f.native, "deleted", "Deleted project");
    f.native.prepare(`UPDATE projects SET deleted_at=?,deleted_by=?,deletion_operation_id='delete-project',revision=revision+1,
      last_mutation_id='delete-project',updated_by=?,updated_at=? WHERE id='deleted'`).run(now, actor, actor, now);
    expect((await listProjects(f.sql)).projects.map(row => row.id)).toEqual(["p"]);
    expect((await listProjects(f.sql, true)).projects.map(row => row.id)).toEqual(["p", "deleted"]);
    await expect(readProjectSnapshot(f.sql, "deleted")).rejects.toMatchObject({ code: "not_found", message: "Project not found" });
    expect((await readProjectSnapshot(f.sql, "deleted", true)).project.deletedAt).toBe(now);
    await expect(readProjectSnapshot(f.sql, "missing")).rejects.toMatchObject({ code: "not_found" });
    f.native.prepare(`UPDATE project_contents SET deleted_at=?,deleted_by=?,deletion_operation_id='remove-c',revision=revision+1,
      last_mutation_id='remove-c',updated_by=?,updated_at=? WHERE id='c'`).run(now, actor, actor, now);
    f.native.prepare(`UPDATE project_items SET deleted_at=?,deleted_by=?,deletion_operation_id='remove-c',revision=revision+1,
      last_mutation_id='remove-c',updated_by=?,updated_at=? WHERE id='item-c'`).run(now, actor, actor, now);
    const active = await readProjectSnapshot(f.sql, "p"), trash = await readProjectSnapshot(f.sql, "p", true);
    expect(active.contents).toEqual([]); expect(active.items).toEqual([]); expect(active.placements).toEqual([]);
    expect(trash.contents[0].id).toBe("c"); expect(trash.items[0].deletedAt).toBe(now); expect(trash.placements).toHaveLength(1);
  });
  it("retains exact unconsumed integer cells and checks named numeric fields, bindings and foreign read statements", async () => {
    const f = fixture(), other = fixture(); project(f.native, "p", "Exact maximum", MAX_PROJECT_SAFE_INTEGER);
    expect((await listProjects(f.sql)).projects[0].revision).toBe(MAX_PROJECT_SAFE_INTEGER);
    const cells = await f.sql.prepare("SELECT 9007199254740993 AS unconsumed, 0.25 AS fraction, x'00ff' AS bytes, NULL AS absent").first();
    expect(cells).toEqual({ unconsumed: 9007199254740993n, fraction: 0.25, bytes: new Uint8Array([0, 255]), absent: null });
    const unsafe = await f.sql.prepare("SELECT *,9007199254740993 AS bad_revision FROM projects WHERE id=?").bind("p").first();
    expect(() => projectReadProjectRow({ ...unsafe!, revision: unsafe!.bad_revision })).toThrow(/project.revision/);
    expect(projectReadDecimal(cells!.fraction, "placement.x", -1, 1)).toBe(0.25);
    expect(() => projectReadDecimal(cells!.unconsumed, "placement.x", -1, 1)).toThrow();
    const statement = f.sql.prepare("SELECT ? AS value").bind(1n).bind(2n);
    expect(Object.keys(statement).sort()).toEqual(["all", "bind", "first"]);
    expect((await f.sql.readBatch([statement]))[0].results).toEqual([{ value: 2n }]);
    await expect(f.sql.readBatch([other.sql.prepare("SELECT 1")])).rejects.toThrow("Foreign Project read statement");
    await expect(f.sql.readBatch([asProjectReadDatabase(f.core).prepare("SELECT 1")])).rejects.toThrow("Foreign Project read statement");
    expect(() => f.sql.prepare("UPDATE projects SET title='wrong'")).toThrow();
    expect(() => f.sql.prepare("SELECT 1; DELETE FROM projects")).toThrow("Only one SQL statement");
    expect(() => statement.bind(Number.MAX_SAFE_INTEGER + 1)).toThrow("exact");
    expect((await listProjects(f.sql)).projects[0].title).toBe("Exact maximum");
  });
  it("keeps reference resolution bounded, ordered and separately timed after the atomic Project batch", async () => {
    const measuredStart = performance.now();
    const f = fixture(); const count = MAX_REFERENCE_RESOLUTION_TARGETS + 1;
    console.info("Project boundary fixture open ms", performance.now() - measuredStart);
    // Seed the identical full boundary fixture in one native transaction;
    // durable per-row autocommits are outside the read contract under test.
    f.native.exec("BEGIN IMMEDIATE");
    try {
      project(f.native);
      // Prepare each unchanged seed statement once while all mature guards
      // remain enabled; compiling the complete trigger graph 804 times is
      // fixture work and measured 8.4s before the actual 15.5ms read.
      const insertSample = f.native.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES(?,?,?,?,?)");
      const insertReference = f.native.prepare(`INSERT INTO reference_targets(id,target_type,target_id,first_registered_at,last_validated_at)
        VALUES(?,'sample',?,?,?)`);
      const insertItem = f.native.prepare(`INSERT INTO project_items(id,project_id,item_type,project_content_id,reference_target_id,created_sequence,
        last_mutation_id,created_by,updated_by,created_at,updated_at) VALUES(?,'p',?,?,?,?,?,?,?,?,?)`);
      const insertPlacement = f.native.prepare(`INSERT INTO project_map_placements(id,project_item_id,x,y,width,height,z_index,last_mutation_id,
        created_by,updated_by,created_at,updated_at) VALUES(?,?,0.25,-0.5,320.5,180.25,-2,?,?,?,?,?)`);
      for (let i = 0; i < count; i++) {
        const sampleId = `sample-${i}`, targetId = `target-${i}`, itemId = `ref-${i}`;
        insertSample.run(sampleId, `S-${i}`, `Sample ${i}`, now, now);
        insertReference.run(targetId, sampleId, now, now);
        insertItem.run(itemId, "reference", null, targetId, i + 1, `create-${itemId}`, actor, actor, now, now);
        insertPlacement.run(`place-${itemId}`, itemId, `place-${itemId}`, actor, actor, now, now);
      }
      f.native.prepare("UPDATE reference_targets SET tombstoned_at=?,last_known_contexts_json='[]' WHERE id='target-0'").run(now);
      f.native.exec("COMMIT");
    } catch (error) { f.native.exec("ROLLBACK"); throw error; }
    expect(f.native.isTransaction).toBe(false);
    console.info("Project boundary fixture seed total ms", performance.now() - measuredStart);
    const readStart = performance.now();
    const prepare = vi.spyOn(f.sql, "prepare"), result = await readProjectSnapshot(f.sql, "p");
    console.info("Project boundary actual read ms", performance.now() - readStart);
    expect(result.items).toHaveLength(count); expect(result.references).toHaveLength(count);
    expect(result.references.find(row => row.registryId === "target-0")?.resolution.resolution).toBe("tombstoned");
    expect(result.references.filter(row => row.resolution.resolution === "resolved")).toHaveLength(count - 1);
    const registryQueries = prepare.mock.calls.filter(([sql]) => sql.includes("JOIN json_each(?) requested"));
    expect(registryQueries).toHaveLength(2);
    expect(result.references.map(row => row.resolution.target.id)).toEqual([...Array(count)].map((_, i) => `sample-${i}`).sort());
  });
  it("keeps exact original Request selection and current pre/post read admission in the actual Hono surface", async () => {
    const f = fixture(); seed(f.native); let admitted = true, reads = 0;
    const service = createProjectReadService({ database: () => { reads++; return f.sql; },
      async admit(selected) { if (!admitted || selected !== actor) throw new HTTPException(403, { message: "Fixture read admission denied" }); } });
    const selected: Request[] = [];
    const app = new Hono<{ Bindings: { service: ProjectReadService }; Variables: { userEmail: string } }>();
    app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: "Unexpected error" }, 500));
    app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); });
    app.route("/", createProjectReadSurface<{ service: ProjectReadService }>((request, bindings) => { selected.push(request); return bindings.service; }));
    const request = new Request("https://fixture.test/projects/p"), response = await app.fetch(request, { service });
    expect(response.status).toBe(200); expect(selected).toHaveLength(1); expect(selected[0]).toBe(request); expect(reads).toBe(1);
    expect((await app.fetch(new Request("https://fixture.test/projects/%20"), { service })).status).toBe(400);
    admitted = false; expect((await app.fetch(new Request("https://fixture.test/projects"), { service })).status).toBe(403); expect(reads).toBe(1);
    // A real SQL callback revokes only the deterministic fixture admission
    // while the actual projection executes; this is not a fake identity grant.
    admitted = true;
    const native = f.native as DatabaseSync & { setAuthorizer(callback: ((action: number, table: string | null) => number) | null): void };
    const codes = constants as unknown as Record<string, number>;
    native.setAuthorizer((action, table) => { if (action === codes.SQLITE_READ && table === "projects") admitted = false; return codes.SQLITE_OK; });
    try { await expect(service.list(false, actor)).rejects.toThrow("Fixture read admission denied"); }
    finally { native.setAuthorizer(null); }
  });
  it("reads one actual seven-statement snapshot while a second native writer waits and then commits", async () => {
    const f = fixture(); seed(f.native);
    const state = new Int32Array(new SharedArrayBuffer(16));
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); const {DatabaseSync,constants}=require('node:sqlite');
      const state=new Int32Array(workerData.state), db=new DatabaseSync(workerData.path,{allowExtension:false,enableForeignKeyConstraints:true});
      try { db.exec('PRAGMA busy_timeout=1500'); Atomics.store(state,0,1); Atomics.notify(state,0);
        if(Atomics.wait(state,1,0,2000)==='timed-out') throw new Error('Writer start deadline');
        db.setAuthorizer((action,first)=>{ if(action===constants.SQLITE_TRANSACTION && first==='BEGIN') {
          Atomics.store(state,2,1); Atomics.notify(state,2); } return constants.SQLITE_OK; });
        db.exec('BEGIN IMMEDIATE'); db.setAuthorizer(null);
        db.prepare("UPDATE projects SET title='Project after',revision=revision+1,last_mutation_id='writer-p',updated_at=? WHERE id='p'").run(workerData.now);
        db.prepare("UPDATE project_contents SET markdown_source='# After',revision=revision+1,last_mutation_id='writer-c',updated_at=? WHERE id='c'").run(workerData.now);
        db.exec('COMMIT'); Atomics.store(state,3,1); Atomics.notify(state,3); parentPort.postMessage('committed');
      } finally { db.close(); }`, { eval: true, workerData: { path: f.filename, state: state.buffer, now }, execArgv: [] });
    workers.push(worker);
    let result: unknown;
    const completion = new Promise<string>((resolve, reject) => {
      worker.once("message", message => { result = message; }); worker.once("error", reject);
      worker.once("exit", code => code === 0 && result === "committed" ? resolve("committed") : reject(new Error(`Writer exit ${code}`)));
    });
    completion.catch(() => undefined);
    while (Atomics.load(state, 0) === 0) { if (Atomics.wait(state, 0, 0, 1000) === "timed-out") throw new Error("Native writer startup deadline"); }
    const native = f.native as DatabaseSync & { setAuthorizer(callback: ((action: number, table: string | null) => number) | null): void };
    const codes = constants as unknown as Record<string, number>; let armed = true, ownedTransaction = false, blockedWriter = false;
    native.setAuthorizer((action, table) => {
      if (armed && action === codes.SQLITE_READ && table === "projects") {
        armed = false; ownedTransaction = f.native.isTransaction;
        Atomics.store(state, 1, 1); Atomics.notify(state, 1);
        if (Atomics.load(state, 2) === 0) Atomics.wait(state, 2, 0, 1000);
        blockedWriter = Atomics.load(state, 2) === 1 && Atomics.wait(state, 3, 0, 30) === "timed-out";
      }
      return codes.SQLITE_OK;
    });
    let snapshot: Awaited<ReturnType<typeof readProjectSnapshot>>;
    try { snapshot = await readProjectSnapshot(f.sql, "p"); }
    finally { native.setAuthorizer(null); }
    expect(armed).toBe(false); expect(ownedTransaction).toBe(true); expect(blockedWriter).toBe(true);
    expect(snapshot.project).toMatchObject({ title: "Project before", revision: 1 });
    expect(snapshot.contents[0]).toMatchObject({ markdownSource: "# Before", revision: 1 });
    expect(await bounded(completion, "Native writer completion deadline")).toBe("committed");
    const after = await readProjectSnapshot(f.sql, "p");
    expect(after.project).toMatchObject({ title: "Project after", revision: 2 });
    expect(after.contents[0]).toMatchObject({ markdownSource: "# After", revision: 2 });
    expect(f.native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
