import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

describe("blob lifecycle migration safety", () => {
  it("applies thumbnail retention over malformed legacy event metadata", () => {
    const database = new DatabaseSync(":memory:");
    const directory = new URL("../migrations/", import.meta.url);
    const migrations = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
    for (const filename of migrations.filter((name) => name < "0017_blob_lifecycle_review_fixes.sql")) {
      database.exec(readFileSync(new URL(filename, directory), "utf8"));
    }
    database.exec(`
      INSERT INTO samples (id, code, title, created_at, updated_at)
      VALUES ('sample-1', 'S-1', 'Sample', '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z');
      INSERT INTO events
        (id, sample_id, kind, metadata_json, created_at)
      VALUES
        ('event-malformed', 'sample-1', 'comment', '{not-json',
          '2026-07-01T00:00:00.000Z'),
        ('event-valid', 'sample-1', 'comment',
          '{"thumbnailKey":"records/thumbnail.bin"}',
          '2026-07-01T00:00:00.000Z');
      INSERT INTO assets
        (id, r2_key, original_name, mime_type, byte_size, status, sha256,
         created_at)
      VALUES ('asset-thumbnail', 'records/thumbnail.bin', 'thumbnail.bin',
        'application/octet-stream', 4, 'ready', '${"a".repeat(64)}',
        '2026-07-01T00:00:00.000Z');
    `);

    expect(() => database.exec(readFileSync(
      new URL("0017_blob_lifecycle_review_fixes.sql", directory),
      "utf8",
    ))).not.toThrow();
    expect(database.prepare(
      `SELECT occurrence_id, retention_reason
       FROM blob_retention_edges
       WHERE object_key = 'records/thumbnail.bin'`,
    ).get()).toEqual({
      occurrence_id: "event-valid:thumbnail",
      retention_reason: "sample_record_thumbnail",
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM blob_retention_edges WHERE occurrence_id = 'event-malformed:thumbnail'",
    ).get()).toEqual({ count: 0 });
    database.close();
  });
});
