import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let native: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;
beforeAll(async () => {
  // Preserve actual Worker wiring, using its bundled entry and genuine D1/R2
  // bindings. Schema setup is once per file, outside unchanged case deadlines.
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

async function seedSample(id: string, code: string) {
  await database.prepare(`INSERT INTO samples
    (id, code, title, description, status, location, pinned, created_at, updated_at)
    VALUES (?, ?, 'Sample one', 'Initial description', 'stored', 'Box 1', 1,
      '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z')`).bind(id, code).run();
}
async function patch(id: string, input: Record<string, unknown>) {
  return native.dispatchFetch(`https://app.test/api/samples/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

describe("sample description update route", () => {
  it("updates and clears Description without changing other sample details", async () => {
    await seedSample("sample-1", "S-001");

    const updateResponse = await patch("sample-1", {
      description: "  Updated sample context  ",
      expectedUpdatedAt: "2026-08-01T10:00:00.000Z",
    });
    expect(updateResponse.status).toBe(200);
    const updated = await database.prepare(
      "SELECT title, description, status, location, pinned, updated_at FROM samples WHERE id = 'sample-1'",
    ).first<Record<string, unknown>>();
    expect(updated).toMatchObject({
      title: "Sample one",
      description: "Updated sample context",
      status: "stored",
      location: "Box 1",
      pinned: 1,
    });

    const clearResponse = await patch("sample-1", {
      description: "   ",
      expectedUpdatedAt: String(updated!.updated_at),
    });
    expect(clearResponse.status).toBe(200);
    const cleared = await database.prepare("SELECT description FROM samples WHERE id = 'sample-1'").first<{ description: string | null }>();
    expect(cleared!.description).toBeNull();
  });

  it("rejects a Description longer than the existing 10,000-character limit", async () => {
    await seedSample("sample-2", "S-002");
    const response = await patch("sample-2", {
      description: "x".repeat(10_001),
      expectedUpdatedAt: "2026-08-01T10:00:00.000Z",
    });
    const payload = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Description is too long");
    const row = await database.prepare("SELECT description, updated_at FROM samples WHERE id = 'sample-2'").first<Record<string, unknown>>();
    expect(row).toMatchObject({
      description: "Initial description",
      updated_at: "2026-08-01T10:00:00.000Z",
    });
  });
});

describe("Samples metadata Worker composition on genuine D1", () => {
  it("retains creation, permanent code, guarded soft deletion and restoration through the actual entry", async () => {
    const invoke = (path: string, method: string, value: unknown) => native.dispatchFetch(`https://app.test/api${path}`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(value),
    });
    const created = await invoke("/samples", "POST", { code: " NATIVE ", title: " Native sample " });
    expect(created.status).toBe(201); const { id } = await created.json() as { id: string };
    const sample = await database.prepare("SELECT code,title,created_by,updated_at FROM samples WHERE id=?").bind(id).first<{ updated_at: string }>();
    expect(sample).toMatchObject({ code: "NATIVE", title: "Native sample", created_by: "local-development" });
    expect((await invoke("/samples", "POST", { code: "NATIVE", title: "Duplicate" })).status).toBe(409);
    expect((await invoke(`/samples/${id}`, "PATCH", { expectedUpdatedAt: sample!.updated_at, code: "replacement" })).status).toBe(400);
    const removed = await invoke(`/samples/${id}`, "DELETE", { confirmationCode: "NATIVE", expectedUpdatedAt: sample!.updated_at });
    expect(removed.status).toBe(200); const deletion = await removed.json() as { updatedAt: string };
    expect(deletion).toMatchObject({ ok: true, deleted: { runs: 0, steps: 0, events: 1, verifications: 0, childrenDetached: 0 } });
    expect((await invoke(`/samples/${id}/restore`, "POST", { confirmationCode: "NATIVE", expectedUpdatedAt: sample!.updated_at })).status).toBe(409);
    expect((await invoke(`/samples/${id}/restore`, "POST", { confirmationCode: "NATIVE", expectedUpdatedAt: deletion.updatedAt })).status).toBe(200);
    expect(await database.prepare("SELECT code,deleted_at,deleted_by FROM samples WHERE id=?").bind(id).first())
      .toEqual({ code: "NATIVE", deleted_at: null, deleted_by: null });
    expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});


describe("Samples read Worker composition on genuine D1", () => {
  it("applies matching-run filters to Processing rows, facet counts and pagination together", async () => {
    const timestamp = "2026-08-01T10:00:00.000Z";
    await database.batch([
      database.prepare("INSERT INTO recipe_families(id,name,template_type,created_at) VALUES('matching-family','Matching process','process',?)").bind(timestamp),
      database.prepare("INSERT INTO template_versions(id,recipe_family_id,name,template_type,version,manifest_hash,content_json,created_at) VALUES('matching-template','matching-family','Matching process','process',1,'matching-manifest','{}',?)").bind(timestamp),
      ...["active", "complete", "cancelled"].map(status => database.prepare("INSERT INTO samples(id,code,title,status,pinned,created_at,updated_at) VALUES(?,?,?, ?,0,?,?)")
        .bind(`matching-${status}`, `MATCH-${status}`, `Matching ${status}`, status === "active" ? "active" : "stored", timestamp, timestamp)),
      ...["active", "complete", "cancelled"].map(status => database.prepare("INSERT INTO runs(id,sample_id,recipe_family_id,template_version_id,sequence_no,run_group_id,template_name_snapshot,template_type_snapshot,template_version_snapshot,status,created_at) VALUES(?,?,'matching-family','matching-template',1,?,'Matching process','process',1,?,?)")
        .bind(`matching-run-${status}`, `matching-${status}`, `matching-group-${status}`, status, timestamp)),
    ]);
    for (const runStatus of ["active", "complete", "cancelled"] as const) {
      for (const status of ["all", "active", "complete", "cancelled"] as const) {
        const response = await native.dispatchFetch(`https://app.test/api/samples?q=MATCH-&view=processing&status=${status}&runFamily=matching-family&runKind=process&runStatus=${runStatus}`);
        expect(response.status).toBe(200);
        const payload = await response.json() as { samples: Array<{ id: string }>; facets: Record<string, number>; pagination: { total: number } };
        const expected = { all: 1, active: Number(runStatus === "active"), complete: Number(runStatus === "complete"), cancelled: Number(runStatus === "cancelled") };
        expect(payload.facets).toEqual(expected); expect(payload.pagination.total).toBe(expected[status]);
        expect(payload.samples.map(sample => sample.id)).toEqual(expected[status] ? [`matching-${runStatus}`] : []);
      }
    }
    const absent = await native.dispatchFetch("https://app.test/api/samples?q=MATCH-&view=processing&status=all&runFamily=absent&runKind=process&runStatus=active");
    expect(absent.status).toBe(200); expect(await absent.json()).toMatchObject({ samples: [], facets: { all: 0, active: 0, complete: 0, cancelled: 0 }, pagination: { total: 0 } });
  });
  it("retains directory query parsing, pagination, Processing facets and current binding selection through the actual entry", async () => {
    await database.batch([
      database.prepare(`INSERT INTO samples(id,code,title,status,location,pinned,created_at,updated_at)
        VALUES('read-parent','READ-PARENT','Read parent','stored','Read Box',0,'2026-08-01T10:00:00.000Z','2026-08-01T10:00:00.000Z')`),
      database.prepare(`INSERT INTO samples(id,code,title,status,location,parent_id,pinned,created_at,updated_at)
        VALUES('read-active','READ-A','Read active','active','Read Box','read-parent',1,'2026-08-01T10:00:00.000Z','2026-08-01T10:00:00.000Z')`),
      database.prepare(`INSERT INTO samples(id,code,title,status,location,pinned,created_at,updated_at)
        VALUES('read-stored','READ-B','Read stored','stored','Other Read Box',0,'2026-08-01T10:00:00.000Z','2026-08-01T10:00:00.000Z')`),
    ]);
    const get = (path: string) => native.dispatchFetch(`https://app.test/api${path}`);
    const page = await get("/samples?q=READ-&page=2&pageSize=1&sort=code-asc");
    expect(page.status).toBe(200); expect(page.headers.get("server-timing")).toMatch(/^d1;dur=\d+\.\d, serialize;dur=\d+\.\d$/);
    expect(await page.json()).toMatchObject({ samples: [{ id: "read-stored" }], pagination: { page: 2, pageSize: 1, total: 3 } });
    expect(await (await get("/samples?q=READ-&parent=READ-PARENT&location=Read%20Box")).json())
      .toMatchObject({ samples: [{ id: "read-active" }], pagination: { total: 1 } });
    expect(await (await get("/samples?q=READ-&view=processing&status=all")).json())
      .toMatchObject({ facets: { active: 1, complete: 0, cancelled: 0, all: 3 }, pagination: { total: 3 } });
    const options = await get("/sample-directory-options"); expect(options.status).toBe(200);
    expect(await options.json()).toMatchObject({ locations: expect.arrayContaining(["Read Box", "Other Read Box"]),
      parents: expect.arrayContaining([{ id: "read-parent", code: "READ-PARENT", title: "Read parent" }]) });
  });
  it("retains detail/Processing omission and hidden-media projection without any provider-byte admission", async () => {
    await database.prepare(`INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,created_at)
      VALUES('read-hidden-asset','read/hidden.png','hidden.png','image/png',4,'ready','2026-08-01T10:00:00.000Z')`).run();
    await database.prepare(`INSERT INTO events(id,sample_id,kind,body,asset_key,metadata_json,created_at)
      VALUES('read-hidden-event','read-active','image','Hidden image','read/hidden.png',
        '{"assetDeletedAt":"2026-08-02T00:00:00.000Z","thumbnailKey":"read/hidden.png"}','2026-08-01T10:00:00.000Z')`).run();
    const normal = await native.dispatchFetch("https://app.test/api/samples/read-active"); expect(normal.status).toBe(200);
    const detail = await normal.json() as { parent: unknown; events: Array<{ id: string; assetKey: string | null; metadata: Record<string, unknown> }> };
    expect(detail.parent).toEqual({ id: "read-parent", code: "READ-PARENT", title: "Read parent" });
    const event = detail.events.find(row => row.id === "read-hidden-event")!;
    expect(event.assetKey).toBeNull(); expect(event.metadata).not.toHaveProperty("thumbnailKey"); expect(event).not.toHaveProperty("assetUrl");
    const processing = await native.dispatchFetch("https://app.test/api/samples/read-active?view=processing"); expect(processing.status).toBe(200);
    const payload = await processing.json(); expect(payload).not.toHaveProperty("parent"); expect(payload).not.toHaveProperty("children"); expect(payload).not.toHaveProperty("events");
    expect(await database.prepare("SELECT asset_key FROM events WHERE id='read-hidden-event'").first()).toEqual({ asset_key: "read/hidden.png" });
    expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
  it("preserves invalid matching-run and deleted/missing detail errors on the genuine Worker", async () => {
    const invalid = await native.dispatchFetch("https://app.test/api/samples?runKind=process");
    expect(invalid.status).toBe(400); expect(await invalid.json()).toEqual({ error: "Invalid matching-run filter" });
    await database.prepare("UPDATE samples SET deleted_at='2026-08-02T00:00:00.000Z' WHERE id='read-stored'").run();
    for (const id of ["read-stored", "not-present"]) {
      const response = await native.dispatchFetch(`https://app.test/api/samples/${id}`);
      expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: "Sample not found" });
    }
  });
});
