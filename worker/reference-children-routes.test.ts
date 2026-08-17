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
  const adapter = new SqliteD1Database(database);
  const env: Env = {
    AUTH_MODE: "disabled",
    DB: adapter as unknown as D1Database,
    ASSETS: {} as R2Bucket,
  };
  return { database, env };
}

function post(env: Env, body: unknown, headers: Record<string, string> = {}) {
  return worker.fetch(new Request("https://app.test/api/references/children", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), env, executionContext);
}

describe("reference children route", () => {
  it("returns authoritative direct children without registering targets", async () => {
    const { database, env } = fixture();
    const response = await post(env, {
      parent: { type: "run_step", id: REFERENCE_FIXTURE_IDS.stepA },
    });
    const payload = await response.json() as {
      parentEligible: boolean;
      children: Array<{ target: { type: string; id: string } }>;
      truncated: boolean;
    };

    expect(response.status).toBe(200);
    expect(payload.parentEligible).toBe(true);
    expect(payload.children.map((child) => child.target)).toEqual([
      { type: "comment", id: REFERENCE_FIXTURE_IDS.comment },
      { type: "execution_image", id: REFERENCE_FIXTURE_IDS.executionImage },
    ]);
    expect(payload.truncated).toBe(false);
    expect(database.prepare("SELECT COUNT(*) AS count FROM reference_targets").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it("rejects malformed JSON, invalid parents, and out-of-range limits", async () => {
    const { database, env } = fixture();
    const malformed = await worker.fetch(new Request(
      "https://app.test/api/references/children",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
    ), env, executionContext);
    const unknown = await post(env, { parent: { type: "unknown", id: "one" } });
    const whitespace = await post(env, { parent: { type: "sample", id: " sample " } });
    const oversized = await post(env, {
      parent: { type: "sample", id: REFERENCE_FIXTURE_IDS.sampleA },
      limit: 101,
    });

    expect(malformed.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(whitespace.status).toBe(400);
    expect(oversized.status).toBe(400);
    database.close();
  });

  it("inherits the core same-origin and authentication middleware", async () => {
    const { database, env } = fixture();
    const body = {
      parent: { type: "sample", id: REFERENCE_FIXTURE_IDS.sampleA },
    };
    const crossOrigin = await post(env, body, { origin: "https://other.test" });
    const invalidAuth = await post({ ...env, AUTH_MODE: "invalid" as "disabled" }, body);

    expect(crossOrigin.status).toBe(403);
    expect(invalidAuth.status).toBe(403);
    database.close();
  });
});
