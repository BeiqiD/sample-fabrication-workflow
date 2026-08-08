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
  return { database, env };
}

function post(env: Env, body: unknown) {
  return worker.fetch(new Request("https://app.test/api/references/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env, executionContext);
}

describe("reference resolution route", () => {
  it("resolves mixed targets through the authenticated application route without writing", async () => {
    const { database, env } = fixture();
    const response = await post(env, { targets: [
      { type: "sample", id: REFERENCE_FIXTURE_IDS.sampleA },
      { type: "comment", id: REFERENCE_FIXTURE_IDS.comment },
      { type: "sample", id: "missing-sample" },
      { type: "sample", id: REFERENCE_FIXTURE_IDS.sampleA },
    ] });
    const payload = await response.json() as {
      results: Array<{ target: { type: string; id: string }; resolution: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.results.map((result) => result.target.id)).toEqual([
      REFERENCE_FIXTURE_IDS.sampleA,
      REFERENCE_FIXTURE_IDS.comment,
      "missing-sample",
      REFERENCE_FIXTURE_IDS.sampleA,
    ]);
    expect(payload.results.map((result) => result.resolution)).toEqual([
      "resolved",
      "resolved",
      "not_found",
      "resolved",
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM reference_targets").get()).toEqual({ count: 0 });
    database.close();
  });

  it("rejects unknown types, invalid IDs, and oversized batches", async () => {
    const { database, env } = fixture();
    const unknown = await post(env, { targets: [{ type: "unknown", id: "one" }] });
    const whitespace = await post(env, { targets: [{ type: "sample", id: " sample " }] });
    const oversized = await post(env, {
      targets: Array.from({ length: 201 }, (_, index) => ({ type: "sample", id: `sample-${index}` })),
    });

    expect(unknown.status).toBe(400);
    expect(whitespace.status).toBe(400);
    expect(oversized.status).toBe(400);
    database.close();
  });

  it("rejects malformed JSON as a client error", async () => {
    const { database, env } = fixture();
    const response = await worker.fetch(new Request("https://app.test/api/references/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }), env, executionContext);
    expect(response.status).toBe(400);
    database.close();
  });
});
