import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  const migrationDirectory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(filename, migrationDirectory), "utf8"));
  }
  database.exec(`
    INSERT INTO recipe_families (id, name, template_type, created_at)
    VALUES ('family-1', 'Process', 'process', '2026-08-07T10:00:00.000Z');
    INSERT INTO template_versions
      (id, recipe_family_id, name, template_type, version, manifest_hash, content_json,
       created_at, template_kind)
    VALUES
      ('template-1', 'family-1', 'Process', 'process', 1, 'manifest-1', '{}',
       '2026-08-07T10:00:00.000Z', 'process');
    INSERT INTO samples (id, code, title, status, created_at, updated_at)
    VALUES
      ('sample-1', 'S-1', 'Sample', 'stored',
       '2026-08-07T10:00:00.000Z', '2026-08-07T10:00:00.000Z');
  `);
  return database;
}

function insertRun(
  database: DatabaseSync,
  id: string,
  sequence: number,
  deletedAt: string | null,
  predecessorRunId: string | null = null,
  status: "active" | "complete" = "active",
) {
  database.prepare(
    `INSERT INTO runs
      (id, sample_id, recipe_family_id, template_version_id, predecessor_run_id, sequence_no, run_group_id,
       run_kind, template_name_snapshot, template_type_snapshot, template_version_snapshot,
       status, created_at, deleted_at, deleted_by)
     VALUES (?, 'sample-1', 'family-1', 'template-1', ?, ?, ?, 'process',
       'Process', 'process', 1, ?, ?, ?, ?)`,
  ).run(
    id,
    predecessorRunId,
    sequence,
    `group-${sequence}`,
    status,
    `2026-08-07T10:0${sequence}:00.000Z`,
    deletedAt,
    deletedAt ? "operator@example.com" : null,
  );
}

describe("run soft-delete schema", () => {
  it("excludes a deleted active process run from the live uniqueness constraint", () => {
    const database = migratedDatabase();
    insertRun(database, "run-deleted", 1, "2026-08-07T10:02:00.000Z");

    expect(() => insertRun(database, "run-live", 2, null)).not.toThrow();
    expect(database.prepare("SELECT id FROM runs ORDER BY sequence_no").all())
      .toEqual([{ id: "run-deleted" }, { id: "run-live" }]);
    expect(() => database.prepare(
      "UPDATE runs SET deleted_at = NULL, deleted_by = NULL WHERE id = 'run-deleted'",
    ).run()).toThrow();
    database.close();
  });

  it("lets a visible run replace a deleted successor without weakening live successor uniqueness", () => {
    const database = migratedDatabase();
    insertRun(database, "run-root", 1, null, null, "complete");
    insertRun(database, "run-deleted-successor", 2, "2026-08-07T10:03:00.000Z", "run-root", "complete");

    expect(() => insertRun(database, "run-live-successor", 3, null, "run-root", "complete"))
      .not.toThrow();
    expect(() => insertRun(database, "run-second-live-successor", 4, null, "run-root", "complete"))
      .toThrow();
    expect(() => database.prepare(
      "UPDATE runs SET deleted_at = NULL, deleted_by = NULL WHERE id = 'run-deleted-successor'",
    ).run()).toThrow();
    database.close();
  });

  it("does not reactivate a sample or roll up status through a deleted run", () => {
    const database = migratedDatabase();
    insertRun(database, "run-deleted", 1, "2026-08-07T10:02:00.000Z");
    database.exec(`
      INSERT INTO run_steps
        (id, run_id, position, status, origin, entry_kind, created_at, updated_at)
      VALUES
        ('step-deleted', 'run-deleted', 1000, 'pending', 'template', 'fabrication',
         '2026-08-07T10:01:00.000Z', '2026-08-07T10:01:00.000Z');
      UPDATE run_steps
      SET status = 'done', updated_at = '2026-08-07T10:03:00.000Z'
      WHERE id = 'step-deleted';
    `);

    expect(database.prepare("SELECT status FROM samples WHERE id = 'sample-1'").get())
      .toEqual({ status: "stored" });
    expect(database.prepare("SELECT status, completed_at FROM runs WHERE id = 'run-deleted'").get())
      .toEqual({ status: "active", completed_at: null });
    database.close();
  });
});
