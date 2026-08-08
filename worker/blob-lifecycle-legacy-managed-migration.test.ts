import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const REPAIR_MIGRATION = "0015_managed_orphan_dedupe_repair.sql";

function migrationNames() {
  const directory = new URL("../migrations/", import.meta.url);
  return {
    directory,
    names: readdirSync(directory).filter((name) => name.endsWith(".sql")).sort(),
  };
}

describe("legacy managed-object migration repair", () => {
  it("rewires a referenced orphan to an existing ready duplicate before 0016 promotes reachability", () => {
    const database = new DatabaseSync(":memory:");
    const { directory, names } = migrationNames();

    for (const filename of names.filter((name) => name < REPAIR_MIGRATION)) {
      database.exec(readFileSync(new URL(filename, directory), "utf8"));
    }

    database.exec(`
      INSERT INTO samples (id, code, title, created_at, updated_at)
      VALUES ('sample-1', 'S-1', 'Sample', '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z');

      INSERT INTO managed_storage_objects
        (id, provider, object_key, original_name, mime_type, byte_size, sha256,
         status, created_at, orphaned_at)
      VALUES
        ('managed-orphan', 'switchdrive', 'legacy/orphan.bin', 'orphan.bin',
          'application/octet-stream', 4, '${"a".repeat(64)}', 'orphaned',
          '2026-07-01T00:00:00.000Z', '2026-07-05T00:00:00.000Z'),
        ('managed-winner', 'switchdrive', 'legacy/winner.bin', 'winner.bin',
          'application/octet-stream', 4, '${"a".repeat(64)}', 'ready',
          '2026-07-06T00:00:00.000Z', NULL);

      INSERT INTO comment_submissions
        (id, context_kind, sample_id, body, status, created_at, updated_at)
      VALUES ('submission-1', 'sample', 'sample-1', 'Unfinished', 'uploading',
        '2026-07-01T00:00:00.000Z', '2026-07-06T00:00:00.000Z');

      INSERT INTO comment_submission_items
        (id, submission_id, kind, status, position, filename, mime_type,
         byte_size, storage_object_id, sha256, created_at, updated_at)
      VALUES ('item-1', 'submission-1', 'attachment', 'ready', 0,
        'orphan.bin', 'application/octet-stream', 4, 'managed-orphan',
        '${"a".repeat(64)}', '2026-07-01T00:00:00.000Z',
        '2026-07-06T00:00:00.000Z');
    `);

    database.exec(readFileSync(new URL(REPAIR_MIGRATION, directory), "utf8"));
    expect(database.prepare(
      "SELECT storage_object_id FROM comment_submission_items WHERE id = 'item-1'",
    ).get()).toEqual({ storage_object_id: "managed-winner" });

    expect(() => {
      for (const filename of names.filter((name) => name > REPAIR_MIGRATION)) {
        database.exec(readFileSync(new URL(filename, directory), "utf8"));
      }
    }).not.toThrow();

    expect(database.prepare(
      `SELECT id, status FROM managed_storage_objects
       WHERE id IN ('managed-orphan', 'managed-winner') ORDER BY id`,
    ).all()).toEqual([
      { id: "managed-orphan", status: "orphaned" },
      { id: "managed-winner", status: "ready" },
    ]);
    expect(database.prepare(
      "SELECT state FROM blob_gc_ledger WHERE blob_record_id = 'managed-orphan'",
    ).get()).toEqual({ state: "orphaned" });
    expect(database.prepare(
      `SELECT object_key, retention_reason FROM blob_retention_edges
       WHERE occurrence_id = 'item-1'`,
    ).get()).toEqual({
      object_key: "legacy/winner.bin",
      retention_reason: "unfinished_comment_item",
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM blob_retention_edges WHERE object_key = 'legacy/orphan.bin'",
    ).get()).toEqual({ count: 0 });

    database.close();
  });
});
