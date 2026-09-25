import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LegacyStorageProfile } from "../../shared/contracts/files";
import { referenceTestDatabase } from "../reference-test-support";
import {
  MAX_INVENTORY_EVIDENCE_ROWS, MAX_INVENTORY_PAGE_SIZE,
  planLegacyInventory, readLegacyInventoryPage, registerLegacyInventory,
  type InventoryDatabase, type InventoryStatement, type LegacyInventoryObservation,
} from "./legacy-inventory";

const NOW = "2026-09-13T12:00:00.000Z";
const HASH = "a".repeat(64);
const PROFILES: LegacyStorageProfile[] = [{
  id: "legacy-r2", adapterType: "r2", namespaceIdentity: "r2:account-1:bucket-1",
  configurationSource: "bootstrap", credentialReference: null, configurationRevision: 1,
}, {
  id: "legacy-switch", adapterType: "switchdrive", namespaceIdentity: "switchdrive:drive.example:user-root-1",
  configurationSource: "environment", credentialReference: "environment:SWITCHDRIVE", configurationRevision: 1,
}];

class Statement implements InventoryStatement {
  constructor(readonly db: DatabaseSync, readonly sql: string, readonly values: unknown[] = []) {}
  bind(...values: unknown[]) { return new Statement(this.db, this.sql, values); }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values) as T[], success: true }; }
  execute() { return this.db.prepare(this.sql).run(...this.values); }
}

const databases: DatabaseSync[] = [];
function fixture() {
  const sql = referenceTestDatabase();
  databases.push(sql);
  const db: InventoryDatabase = {
    prepare: (query) => new Statement(sql, query),
    batch: async (statements) => {
      sql.exec("BEGIN");
      try {
        const results = statements.map((statement) => (statement as Statement).execute());
        sql.exec("COMMIT");
        return results.map(() => ({ success: true }));
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { sql, db };
}
afterEach(() => { databases.splice(0).forEach((db) => db.close()); vi.unstubAllGlobals(); });

function asset(sql: DatabaseSync, id: string, key = id, status = "ready", hash: string | null = HASH) {
  sql.prepare(`INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
    VALUES (?, ?, 'same.png', 'image/png', 10, ?, ?, ?)`).run(id, key, status, hash, NOW);
}
function managed(sql: DatabaseSync, id: string, key = id, status = "ready") {
  sql.prepare(`INSERT INTO managed_storage_objects
    (id, provider, object_key, original_name, mime_type, byte_size, sha256, status, created_at)
    VALUES (?, 'switchdrive', ?, 'same.png', 'image/png', 10, ?, ?, ?)`).run(id, key, HASH, status, NOW);
}
function sample(sql: DatabaseSync) {
  sql.prepare(`INSERT INTO samples (id, code, title, created_at, updated_at) VALUES ('s', 'S', 'Sample', ?, ?)`).run(NOW, NOW);
}
function importWriter(sql: DatabaseSync) {
  const statement = sql.prepare(`INSERT INTO imports
    (id, status, source_filename, source_sha256, sheet_name, template_type, workbook_asset_key, manifest_asset_key, created_at)
    VALUES (?, 'ready', 'source.xlsx', ?, 'sheet', 'process', ?, ?, ?)`);
  return (id: string, workbook: string, manifest: string | null = null) =>
    statement.run(id, HASH, workbook, manifest, NOW);
}
function imported(sql: DatabaseSync, id: string, workbook: string, manifest: string | null = null) {
  importWriter(sql)(id, workbook, manifest);
}
function comment(sql: DatabaseSync, id: string, kind: "comment_image" | "attachment", assetId: string | null, managedId: string | null, position = 0) {
  sql.prepare(`INSERT OR IGNORE INTO comment_submissions
    (id, context_kind, sample_id, body, status, created_at, updated_at)
    VALUES ('c', 'sample', 's', '', 'ready', ?, ?)`).run(NOW, NOW);
  sql.prepare(`INSERT INTO comment_submission_items
    (id, submission_id, kind, status, position, asset_id, storage_object_id, created_at, updated_at)
    VALUES (?, 'c', ?, 'ready', ?, ?, ?, ?, ?)`).run(id, kind, position, assetId, managedId, NOW, NOW);
}
function observation(key: string, override: Partial<LegacyInventoryObservation> = {}): LegacyInventoryObservation {
  return {
    storeKind: "r2", provider: "r2", objectKey: key,
    records: [{ table: "assets", id: key, byte_size: 10, sha256: HASH, status: "ready", import_id: null }],
    consumers: [], lifecycle: [], ...override,
  };
}
function counts(sql: DatabaseSync) {
  return ["storage_profiles", "files", "file_locations", "legacy_file_mappings"].map((table) =>
    Number(sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n));
}

describe("FP1 dormant legacy metadata inventory", () => {
  it("inventories populated registered, direct-only, GC and quarantine roots without reading bytes", async () => {
    const { sql, db } = fixture();
    const fetcher = vi.fn(() => { throw new Error("Inventory must not use storage"); });
    vi.stubGlobal("fetch", fetcher);
    sample(sql);
    asset(sql, "ready", "shared-key");
    asset(sql, "failed", "failed-key", "failed");
    managed(sql, "original", "shared-key");
    managed(sql, "deleted", "deleted-key", "deleted");
    imported(sql, "import", "direct-workbook", "direct-manifest");
    sql.prepare(`INSERT INTO events (id, sample_id, kind, asset_key, metadata_json, created_at)
      VALUES ('e', 's', 'image', 'event-only', '{"thumbnailKey":"thumbnail-only"}', ?)`).run(NOW);
    sql.prepare(`INSERT INTO blob_gc_ledger (store_kind, provider, object_key, state, updated_at, last_error)
      VALUES ('r2', 'r2', 'gc-only', 'deleted', ?, 'credential-secret-must-not-be-exported')`).run(NOW);
    sql.prepare(`INSERT INTO blob_integrity_quarantine
      (store_kind, provider, object_key, reason, expected_byte_size, operation_id, detected_at, last_checked_at)
      VALUES ('managed', 'switchdrive', 'missing-only', 'missing', 45, 'op', ?, ?)`).run(NOW, NOW);
    const page = await readLegacyInventoryPage(db, { observedAt: NOW });
    expect(page.nextCursor).toBeNull();
    expect(page.observations.map((o) => o.objectKey).sort()).toEqual([
      "deleted-key", "direct-manifest", "direct-workbook", "event-only", "failed-key", "gc-only", "missing-only",
      "shared-key", "shared-key", "thumbnail-only",
    ]);
    const plan = await registerLegacyInventory(db, page, PROFILES);
    expect(plan.entries.find((e) => e.objectKey === "direct-workbook")).toMatchObject({ purpose: "provenance" });
    expect(plan.entries.find((e) => e.objectKey === "thumbnail-only")).toMatchObject({ purpose: "derived_preview" });
    expect(plan.entries.find((e) => e.objectKey === "event-only")).toMatchObject({ purpose: null, classification: "unclassified" });
    expect(plan.entries.find((e) => e.objectKey === "missing-only")).toMatchObject({ expectedByteSize: 45, expectedSha256: null });
    const sameKey = plan.entries.filter((e) => e.objectKey === "shared-key");
    expect(new Set(sameKey.map((e) => e.fileId)).size).toBe(2);
    expect(new Set(sameKey.map((e) => e.profileId)).size).toBe(2);
    expect(sql.prepare("SELECT DISTINCT state, verified_sha256, active_location_id FROM files").all())
      .toEqual([{ state: "unresolved", verified_sha256: null, active_location_id: null }]);
    expect(sql.prepare("SELECT DISTINCT state FROM file_locations").all()).toEqual([{ state: "unresolved" }]);
    expect(sql.prepare("SELECT status FROM assets WHERE id='failed'").get()!.status).toBe("failed");
    expect(sql.prepare("SELECT status FROM managed_storage_objects WHERE id='deleted'").get()!.status).toBe("deleted");
    expect(JSON.stringify(plan)).not.toContain("credential-secret");
    expect(fetcher).not.toHaveBeenCalled();
    expect(counts(sql)).toEqual([2, 10, 10, 10]);
    expect(sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("classifies actual Comment operations, reciprocal previews and mixed consumers conservatively", async () => {
    const { sql, db } = fixture();
    sample(sql);
    asset(sql, "embedded", "embedded", "ready", "b".repeat(64));
    asset(sql, "preview", "preview", "ready", "c".repeat(64));
    asset(sql, "mixed", "mixed", "ready", "d".repeat(64)); managed(sql, "source");
    comment(sql, "embedded-item", "comment_image", "embedded", null, 0);
    comment(sql, "preview-item", "comment_image", "preview", null, 1);
    comment(sql, "source-item", "attachment", null, "source", 2);
    comment(sql, "mixed-item", "comment_image", "mixed", null, 3);
    sql.exec(`UPDATE comment_submission_items SET related_item_id='source-item' WHERE id='preview-item';
      UPDATE comment_submission_items SET related_item_id='preview-item' WHERE id='source-item'`);
    imported(sql, "import", "mixed");
    const page = await readLegacyInventoryPage(db, { observedAt: NOW });
    const plan = await registerLegacyInventory(db, page, PROFILES);
    const purposes = Object.fromEntries(plan.entries.map((e) => [e.objectKey, e.purpose]));
    expect(purposes).toEqual({ embedded: "embedded_content", preview: "derived_preview", source: "research_source", mixed: null });
    expect(plan.entries.find((e) => e.objectKey === "mixed")?.classification).toBe("ambiguous");
  });

  it("preserves raw invalid expected metadata as evidence without publishing a verified claim", async () => {
    const { sql, db } = fixture();
    asset(sql, "invalid", "invalid", "ready", "claimed-but-not-validated");
    sql.exec("UPDATE assets SET byte_size = -9 WHERE id = 'invalid'");
    const plan = await registerLegacyInventory(db, await readLegacyInventoryPage(db, { observedAt: NOW }), PROFILES);
    expect(plan.entries[0]).toMatchObject({ expectedByteSize: null, expectedSha256: null });
    const evidence = JSON.parse(plan.entries[0].evidenceJson);
    expect(evidence.records[0]).toMatchObject({ byte_size: -9, sha256: "claimed-but-not-validated", status: "ready" });
    expect(evidence.verification).toBe("not_performed");
  });

  it("retains expired historical consumers when deciding whether purpose is ambiguous", async () => {
    const { sql, db } = fixture();
    sample(sql); asset(sql, "historical");
    comment(sql, "historical-item", "comment_image", "historical", null);
    imported(sql, "import", "historical");
    sql.exec("UPDATE comment_submission_items SET deleted_at='2020-01-01T00:00:00.000Z' WHERE id='historical-item'");
    expect(sql.prepare("SELECT occurrence_type FROM blob_retention_edges WHERE object_key='historical'").all())
      .toEqual([{ occurrence_type: "import_workbook" }]);
    const plan = await registerLegacyInventory(db, await readLegacyInventoryPage(db, { observedAt: NOW }), PROFILES);
    expect(plan.entries[0]).toMatchObject({ purpose: null, classification: "ambiguous" });
    expect(JSON.parse(plan.entries[0].evidenceJson).consumers).toHaveLength(2);
  });

  it("makes exact frozen retries idempotent, including an acknowledgement lost after commit", async () => {
    const { sql, db } = fixture();
    asset(sql, "a");
    const page = await readLegacyInventoryPage(db, { observedAt: NOW });
    const first = await registerLegacyInventory(db, page, PROFILES);
    const retry = await registerLegacyInventory(db, structuredClone(page), structuredClone(PROFILES));
    expect(retry).toEqual(first);
    expect(counts(sql)).toEqual([2, 1, 1, 1]);
    const lostAck: InventoryDatabase = { ...db, batch: async (statements) => { await db.batch(statements); throw new Error("lost acknowledgement"); } };
    await expect(registerLegacyInventory(lostAck, page, PROFILES)).rejects.toThrow("lost acknowledgement");
    await expect(registerLegacyInventory(db, page, PROFILES)).resolves.toEqual(first);
    expect(counts(sql)).toEqual([2, 1, 1, 1]);
  });

  it("rolls back the whole bounded page on stale evidence or a conflicting identity", async () => {
    const { sql, db } = fixture();
    const old = observation("old");
    await registerLegacyInventory(db, { observedAt: NOW, observations: [old] }, PROFILES);
    const changed = structuredClone(old);
    changed.records[0].byte_size = 11;
    await expect(registerLegacyInventory(db, {
      observedAt: NOW, observations: [observation("new-before-conflict"), changed],
    }, PROFILES)).rejects.toThrow();
    expect(counts(sql)).toEqual([2, 1, 1, 1]);
    expect(sql.prepare("SELECT expected_byte_size FROM files").get()!.expected_byte_size).toBe(10);
    await expect(registerLegacyInventory(db, { observedAt: "2026-09-13T12:01:00.000Z", observations: [old] }, PROFILES)).rejects.toThrow();
  });

  it("rejects a changed namespace, profile ID or configuration without reinterpreting historical keys", async () => {
    const { sql, db } = fixture();
    const page = { observedAt: NOW, observations: [observation("same")] };
    await registerLegacyInventory(db, page, PROFILES);
    for (const changed of [
      { ...PROFILES[0], namespaceIdentity: "r2:account-2:bucket-2" },
      { ...PROFILES[0], id: "replacement-profile" },
    ]) {
      await expect(registerLegacyInventory(db, page, [changed, PROFILES[1]])).rejects.toThrow();
      expect(counts(sql)).toEqual([2, 1, 1, 1]);
    }
    expect(sql.prepare("SELECT namespace_identity FROM storage_profiles WHERE id='legacy-r2'").get()!.namespace_identity)
      .toBe(PROFILES[0].namespaceIdentity);
  });

  it("supports bounded keyset pages with one coherent query each and frozen profiles across timestamps", async () => {
    const { sql, db } = fixture();
    for (let i = 0; i < 5; i++) asset(sql, `key-${i}`, `key-${i}`, "ready", String(i).repeat(64));
    const query = vi.spyOn(db, "prepare");
    const one = await readLegacyInventoryPage(db, { observedAt: NOW, limit: 2 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(one.observations).toHaveLength(2);
    expect(one.nextCursor?.objectKey).toBe("key-1");
    await registerLegacyInventory(db, one, PROFILES);
    const two = await readLegacyInventoryPage(db, { observedAt: "2026-09-13T12:01:00.000Z", limit: 2, after: one.nextCursor! });
    await registerLegacyInventory(db, two, PROFILES);
    const three = await readLegacyInventoryPage(db, { observedAt: "2026-09-13T12:02:00.000Z", limit: 2, after: two.nextCursor! });
    expect(three.nextCursor).toBeNull();
    await registerLegacyInventory(db, three, PROFILES);
    expect(counts(sql)).toEqual([2, 5, 5, 5]);
    expect(sql.prepare("SELECT DISTINCT created_at FROM storage_profiles").all()).toEqual([{ created_at: NOW }]);
  });

  it("fails without writes when provider namespace resolution or page/evidence bounds are missing", async () => {
    const { sql, db } = fixture();
    const snapshot = { observedAt: NOW, observations: [observation("a")] };
    await expect(registerLegacyInventory(db, snapshot, [])).rejects.toThrow("profiles");
    await expect(registerLegacyInventory(db, snapshot, [PROFILES[1]])).rejects.toThrow("namespace");
    await expect(registerLegacyInventory(db, snapshot, [PROFILES[0], { ...PROFILES[0], id: "another" }])).rejects.toThrow("one frozen");
    await expect(readLegacyInventoryPage(db, { observedAt: NOW, limit: MAX_INVENTORY_PAGE_SIZE + 1 })).rejects.toThrow("page size");
    await expect(registerLegacyInventory(db, { observedAt: NOW,
      observations: Array.from({ length: MAX_INVENTORY_PAGE_SIZE + 1 }, (_, i) => observation(String(i))),
    }, PROFILES)).rejects.toThrow("too large");
    const tooMany = observation("many", { consumers: Array.from({ length: MAX_INVENTORY_EVIDENCE_ROWS + 1 }, () => ({ purpose: "provenance" })) });
    await expect(registerLegacyInventory(db, { observedAt: NOW, observations: [tooMany] }, PROFILES)).rejects.toThrow("bounded inventory");
    expect(counts(sql)).toEqual([0, 0, 0, 0]);
  });

  it("rejects query credential namespaces and secret/non-whitelisted evidence fields", async () => {
    const { sql, db } = fixture();
    for (const namespaceIdentity of ["https://user:secret@example.com/root", "https://example.com/root?token=secret"]) {
      await expect(registerLegacyInventory(db, { observedAt: NOW, observations: [] }, [{ ...PROFILES[0], namespaceIdentity }]))
        .rejects.toThrow("cannot contain");
    }
    await expect(registerLegacyInventory(db, { observedAt: NOW, observations: [observation("a", {
      records: [{ table: "assets", byte_size: 10, secret: "should-not-export" }],
    })] }, PROFILES)).rejects.toThrow("Invalid legacy evidence");
    const profileWithExtras = { ...PROFILES[0], secret: "should-not-export" };
    const plan = await planLegacyInventory({ observedAt: NOW, observations: [] }, [profileWithExtras]);
    expect(JSON.stringify(plan)).not.toContain("should-not-export");
    expect(counts(sql)).toEqual([0, 0, 0, 0]);
  });

  it("refuses silently truncated live consumer evidence", async () => {
    const { sql, db } = fixture();
    // Reuse compilation while executing every insertion and its current-schema
    // triggers; the boundary still contains one more consumer than the limit.
    const insertImport = importWriter(sql);
    for (let i = 0; i <= MAX_INVENTORY_EVIDENCE_ROWS; i++) insertImport(`import-${i}`, "shared-source");
    await expect(readLegacyInventoryPage(db, { observedAt: NOW })).rejects.toThrow("bounded inventory limit");
    expect(counts(sql)).toEqual([0, 0, 0, 0]);
  });

  it("keeps legacy retention unchanged; registering an unreferenced observation adds no hold", async () => {
    const { sql, db } = fixture();
    asset(sql, "orphan");
    const before = sql.prepare("SELECT * FROM blob_retention_edges").all();
    await registerLegacyInventory(db, await readLegacyInventoryPage(db, { observedAt: NOW }), PROFILES);
    expect(sql.prepare("SELECT * FROM blob_retention_edges").all()).toEqual(before);
    expect(before).toEqual([]);
  });

  it("does not acknowledge an incomplete or explicitly failed atomic batch result", async () => {
    const { sql, db } = fixture();
    for (const result of [[], [{ success: false }]]) {
      const failing = { ...db, batch: async () => result };
      await expect(registerLegacyInventory(failing, { observedAt: NOW, observations: [observation("a")] }, PROFILES))
        .rejects.toThrow("did not acknowledge");
    }
    expect(counts(sql)).toEqual([0, 0, 0, 0]);
  });
});
