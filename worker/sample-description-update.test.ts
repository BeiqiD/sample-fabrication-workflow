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
