import { describe, expect, it } from "vitest";
import worker from "./index";
import type { Env } from "./types";
import {
  REFERENCE_FIXTURE_IDS,
  referenceTestDatabase,
  seedReferenceGraph,
  SqliteD1Database,
} from "./reference-test-support";

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

function fixture() {
  const database = referenceTestDatabase();
  seedReferenceGraph(database);
  const d1 = new SqliteD1Database(database);
  const env: Env = {
    AUTH_MODE: "disabled",
    DB: d1 as unknown as D1Database,
    ASSETS: {} as R2Bucket,
  };
  return { database, d1, env };
}

function search(env: Env, body: unknown, headers: Record<string, string> = {}) {
  return worker.fetch(new Request("https://app.test/api/references/search", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), env, executionContext);
}

describe("reference search route", () => {
  it("returns resolved deterministic results without registry writes", async () => {
    const { database, env } = fixture();
    const response = await search(env, {
      query: "REF-A",
      types: ["sample", "run", "run_step"],
      limit: 10,
    });
    const payload = await response.json() as {
      query: string;
      truncated: boolean;
      results: Array<{
        target: { type: string; id: string };
        match: { tier: string };
        resolution: {
          resolution: string;
          destination: { referenceUrl: string };
        };
      }>;
    };

    expect(response.status).toBe(200);
    expect(payload.query).toBe("REF-A");
    expect(payload.results[0]).toMatchObject({
      target: { type: "sample", id: REFERENCE_FIXTURE_IDS.sampleA },
      match: { tier: "exact_primary" },
      resolution: { resolution: "resolved" },
    });
    expect(payload.results[0].resolution.destination.referenceUrl)
      .toMatch(/^\/references\/sample\/r1_[A-Za-z0-9_-]+$/);
    expect(database.prepare("SELECT COUNT(*) AS count FROM reference_targets").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it("maps malformed and invalid input to client errors", async () => {
    const { database, env } = fixture();
    const malformed = await worker.fetch(new Request("https://app.test/api/references/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }), env, executionContext);
    const invalidBodies = [
      {},
      { query: "" },
      { query: "reference", types: ["unknown"] },
      { query: "reference", sampleId: " sample " },
      { query: "reference", from: "invalid" },
      { query: "reference", limit: 51 },
    ];

    expect(malformed.status).toBe(400);
    for (const body of invalidBodies) {
      expect((await search(env, body)).status).toBe(400);
    }
    database.close();
  });

  it("inherits the core same-origin policy", async () => {
    const { database, env } = fixture();
    const response = await search(
      env,
      { query: "Reference" },
      { origin: "https://other.test" },
    );
    expect(response.status).toBe(403);
    database.close();
  });
});
