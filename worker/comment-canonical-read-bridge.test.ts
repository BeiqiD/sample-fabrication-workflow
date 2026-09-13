import { describe, expect, it } from "vitest";
import type { ReferenceResolution } from "../shared/reference-types";
import type { SampleDetail } from "../shared/types";
import worker from "./index";
import { REFERENCE_FIXTURE_IDS as ids, referenceTestDatabase, seedReferenceGraph, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const canonicalBody = "Canonical spectroscopy observation";
const staleBody = "Retired duplicate must stay out of the current reading";
const legacyBody = "Original legacy observation";
const legacyId = "read-bridge-legacy";
const context = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

class SnapshotDatabase extends SqliteD1Database {
  batchCount = 0;
  override async batch(statements: D1PreparedStatement[]) {
    this.batchCount += 1;
    return super.batch(statements);
  }
}

function fixture() {
  const database = referenceTestDatabase();
  seedReferenceGraph(database);
  database.prepare("UPDATE comment_submissions SET body = ? WHERE id = ?").run(canonicalBody, ids.comment);
  database.prepare("UPDATE run_step_comments SET body = ? WHERE submission_id = ?").run(staleBody, ids.comment);
  database.prepare(`INSERT INTO run_step_comments
    (id, run_step_id, scope, body, actor_email, created_at, updated_at)
    VALUES (?, ?, 'individual', ?, 'legacy@example.com', '2026-08-01T05:00:00.000Z', '2026-08-01T05:00:00.000Z')`)
    .run(legacyId, ids.stepA, legacyBody);
  const d1 = new SnapshotDatabase(database);
  const env = { AUTH_MODE: "disabled", DB: d1 as unknown as D1Database, ASSETS: {} as R2Bucket } satisfies Env;
  const request = (path: string, method = "GET", body?: unknown) => worker.fetch(
    new Request(`https://app.test/api${path}`, { method, ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }) }), env, context,
  );
  return {
    database, d1, request,
    async detail() {
      const response = await request(`/samples/${ids.sampleA}`);
      expect(response.status).toBe(200);
      return response.json() as Promise<SampleDetail>;
    },
    async resolve() {
      const response = await request("/references/resolve", "POST", { targets: [
        { type: "comment_occurrence", id: ids.commentOccurrenceA },
        { type: "comment_occurrence", id: legacyId },
      ] });
      expect(response.status).toBe(200);
      return (await response.json() as { results: ReferenceResolution[] }).results;
    },
  };
}

describe("canonical Comment read bridge before schema cleanup", () => {
  it("reads canonical text and legacy text by ownership without rewriting either stored row", async () => {
    const f = fixture();
    try {
      const before = f.database.prepare("SELECT * FROM run_step_comments ORDER BY id").all();
      const comments = (await f.detail()).runs[0].steps[0].comments;
      expect(comments.find((comment) => comment.id === ids.commentOccurrenceA)).toMatchObject({
        body: canonicalBody, submissionId: ids.comment, operationGroupId: "reference-comment-group",
      });
      expect(comments.find((comment) => comment.id === legacyId)).toMatchObject({ body: legacyBody, submissionId: null });
      const [canonical, legacy] = await f.resolve();
      expect(canonical).toMatchObject({ resolution: "resolved", source: { excerpt: canonicalBody, state: "ready" } });
      expect(legacy).toMatchObject({ resolution: "resolved", source: { excerpt: legacyBody, state: "legacy" } });
      expect(canonical.destination.openSourceUrl).toContain(`/processing/${ids.sampleA}?run=${ids.runA}&step=${ids.stepA}&focus=comment_occurrence`);
      expect(f.database.prepare("SELECT * FROM run_step_comments ORDER BY id").all()).toEqual(before);
    } finally { f.database.close(); }
  });

  it("keeps an empty canonical body empty instead of reviving the duplicated text", async () => {
    const f = fixture();
    try {
      f.database.prepare("UPDATE comment_submissions SET body = '' WHERE id = ?").run(ids.comment);
      expect((await f.detail()).runs[0].steps[0].comments.find((comment) => comment.id === ids.commentOccurrenceA)?.body).toBe("");
      const [canonical] = await f.resolve();
      expect(canonical.source).toMatchObject({ title: "Step Comment", excerpt: null });
      expect(JSON.stringify(canonical)).not.toContain(staleBody);
    } finally { f.database.close(); }
  });

  it("marks a dangling canonical submission inconsistent rather than treating it as legacy text", async () => {
    const f = fixture();
    try {
      // A corrupted retained database is deliberately observed, not repaired.
      f.database.exec("PRAGMA foreign_keys = OFF");
      f.database.prepare("UPDATE run_step_comments SET submission_id = 'missing-canonical' WHERE id = ?").run(ids.commentOccurrenceA);
      f.database.exec("PRAGMA foreign_keys = ON");
      const [canonical] = await f.resolve();
      expect(canonical).toMatchObject({ resolution: "inconsistent", source: { excerpt: null, state: null } });
      expect(JSON.stringify(canonical)).not.toContain(staleBody);
      expect((await f.detail()).runs[0].steps[0].comments.some((comment) => comment.id === ids.commentOccurrenceA)).toBe(false);
    } finally { f.database.close(); }
  });

  it("keeps canonical search singular and preserves legacy body search", async () => {
    const f = fixture();
    try {
      for (const [query, expected] of [[canonicalBody, [ids.comment]], [legacyBody, [legacyId]], [staleBody, []]] as const) {
        const response = await f.request("/references/search", "POST", { query, types: ["comment", "comment_occurrence"], limit: 10 });
        expect(response.status).toBe(200);
        const payload = await response.json() as { results: Array<{ target: { id: string } }> };
        expect(payload.results.map((row) => row.target.id)).toEqual(expected);
      }
    } finally { f.database.close(); }
  });

  it.each(["common", "individual"])("uses canonical text for %s occurrence lifecycle summaries and preserves identity", async (scope) => {
    const f = fixture();
    try {
      if (scope === "individual") f.database.prepare("UPDATE run_step_comments SET scope = 'individual', operation_group_id = NULL WHERE id = ?").run(ids.commentOccurrenceA);
      const count = scope === "common" ? 2 : 1;
      const previousEventIds = new Set(f.database.prepare("SELECT id FROM events").all().map((row) => row.id));
      const canonical = f.database.prepare("SELECT * FROM comment_submissions WHERE id = ?").get(ids.comment);
      const deleted = await f.request(`/run-step-comments/${ids.commentOccurrenceA}`, "DELETE");
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toMatchObject({ deleted: count });
      const tombstones = f.database.prepare("SELECT id, submission_id, body, deletion_operation_id FROM run_step_comments WHERE deleted_at IS NOT NULL ORDER BY id").all();
      expect(tombstones).toHaveLength(count);
      expect(tombstones.every((row) => row.submission_id === ids.comment && row.body === staleBody)).toBe(true);
      expect(new Set(tombstones.map((row) => row.deletion_operation_id)).size).toBe(1);
      const restored = await f.request(`/run-step-comments/${ids.commentOccurrenceA}/restore`, "POST");
      expect(restored.status).toBe(200);
      const events = f.database.prepare("SELECT id, body FROM events ORDER BY created_at, id").all()
        .filter((row) => !previousEventIds.has(row.id));
      expect(events).toHaveLength(count * 2);
      expect(events.every((event) => String(event.body).includes(canonicalBody) && !String(event.body).includes(staleBody))).toBe(true);
      expect(f.database.prepare("SELECT * FROM comment_submissions WHERE id = ?").get(ids.comment)).toEqual(canonical);
      expect(f.database.prepare("SELECT COUNT(*) AS count FROM run_step_comments WHERE deleted_at IS NOT NULL").get()).toEqual({ count: 0 });
    } finally { f.database.close(); }
  });

  it.each(["common", "individual"])("uses canonical text for %s image deletion without deleting the Comment", async (scope) => {
    const f = fixture();
    try {
      f.database.prepare("UPDATE run_step_comments SET asset_id = 'reference-comment-asset' WHERE submission_id = ?").run(ids.comment);
      if (scope === "individual") f.database.prepare("UPDATE run_step_comments SET scope = 'individual', operation_group_id = NULL WHERE id = ?").run(ids.commentOccurrenceA);
      const previousEventIds = new Set(f.database.prepare("SELECT id FROM events").all().map((row) => row.id));
      const response = await f.request(`/run-step-comments/${ids.commentOccurrenceA}/asset`, "DELETE");
      expect(response.status).toBe(200);
      const events = f.database.prepare("SELECT id, body FROM events ORDER BY id").all()
        .filter((row) => !previousEventIds.has(row.id));
      expect(events).toHaveLength(scope === "common" ? 2 : 1);
      expect(events.every((row) => row.body === `Deleted comment image attachment · ${canonicalBody}`)).toBe(true);
      expect(f.database.prepare("SELECT COUNT(*) AS count FROM run_step_comments WHERE deleted_at IS NOT NULL").get()).toEqual({ count: 0 });
      expect((await f.detail()).runs[0].steps[0].comments.find((comment) => comment.id === ids.commentOccurrenceA)?.body).toBe(canonicalBody);
    } finally { f.database.close(); }
  });

  it("keeps schema-7 stored values and columns exact inside one export snapshot", async () => {
    const f = fixture();
    try {
      f.database.prepare("UPDATE samples SET process_revision = 37 WHERE id = ?").run(ids.sampleA);
      const samples = f.database.prepare("SELECT * FROM samples ORDER BY created_at, id").all();
      const comments = f.database.prepare("SELECT * FROM run_step_comments ORDER BY run_step_id, created_at, id").all();
      // Simulate additive columns only: Stage A must not advertise them as v7.
      f.database.exec("ALTER TABLE samples ADD COLUMN future_bridge_marker TEXT DEFAULT 'private'; ALTER TABLE run_step_comments ADD COLUMN legacy_body TEXT");
      f.d1.resetQueryCount();
      const response = await f.request("/exports/all");
      expect(response.status).toBe(200);
      const archive = await response.json() as { schemaVersion: number; tables: Record<string, unknown[]> };
      expect(archive.schemaVersion).toBe(7);
      expect(archive.tables.samples).toEqual(samples);
      expect(archive.tables.run_step_comments).toEqual(comments);
      expect(f.d1.batchCount).toBe(1);
      expect(f.d1.queryCount).toBe(Object.keys(archive.tables).length);
    } finally { f.database.close(); }
  });
});
