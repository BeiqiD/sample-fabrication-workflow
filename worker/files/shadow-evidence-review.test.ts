import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { readShadowBaseline } from "./shadow-baseline";
import { readShadowEvidenceReview } from "./shadow-evidence-review";
import type { FileShadowEvidenceReview } from "../../shared/contracts/file-shadow-evidence-review";
import type { LiveConsumerDatabase } from "./live-consumer-baseline";
import { readShadowIdentification, SHADOW_IDENTIFICATION_COLUMN_SQL } from "./shadow-identification";

const databases: DatabaseSync[] = [];
const now = "2026-09-28T08:00:00.000Z", sha = "a".repeat(64);
const key = (consumerId = "content-a", consumerSubId = "") => ({ consumerKind: "project_content_attachment", consumerId, consumerSubId, fileSlot: "primary" });
const executionContext = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
function fixture(referenceCount = 2) {
  const sql = referenceTestDatabase(); databases.push(sql);
  sql.prepare(`INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,actor_email,created_at)
    VALUES('shared-asset','private/provider-object-key','registry-private-name.png','image/png',23,'ready',?,'private-actor@example.com',?)`).run(sha, now);
  for (const [suffix, name] of [["a", "first reference.png"], ["b", "different reference.png"]].slice(0, referenceCount)) {
    sql.prepare(`INSERT INTO projects(id,title,last_mutation_id,created_by,updated_by,created_at,updated_at)
      VALUES(?,?,?,'private-actor@example.com','private-actor@example.com',?,?)`).run(`project-${suffix}`, `Research source R2 verified ${suffix}`, `project-create-${suffix}`, now, now);
    sql.prepare(`INSERT INTO project_contents(id,project_id,content_type,last_mutation_id,created_by,updated_by,created_at,updated_at)
      VALUES(?,?,'attachment',?,'private-actor@example.com','private-actor@example.com',?,?)`).run(`content-${suffix}`, `project-${suffix}`, `content-create-${suffix}`, now, now);
    sql.prepare(`INSERT INTO project_content_attachments(project_content_id,asset_id,original_name,mime_type,byte_size,created_by,created_at,creation_operation_id)
      VALUES(?,'shared-asset',?,'image/png',23,'private-actor@example.com',?,?)`).run(`content-${suffix}`, name, now, `attachment-create-${suffix}`);
  }
  sql.prepare("INSERT INTO storage_profiles VALUES('unproven-current-profile','r2','r2:private-account:private-bucket','bootstrap',NULL,1,'historical',?)").run(now);
  const db = new SqliteD1Database(sql);
  const get = vi.fn(), head = vi.fn(), put = vi.fn(), remove = vi.fn(), list = vi.fn(), providerFetch = vi.fn();
  vi.stubGlobal("fetch", providerFetch);
  const env: Env = { AUTH_MODE: "disabled", DB: db as unknown as D1Database, ASSETS: { get, head, put, delete: remove, list } as unknown as R2Bucket };
  const request = (path: string, body?: unknown, targetEnv = env, headers: HeadersInit = {}) => worker.fetch(new Request(`https://app.test/api/files/shadow/${path}`,
    body === undefined ? undefined : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }), targetEnv, executionContext);
  const changes = () => Number(sql.prepare("SELECT total_changes() count").get()!.count);
  const noProvider = () => { for (const fn of [get, head, put, remove, list, providerFetch]) expect(fn).not.toHaveBeenCalled(); };
  return { sql, db, env, request, changes, noProvider };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const db of databases.splice(0)) db.close(); });

describe("read-only historical File evidence review", () => {
  it("returns only the bounded safe projection in one primary snapshot without writes or provider I/O", async () => {
    const f = fixture(), before = await readShadowBaseline(f.db, key()), changes = f.changes();
    const withSession = vi.fn(() => f.db);
    const env = { ...f.env, DB: { withSession, prepare: f.db.prepare.bind(f.db) } as unknown as D1Database };
    f.db.resetQueryCount();
    const response = await f.request("evidence-review", { key: key() }, env);
    expect(response.status).toBe(200);
    const review = await response.json() as FileShadowEvidenceReview;
    expect(review).toEqual({ version: 1, kind: "file-shadow-evidence-review", readOnly: true, bytesVerified: false, key: key(),
      head: { generation: before.head!.generation, occurrenceId: before.head!.occurrence_id, sourceMetadataSha256: before.head!.source_sha256 },
      baselineSha256: before.baselineSha256, status: "ambiguous", reasons: ["consumer_purpose_unresolved", "namespace_evidence_missing"],
      identification: { projectId: "project-a", projectTitle: "Research source R2 verified a", attachmentName: "first reference.png" },
      purpose: null, expectedBytes: 23, expectedSha256: sha, sourceProvider: "r2", sourceProfile: null,
      peerReferences: [{ key: key("content-b"), purpose: null }] });
    const safeJson = JSON.stringify(review);
    for (const privateValue of ["private/provider-object-key", "private-actor@example.com", "registry-private-name.png", "private-bucket", "unproven-current-profile"]) expect(safeJson).not.toContain(privateValue);
    expect(withSession).toHaveBeenCalledExactlyOnceWith("first-primary"); expect(f.db.queryCount).toBe(1);
    expect(f.changes()).toBe(changes); f.noProvider();
    expect(await readShadowBaseline(f.db, key())).toEqual(before);
  });

  it("keeps two references sharing one locator independently identified and unresolved", async () => {
    const f = fixture(), changes = f.changes();
    const first = await readShadowEvidenceReview(f.db, key()), second = await readShadowEvidenceReview(f.db, key("content-b"));
    expect(first.identification?.attachmentName).toBe("first reference.png");
    expect(second.identification?.attachmentName).toBe("different reference.png");
    expect(first.head!.occurrenceId).not.toBe(second.head!.occurrenceId); expect(first.baselineSha256).not.toBe(second.baselineSha256);
    expect(first.peerReferences).toEqual([{ key: key("content-b"), purpose: null }]);
    expect(second.peerReferences).toEqual([{ key: key(), purpose: null }]);
    for (const review of [first, second]) expect(review).toMatchObject({ purpose: null, sourceProfile: null, status: "ambiguous", bytesVerified: false,
      reasons: ["consumer_purpose_unresolved", "namespace_evidence_missing"] });
    expect(f.changes()).toBe(changes); f.noProvider();
  });

  it("never labels the selected reference itself as another shared reference", async () => {
    const f = fixture(1);
    expect((await readShadowEvidenceReview(f.db, key())).peerReferences).toEqual([]);
    f.noProvider();
  });

  it("omits an oversized historical label while keeping the existing consumer list and exact review usable", async () => {
    const f = fixture();
    // Recreate an old row that predates today's title input guards, restoring
    // the exact schema before either reviewed reader runs.
    const triggers = f.sql.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='projects'").all() as { name: string; sql: string }[];
    for (const trigger of triggers) f.sql.exec(`DROP TRIGGER "${trigger.name}"`);
    f.sql.prepare("UPDATE projects SET title=? WHERE id='project-a'").run(" ".repeat(4096) + "Historical title");
    for (const trigger of triggers) f.sql.exec(trigger.sql);
    const baseline = await readShadowBaseline(f.db, key()), changes = f.changes();
    const page = await f.request("consumers"); expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ records: [{ consumer_id: "content-a", identification: null }, { consumer_id: "content-b" }] });
    const review = await readShadowEvidenceReview(f.db, key());
    expect(review).toMatchObject({ key: key(), identification: null, status: "ambiguous", baselineSha256: baseline.baselineSha256 });
    expect(f.changes()).toBe(changes); f.noProvider();
  });

  it("omits optional hints when SQLite JSON escaping exceeds their envelope despite bounded raw fields", () => {
    const f = fixture(), projectId = "\u0001".repeat(14000);
    // Use the production SQL projection: raw ID bytes fit its field bound, but
    // json_object escapes each control character into six JSON bytes.
    const row = f.sql.prepare(`SELECT ${SHADOW_IDENTIFICATION_COLUMN_SQL}
      FROM (SELECT ? AS id,'Title' AS title) review_project
      CROSS JOIN (SELECT 'Name' AS original_name) review_attachment`).get(projectId)!;
    expect(new TextEncoder().encode(projectId).length).toBeLessThan(64 * 1024);
    expect(new TextEncoder().encode(String(row.identification_json)).length).toBeGreaterThan(80 * 1024);
    expect(readShadowIdentification(row.identification_json)).toBeNull();
    f.noProvider();
  });

  it("lists bounded identity labels in the original page SELECT without changing pagination", async () => {
    const f = fixture(), changes = f.changes(); f.db.resetQueryCount();
    const response = await f.request("consumers?limit=1"), page = await response.json() as { records: unknown[]; nextCursor: ReturnType<typeof key> };
    expect(response.status).toBe(200); expect(f.db.queryCount).toBe(1);
    expect(page).toMatchObject({ records: [{ consumer_id: "content-a", state: "pending", identification: {
      projectId: "project-a", projectTitle: "Research source R2 verified a", attachmentName: "first reference.png" } }], nextCursor: key() });
    const next = await f.request(`consumers?limit=1&after=${encodeURIComponent(JSON.stringify(page.nextCursor))}`);
    expect(await next.json()).toMatchObject({ records: [{ consumer_id: "content-b", identification: { attachmentName: "different reference.png" } }], nextCursor: null });
    expect(f.changes()).toBe(changes); f.noProvider();
  });

  it("captures identity labels and source qualification before a concurrent Project edit", async () => {
    const f = fixture(), original = await readShadowBaseline(f.db, key());
    const database: LiveConsumerDatabase = { prepare(query) { return { bind(...values) { return { ...this, async all<T>() {
      const result = await f.db.prepare(query).bind(...values).all<T>();
      f.sql.prepare("UPDATE projects SET title='Changed concurrently',revision=revision+1,last_mutation_id='rename-concurrent',updated_at=? WHERE id='project-a'").run(now);
      return result;
    } }; }, async all<T>() { return f.db.prepare(query).all<T>(); } }; } };
    f.db.resetQueryCount();
    const review = await readShadowEvidenceReview(database, key());
    expect(f.db.queryCount).toBe(1);
    expect(review.identification?.projectTitle).toBe("Research source R2 verified a"); expect(review.baselineSha256).toBe(original.baselineSha256);
    expect((await readShadowBaseline(f.db, key())).head!.occurrence_id).not.toBe(original.head!.occurrence_id);
    f.noProvider();
  });

  it.each(["", "historical\0文件", "é\u0301文件"])("preserves opaque absent identity %j without aliasing an existing reference", async id => {
    const f = fixture(), input = key(id), changes = f.changes();
    const response = await f.request("evidence-review", { key: input });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ key: input, head: null, identification: null, status: "absent", purpose: null,
      expectedBytes: null, expectedSha256: null, sourceProvider: null, sourceProfile: null, peerReferences: [] });
    const nonemptySubId = key("content-a", id || "unmatched");
    expect(await (await f.request("evidence-review", { key: nonemptySubId })).json()).toMatchObject({ key: nonemptySubId, status: "absent", identification: null });
    expect(f.changes()).toBe(changes); f.noProvider();
  });

  it("rejects malformed and unsupported keys before database reads, including comma-key collisions", async () => {
    const f = fixture(); f.db.resetQueryCount();
    for (const input of [null, {}, { ...key(), consumerId: 4 }, { ...key(), extra: "field" },
      { consumerId: "content-a", "consumerKind,consumerSubId": "project_content_attachment", fileSlot: "primary" },
      { ...key(), consumerId: "长".repeat(23000) }, { ...key(), consumerKind: "event" }, { ...key(), fileSlot: "evidence" }]) {
      expect((await f.request("evidence-review", { key: input })).status).toBe(400);
    }
    expect((await f.request("evidence-review", { key: key(), adjudicate: true })).status).toBe(400);
    expect(f.db.queryCount).toBe(0); f.noProvider();
  });

  it("fails closed on missing/oversized identity metadata or an incomplete primary snapshot", async () => {
    const f = fixture();
    for (const change of [
      (row: Record<string, unknown>) => { delete row.identification_json; },
      (row: Record<string, unknown>) => { row.identification_json = JSON.stringify({ projectId: "p", projectTitle: "x".repeat(4097), attachmentName: "name" }); },
      (row: Record<string, unknown>) => { row.identification_json = '{"invalid":true}'; },
      (row: Record<string, unknown>) => { row.record_count = 2; },
      (row: Record<string, unknown>) => { row.schema_json = "[]"; },
    ]) {
      const database: LiveConsumerDatabase = { prepare(query) { return { bind(...values) { return { ...this, async all<T>() {
        const result = await f.db.prepare(query).bind(...values).all<Record<string, unknown>>();
        change(result.results[0]); return result as unknown as { success: boolean; results: T[] };
      } }; }, async all<T>() { return f.db.prepare(query).all<T>(); } }; } };
      await expect(readShadowEvidenceReview(database, key())).rejects.toThrow();
    }
    f.noProvider();
  });

  it("enforces authentication and the shared cross-origin POST boundary without touching metadata", async () => {
    const f = fixture(); vi.spyOn(console, "warn").mockImplementation(() => undefined); f.db.resetQueryCount();
    expect((await f.request("evidence-review", { key: key() }, { ...f.env, AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: "https://access.example", ACCESS_AUD: "aud" })).status).toBe(403);
    expect((await f.request("evidence-review", { key: key() }, f.env, { origin: "https://attacker.example" })).status).toBe(403);
    expect(f.db.queryCount).toBe(0); f.noProvider();
  });
});
