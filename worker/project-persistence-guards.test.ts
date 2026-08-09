import { describe, expect, it } from "vitest";
import { MAX_PROJECT_SAFE_INTEGER } from "../shared/project-types";
import {
  createProject,
  deleteProject,
  removeProjectItem,
  restoreProjectItem,
} from "./projects/service";
import {
  referenceTestDatabase,
  SqliteD1Database,
} from "./reference-test-support";

const ACTOR = "guard-user@example.com";
const NOW = "2026-08-09T23:00:00.000Z";

function fixture() {
  const database = referenceTestDatabase();
  const adapter = new SqliteD1Database(database);
  return { database, db: adapter as unknown as D1Database };
}

async function seedProject(db: D1Database, id = "project-guard") {
  await createProject(db, {
    id,
    title: "Guard Project",
    operationId: `create-${id}`,
  }, ACTOR, NOW);
}

function insertOwnedItem(
  database: ReturnType<typeof referenceTestDatabase>,
  suffix: string,
  sequence: number,
  revision = 1,
) {
  database.prepare(`
    INSERT INTO project_contents (
      id, project_id, content_type, markdown_source, format_version,
      revision, last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, 'project-guard', 'markdown', ?, 1, ?, ?, ?, ?, ?, ?)
  `).run(
    `content-${suffix}`,
    `# ${suffix}`,
    revision,
    `create-content-${suffix}`,
    ACTOR,
    ACTOR,
    NOW,
    NOW,
  );
  database.prepare(`
    INSERT INTO project_items (
      id, project_id, item_type, project_content_id, created_sequence,
      revision, last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, 'project-guard', 'content', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `item-${suffix}`,
    `content-${suffix}`,
    sequence,
    revision,
    `create-item-${suffix}`,
    ACTOR,
    ACTOR,
    NOW,
    NOW,
  );
  database.prepare(`
    INSERT INTO project_map_placements (
      id, project_item_id, x, y, width, height, z_index,
      revision, last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, 0, 0, 320, 180, 0, 1, ?, ?, ?, ?, ?)
  `).run(
    `placement-${suffix}`,
    `item-${suffix}`,
    `create-placement-${suffix}`,
    ACTOR,
    ACTOR,
    NOW,
    NOW,
  );
}

describe("Project persistence database guards", () => {
  it("rejects child-row updates after the parent Project is deleted", async () => {
    const { database, db } = fixture();
    await seedProject(db);
    insertOwnedItem(database, "a", 1);

    await deleteProject(db, "project-guard", {
      expectedRevision: 1,
      operationId: "delete-project-guard",
    }, ACTOR, "2026-08-09T23:01:00.000Z");

    expect(() => database.prepare(`
      UPDATE project_contents
      SET markdown_source = '# changed', revision = 2,
          last_mutation_id = 'edit-after-project-delete',
          updated_by = ?, updated_at = ?
      WHERE id = 'content-a'
    `).run(ACTOR, NOW)).toThrow(/active project/);
    expect(() => database.prepare(`
      UPDATE project_items
      SET deleted_at = ?, deleted_by = ?, deletion_operation_id = 'remove-after-project-delete',
          revision = 2, last_mutation_id = 'remove-after-project-delete',
          updated_by = ?, updated_at = ?
      WHERE id = 'item-a'
    `).run(NOW, ACTOR, ACTOR, NOW)).toThrow(/active project/);

    expect(database.prepare(`
      SELECT markdown_source, revision FROM project_contents WHERE id = 'content-a'
    `).get()).toEqual({ markdown_source: "# a", revision: 1 });
    expect(database.prepare(`
      SELECT deleted_at, revision FROM project_items WHERE id = 'item-a'
    `).get()).toEqual({ deleted_at: null, revision: 1 });
    database.close();
  });

  it("rolls back edge, content, and item deletion when an endpoint is revision-exhausted", async () => {
    const { database, db } = fixture();
    await seedProject(db);
    insertOwnedItem(database, "exhausted", 1, MAX_PROJECT_SAFE_INTEGER);
    insertOwnedItem(database, "other", 2);
    database.prepare(`
      INSERT INTO project_edges (
        id, project_id, source_item_id, target_item_id,
        source_handle, target_handle, marker_start, marker_end, label,
        revision, last_mutation_id, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'edge-exhausted', 'project-guard', 'item-exhausted', 'item-other',
        'right', 'left', 'none', 'arrow', 'supports',
        1, 'create-edge-exhausted', ?, ?, ?, ?
      )
    `).run(ACTOR, ACTOR, NOW, NOW);

    await expect(removeProjectItem(db, "project-guard", "item-exhausted", {
      expectedItemRevision: MAX_PROJECT_SAFE_INTEGER,
      expectedContentRevision: MAX_PROJECT_SAFE_INTEGER,
      operationId: "remove-exhausted",
    }, ACTOR, "2026-08-09T23:02:00.000Z")).rejects.toBeDefined();

    expect(database.prepare(`
      SELECT deleted_at, revision FROM project_edges WHERE id = 'edge-exhausted'
    `).get()).toEqual({ deleted_at: null, revision: 1 });
    expect(database.prepare(`
      SELECT deleted_at, revision FROM project_contents WHERE id = 'content-exhausted'
    `).get()).toEqual({ deleted_at: null, revision: MAX_PROJECT_SAFE_INTEGER });
    expect(database.prepare(`
      SELECT deleted_at, revision FROM project_items WHERE id = 'item-exhausted'
    `).get()).toEqual({ deleted_at: null, revision: MAX_PROJECT_SAFE_INTEGER });
    database.close();
  });

  it("does not restore a reference occurrence after its registry target is tombstoned", async () => {
    const { database, db } = fixture();
    await seedProject(db);
    database.prepare(`
      INSERT INTO reference_targets (
        id, registry_version, target_type, target_id,
        first_registered_at, last_validated_at, last_known_contexts_json
      ) VALUES (
        'target-guard', 1, 'sample', 'sample-guard', ?, ?, '[]'
      )
    `).run(NOW, NOW);
    database.prepare(`
      INSERT INTO project_items (
        id, project_id, item_type, reference_target_id, created_sequence,
        revision, last_mutation_id, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'item-reference', 'project-guard', 'reference', 'target-guard', 1,
        1, 'create-reference', ?, ?, ?, ?
      )
    `).run(ACTOR, ACTOR, NOW, NOW);
    database.prepare(`
      INSERT INTO project_map_placements (
        id, project_item_id, x, y, width, height, z_index,
        revision, last_mutation_id, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'placement-reference', 'item-reference', 0, 0, 320, 180, 0,
        1, 'create-reference', ?, ?, ?, ?
      )
    `).run(ACTOR, ACTOR, NOW, NOW);

    const removed = await removeProjectItem(db, "project-guard", "item-reference", {
      expectedItemRevision: 1,
      operationId: "remove-reference",
    }, ACTOR, "2026-08-09T23:03:00.000Z");
    expect(removed.item.deletedAt).not.toBeNull();

    database.prepare(`
      UPDATE reference_targets
      SET tombstoned_at = ?, tombstone_reason = 'source permanently deleted'
      WHERE id = 'target-guard'
    `).run("2026-08-09T23:04:00.000Z");

    await expect(restoreProjectItem(db, "project-guard", "item-reference", {
      expectedItemRevision: 2,
      operationId: "restore-reference",
    }, ACTOR, "2026-08-09T23:05:00.000Z")).rejects.toBeDefined();
    expect(database.prepare(`
      SELECT deleted_at, revision FROM project_items WHERE id = 'item-reference'
    `).get()).toMatchObject({ revision: 2 });
    expect(database.prepare(`
      SELECT deleted_at FROM project_items WHERE id = 'item-reference'
    `).get()).not.toEqual({ deleted_at: null });
    database.close();
  });
});
