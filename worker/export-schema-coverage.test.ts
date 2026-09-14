import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FULL_EXPORT_TABLE_QUERIES } from "./export-catalog";
import { snapshotFullExportV14 } from "./export-v14-snapshot";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";

// These optional tables belong to Wrangler/D1, not application state. SQLite's
// own reserved sqlite_* tables are also excluded. Do not exclude arbitrary
// underscore-prefixed tables: a new application table must enter the export.
const PLATFORM_TABLES = new Set(["d1_migrations", "_cf_KV"]);

// This time-dependent projection is part of the archive contract in addition to
// its source tables. Other views are rebuildable only after an explicit decision
// here; a newly introduced view must not silently disappear from the inventory.
const EXPORTED_VIEWS = new Set([
  "blob_retention_edges",
  "file_consumer_relational_projection",
  "file_consumer_content_projection",
  "file_consumer_direct_projection",
  "file_consumer_projection",
  "file_relational_retention_edges",
  "file_content_retention_edges",
  "file_direct_retention_edges",
  "file_retention_edges",
  "file_location_retention_edges",
  "file_location_availability",
]);
const REBUILDABLE_VIEWS = new Set([
  // This has no clock-dependent rows; restore deterministically rebuilds it
  // from the exported publication and availability relations.
  "file_usable_publications",
  // The aggregate retention snapshot above already includes these branches.
  "blob_retention_edges_attachment_derivatives",
  "blob_retention_edges_comment_items",
  "blob_retention_edges_direct_keys",
  "blob_retention_edges_project_attachments",
  "blob_retention_edges_r2_occurrences",
  // These are publication/recovery queries over exported canonical rows.
  "attachment_derivative_browser_safe_assets",
  "fabublox_import_asset_dependencies",
  "fabublox_import_asset_dependencies_provenance",
  "fabublox_import_asset_dependencies_template",
  "fabublox_recovery_import_asset_edges",
  "fabublox_recovery_public_asset_edges",
  "fabublox_recovery_public_asset_edges_external",
  "fabublox_recovery_public_asset_edges_state",
  "fabublox_recovery_public_asset_edges_template",
]);

function assertExportSchemaCoverage(database: DatabaseSync) {
  const schema = database.prepare(`
    SELECT type, name FROM sqlite_schema
    WHERE type IN ('table', 'view')
    ORDER BY name
  `).all() as Array<{ type: "table" | "view"; name: string }>;
  const tables = schema.filter(({ type, name }) => type === "table"
    && !name.startsWith("sqlite_") && !PLATFORM_TABLES.has(name));
  const views = new Set(schema.filter(({ type }) => type === "view").map(({ name }) => name));
  const classifiedViews = new Set([...EXPORTED_VIEWS, ...REBUILDABLE_VIEWS]);
  const required = new Set([...tables.map(({ name }) => name), ...EXPORTED_VIEWS]);
  const actual = new Set(Object.keys(FULL_EXPORT_TABLE_QUERIES));
  const issues = [
    ...[...required].filter((name) => !actual.has(name))
      .map((name) => `Missing export: ${name}`),
    ...[...actual].filter((name) => !required.has(name))
      .map((name) => `Unexpected export: ${name}`),
    ...[...views].filter((name) => !classifiedViews.has(name))
      .map((name) => `Unclassified view: ${name}`),
    ...[...classifiedViews].filter((name) => !views.has(name))
      .map((name) => `Stale view classification: ${name}`),
  ];
  if (issues.length) throw new Error(issues.join("\n"));
}

describe("complete export schema coverage", () => {
  let database: DatabaseSync;

  beforeEach(() => { database = referenceTestDatabase(); });
  afterEach(() => { database.close(); });

  it("covers every migrated application table and required view with the actual v14 snapshot", async () => {
    // Discover tables from the real migration result, independently of the
    // export catalog. The table count is deliberately not frozen at today's 34.
    assertExportSchemaCoverage(database);
    const snapshot = await snapshotFullExportV14(new SqliteD1Database(database) as unknown as D1Database);
    expect(Object.keys(snapshot.tables).sort()).toEqual(Object.keys(FULL_EXPORT_TABLE_QUERIES).sort());
    expect(snapshot.artifacts.sourceSchema.value.compatibilityColumns.samples).not.toContain("process_revision");
    expect(snapshot.artifacts.sourceSchema.value.compatibilityColumns.run_step_comments).toContain("legacy_body");
    expect(snapshot.artifacts.sourceSchema.value.compatibilityColumns.run_step_comments).not.toContain("body");
  });

  it.each(["audit_future_records", "_audit_future_records"])(
    "rejects an application table omitted from the export: %s",
    (name) => {
      // Fixed test identifiers, never user input.
      database.exec(`CREATE TABLE "${name}" (id TEXT PRIMARY KEY)`);
      expect(() => assertExportSchemaCoverage(database))
        .toThrow(`Missing export: ${name}`);
    },
  );

  it("requires an explicit export or rebuild decision for a new view", () => {
    database.exec("CREATE VIEW audit_future_projection AS SELECT id FROM samples");
    expect(() => assertExportSchemaCoverage(database))
      .toThrow("Unclassified view: audit_future_projection");
  });

  it("ignores only the optional platform tables and SQLite-owned metadata", () => {
    database.exec(`
      CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
      CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB);
    `);
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'sqlite_sequence'").get())
      .toBeDefined();
    assertExportSchemaCoverage(database);
  });
});
