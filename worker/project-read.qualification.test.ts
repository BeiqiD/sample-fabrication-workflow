import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { d1ProjectReadDatabase } from "./projects/read-d1";

// Genuine bundled Worker entry and actual Miniflare D1/R2 bindings. This is
// Worker-library qualification, never a D1-shaped local Node business adapter.
let native: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;
beforeAll(async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
    bundle: true, format: "esm", platform: "browser", write: false });
  native = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-20",
    d1Databases: ["DB"], r2Buckets: ["ASSETS"], bindings: { AUTH_MODE: "disabled" }, log: new Log(LogLevel.ERROR) });
  database = await native.getD1Database("DB");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) {
    await database.batch(splitSql(readFileSync(new URL(name, migrations), "utf8")).map(sql => database.prepare(sql)));
  }
}, 30_000);
afterAll(async () => { await native?.dispose(); });
const get = (path: string) => native.dispatchFetch(`https://app.test/api${path}`);
const invoke = (path: string, method: string, body: unknown) => native.dispatchFetch(`https://app.test/api${path}`, {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const geometry = { x: 0.25, y: -0.5, width: 320.5, height: 180.25, zIndex: -2 };

describe("Project two-GET extraction through the genuine current Worker: four scopes", () => {
  it("retains mature Markdown/reference creation and ordered snapshot projections through the actual entry", async () => {
    const created = await invoke("/projects", "POST", { id: "worker-read", title: "Worker project", operationId: "create-worker-read" });
    expect(created.status).toBe(201);
    const markdown = await invoke("/projects/worker-read/items/markdown", "POST", { contentId: "worker-content", itemId: "worker-item",
      placementId: "worker-placement", markdownSource: "# Actual Worker", geometry, expectedProjectRevision: 1, operationId: "create-worker-content" });
    expect(markdown.status).toBe(201);
    await database.prepare(`INSERT INTO samples(id,code,title,created_at,updated_at)
      VALUES('worker-source','W-SOURCE','Source sample','2026-08-01T10:00:00.000Z','2026-08-01T10:00:00.000Z')`).run();
    const reference = await invoke("/projects/worker-read/items/reference", "POST", { itemId: "worker-reference", placementId: "worker-ref-placement",
      target: { type: "sample", id: "worker-source" }, geometry, expectedProjectRevision: 2, operationId: "create-worker-reference" });
    expect(reference.status).toBe(201);
    const before = (await database.prepare("SELECT * FROM projects WHERE id='worker-read'").all()).results;
    const response = await get("/projects/worker-read"); expect(response.status).toBe(200);
    const snapshot = await response.json() as { project: unknown; contents: unknown[]; items: Array<{ id: string; createdSequence: number }>;
      placements: unknown[]; references: Array<{ resolution: unknown }> };
    expect(snapshot.project).toMatchObject({ id: "worker-read", title: "Worker project", revision: 3, createdBy: "local-development" });
    expect(snapshot.contents).toEqual([expect.objectContaining({ id: "worker-content", markdownSource: "# Actual Worker", formatVersion: 1 })]);
    expect(snapshot.items.map(row => [row.id, row.createdSequence])).toEqual([["worker-item", 1], ["worker-reference", 2]]);
    expect(snapshot.placements).toEqual([expect.objectContaining(geometry), expect.objectContaining(geometry)]);
    expect(snapshot.references[0].resolution).toMatchObject({ resolution: "resolved", target: { type: "sample", id: "worker-source" } });
    expect((await database.prepare("SELECT * FROM projects WHERE id='worker-read'").all()).results).toEqual(before);
    expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
  it("preserves active/deleted ordering and includeDeleted through real D1 reads", async () => {
    const base = "2026-08-01T10:00:00.000Z";
    for (const [id, timestamp] of [["worker-list-a", "2026-08-02T10:00:00.000Z"], ["worker-list-b", base], ["worker-list-deleted", base]]) {
      await database.prepare(`INSERT INTO projects(id,title,last_mutation_id,created_by,updated_by,created_at,updated_at)
        VALUES(?,?,?,'local-development','local-development',?,?)`).bind(id, id, `create-${id}`, base, timestamp).run();
    }
    const removed = await invoke("/projects/worker-list-deleted", "DELETE", { expectedRevision: 1, operationId: "remove-worker-list-deleted" });
    expect(removed.status).toBe(200);
    const list = await (await get("/projects")).json() as { projects: Array<{ id: string }> };
    expect(list.projects.filter(row => row.id.startsWith("worker-list-")).map(row => row.id)).toEqual(["worker-list-a", "worker-list-b"]);
    const all = await (await get("/projects?includeDeleted=1")).json() as { projects: Array<{ id: string }> };
    expect(all.projects.filter(row => row.id.startsWith("worker-list-")).map(row => row.id)).toEqual(["worker-list-a", "worker-list-b", "worker-list-deleted"]);
    expect((await get("/projects/worker-list-deleted")).status).toBe(404);
    const included = await get("/projects/worker-list-deleted?includeDeleted=1"); expect(included.status).toBe(200);
    expect(await included.json()).toMatchObject({ project: { id: "worker-list-deleted", revision: 2, deletedBy: "local-development" }, items: [] });
  });
  it("retains invalid/missing errors and item trash projection without broadening route or byte ownership", async () => {
    const invalid = await get("/projects/%20"); expect(invalid.status).toBe(400); expect(await invalid.json()).toEqual({ error: "A valid Project ID is required" });
    const missing = await get("/projects/worker-not-present"); expect(missing.status).toBe(404); expect(await missing.json()).toEqual({ error: "Project not found" });
    expect((await invoke("/projects", "POST", { id: "worker-trash", title: "Trash project", operationId: "create-worker-trash" })).status).toBe(201);
    expect((await invoke("/projects/worker-trash/items/markdown", "POST", { contentId: "worker-trash-content", itemId: "worker-trash-item",
      placementId: "worker-trash-placement", markdownSource: "# Retained trash", geometry, expectedProjectRevision: 1, operationId: "create-worker-trash-content" })).status).toBe(201);
    const removed = await invoke("/projects/worker-trash/items/worker-trash-item", "DELETE", {
      expectedItemRevision: 1, expectedContentRevision: 1, operationId: "remove-worker-trash-item" });
    expect(removed.status).toBe(200);
    const active = await (await get("/projects/worker-trash")).json() as { contents: unknown[]; items: Array<{ id: string }> };
    expect(active.contents).toEqual([]); expect(active.items).toEqual([]);
    const trash = await (await get("/projects/worker-trash?includeDeleted=1")).json() as { contents: unknown[]; items: Array<{ id: string; deletionOperationId?: string }> };
    expect(trash.contents).toHaveLength(1); expect(trash.items.find(row => row.id === "worker-trash-item")?.deletionOperationId).toBe("remove-worker-trash-item");
    expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
  it("keeps recursively bound genuine D1 statements owned by their exact read view", async () => {
    const actual = database as unknown as D1Database; // Actual Miniflare binding; never a fabricated shape.
    const first = d1ProjectReadDatabase(actual), foreign = d1ProjectReadDatabase(actual);
    const statement = first.prepare("SELECT ? AS n").bind(1).bind(2);
    expect(Object.keys(statement).sort()).toEqual(["all", "bind", "first"]);
    expect((await first.readBatch([statement]))[0].results).toEqual([{ n: 2 }]);
    await expect(first.readBatch([foreign.prepare("SELECT 9 AS n")])).rejects.toThrow("Foreign Project read statement");
    expect(() => first.prepare("DELETE FROM projects")).toThrow("code-owned SELECT");
    expect((await get("/projects")).status).toBe(200);
  });
});
