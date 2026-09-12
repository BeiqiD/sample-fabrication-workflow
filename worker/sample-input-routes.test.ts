import { describe, expect, it, vi } from "vitest";
import worker from "./index";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

function request(env: Env, method: "POST" | "PATCH", body: string, id = "sample-input") {
  return worker.fetch(new Request(`https://app.test/api/samples${method === "PATCH" ? `/${id}` : ""}`, {
    method,
    headers: { "content-type": "application/json" },
    body,
  }), env, executionContext);
}

function noDatabaseAccess() {
  const unexpected = () => { throw new Error("Invalid Sample input reached the database"); };
  const prepare = vi.fn(unexpected);
  const batch = vi.fn(unexpected);
  const env = {
    AUTH_MODE: "disabled",
    DB: { prepare, batch } as unknown as D1Database,
    ASSETS: {} as R2Bucket,
  } satisfies Env;
  return { env, prepare, batch };
}

const invalidBodies = [
  ["empty body", ""],
  ["malformed JSON", "{"],
  ["null", "null"],
  ["number", "42"],
  ["string", '"sample"'],
  ["boolean", "true"],
  ["empty array", "[]"],
  ["array of objects", '[{"code":"S-001","title":"Sample","expectedUpdatedAt":"2026-09-12"}]'],
] as const;

describe.each(["POST", "PATCH"] as const)("Sample %s JSON boundary", (method) => {
  it.each(invalidBodies)("rejects %s before database access", async (_name, body) => {
    const { env, prepare, batch } = noDatabaseAccess();
    const response = await request(env, method, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: method === "POST" ? "Invalid sample fields" : "Invalid sample update",
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });
});

describe("Sample field validation", () => {
  it.each([
    ["code", 123],
    ["title", {}],
    ["description", []],
    ["location", false],
    ["status", "unrecognized"],
  ] as const)("rejects invalid creation %s before database access", async (field, value) => {
    const { env, prepare, batch } = noDatabaseAccess();
    const response = await request(env, "POST", JSON.stringify({
      code: "S-001", title: "Sample", [field]: value,
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid sample fields" });
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it.each([
    ["expectedUpdatedAt", 123, "Invalid sample update"],
    ["title", {}, "Invalid sample update"],
    ["description", [], "Invalid sample update"],
    ["location", false, "Invalid sample update"],
    ["pinned", "true", "Invalid sample update"],
    ["status", false, "Invalid sample status"],
    ["code", "replacement", "Sample code is a permanent identifier and cannot be changed"],
  ] as const)("rejects invalid update %s before database access", async (field, value, error) => {
    const { env, prepare, batch } = noDatabaseAccess();
    const response = await request(env, "PATCH", JSON.stringify({
      expectedUpdatedAt: "2026-09-12T00:00:00.000Z", [field]: value,
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it("preserves creation, trimming, no-op updates, concurrency, and permanent identity", async () => {
    const database = referenceTestDatabase();
    const adapter = new SqliteD1Database(database);
    const env = {
      AUTH_MODE: "disabled",
      DB: adapter as unknown as D1Database,
      ASSETS: {} as R2Bucket,
    } satisfies Env;
    try {
      const createBody = JSON.stringify({
        code: " S-001 ", title: " Sample one ", description: " Initial description ", location: " Box 1 ",
      });
      const created = await request(env, "POST", createBody);
      expect(created.status).toBe(201);
      const { id } = await created.json() as { id: string };
      const initial = database.prepare("SELECT * FROM samples WHERE id = ?").get(id)!;
      expect(initial).toMatchObject({
        code: "S-001", title: "Sample one", description: "Initial description", location: "Box 1",
        status: "stored", created_by: "local-development", updated_by: "local-development",
      });

      const updated = await request(env, "PATCH", JSON.stringify({
        expectedUpdatedAt: initial.updated_at,
        title: " Updated sample ", description: "  ", location: "  ", pinned: true,
      }), id);
      expect(updated.status).toBe(200);
      const row = database.prepare("SELECT * FROM samples WHERE id = ?").get(id)!;
      expect(row).toMatchObject({
        code: "S-001", title: "Updated sample", description: null, location: null, pinned: 1, status: "stored",
      });
      const audit = database.prepare(`
        SELECT metadata_json FROM events
        WHERE sample_id = ? AND json_extract(metadata_json, '$.action') = 'sample_details_updated'
      `).get(id)!;
      expect(JSON.parse(String(audit.metadata_json))).toMatchObject({
        changes: { title: { from: "Sample one", to: "Updated sample" } },
      });

      const noOp = await request(env, "PATCH", JSON.stringify({ expectedUpdatedAt: row.updated_at }), id);
      expect(noOp.status).toBe(200);
      expect(await noOp.json()).toEqual({ ok: true, updatedAt: row.updated_at });
      const stale = await request(env, "PATCH", JSON.stringify({
        expectedUpdatedAt: "2000-01-01T00:00:00.000Z", title: "Stale change",
      }), id);
      expect(stale.status).toBe(409);
      const duplicate = await request(env, "POST", createBody);
      expect(duplicate.status).toBe(409);
      expect(database.prepare("SELECT code, title FROM samples WHERE id = ?").get(id))
        .toEqual({ code: "S-001", title: "Updated sample" });
    } finally {
      database.close();
    }
  });
});
