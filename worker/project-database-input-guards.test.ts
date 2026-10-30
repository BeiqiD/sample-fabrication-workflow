import { describe, expect, it } from "vitest";
import { MAX_PROJECT_MARKDOWN_LENGTH } from "../shared/project-api";
import {
  referenceTestDatabase,
} from "./reference-test-support";

const ACTOR = "database-guard@example.com";
const NOW = "2026-08-10T08:00:00.000Z";

type Database = ReturnType<typeof referenceTestDatabase>;

function insertProject(
  database: Database,
  id = "project-safe",
  operationId = "create-project-safe",
) {
  database.prepare(`
    INSERT INTO projects (
      id, title, last_mutation_id,
      created_by, updated_by, created_at, updated_at
    ) VALUES (?, 'Safe Project', ?, ?, ?, ?, ?)
  `).run(id, operationId, ACTOR, ACTOR, NOW, NOW);
}

function insertMarkdownContent(
  database: Database,
  id: string,
  operationId: string,
  source = "# safe",
) {
  database.prepare(`
    INSERT INTO project_contents (
      id, project_id, content_type, markdown_source,
      last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, 'project-safe', 'markdown', ?, ?, ?, ?, ?, ?)
  `).run(id, source, operationId, ACTOR, ACTOR, NOW, NOW);
}

function insertContentItem(
  database: Database,
  id: string,
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
  id: string,
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
  id: string,
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

function seedGraph(database: Database) {
  insertProject(database);
  insertMarkdownContent(database, "content-a", "create-content-a");
  insertContentItem(database, "item-a", "content-a", 1, "create-item-a");
  insertPlacement(database, "placement-a", "item-a", "create-placement-a");
  insertMarkdownContent(database, "content-b", "create-content-b");
  insertContentItem(database, "item-b", "content-b", 2, "create-item-b");
  insertPlacement(database, "placement-b", "item-b", "create-placement-b");
  insertEdge(database, "edge-a-b", "item-a", "item-b", "create-edge-a-b");
}

describe("Project database input guards", () => {
  it("rejects unsafe Project row identities and creation operation IDs", () => {
    const database = referenceTestDatabase();

    expect(() => insertProject(database, "..", "create-project-unsafe"))
      .toThrow(/API-safe/);
    expect(() => insertProject(database, "project-unsafe-op", "..\/operation"))
      .toThrow(/API-safe/);
    insertProject(database);

    expect(() => insertMarkdownContent(
      database,
      "content/unsafe",
      "create-content-unsafe",
    )).toThrow(/API-safe/);
    expect(() => insertMarkdownContent(
      database,
      "content-unsafe-op",
      "../operation",
    )).toThrow(/API-safe/);
    insertMarkdownContent(database, "content-safe", "create-content-safe");

    expect(() => insertContentItem(
      database,
      "item/unsafe",
      "content-safe",
      1,
      "create-item-unsafe",
    )).toThrow(/API-safe/);
    expect(() => insertContentItem(
      database,
      "item-unsafe-op",
      "content-safe",
      1,
      "../operation",
    )).toThrow(/API-safe/);
    insertContentItem(database, "item-safe", "content-safe", 1, "create-item-safe");

    expect(() => insertPlacement(
      database,
      "placement/unsafe",
      "item-safe",
      "create-placement-unsafe",
    )).toThrow(/API-safe/);
    expect(() => insertPlacement(
      database,
      "placement-unsafe-op",
      "item-safe",
      "../operation",
    )).toThrow(/API-safe/);
    insertPlacement(database, "placement-safe", "item-safe", "create-placement-safe");

    insertMarkdownContent(database, "content-other", "create-content-other");
    insertContentItem(database, "item-other", "content-other", 2, "create-item-other");
    insertPlacement(database, "placement-other", "item-other", "create-placement-other");
    expect(() => insertEdge(
      database,
      "edge/unsafe",
      "item-safe",
      "item-other",
      "create-edge-unsafe",
    )).toThrow(/API-safe/);
    expect(() => insertEdge(
      database,
      "edge-unsafe-op",
      "item-safe",
      "item-other",
      "../operation",
    )).toThrow(/API-safe/);

    database.prepare(`
      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size,
        status, actor_email, created_at, sha256
      ) VALUES (
        'asset-safe', 'projects/asset-safe.bin', 'asset-safe.bin',
        'application/octet-stream', 4, 'ready', ?, ?, ?
      )
    `).run(ACTOR, NOW, "a".repeat(64));
    database.prepare(`
      INSERT INTO project_contents (
        id, project_id, content_type, attachment_caption,
        last_mutation_id, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'content-attachment', 'project-safe', 'attachment', NULL,
        'create-content-attachment', ?, ?, ?, ?
      )
    `).run(ACTOR, ACTOR, NOW, NOW);
    expect(() => database.prepare(`
      INSERT INTO project_content_attachments (
        project_content_id, asset_id, original_name, mime_type, byte_size,
        created_by, created_at, creation_operation_id
      ) VALUES (
        'content-attachment', 'asset-safe', 'asset-safe.bin',
        'application/octet-stream', 4, ?, ?, '../operation'
      )
    `).run(ACTOR, NOW)).toThrow(/API-safe/);

    database.close();
  });

  it("rejects unsafe mutation and lifecycle operation IDs on direct updates", () => {
    const database = referenceTestDatabase();
    seedGraph(database);

    expect(() => database.prepare(`
      UPDATE projects
      SET title = 'Changed', revision = 2,
          last_mutation_id = '../rename', updated_by = ?, updated_at = ?
      WHERE id = 'project-safe'
    `).run(ACTOR, NOW)).toThrow(/API-safe/);
    expect(() => database.prepare(`
      UPDATE projects
      SET deleted_at = ?, deleted_by = ?, deletion_operation_id = '../delete',
          revision = 2, last_mutation_id = 'delete-project-safe',
          updated_by = ?, updated_at = ?
      WHERE id = 'project-safe'
    `).run(NOW, ACTOR, ACTOR, NOW)).toThrow(/API-safe/);

    expect(() => database.prepare(`
      UPDATE project_contents
      SET markdown_source = '# changed', revision = 2,
          last_mutation_id = '../edit', updated_by = ?, updated_at = ?
      WHERE id = 'content-a'
    `).run(ACTOR, NOW)).toThrow(/API-safe/);
    expect(() => database.prepare(`
      UPDATE project_contents
      SET deleted_at = ?, deleted_by = ?, deletion_operation_id = '../delete',
          revision = 2, last_mutation_id = 'delete-content-a',
          updated_by = ?, updated_at = ?
      WHERE id = 'content-a'
    `).run(NOW, ACTOR, ACTOR, NOW)).toThrow(/API-safe/);

    expect(() => database.prepare(`
      UPDATE project_map_placements
      SET x = 10, revision = 2,
          last_mutation_id = '../move', updated_by = ?, updated_at = ?
      WHERE id = 'placement-a'
    `).run(ACTOR, NOW)).toThrow(/API-safe/);

    database.prepare(`
      INSERT INTO reference_targets (
        id, registry_version, target_type, target_id,
        first_registered_at, last_validated_at, last_known_contexts_json
      ) VALUES (
        'target-safe', 1, 'sample', 'sample-safe', ?, ?, '[]'
      )
    `).run(NOW, NOW);
    database.prepare(`
      INSERT INTO project_items (
        id, project_id, item_type, reference_target_id, created_sequence,
        last_mutation_id, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'item-reference-safe', 'project-safe', 'reference', 'target-safe', 3,
        'create-item-reference-safe', ?, ?, ?, ?
      )
    `).run(ACTOR, ACTOR, NOW, NOW);
    insertPlacement(
      database,
      "placement-reference-safe",
      "item-reference-safe",
      "create-placement-reference-safe",
    );
    expect(() => database.prepare(`
      UPDATE project_items
      SET deleted_at = ?, deleted_by = ?, deletion_operation_id = '../delete',
          revision = 2, last_mutation_id = 'delete-item-reference-safe',
          updated_by = ?, updated_at = ?
      WHERE id = 'item-reference-safe'
    `).run(NOW, ACTOR, ACTOR, NOW)).toThrow(/API-safe/);

    expect(() => database.prepare(`
      UPDATE project_edges
      SET label = 'changed', revision = 2,
          last_mutation_id = '../edit', updated_by = ?, updated_at = ?
      WHERE id = 'edge-a-b'
    `).run(ACTOR, NOW)).toThrow(/API-safe/);
    expect(() => database.prepare(`
      UPDATE project_edges
      SET deleted_at = ?, deleted_by = ?, deletion_operation_id = '../delete',
          revision = 2, last_mutation_id = 'delete-edge-a-b',
          updated_by = ?, updated_at = ?
      WHERE id = 'edge-a-b'
    `).run(NOW, ACTOR, ACTOR, NOW)).toThrow(/API-safe/);

    database.close();
  });

  it("rejects oversized Markdown and non-http attachment source URLs in SQL", () => {
    const database = referenceTestDatabase();
    insertProject(database);
    const oversized = "x".repeat(MAX_PROJECT_MARKDOWN_LENGTH + 1);

    expect(() => insertMarkdownContent(
      database,
      "content-oversized",
      "create-content-oversized",
      oversized,
    )).toThrow(/maximum length/);

    insertMarkdownContent(database, "content-markdown", "create-content-markdown");
    expect(() => database.prepare(`
      UPDATE project_contents
      SET markdown_source = ?, revision = 2,
          last_mutation_id = 'expand-content-markdown',
          updated_by = ?, updated_at = ?
      WHERE id = 'content-markdown'
    `).run(oversized, ACTOR, NOW)).toThrow(/maximum length/);

    expect(() => database.prepare(`
      INSERT INTO project_contents (
        id, project_id, content_type, attachment_source_url,
        last_mutation_id, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'content-bad-url', 'project-safe', 'attachment', 'javascript:alert(1)',
        'create-content-bad-url', ?, ?, ?, ?
      )
    `).run(ACTOR, ACTOR, NOW, NOW)).toThrow(/http or https/);

    database.prepare(`
      INSERT INTO project_contents (
        id, project_id, content_type, attachment_source_url,
        last_mutation_id, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'content-good-url', 'project-safe', 'attachment', 'HTTPS://example.test/source',
        'create-content-good-url', ?, ?, ?, ?
      )
    `).run(ACTOR, ACTOR, NOW, NOW);
    expect(() => database.prepare(`
      UPDATE project_contents
      SET attachment_source_url = 'javascript:alert(1)', revision = 2,
          last_mutation_id = 'update-content-bad-url',
          updated_by = ?, updated_at = ?
      WHERE id = 'content-good-url'
    `).run(ACTOR, NOW)).toThrow(/http or https/);
    expect(database.prepare(`
      SELECT attachment_source_url FROM project_contents
      WHERE id = 'content-good-url'
    `).get()).toEqual({ attachment_source_url: "HTTPS://example.test/source" });

    database.close();
  });
});
