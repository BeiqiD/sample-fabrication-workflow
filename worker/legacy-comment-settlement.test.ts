import { describe, expect, it } from "vitest";
import worker from "./index";
import { referenceTestDatabase, seedReferenceGraph, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

type DatabaseResults = Awaited<ReturnType<SqliteD1Database["batch"]>>;
class ObservedDatabase extends SqliteD1Database {
  insertedChanges = 0;
  beforeBatch?: () => void;
  afterBatch?: (results: DatabaseResults) => void;

  override async batch(statements: D1PreparedStatement[]) {
    this.beforeBatch?.();
    const results = await super.batch(statements);
    this.insertedChanges = results[0].meta.changes;
    this.afterBatch?.(results);
    return results;
  }
}

function fixture(scope: "individual" | "common" = "common") {
  const database = referenceTestDatabase();
  seedReferenceGraph(database);
  const d1 = new ObservedDatabase(database);
  const env = { AUTH_MODE: "disabled", DB: d1 as unknown as D1Database, ASSETS: {} as R2Bucket } satisfies Env;
  const targets = (scope === "common" ? ["a", "b"] : ["a"]).map((suffix) => ({
    sampleId: `reference-sample-${suffix}`, runId: `reference-run-${suffix}`,
    stepId: `reference-step-${suffix}`, expectedUpdatedAt: "2026-08-01T02:00:00.000Z",
  }));
  return {
    database, d1, targets,
    request: () => worker.fetch(new Request("https://app.test/api/run-step-comments", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, body: "Qualified legacy creation", targets }),
    }), env, { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext),
  };
}

describe("legacy Comment creation settlement", () => {
  for (const timing of ["BEFORE", "AFTER"]) for (const scope of ["individual", "common"] as const) {
    it(`acknowledges the exact ${scope} occurrence set despite ${timing} trigger changes`, async () => {
      const f = fixture(scope);
      try {
        f.database.exec(`CREATE TRIGGER settlement_noop_update ${timing} INSERT ON run_step_comments
          BEGIN UPDATE run_steps SET title = title WHERE id = NEW.run_step_id; END;`);
        const response = await f.request();
        expect(response.status).toBe(201);
        const payload = await response.json() as { operationGroupId: string };
        // D1 reports trigger side effects as well as inserted business rows.
        // Shadow capture adds its own writes; settlement still uses the exact
        // RETURNING occurrence set checked below, never this inflated count.
        expect(f.d1.insertedChanges).toBeGreaterThan(f.targets.length);
        const rows = f.database.prepare("SELECT id, run_step_id, scope, legacy_body AS body, actor_email FROM run_step_comments WHERE operation_group_id = ? ORDER BY run_step_id").all(payload.operationGroupId);
        expect(rows).toHaveLength(f.targets.length);
        expect(new Set(rows.map(({ id }) => id)).size).toBe(f.targets.length);
        expect(rows.map(({ run_step_id }) => run_step_id)).toEqual(f.targets.map(({ stepId }) => stepId));
        expect(rows.every((row) => row.scope === scope && row.body === "Qualified legacy creation" && row.actor_email === "local-development")).toBe(true);
        const events = f.database.prepare("SELECT metadata_json FROM events WHERE json_extract(metadata_json, '$.operationGroupId') = ? ORDER BY sample_id").all(payload.operationGroupId);
        expect(events).toHaveLength(f.targets.length);
        expect(events.every(({ metadata_json }) => JSON.parse(String(metadata_json)).action === "step_comment")).toBe(true);
      } finally { f.database.close(); }
    });
  }

  const invalidProofs: Array<[string, (rows: Array<Record<string, unknown>>) => unknown]> = [
    ["missing results", () => undefined],
    ["null results", () => null],
    ["non-array results", () => ({ id: "not-an-array" })],
    ["missing occurrence", (rows) => rows.slice(1)],
    ["wrong occurrence", (rows) => [{ id: "not-generated-by-this-request" }, rows[1]]],
    ["duplicate occurrence", (rows) => [rows[0], rows[0]]],
    ["missing id", (rows) => [{}, rows[1]]],
    ["non-string id", (rows) => [{ id: 42 }, rows[1]]],
    ["extra occurrence", (rows) => [...rows, { id: "extra" }]],
  ];
  for (const [name, change] of invalidProofs) it(`rejects ${name} proof even when the reported change count looks correct`, async () => {
    const f = fixture();
    try {
      const beforeComments = f.database.prepare("SELECT COUNT(*) AS count FROM run_step_comments").get()!.count;
      const beforeEvents = f.database.prepare("SELECT COUNT(*) AS count FROM events").get()!.count;
      f.d1.afterBatch = (results) => {
        results[0].meta.changes = f.targets.length;
        Reflect.set(results[0], "results", change(results[0].results));
      };
      const response = await f.request();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Unable to confirm whether the comment was saved" });
      // The batch already committed; an untrusted response must not claim that
      // the write was rejected or encourage a retry as a known conflict.
      expect(f.database.prepare("SELECT COUNT(*) AS count FROM run_step_comments").get()!.count).toBe(Number(beforeComments) + f.targets.length);
      expect(f.database.prepare("SELECT COUNT(*) AS count FROM events").get()!.count).toBe(Number(beforeEvents) + f.targets.length);
    } finally { f.database.close(); }
  });

  it("preserves the all-target write guard when a step changes after validation", async () => {
    const f = fixture();
    try {
      const beforeComments = f.database.prepare("SELECT * FROM run_step_comments ORDER BY id").all();
      const beforeEvents = f.database.prepare("SELECT * FROM events ORDER BY id").all();
      f.d1.beforeBatch = () => f.database.prepare("UPDATE run_steps SET updated_at = '2026-09-13T00:00:00.000Z' WHERE id = 'reference-step-b'").run();
      const response = await f.request();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "One or more sample steps changed before the comment was saved" });
      expect(f.database.prepare("SELECT * FROM run_step_comments ORDER BY id").all()).toEqual(beforeComments);
      expect(f.database.prepare("SELECT * FROM events ORDER BY id").all()).toEqual(beforeEvents);
    } finally { f.database.close(); }
  });
});
