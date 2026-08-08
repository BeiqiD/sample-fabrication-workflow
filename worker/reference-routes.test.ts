import { describe, expect, it } from "vitest";
import worker from "./index";
import type { Env } from "./types";
import {
  REFERENCE_FIXTURE_IDS,
  referenceTestDatabase,
  seedReferenceGraph,
  SqliteD1Database,
} from "./reference-test-support";

class CountingSqliteD1Database extends SqliteD1Database {
  batchCount = 0;
  directQueryCount = 0;
  private inBatch = false;

  override recordQuery() {
    super.recordQuery();
    if (this.inBatch) return;
    this.directQueryCount += 1;
  }

  override async batch(statements: D1PreparedStatement[]) {
    this.batchCount += 1;
    this.inBatch = true;
    try {
      return await super.batch(statements);
    } finally {
      this.inBatch = false;
    }
  }

  resetCounts() {
    this.resetQueryCount();
    this.batchCount = 0;
    this.directQueryCount = 0;
  }
}

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

function fixture() {
  const database = referenceTestDatabase();
  seedReferenceGraph(database);
  const d1 = new CountingSqliteD1Database(database);
  const env: Env = {
    AUTH_MODE: "disabled",
    DB: d1 as unknown as D1Database,
    ASSETS: {} as R2Bucket,
  };
  return { database, d1, env };
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

  it("inherits the core same-origin and authentication middleware", async () => {
    const { database, env } = fixture();
    const crossOrigin = await worker.fetch(new Request("https://app.test/api/references/resolve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://other.test",
      },
      body: JSON.stringify({ targets: [{ type: "sample", id: REFERENCE_FIXTURE_IDS.sampleA }] }),
    }), env, executionContext);
    expect(crossOrigin.status).toBe(403);

    const invalidAuth = await post({ ...env, AUTH_MODE: "invalid" as "disabled" }, {
      targets: [{ type: "sample", id: REFERENCE_FIXTURE_IDS.sampleA }],
    });
    expect(invalidAuth.status).toBe(403);
    database.close();
  });

  it("exports registry rows inside the core table-snapshot batch without blob occurrences", async () => {
    const { database, d1, env } = fixture();
    database.prepare(`
      INSERT INTO reference_targets
        (id, target_type, target_id, first_registered_at, last_validated_at, last_known_contexts_json)
      VALUES ('registry-export', 'sample', ?,
              '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', '[]')
    `).run(REFERENCE_FIXTURE_IDS.sampleA);
    d1.resetCounts();

    const response = await worker.fetch(
      new Request("https://app.test/api/exports/all"),
      env,
      executionContext,
    );
    const payload = await response.json() as {
      schemaVersion: number;
      tables: Record<string, Array<Record<string, unknown>>>;
      blobs: Array<{ sourceOccurrences: Array<{ sourceType: string }> }>;
    };

    expect(response.status).toBe(200);
    expect(d1.batchCount).toBe(1);
    expect(d1.directQueryCount).toBe(0);
    expect(payload.schemaVersion).toBe(3);
    expect(payload.tables.reference_targets).toEqual([
      expect.objectContaining({
        id: "registry-export",
        target_type: "sample",
        target_id: REFERENCE_FIXTURE_IDS.sampleA,
      }),
    ]);
    expect(payload.blobs.flatMap((blob) => blob.sourceOccurrences)
      .some((occurrence) => occurrence.sourceType === "reference_target")).toBe(false);
    database.close();
  });
});
