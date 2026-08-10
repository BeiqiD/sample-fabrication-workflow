import { describe, expect, it } from "vitest";
import { referenceTestDatabase } from "./reference-test-support";

const ACTOR = "identifier-byte-guard@example.com";
const NOW = "2026-08-10T09:00:00.000Z";

type Database = ReturnType<typeof referenceTestDatabase>;

function insertProject(database: Database, id: string | null, operationId: string) {
  database.prepare(`
    INSERT INTO projects (
      id, title, last_mutation_id,
      created_by, updated_by, created_at, updated_at
    ) VALUES (?, 'Identifier guard', ?, ?, ?, ?, ?)
  `).run(id, operationId, ACTOR, ACTOR, NOW, NOW);
}

function insertContent(database: Database, id: string | null, operationId: string) {
  database.prepare(`
    INSERT INTO project_contents (
      id, project_id, content_type, markdown_source,
      last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, 'project-safe', 'markdown', '# safe', ?, ?, ?, ?, ?)
  `).run(id, operationId, ACTOR, ACTOR, NOW, NOW);
}

function insertItem(
  database: Database,
  id: string | null,
  contentId: string,
  sequence: number,
  operationId: string,
) {
  database.prepare(`
    INSERT INTO project_items (
      id, project_id, item_type, project_content_id, created_sequence,
      last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, 'project-safe', 'content', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, contentId, sequence, operationId, ACTOR, ACTOR, NOW, NOW);
}

function insertPlacement(
  database: Database,
  id: string | null,
  itemId: string,
  operationId: string,
) {
  database.prepare(`
    INSERT INTO project_map_placements (
      id, project_item_id, x, y, width, height, z_index,
      last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, 0, 0, 320, 180, 0, ?, ?, ?, ?, ?)
  `).run(id, itemId, operationId, ACTOR, ACTOR, NOW, NOW);
}

function insertEdge(
  database: Database,
  id: string | null,
  sourceItemId: string,
  targetItemId: string,
  operationId: string,
) {
  database.prepare(`
    INSERT INTO project_edges (
      id, project_id, source_item_id, target_item_id,
      source_handle, target_handle, marker_start, marker_end,
      last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (
      ?, 'project-safe', ?, ?, 'right', 'left', 'none', 'arrow',
      ?, ?, ?, ?, ?
    )
  `).run(id, sourceItemId, targetItemId, operationId, ACTOR, ACTOR, NOW, NOW);
}

describe("Project identifier byte guards", () => {
  it("rejects NULL and embedded-NUL primary route identities", () => {
    const database = referenceTestDatabase();

    expect(() => insertProject(database, null, "create-null-project"))
      .toThrow(/API-safe/);
    expect(() => insertProject(database, "project\u0000/unsafe", "create-nul-project"))
      .toThrow(/API-safe/);
    insertProject(database, "project-safe", "create-project-safe");

    expect(() => insertContent(database, null, "create-null-content"))
      .toThrow(/API-safe/);
    expect(() => insertContent(database, "content\u0000/unsafe", "create-nul-content"))
      .toThrow(/API-safe/);
    insertContent(database, "content-safe", "create-content-safe");

    expect(() => insertItem(
      database,
      null,
      "content-safe",
      1,
      "create-null-item",
    )).toThrow(/API-safe/);
    expect(() => insertItem(
      database,
      "item\u0000/unsafe",
      "content-safe",
      1,
      "create-nul-item",
    )).toThrow(/API-safe/);
    insertItem(database, "item-safe", "content-safe", 1, "create-item-safe");

    expect(() => insertPlacement(
      database,
      null,
      "item-safe",
      "create-null-placement",
    )).toThrow(/API-safe/);
    expect(() => insertPlacement(
      database,
      "placement\u0000/unsafe",
      "item-safe",
      "create-nul-placement",
    )).toThrow(/API-safe/);
    insertPlacement(database, "placement-safe", "item-safe", "create-placement-safe");

    insertContent(database, "content-other", "create-content-other");
    insertItem(database, "item-other", "content-other", 2, "create-item-other");
    insertPlacement(database, "placement-other", "item-other", "create-placement-other");

    expect(() => insertEdge(
      database,
      null,
      "item-safe",
      "item-other",
      "create-null-edge",
    )).toThrow(/API-safe/);
    expect(() => insertEdge(
      database,
      "edge\u0000/unsafe",
      "item-safe",
      "item-other",
      "create-nul-edge",
    )).toThrow(/API-safe/);

    database.close();
  });

  it("rejects embedded-NUL creation, mutation, and deletion operation IDs", () => {
    const database = referenceTestDatabase();

    expect(() => insertProject(
      database,
      "project-nul-operation",
      "create\u0000/operation",
    )).toThrow(/API-safe/);
    insertProject(database, "project-safe", "create-project-safe");
    insertContent(database, "content-safe", "create-content-safe");
    insertItem(database, "item-safe", "content-safe", 1, "create-item-safe");
    insertPlacement(database, "placement-safe", "item-safe", "create-placement-safe");

    expect(() => database.prepare(`
      UPDATE projects
      SET title = 'Changed', revision = 2,
          last_mutation_id = ?, updated_by = ?, updated_at = ?
      WHERE id = 'project-safe'
    `).run("rename\u0000/operation", ACTOR, NOW)).toThrow(/API-safe/);

    expect(() => database.prepare(`
      UPDATE project_contents
      SET deleted_at = ?, deleted_by = ?, deletion_operation_id = ?,
          revision = 2, last_mutation_id = 'delete-content-safe',
          updated_by = ?, updated_at = ?
      WHERE id = 'content-safe'
    `).run(NOW, ACTOR, "delete\u0000/operation", ACTOR, NOW)).toThrow(/API-safe/);

    expect(database.prepare(`
      SELECT title, revision, last_mutation_id FROM projects
      WHERE id = 'project-safe'
    `).get()).toEqual({
      title: "Identifier guard",
      revision: 1,
      last_mutation_id: "create-project-safe",
    });
    expect(database.prepare(`
      SELECT deleted_at, revision FROM project_contents
      WHERE id = 'content-safe'
    `).get()).toEqual({ deleted_at: null, revision: 1 });

    database.close();
  });
});
