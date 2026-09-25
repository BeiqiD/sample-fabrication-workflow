import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import { registerLegacyInventory } from "./legacy-inventory";
import { MAX_LIVE_CONSUMER_SOURCE_KEY_BYTES, MAX_LIVE_CONSUMER_SOURCE_ROWS, readFileConsumerBaseline, type LiveConsumerDatabase, type LiveConsumerKey } from "./live-consumer-baseline";

const NOW = "2026-09-25T12:00:00.000Z";
const HASH = "a".repeat(64);
const databases: DatabaseSync[] = [];
function fixture() {
  const sql = referenceTestDatabase({ throughMigration: "0007_fp1_file_authority_transition.sql" }); databases.push(sql);
  const local = new SqliteD1Database(sql);
  const sessions: string[] = [];
  const db: LiveConsumerDatabase = { prepare: (q) => local.prepare(q), withSession: (constraint) => { sessions.push(constraint); return local; } };
  sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('s','S','Sample',?,?)").run(NOW, NOW);
  return { sql, db, local, sessions };
}
function asset(sql: DatabaseSync, id = "asset", key = "key", hash = HASH) {
  sql.prepare("INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at) VALUES(?,?,'private-name.png','image/png',10,'ready',?,?)").run(id, key, hash, NOW);
}
function imported(sql: DatabaseSync, id = "import", key: string | null = "key") {
  sql.prepare("INSERT INTO imports(id,status,source_filename,source_sha256,sheet_name,template_type,workbook_asset_key,created_at) VALUES(?,'ready','private-workbook.xlsx',?,'sheet','process',?,?)").run(id, HASH, key, NOW);
}
async function mapping(local: SqliteD1Database, key = "key") {
  await registerLegacyInventory(local, { observedAt: NOW, observations: [{ storeKind: "r2", provider: "r2", objectKey: key,
    records: [{ table: "assets", id: "asset", byte_size: 10, sha256: HASH, status: "ready", import_id: null }], consumers: [], lifecycle: [] }] },
  [{ id: "profile", adapterType: "r2", namespaceIdentity: "r2:account:bucket", configurationSource: "bootstrap", credentialReference: null, configurationRevision: 1 }]);
}
function comment(sql: DatabaseSync, bound = true) {
  sql.prepare("INSERT INTO comment_submissions(id,context_kind,sample_id,body,status,created_at,updated_at) VALUES('comment','sample','s','PRIVATE BODY','ready',?,?)").run(NOW, NOW);
  sql.prepare("INSERT INTO comment_submission_items(id,submission_id,kind,status,position,asset_id,sha256,byte_size,created_at,updated_at) VALUES('item','comment','comment_image',?,0,?,?,10,?,?)").run(bound ? "ready" : "pending", bound ? "asset" : null, HASH, NOW, NOW);
}
afterEach(() => { databases.splice(0).forEach((db) => db.close()); vi.unstubAllGlobals(); });

describe("bounded live consumer metadata baseline", () => {
  it("reads a populated ready-to-verify source once on primary without writes or provider IO", async () => {
    const { sql, db, local, sessions } = fixture();
    asset(sql); imported(sql); await mapping(local);
    const fetcher = vi.fn(() => { throw new Error("No provider capability"); }); vi.stubGlobal("fetch", fetcher);
    const changes = sql.prepare("SELECT total_changes() n").get()!.n;
    local.resetQueryCount();
    const first = await readFileConsumerBaseline(db);
    expect(first.records).toHaveLength(1);
    expect(first.records[0]).toMatchObject({ key: { consumerKind: "import", consumerId: "import", consumerSubId: "", fileSlot: "workbook" },
      status: "ready_to_verify", purpose: "provenance", reasons: [] });
    expect(first).toMatchObject({ executable: false, bytesVerified: false, nextCursor: null });
    expect(local.queryCount).toBe(1); expect(sessions).toEqual(["first-primary"]);
    expect(sql.prepare("SELECT total_changes() n").get()!.n).toBe(changes);
    expect(fetcher).not.toHaveBeenCalled();
    const second = await readFileConsumerBaseline(db);
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("private-workbook");
  });

  it("separates pending content, a missing registry, and cross-purpose aliases", async () => {
    const { sql, db, local } = fixture(); asset(sql); imported(sql); await mapping(local); comment(sql, false);
    sql.prepare("INSERT INTO events(id,sample_id,kind,asset_key,metadata_json,created_at) VALUES('event','s','image','key','{\"action\":\"sample_record\"}',?)").run(NOW);
    imported(sql, "missing", "not-registered");
    const result = await readFileConsumerBaseline(db);
    expect(result.records.find((r) => r.key.consumerId === "item")!.status).toBe("pending_no_locator");
    expect(result.records.find((r) => r.key.consumerId === "missing")!.status).toBe("unavailable");
    const shared = result.records.find((r) => r.key.consumerId === "import")!;
    expect(shared.status).toBe("ambiguous"); expect(shared.reasons).toContain("independent_verified_copies_required");
  });

  it("refuses ready-to-verify when an occurrence disagrees with the registry", async () => {
    const { sql, db, local } = fixture(); asset(sql); await mapping(local); comment(sql);
    expect((await readFileConsumerBaseline(db)).records[0].status).toBe("ready_to_verify");
    sql.prepare("UPDATE comment_submission_items SET sha256=? WHERE id='item'").run("b".repeat(64));
    const record = (await readFileConsumerBaseline(db)).records[0];
    expect(record.status).toBe("ambiguous"); expect(record.reasons).toContain("expected_byte_metadata_conflict");
    const importedSource = fixture(); asset(importedSource.sql); imported(importedSource.sql); await mapping(importedSource.local);
    importedSource.sql.prepare("UPDATE imports SET source_sha256=? WHERE id='import'").run("b".repeat(64));
    expect((await readFileConsumerBaseline(importedSource.db)).records[0].reasons).toContain("expected_byte_metadata_conflict");
  });

  it("hashes parent retry/lifecycle and registry changes while preserving historical rows", async () => {
    const { sql, db, local } = fixture(); asset(sql); await mapping(local); comment(sql);
    const before = (await readFileConsumerBaseline(db)).records[0];
    sql.prepare("UPDATE comment_submissions SET retry_until='2026-10-01T00:00:00.000Z' WHERE id='comment'").run();
    const parentChanged = (await readFileConsumerBaseline(db)).records[0];
    expect(parentChanged.baselineSha256).not.toBe(before.baselineSha256);
    sql.prepare("UPDATE assets SET status='failed' WHERE id='asset'").run();
    const failed = (await readFileConsumerBaseline(db)).records[0];
    expect(failed.baselineSha256).not.toBe(parentChanged.baselineSha256); expect(failed.status).toBe("unavailable");
  });

  it("preserves composite and historical NUL/long identities through typed pagination", async () => {
    const { sql, db } = fixture(); asset(sql, "c", "one"); asset(sql, "b:c", "two", "b".repeat(64));
    for (const id of ["a:b", "a"]) sql.prepare("INSERT INTO state_representations(hash,content_json,created_at) VALUES(?,'{}',?)").run(id, NOW);
    sql.exec("INSERT INTO state_representation_assets(state_hash,asset_id) VALUES('a:b','c'),('a','b:c')");
    const id = "nul\0" + "x".repeat(5000);
    sql.prepare("INSERT INTO events(id,sample_id,kind,asset_key,metadata_json,created_at) VALUES(?,'s','image','unregistered','{\"action\":\"sample_record\"}',?)").run(id, NOW);
    let after: LiveConsumerKey | undefined; const keys: LiveConsumerKey[] = [];
    do { const page = await readFileConsumerBaseline(db, { limit: 1, after }); keys.push(...page.records.map((r) => r.key)); after = page.nextCursor ?? undefined; } while (after);
    expect(keys).toHaveLength(3); expect(keys[0].consumerId).toBe(id);
    expect(keys.slice(1).map((k) => [k.consumerId, k.consumerSubId])).toEqual([["a", "b:c"], ["a:b", "c"]]);
  });

  it("does not leak malformed event JSON and keeps its otherwise unbound thumbnail visible", async () => {
    const { sql, db } = fixture();
    sql.prepare("INSERT INTO events(id,sample_id,kind,metadata_json,created_at) VALUES('e','s','image',?,?)").run(JSON.stringify({ thumbnailKey: { secret: "PRIVATE TOKEN" }, action: ["PRIVATE BODY"] }), NOW);
    const page = await readFileConsumerBaseline(db);
    expect(page.records).toHaveLength(1); expect(page.records[0].status).toBe("ambiguous");
    expect(JSON.stringify(page)).not.toContain("PRIVATE");
    expect(page.records[0].related.eventMetadata!.semantics_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed on malformed cursors and partial transport results", async () => {
    const { db } = fixture();
    for (const after of [null, 0, false, "", [], { consumerKind: "import" }]) await expect(readFileConsumerBaseline(db, { after: after as LiveConsumerKey })).rejects.toThrow(/cursor/);
    const incomplete: LiveConsumerDatabase = { prepare: (query) => { const statement = db.prepare(query); return { bind: (...values) => {
      const bound = statement.bind(...values); return { bind: () => { throw new Error("Not used"); }, all: async () => { await bound.all(); return { success: true, results: [] }; } };
    }, all: async () => ({ success: false, results: [] }) }; } };
    await expect(readFileConsumerBaseline(incomplete)).rejects.toThrow(/incomplete/);
  });

  it("rejects partial/drifted generations and unaddressable NULL identities", async () => {
    const a = fixture(); a.sql.exec("DROP TRIGGER template_versions_file_replace_guard");
    await expect(readFileConsumerBaseline(a.db)).rejects.toThrow(/schema generation/);
    const b = fixture(); b.sql.prepare("INSERT INTO events(id,sample_id,kind,asset_key,created_at) VALUES(NULL,'s','image','key',?)").run(NOW);
    await expect(readFileConsumerBaseline(b.db)).rejects.toThrow(/typed cursor/);
  });

  it("enforces installation source qualification caps before metadata hydration", { timeout: 20_000 }, async () => {
    const a = fixture();
    a.sql.exec("BEGIN"); for (let index = 0; index <= MAX_LIVE_CONSUMER_SOURCE_ROWS; index++) imported(a.sql, `i${index}`, null); a.sql.exec("COMMIT");
    await expect(readFileConsumerBaseline(a.db)).rejects.toThrow(/source row bound/);
    const b = fixture();
    b.sql.prepare("INSERT INTO events(id,sample_id,kind,metadata_json,created_at) VALUES('large','s','image',?,?)").run(JSON.stringify({ body: "x".repeat(MAX_LIVE_CONSUMER_SOURCE_KEY_BYTES) }), NOW);
    await expect(readFileConsumerBaseline(b.db)).rejects.toThrow(/source key byte bound/);
  });
});
