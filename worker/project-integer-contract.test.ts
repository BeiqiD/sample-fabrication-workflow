import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MAX_PROJECT_SAFE_INTEGER } from "../shared/project-types";
import { referenceTestDatabase } from "./reference-test-support";

const NOW = "2026-08-09T18:00:00.000Z";
const ACTOR = "researcher@example.com";

function insertProject(
  database: DatabaseSync,
  id: string,
  revision = 1,
  nextCreatedSequence = 1,
) {
  database.prepare(`
    INSERT INTO projects (
      id, title, revision, next_created_sequence, last_mutation_id,
      created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `Project ${id}`,
    revision,
    nextCreatedSequence,
    `create-${id}`,
    ACTOR,
    ACTOR,
    NOW,
    NOW,
  );
}

function insertContent(
  database: DatabaseSync,
  id: string,
  projectId: string,
  revision = 1,
  formatVersion = 1,
  contentType: "markdown" | "attachment" = "markdown",
) {
  database.prepare(`
    INSERT INTO project_contents (
      id, project_id, content_type, markdown_source, format_version, revision,
      last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    contentType,
    contentType === "markdown" ? `# ${id}` : null,
    formatVersion,
    revision,
    `create-${id}`,
    ACTOR,
    ACTOR,
    NOW,
    NOW,
  );
}

function insertReferenceTarget(database: DatabaseSync, id: string) {
  database.prepare(`
    INSERT INTO reference_targets (
      id, target_type, target_id, first_registered_at, last_validated_at
    ) VALUES (?, 'sample', ?, ?, ?)
  `).run(id, `sample-${id}`, NOW, NOW);
}

function insertItem(
  database: DatabaseSync,
  id: string,
  projectId: string,
  referenceTargetId: string,
  createdSequence: number,
  revision = 1,
) {
  database.prepare(`
    INSERT INTO project_items (
      id, project_id, item_type, reference_target_id, created_sequence, revision,
      last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, 'reference', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    referenceTargetId,
    createdSequence,
    revision,
    `create-${id}`,
    ACTOR,
    ACTOR,
    NOW,
    NOW,
  );
}

function insertPlacement(
  database: DatabaseSync,
  id: string,
  itemId: string,
  revision = 1,
) {
  database.prepare(`
    INSERT INTO project_map_placements (
      id, project_item_id, x, y, width, height, z_index, revision,
      last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, 0, 0, 320, 180, 0, ?, ?, ?, ?, ?, ?)
  `).run(id, itemId, revision, `create-${id}`, ACTOR, ACTOR, NOW, NOW);
}

function insertEdge(
  database: DatabaseSync,
  id: string,
  projectId: string,
  sourceItemId: string,
  targetItemId: string,
  revision = 1,
) {
  database.prepare(`
    INSERT INTO project_edges (
      id, project_id, source_item_id, target_item_id,
      source_handle, target_handle, marker_start, marker_end, label, revision,
      last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'right', 'left', 'none', 'arrow', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    sourceItemId,
    targetItemId,
    id,
    revision,
    `create-${id}`,
    ACTOR,
    ACTOR,
    NOW,
    NOW,
  );
}

function insertAsset(database: DatabaseSync, id: string, byteSize: number) {
  database.prepare(`
    INSERT INTO assets (
      id, r2_key, original_name, mime_type, byte_size,
      status, actor_email, created_at, sha256
    ) VALUES (?, ?, ?, 'application/octet-stream', ?, 'ready', ?, ?, ?)
  `).run(
    id,
    `projects/${id}.bin`,
    `${id}.bin`,
    byteSize,
    ACTOR,
    NOW,
    id.padEnd(64, "a").slice(0, 64),
  );
}

function insertAttachmentMetadata(
  database: DatabaseSync,
  contentId: string,
  assetId: string,
  byteSize: number,
) {
  database.prepare(`
    INSERT INTO project_content_attachments (
      project_content_id, asset_id, original_name, mime_type, byte_size,
      created_by, created_at, creation_operation_id
    ) VALUES (?, ?, ?, 'application/octet-stream', ?, ?, ?, ?)
  `).run(
    contentId,
    assetId,
    `${assetId}.bin`,
    byteSize,
    ACTOR,
    NOW,
    `attach-${contentId}`,
  );
}

describe("Project integer schema contract", () => {
  it("rejects fractional, infinite, and unsafe values for every persisted counter", () => {
    const database = referenceTestDatabase();
    const invalidValues = [
      { label: "fractional", value: 1.5 },
      { label: "infinite", value: Number.POSITIVE_INFINITY },
      { label: "unsafe", value: MAX_PROJECT_SAFE_INTEGER + 1 },
    ];

    for (const { label, value } of invalidValues) {
      expect(() => insertProject(database, `bad-project-revision-${label}`, value, 1)).toThrow();
      expect(() => insertProject(database, `bad-project-sequence-${label}`, 1, value)).toThrow();
    }

    insertProject(database, "project-a");
    insertReferenceTarget(database, "target-a");

    for (const { label, value } of invalidValues) {
      expect(() => insertContent(
        database,
        `bad-content-revision-${label}`,
        "project-a",
        value,
        1,
      )).toThrow();
      expect(() => insertContent(
        database,
        `bad-format-version-${label}`,
        "project-a",
        1,
        value,
      )).toThrow();
      expect(() => insertItem(
        database,
        `bad-item-sequence-${label}`,
        "project-a",
        "target-a",
        value,
        1,
      )).toThrow();
      expect(() => insertItem(
        database,
        `bad-item-revision-${label}`,
        "project-a",
        "target-a",
        100 + invalidValues.indexOf(invalidValues.find((entry) => entry.label === label)!),
        value,
      )).toThrow();
    }

    insertItem(database, "item-a", "project-a", "target-a", 1);
    insertItem(database, "item-b", "project-a", "target-a", 2);

    for (const { label, value } of invalidValues) {
      expect(() => insertPlacement(database, `bad-placement-revision-${label}`, "item-a", value))
        .toThrow();
      expect(() => insertEdge(
        database,
        `bad-edge-revision-${label}`,
        "project-a",
        "item-a",
        "item-b",
        value,
      )).toThrow();
    }

    insertContent(database, "attachment-a", "project-a", 1, 1, "attachment");
    insertAsset(database, "asset-a", 4);
    for (const { value } of invalidValues) {
      expect(() => insertAttachmentMetadata(database, "attachment-a", "asset-a", value))
        .toThrow();
    }

    insertProject(
      database,
      "project-max",
      MAX_PROJECT_SAFE_INTEGER,
      MAX_PROJECT_SAFE_INTEGER,
    );
    insertContent(
      database,
      "content-max",
      "project-a",
      MAX_PROJECT_SAFE_INTEGER,
      MAX_PROJECT_SAFE_INTEGER,
    );
    insertItem(
      database,
      "item-max",
      "project-a",
      "target-a",
      MAX_PROJECT_SAFE_INTEGER,
      MAX_PROJECT_SAFE_INTEGER,
    );
    insertPlacement(database, "placement-max", "item-max", MAX_PROJECT_SAFE_INTEGER);
    insertEdge(
      database,
      "edge-max",
      "project-a",
      "item-a",
      "item-b",
      MAX_PROJECT_SAFE_INTEGER,
    );
    insertContent(database, "attachment-max", "project-a", 1, 1, "attachment");
    insertAsset(database, "asset-max", MAX_PROJECT_SAFE_INTEGER);
    insertAttachmentMetadata(
      database,
      "attachment-max",
      "asset-max",
      MAX_PROJECT_SAFE_INTEGER,
    );

    expect(database.prepare(`
      SELECT typeof(revision) AS revision_type,
             typeof(next_created_sequence) AS sequence_type
      FROM projects WHERE id = 'project-max'
    `).get()).toEqual({ revision_type: "integer", sequence_type: "integer" });
    expect(database.prepare(`
      SELECT typeof(byte_size) AS byte_size_type
      FROM project_content_attachments WHERE project_content_id = 'attachment-max'
    `).get()).toEqual({ byte_size_type: "integer" });
    database.close();
  });

  it("rejects fractional and infinite revisions on all five revisioned tables", () => {
    const database = referenceTestDatabase();
    insertProject(database, "project-a");
    insertContent(database, "content-a", "project-a");
    insertReferenceTarget(database, "target-a");
    insertItem(database, "item-a", "project-a", "target-a", 1);
    insertItem(database, "item-b", "project-a", "target-a", 2);
    insertItem(database, "item-lifecycle", "project-a", "target-a", 3);
    insertPlacement(database, "placement-a", "item-a");
    insertEdge(database, "edge-a", "project-a", "item-a", "item-b");

    for (const [index, revision] of [1.5, Number.POSITIVE_INFINITY].entries()) {
      expect(() => database.prepare(`
        UPDATE projects
        SET title = ?, revision = ?, last_mutation_id = ?, updated_at = ?
        WHERE id = 'project-a'
      `).run(`Project ${index}`, revision, `project-${index}`, NOW)).toThrow();
      expect(() => database.prepare(`
        UPDATE project_contents
        SET markdown_source = ?, revision = ?, last_mutation_id = ?, updated_at = ?
        WHERE id = 'content-a'
      `).run(`content-${index}`, revision, `content-${index}`, NOW)).toThrow();
      expect(() => database.prepare(`
        UPDATE project_items
        SET deleted_at = ?, deleted_by = ?, deletion_operation_id = ?,
            revision = ?, last_mutation_id = ?, updated_at = ?
        WHERE id = 'item-lifecycle'
      `).run(NOW, ACTOR, `delete-${index}`, revision, `item-${index}`, NOW)).toThrow();
      expect(() => database.prepare(`
        UPDATE project_map_placements
        SET x = ?, revision = ?, last_mutation_id = ?, updated_at = ?
        WHERE id = 'placement-a'
      `).run(index + 1, revision, `placement-${index}`, NOW)).toThrow();
      expect(() => database.prepare(`
        UPDATE project_edges
        SET label = ?, revision = ?, last_mutation_id = ?, updated_at = ?
        WHERE id = 'edge-a'
      `).run(`edge-${index}`, revision, `edge-${index}`, NOW)).toThrow();
    }

    expect(database.prepare(`SELECT revision FROM projects WHERE id = 'project-a'`).get())
      .toEqual({ revision: 1 });
    expect(database.prepare(`SELECT revision FROM project_contents WHERE id = 'content-a'`).get())
      .toEqual({ revision: 1 });
    expect(database.prepare(`SELECT revision FROM project_items WHERE id = 'item-lifecycle'`).get())
      .toEqual({ revision: 1 });
    expect(database.prepare(`SELECT revision FROM project_map_placements WHERE id = 'placement-a'`).get())
      .toEqual({ revision: 1 });
    expect(database.prepare(`SELECT revision FROM project_edges WHERE id = 'edge-a'`).get())
      .toEqual({ revision: 1 });
    database.close();
  });

  it("rejects non-safe sequence and format updates even with a valid next revision", () => {
    const database = referenceTestDatabase();
    insertProject(database, "project-a");
    insertContent(database, "content-a", "project-a");

    for (const [index, value] of [
      1.5,
      Number.POSITIVE_INFINITY,
      MAX_PROJECT_SAFE_INTEGER + 1,
    ].entries()) {
      expect(() => database.prepare(`
        UPDATE projects
        SET next_created_sequence = ?, revision = 2,
            last_mutation_id = ?, updated_at = ?
        WHERE id = 'project-a'
      `).run(value, `sequence-${index}`, NOW)).toThrow();
      expect(() => database.prepare(`
        UPDATE project_contents
        SET format_version = ?, revision = 2,
            last_mutation_id = ?, updated_at = ?
        WHERE id = 'content-a'
      `).run(value, `format-${index}`, NOW)).toThrow();
    }

    expect(database.prepare(`
      SELECT revision, next_created_sequence FROM projects WHERE id = 'project-a'
    `).get()).toEqual({ revision: 1, next_created_sequence: 1 });
    expect(database.prepare(`
      SELECT revision, format_version FROM project_contents WHERE id = 'content-a'
    `).get()).toEqual({ revision: 1, format_version: 1 });
    database.close();
  });
});
