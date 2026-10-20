import { describe, expect, it } from "vitest";
import { REFERENCE_TARGET_TYPES } from "../shared/reference-types";
import { referenceTestDatabase, seedReferenceGraph } from "./reference-test-support";

describe("reference target registry schema", () => {
  it("creates a sparse closed v1 registry with valid JSON contexts", () => {
    const database = referenceTestDatabase();
    seedReferenceGraph(database);
    const columns = database.prepare("PRAGMA table_info(reference_targets)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "id",
      "registry_version",
      "target_type",
      "target_id",
      "first_registered_at",
      "last_validated_at",
      "tombstoned_at",
      "last_known_contexts_json",
    ]));
    expect(database.prepare("SELECT COUNT(*) AS count FROM reference_targets").get()).toEqual({ count: 0 });

    const insert = database.prepare(`
      INSERT INTO reference_targets
        (id, target_type, target_id, first_registered_at, last_validated_at, last_known_contexts_json)
      VALUES (?, ?, ?, '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', '[]')
    `);
    REFERENCE_TARGET_TYPES.forEach((type, index) => insert.run(`registry-${index}`, type, `target-${index}`));
    expect(database.prepare("SELECT target_type FROM reference_targets ORDER BY target_type").all())
      .toHaveLength(REFERENCE_TARGET_TYPES.length);

    expect(() => insert.run("registry-unknown", "unknown", "target-unknown"))
      .toThrow(/CHECK constraint failed/);
    expect(() => database.prepare(`
      INSERT INTO reference_targets
        (id, target_type, target_id, first_registered_at, last_validated_at, last_known_contexts_json)
      VALUES ('registry-invalid-json', 'sample', 'invalid-json', '2026-08-08T00:00:00.000Z',
              '2026-08-08T00:00:00.000Z', '{}')
    `).run()).toThrow(/CHECK constraint failed/);
    database.close();
  });

  it("keeps registry identity immutable while allowing validation metadata updates", () => {
    const database = referenceTestDatabase();
    database.prepare(`
      INSERT INTO reference_targets
        (id, target_type, target_id, first_registered_at, last_validated_at)
      VALUES ('registry-immutable', 'sample', 'sample-original',
              '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
    `).run();

    for (const assignment of [
      "id = 'registry-retargeted'",
      "registry_version = 2",
      "target_type = 'run'",
      "target_id = 'sample-retargeted'",
      "first_registered_at = '2026-08-09T00:00:00.000Z'",
    ]) {
      expect(() => database.prepare(
        `UPDATE reference_targets SET ${assignment} WHERE id = 'registry-immutable'`,
      ).run()).toThrow();
    }
    expect(() => database.prepare(`
      UPDATE reference_targets
      SET last_validated_at = '2026-08-08T01:00:00.000Z',
          last_known_contexts_json = '[{"segments":[]}]',
          tombstoned_at = '2026-08-08T02:00:00.000Z'
      WHERE id = 'registry-immutable'
    `).run()).not.toThrow();
    expect(database.prepare(`
      SELECT id, registry_version, target_type, target_id, first_registered_at,
             last_validated_at, last_known_contexts_json, tombstoned_at
      FROM reference_targets WHERE id = 'registry-immutable'
    `).get()).toEqual({
      id: "registry-immutable",
      registry_version: 1,
      target_type: "sample",
      target_id: "sample-original",
      first_registered_at: "2026-08-08T00:00:00.000Z",
      last_validated_at: "2026-08-08T01:00:00.000Z",
      last_known_contexts_json: '[{"segments":[]}]',
      tombstoned_at: "2026-08-08T02:00:00.000Z",
    });
    database.close();
  });

  it("rejects physical deletion of registry rows", () => {
    const database = referenceTestDatabase();
    database.prepare(`
      INSERT INTO reference_targets
        (id, target_type, target_id, first_registered_at, last_validated_at)
      VALUES ('registry-protected', 'sample', 'sample-protected',
              '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
    `).run();
    expect(() => database.prepare("DELETE FROM reference_targets WHERE id = 'registry-protected'").run())
      .toThrow(/reference target physical deletion is disabled/);
    expect(database.prepare("SELECT id FROM reference_targets WHERE id = 'registry-protected'").get())
      .toEqual({ id: "registry-protected" });
    database.close();
  });
});
