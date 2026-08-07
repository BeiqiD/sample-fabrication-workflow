import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationDirectory = new URL("../migrations/", import.meta.url);
const migrationNames = readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort();

function apply(database: DatabaseSync, names: string[]) {
  for (const filename of names) {
    database.exec(readFileSync(new URL(filename, migrationDirectory), "utf8"));
  }
}

describe("built-in metrology template retirement", () => {
  it("leaves a newly migrated database with no visible preset templates", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, migrationNames);

    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM template_versions
       WHERE id LIKE 'builtin-metrology-template-%' AND archived_at IS NULL`,
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM recipe_families
       WHERE id LIKE 'builtin-metrology-family-%' AND archived_at IS NULL`,
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM template_versions WHERE id LIKE 'builtin-metrology-template-%'",
    ).get()).toEqual({ count: 5 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM recipe_families WHERE id LIKE 'builtin-metrology-family-%'",
    ).get()).toEqual({ count: 5 });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM step_definitions
       WHERE hash IN (
         'b340e57f0b53f1d1f657f99ef1bd25c8b9b54dd442a1d50ae7ea7a936af409b5',
         'f139b09ba3ea4362d62a582621083ab0f3cb2d7abdf7524867ec59deab52014f',
         '9025873f845664d95a057cf912841db6ef58e9c56045422151cdf4bfe1aed953',
         '5f9d9a7b109c964d38b31409327aa4679e66770f6ea806db913e506b80c3c23c',
         'd17dc56cbd17d7edbd2290926580871834b226e6823c52bfe18af125dddecdae'
       )`,
    ).get()).toEqual({ count: 5 });
    database.close();
  });

  it("preserves embedded steps and reference files while freeing the preset title", () => {
    const database = new DatabaseSync(":memory:");
    const cleanupIndex = migrationNames.indexOf("0013_remove_builtin_metrology_templates.sql");
    apply(database, migrationNames.slice(0, cleanupIndex));
    database.exec(`
      INSERT INTO recipe_families (id, name, template_type, created_at)
      VALUES ('process-family', 'Process family', 'process', '2026-08-07T10:00:00.000Z');
      INSERT INTO template_versions
        (id, recipe_family_id, name, template_type, version, manifest_hash,
         content_json, created_at, template_kind)
      VALUES
        ('process-template', 'process-family', 'Process template', 'process', 1,
         'process-manifest', '{}', '2026-08-07T10:00:00.000Z', 'process');
      INSERT INTO samples (id, code, title, status, created_at, updated_at)
      VALUES ('sample-1', 'S-1', 'Sample', 'stored',
        '2026-08-07T10:00:00.000Z', '2026-08-07T10:00:00.000Z');
      INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, sequence_no, run_group_id,
         run_kind, template_name_snapshot, template_type_snapshot, template_version_snapshot,
         status, created_at)
      VALUES
        ('run-1', 'sample-1', 'process-family',
         'process-template', 1, 'group-1', 'process',
         'Process template', 'process', 1, 'complete', '2026-08-07T10:05:00.000Z');
      INSERT INTO run_steps
        (id, run_id, template_step_id, position, status, origin, entry_kind,
         title, created_at, updated_at)
      VALUES
        ('embedded-sem', 'run-1', 'builtin-metrology-step-sem', 1000, 'done',
         'ad_hoc', 'metrology', 'SEM',
         '2026-08-07T10:06:00.000Z', '2026-08-07T10:06:00.000Z');
      INSERT INTO assets
        (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES
        ('reference-asset', 'reference-key', 'sem-notes.pdf', 'application/pdf',
         12, 'ready', 'reference-hash', '2026-08-07T10:07:00.000Z');
      INSERT INTO metrology_template_references
        (id, template_version_id, asset_id, display_name, created_at)
      VALUES
        ('sem-reference', 'builtin-metrology-template-sem', 'reference-asset',
         'sem-notes.pdf', '2026-08-07T10:07:00.000Z');
    `);

    apply(database, migrationNames.slice(cleanupIndex));

    expect(database.prepare(
      `SELECT name, archived_at, archived_by
       FROM template_versions WHERE id = 'builtin-metrology-template-sem'`,
    ).get()).toEqual({
      name: "Retired built-in · SEM · builtin-metrology-template-sem",
      archived_at: "2026-08-07T00:00:00.000Z",
      archived_by: "system:retire-builtin-metrology",
    });
    expect(database.prepare(
      `SELECT name, archived_at, archived_by
       FROM recipe_families WHERE id = 'builtin-metrology-family-sem'`,
    ).get()).toEqual({
      name: "Retired built-in · SEM · builtin-metrology-family-sem",
      archived_at: "2026-08-07T00:00:00.000Z",
      archived_by: "system:retire-builtin-metrology",
    });
    expect(database.prepare(
      "SELECT template_step_id FROM run_steps WHERE id = 'embedded-sem'",
    ).get()).toEqual({ template_step_id: "builtin-metrology-step-sem" });
    expect(database.prepare(
      `SELECT template_version_id, asset_id
       FROM metrology_template_references WHERE id = 'sem-reference'`,
    ).get()).toEqual({
      template_version_id: "builtin-metrology-template-sem",
      asset_id: "reference-asset",
    });
    expect(() => database.exec(`
      INSERT INTO recipe_families (id, name, template_type, created_at)
      VALUES ('user-sem-family', 'Metrology template · user-sem-family', 'module',
        '2026-08-07T11:00:00.000Z');
      INSERT INTO template_versions
        (id, recipe_family_id, name, template_type, version, manifest_hash,
         content_json, created_at, template_kind)
      VALUES
        ('user-sem-template', 'user-sem-family', 'SEM', 'module', 1,
         'user-sem-manifest', '{}', '2026-08-07T11:00:00.000Z', 'metrology');
    `)).not.toThrow();
    database.close();
  });
});
