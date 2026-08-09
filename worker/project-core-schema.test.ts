import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  MAX_PROJECT_MAP_COORDINATE_ABS,
  MAX_PROJECT_MAP_NODE_SIZE,
  MAX_PROJECT_MAP_Z_INDEX_ABS,
  type ProjectMapGeometry,
} from "../shared/project-types";
import { referenceTestDatabase } from "./reference-test-support";

const NOW = "2026-08-09T12:00:00.000Z";
const ACTOR = "researcher@example.com";

function columns(database: DatabaseSync, table: string) {
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((column) => column.name));
}

function seedProject(database: DatabaseSync, id: string, operationId = `create-${id}`) {
  database.prepare(`
    INSERT INTO projects (
      id, title, last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, `Project ${id}`, operationId, ACTOR, ACTOR, NOW, NOW);
}

function seedContent(
  database: DatabaseSync,
  input: { id: string; projectId: string; type?: "markdown" | "attachment"; source?: string | null },
) {
  const type = input.type ?? "markdown";
  database.prepare(`
    INSERT INTO project_contents (
      id, project_id, content_type, markdown_source, last_mutation_id,
      created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.projectId,
    type,
    type === "markdown" ? input.source ?? `# ${input.id}` : null,
    `create-${input.id}`,
    ACTOR,
    ACTOR,
    NOW,
    NOW,
  );
}

function seedReferenceTarget(database: DatabaseSync, id: string, tombstonedAt: string | null = null) {
  database.prepare(`
    INSERT INTO reference_targets (
      id, target_type, target_id, first_registered_at, last_validated_at, tombstoned_at
    ) VALUES (?, 'sample', ?, ?, ?, ?)
  `).run(id, `sample-${id}`, NOW, NOW, tombstonedAt);
}

function seedItem(database: DatabaseSync, input: {
  id: string;
  projectId: string;
  sequence: number;
  contentId?: string;
  referenceTargetId?: string;
}) {
  database.prepare(`
    INSERT INTO project_items (
      id, project_id, item_type, project_content_id, reference_target_id,
      created_sequence, last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.projectId,
    input.contentId ? "content" : "reference",
    input.contentId ?? null,
    input.referenceTargetId ?? null,
    input.sequence,
    `create-${input.id}`,
    ACTOR,
    ACTOR,
    NOW,
    NOW,
  );
}

function seedPlacement(
  database: DatabaseSync,
  id: string,
  itemId: string,
  geometry: Partial<ProjectMapGeometry> = {},
) {
  const {
    x = 0,
    y = 0,
    width = 320,
    height = 180,
    zIndex = 0,
  } = geometry;
  database.prepare(`
    INSERT INTO project_map_placements (
      id, project_item_id, x, y, width, height, z_index,
      last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    itemId,
    x,
    y,
    width,
    height,
    zIndex,
    `create-${id}`,
    ACTOR,
    ACTOR,
    NOW,
    NOW,
  );
}

function seedEdge(database: DatabaseSync, input: {
  id: string;
  projectId: string;
  sourceItemId: string;
  targetItemId: string;
  label?: string | null;
}) {
  database.prepare(`
    INSERT INTO project_edges (
      id, project_id, source_item_id, target_item_id,
      source_handle, target_handle, marker_start, marker_end, label,
      last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'right', 'left', 'none', 'arrow', ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.projectId,
    input.sourceItemId,
    input.targetItemId,
    input.label ?? null,
    `create-${input.id}`,
    ACTOR,
    ACTOR,
    NOW,
    NOW,
  );
}

describe("Project core schema", () => {
  it("installs the six normalized Project tables and revision metadata", () => {
    const database = referenceTestDatabase();
    const tables = new Set((database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'project%'
    `).all() as { name: string }[]).map((row) => row.name));

    expect(tables).toEqual(new Set([
      "projects",
      "project_contents",
      "project_content_attachments",
      "project_items",
      "project_map_placements",
      "project_edges",
    ]));
    expect([...columns(database, "projects")]).toEqual(expect.arrayContaining([
      "revision", "next_created_sequence", "last_mutation_id",
      "deleted_at", "deleted_by", "deletion_operation_id",
    ]));
    expect([...columns(database, "project_contents")]).toEqual(expect.arrayContaining([
      "markdown_source", "attachment_caption", "attachment_source_url", "revision",
    ]));
    expect([...columns(database, "project_items")]).toEqual(expect.arrayContaining([
      "project_content_id", "reference_target_id", "created_sequence", "revision",
    ]));
    expect([...columns(database, "project_map_placements")]).toEqual(expect.arrayContaining([
      "x", "y", "width", "height", "z_index", "revision",
    ]));
    database.close();
  });

  it("keeps Reading order occurrence-based and permits repeated references only", () => {
    const database = referenceTestDatabase();
    seedProject(database, "project-a");
    seedProject(database, "project-b");
    seedContent(database, { id: "content-a", projectId: "project-a" });
    seedContent(database, { id: "content-b", projectId: "project-b" });
    seedReferenceTarget(database, "target-a");
    seedReferenceTarget(database, "target-gone", NOW);

    seedItem(database, {
      id: "content-item",
      projectId: "project-a",
      sequence: 1,
      contentId: "content-a",
    });
    seedItem(database, {
      id: "reference-item-1",
      projectId: "project-a",
      sequence: 2,
      referenceTargetId: "target-a",
    });
    seedItem(database, {
      id: "reference-item-2",
      projectId: "project-a",
      sequence: 3,
      referenceTargetId: "target-a",
    });

    expect(database.prepare(`
      SELECT id FROM project_items
      WHERE project_id = 'project-a' AND deleted_at IS NULL
      ORDER BY created_sequence
    `).all()).toEqual([
      { id: "content-item" },
      { id: "reference-item-1" },
      { id: "reference-item-2" },
    ]);
    expect(() => seedItem(database, {
      id: "duplicate-content",
      projectId: "project-a",
      sequence: 4,
      contentId: "content-a",
    })).toThrow();
    expect(() => seedItem(database, {
      id: "wrong-project-content",
      projectId: "project-a",
      sequence: 4,
      contentId: "content-b",
    })).toThrow(/another project|unavailable/);
    expect(() => seedItem(database, {
      id: "duplicate-sequence",
      projectId: "project-a",
      sequence: 3,
      referenceTargetId: "target-a",
    })).toThrow();
    expect(() => seedItem(database, {
      id: "tombstoned-target",
      projectId: "project-a",
      sequence: 4,
      referenceTargetId: "target-gone",
    })).toThrow(/reference target is unavailable/);
    database.close();
  });

  it("requires every semantic update to advance one revision with a fresh operation id", () => {
    const database = referenceTestDatabase();
    seedProject(database, "project-a");
    seedContent(database, { id: "content-a", projectId: "project-a", source: "first" });
    seedItem(database, {
      id: "item-a",
      projectId: "project-a",
      sequence: 1,
      contentId: "content-a",
    });
    seedPlacement(database, "placement-a", "item-a");

    expect(() => database.prepare(`
      UPDATE projects SET title = 'Changed' WHERE id = 'project-a'
    `).run()).toThrow(/next revision/);
    database.prepare(`
      UPDATE projects
      SET title = 'Changed', revision = 2, last_mutation_id = 'rename-2', updated_at = ?
      WHERE id = 'project-a'
    `).run(NOW);
    expect(() => database.prepare(`
      UPDATE projects
      SET title = 'Changed again', revision = 3, last_mutation_id = 'rename-2', updated_at = ?
      WHERE id = 'project-a'
    `).run(NOW)).toThrow(/fresh mutation id/);

    expect(() => database.prepare(`
      UPDATE project_contents SET markdown_source = 'second' WHERE id = 'content-a'
    `).run()).toThrow(/next revision/);
    database.prepare(`
      UPDATE project_contents
      SET markdown_source = 'second', revision = 2,
          last_mutation_id = 'edit-2', updated_at = ?
      WHERE id = 'content-a'
    `).run(NOW);

    expect(() => database.prepare(`
      UPDATE project_map_placements SET x = 40 WHERE id = 'placement-a'
    `).run()).toThrow(/next revision/);
    database.prepare(`
      UPDATE project_map_placements
      SET x = 40, revision = 2, last_mutation_id = 'move-2', updated_at = ?
      WHERE id = 'placement-a'
    `).run(NOW);

    expect(() => database.prepare(`
      UPDATE project_items SET created_sequence = 99 WHERE id = 'item-a'
    `).run()).toThrow(/identity is immutable/);
    expect(database.prepare(`
      SELECT title, revision FROM projects WHERE id = 'project-a'
    `).get()).toEqual({ title: "Changed", revision: 2 });
    database.close();
  });

  it("rejects revision rewind, pre-bump, and duplicate-version reuse on every revisioned table", () => {
    const database = referenceTestDatabase();
    seedProject(database, "project-a");
    seedContent(database, { id: "content-a", projectId: "project-a", source: "first" });
    seedReferenceTarget(database, "target-a");
    seedItem(database, {
      id: "item-a", projectId: "project-a", sequence: 1, contentId: "content-a",
    });
    seedItem(database, {
      id: "item-b", projectId: "project-a", sequence: 2, referenceTargetId: "target-a",
    });
    seedItem(database, {
      id: "item-lifecycle", projectId: "project-a", sequence: 3, referenceTargetId: "target-a",
    });
    seedPlacement(database, "placement-a", "item-a");
    seedEdge(database, {
      id: "edge-a",
      projectId: "project-a",
      sourceItemId: "item-a",
      targetItemId: "item-b",
      label: "first",
    });

    database.prepare(`
      UPDATE projects
      SET title = 'Project two', revision = 2,
          last_mutation_id = 'project-2', updated_at = ?
      WHERE id = 'project-a'
    `).run(NOW);
    database.prepare(`
      UPDATE project_contents
      SET markdown_source = 'second', revision = 2,
          last_mutation_id = 'content-2', updated_at = ?
      WHERE id = 'content-a'
    `).run(NOW);
    database.prepare(`
      UPDATE project_items
      SET deleted_at = ?, deleted_by = ?, deletion_operation_id = 'delete-item',
          revision = 2, last_mutation_id = 'item-2', updated_at = ?
      WHERE id = 'item-lifecycle'
    `).run(NOW, ACTOR, NOW);
    database.prepare(`
      UPDATE project_map_placements
      SET x = 10, revision = 2,
          last_mutation_id = 'placement-2', updated_at = ?
      WHERE id = 'placement-a'
    `).run(NOW);
    database.prepare(`
      UPDATE project_edges
      SET label = 'second', revision = 2,
          last_mutation_id = 'edge-2', updated_at = ?
      WHERE id = 'edge-a'
    `).run(NOW);

    const cases = [
      {
        table: "projects",
        id: "project-a",
        duplicateVersionSql: `
          UPDATE projects
          SET title = 'Project three', revision = 2,
              last_mutation_id = 'project-repeat', updated_at = ?
          WHERE id = 'project-a'
        `,
        duplicateVersionBindings: [NOW],
      },
      {
        table: "project_contents",
        id: "content-a",
        duplicateVersionSql: `
          UPDATE project_contents
          SET markdown_source = 'third', revision = 2,
              last_mutation_id = 'content-repeat', updated_at = ?
          WHERE id = 'content-a'
        `,
        duplicateVersionBindings: [NOW],
      },
      {
        table: "project_items",
        id: "item-lifecycle",
        duplicateVersionSql: `
          UPDATE project_items
          SET deleted_at = NULL, deleted_by = NULL, deletion_operation_id = NULL,
              revision = 2, last_mutation_id = 'item-repeat', updated_at = ?
          WHERE id = 'item-lifecycle'
        `,
        duplicateVersionBindings: [NOW],
      },
      {
        table: "project_map_placements",
        id: "placement-a",
        duplicateVersionSql: `
          UPDATE project_map_placements
          SET x = 20, revision = 2,
              last_mutation_id = 'placement-repeat', updated_at = ?
          WHERE id = 'placement-a'
        `,
        duplicateVersionBindings: [NOW],
      },
      {
        table: "project_edges",
        id: "edge-a",
        duplicateVersionSql: `
          UPDATE project_edges
          SET label = 'third', revision = 2,
              last_mutation_id = 'edge-repeat', updated_at = ?
          WHERE id = 'edge-a'
        `,
        duplicateVersionBindings: [NOW],
      },
    ] as const;

    for (const testCase of cases) {
      expect(() => database.prepare(`
        UPDATE ${testCase.table}
        SET revision = 1, last_mutation_id = ?
        WHERE id = ?
      `).run(`rewind-${testCase.id}`, testCase.id)).toThrow(/semantic update/);
      expect(() => database.prepare(`
        UPDATE ${testCase.table}
        SET revision = 3, last_mutation_id = ?
        WHERE id = ?
      `).run(`pre-bump-${testCase.id}`, testCase.id)).toThrow(/semantic update/);
      expect(() => database.prepare(testCase.duplicateVersionSql)
        .run(...testCase.duplicateVersionBindings)).toThrow(/next revision/);
      expect(database.prepare(`
        SELECT revision FROM ${testCase.table} WHERE id = ?
      `).get(testCase.id)).toEqual({ revision: 2 });
    }
    database.close();
  });

  it("allows zero or one placement per item and validates bounded Map geometry and local edges", () => {
    const database = referenceTestDatabase();
    seedProject(database, "project-a");
    seedProject(database, "project-b");
    seedReferenceTarget(database, "target-a");
    seedItem(database, {
      id: "item-a1", projectId: "project-a", sequence: 1, referenceTargetId: "target-a",
    });
    seedItem(database, {
      id: "item-a2", projectId: "project-a", sequence: 2, referenceTargetId: "target-a",
    });
    seedItem(database, {
      id: "item-b1", projectId: "project-b", sequence: 1, referenceTargetId: "target-a",
    });
    seedPlacement(database, "placement-a1", "item-a1");

    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM project_map_placements
      WHERE project_item_id = 'item-a2'
    `).get()).toEqual({ count: 0 });
    expect(() => seedPlacement(database, "placement-a1-copy", "item-a1", { x: 200 })).toThrow();
    expect(() => seedPlacement(database, "infinite-coordinate", "item-a2", {
      x: Number.POSITIVE_INFINITY,
    })).toThrow();
    expect(() => seedPlacement(database, "oversized-coordinate", "item-a2", {
      x: MAX_PROJECT_MAP_COORDINATE_ABS + 1,
    })).toThrow();
    expect(() => seedPlacement(database, "zero-size", "item-a2", {
      width: 0,
    })).toThrow();
    expect(() => seedPlacement(database, "oversized-node", "item-a2", {
      width: MAX_PROJECT_MAP_NODE_SIZE + 1,
    })).toThrow();
    expect(() => seedPlacement(database, "oversized-z", "item-a2", {
      zIndex: MAX_PROJECT_MAP_Z_INDEX_ABS + 1,
    })).toThrow();
    seedPlacement(database, "placement-a2", "item-a2", {
      x: MAX_PROJECT_MAP_COORDINATE_ABS,
      y: -MAX_PROJECT_MAP_COORDINATE_ABS,
      width: MAX_PROJECT_MAP_NODE_SIZE,
      height: MAX_PROJECT_MAP_NODE_SIZE,
      zIndex: MAX_PROJECT_MAP_Z_INDEX_ABS,
    });

    seedEdge(database, {
      id: "edge-a", projectId: "project-a", sourceItemId: "item-a1", targetItemId: "item-a2",
      label: "supports",
    });
    expect(() => seedEdge(database, {
      id: "edge-cross", projectId: "project-a", sourceItemId: "item-a1", targetItemId: "item-b1",
    })).toThrow(/same project/);
    expect(() => seedEdge(database, {
      id: "edge-self", projectId: "project-a", sourceItemId: "item-a1", targetItemId: "item-a1",
    })).toThrow();
    expect(() => seedEdge(database, {
      id: "edge-duplicate", projectId: "project-a", sourceItemId: "item-a1", targetItemId: "item-a2",
      label: "supports",
    })).toThrow();
    seedEdge(database, {
      id: "edge-parallel", projectId: "project-a", sourceItemId: "item-a1", targetItemId: "item-a2",
      label: "contrasts",
    });

    expect(() => database.prepare(`
      UPDATE project_edges SET label = 'explains' WHERE id = 'edge-a'
    `).run()).toThrow(/next revision/);
    database.prepare(`
      UPDATE project_edges
      SET label = 'explains', revision = 2,
          last_mutation_id = 'edge-label-2', updated_at = ?
      WHERE id = 'edge-a'
    `).run(NOW);
    expect(() => database.prepare(`
      UPDATE project_edges SET target_item_id = 'item-b1' WHERE id = 'edge-a'
    `).run()).toThrow();
    database.close();
  });

  it("keeps attachment descriptions revisioned while intrinsic blob metadata stays immutable", () => {
    const database = referenceTestDatabase();
    seedProject(database, "project-a");
    seedContent(database, { id: "attachment-a", projectId: "project-a", type: "attachment" });
    expect(() => database.prepare(`
      INSERT INTO project_contents (
        id, project_id, content_type, markdown_source, attachment_caption,
        last_mutation_id, created_by, updated_by, created_at, updated_at
      ) VALUES ('bad-markdown-caption', 'project-a', 'markdown', '# text', 'caption',
        'bad-markdown-caption', ?, ?, ?, ?)
    `).run(ACTOR, ACTOR, NOW, NOW)).toThrow();
    database.prepare(`
      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size,
        status, actor_email, created_at, sha256
      ) VALUES ('asset-a', 'projects/asset-a.bin', 'asset-a.bin',
        'application/octet-stream', 4, 'ready', ?, ?, ?)
    `).run(ACTOR, NOW, "a".repeat(64));
    database.prepare(`
      INSERT INTO blob_gc_ledger (
        store_kind, provider, object_key, blob_record_id, state,
        operation_id, orphaned_at, updated_at
      ) VALUES ('r2', 'r2', 'projects/asset-a.bin', 'asset-a', 'orphaned',
        'gc-a', ?, ?)
    `).run(NOW, NOW);

    database.prepare(`
      INSERT INTO project_content_attachments (
        project_content_id, asset_id, original_name, mime_type, byte_size,
        created_by, created_at, creation_operation_id
      ) VALUES ('attachment-a', 'asset-a', 'asset-a.bin',
        'application/octet-stream', 4, ?, ?, 'attach-a')
    `).run(ACTOR, NOW);

    expect(database.prepare(`
      SELECT source_type, source_id, occurrence_type, occurrence_id, retention_reason
      FROM blob_retention_edges
      WHERE object_key = 'projects/asset-a.bin'
    `).get()).toEqual({
      source_type: "project_content",
      source_id: "attachment-a",
      occurrence_type: "project_content_attachment",
      occurrence_id: "attachment-a",
      retention_reason: "project_attachment",
    });
    expect(database.prepare(`
      SELECT state FROM blob_gc_ledger
      WHERE store_kind = 'r2' AND object_key = 'projects/asset-a.bin'
    `).get()).toBeUndefined();

    expect(() => database.prepare(`
      UPDATE project_contents
      SET attachment_caption = 'Figure 1'
      WHERE id = 'attachment-a'
    `).run()).toThrow(/next revision/);
    database.prepare(`
      UPDATE project_contents
      SET attachment_caption = 'Figure 1',
          attachment_source_url = 'https://example.test/source',
          revision = 2, last_mutation_id = 'describe-attachment-2', updated_at = ?
      WHERE id = 'attachment-a'
    `).run(NOW);
    expect(database.prepare(`
      SELECT attachment_caption, attachment_source_url, revision
      FROM project_contents WHERE id = 'attachment-a'
    `).get()).toEqual({
      attachment_caption: "Figure 1",
      attachment_source_url: "https://example.test/source",
      revision: 2,
    });
    expect(() => database.prepare(`
      UPDATE project_content_attachments
      SET original_name = 'renamed.bin'
      WHERE project_content_id = 'attachment-a'
    `).run()).toThrow(/intrinsic metadata is immutable/);

    seedContent(database, { id: "attachment-b", projectId: "project-a", type: "attachment" });
    database.prepare(`
      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size,
        status, actor_email, created_at, sha256
      ) VALUES ('asset-b', 'projects/asset-b.bin', 'asset-b.bin',
        'application/octet-stream', 4, 'ready', ?, ?, ?)
    `).run(ACTOR, NOW, "b".repeat(64));
    database.prepare(`
      INSERT INTO blob_gc_ledger (
        store_kind, provider, object_key, blob_record_id, state,
        operation_id, deletion_started_at, updated_at
      ) VALUES ('r2', 'r2', 'projects/asset-b.bin', 'asset-b', 'deleting',
        'gc-b', ?, ?)
    `).run(NOW, NOW);
    expect(() => database.prepare(`
      INSERT INTO project_content_attachments (
        project_content_id, asset_id, original_name, mime_type, byte_size,
        created_by, created_at, creation_operation_id
      ) VALUES ('attachment-b', 'asset-b', 'asset-b.bin',
        'application/octet-stream', 4, ?, ?, 'attach-b')
    `).run(ACTOR, NOW)).toThrow(/blob locator is unavailable/);
    database.close();
  });

  it.each([
    "projects",
    "project_contents",
    "project_content_attachments",
    "project_items",
    "project_map_placements",
    "project_edges",
  ])("disables physical deletion from %s", (table) => {
    const database = referenceTestDatabase();
    const trigger = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = ? AND name LIKE '%reject_physical_delete'
    `).get(table);
    expect(trigger).toBeDefined();
    database.close();
  });
});
