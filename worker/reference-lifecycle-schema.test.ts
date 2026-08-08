import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  const migrationDirectory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(filename, migrationDirectory), "utf8"));
  }
  return database;
}

function columns(database: DatabaseSync, table: string) {
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((column) => column.name));
}

describe("reference lifecycle schema", () => {
  it.each([
    "samples",
    "runs",
    "run_steps",
    "comment_submissions",
    "run_step_comments",
    "comment_submission_items",
    "run_step_assets",
    "metrology_template_references",
    "template_versions",
  ])("gives %s a recoverable deletion identity", (table) => {
    const database = migratedDatabase();
    expect([...columns(database, table)]).toEqual(expect.arrayContaining(["deleted_at", "deleted_by"]));
    database.close();
  });

  it("keeps comment occurrence edit metadata separate from its canonical submission", () => {
    const database = migratedDatabase();
    expect([...columns(database, "comment_submissions")]).toEqual(expect.arrayContaining([
      "id", "body", "updated_at", "last_mutation_id",
      "deleted_at", "deleted_by", "deletion_operation_id",
    ]));
    expect([...columns(database, "run_step_comments")]).toEqual(expect.arrayContaining([
      "id", "submission_id", "run_step_id", "updated_at", "updated_by", "deleted_at", "deleted_by",
      "last_mutation_id", "deletion_operation_id",
      "asset_deleted_at", "asset_deleted_by", "asset_deletion_operation_id",
    ]));
    database.close();
  });

  it("gives batch-authoritative sources an internal mutation marker", () => {
    const database = migratedDatabase();
    expect(columns(database, "runs")).toContain("last_mutation_id");
    expect(columns(database, "comment_submissions")).toContain("last_mutation_id");
    expect(columns(database, "run_step_comments")).toContain("last_mutation_id");
    expect(columns(database, "run_step_assets")).toContain("last_mutation_id");
    database.close();
  });

  it("does not put lifecycle fields on content-addressed blob records", () => {
    const database = migratedDatabase();
    expect(columns(database, "assets")).not.toContain("deleted_at");
    expect(columns(database, "managed_storage_objects")).not.toContain("deleted_at");
    database.close();
  });
});
