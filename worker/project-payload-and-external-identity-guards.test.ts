import { describe, expect, it } from "vitest";
import { MAX_PROJECT_MARKDOWN_LENGTH } from "../shared/project-api";
import {
  MAX_PROJECT_ATTACHMENT_CAPTION_LENGTH,
  MAX_PROJECT_EDGE_LABEL_LENGTH,
  MAX_PROJECT_TITLE_LENGTH,
} from "../shared/project-types";
import { referenceTestDatabase } from "./reference-test-support";

const ACTOR = "payload-guard@example.com";
const NOW = "2026-08-10T10:00:00.000Z";

type Database = ReturnType<typeof referenceTestDatabase>;
type BoundText = string | Uint8Array;
type NullableBoundText = BoundText | null;

function blob(value: string) {
  return new TextEncoder().encode(value);
}

function insertProject(
  database: Database,
  id = "project-safe",
  title: BoundText = "Safe Project",
  operationId = "create-project-safe",
) {
  database.prepare(`
    INSERT INTO projects (
      id, title, last_mutation_id,
      created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, operationId, ACTOR, ACTOR, NOW, NOW);
}

function insertMarkdownContent(
  database: Database,
  id: string,
  source: BoundText,
  operationId: string,
) {
  database.prepare(`
    INSERT INTO project_contents (
      id, project_id, content_type, markdown_source,
      last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, 'project-safe', 'markdown', ?, ?, ?, ?, ?, ?)
  `).run(id, source, operationId, ACTOR, ACTOR, NOW, NOW);
}

function insertAttachmentContent(
  database: Database,
  id: string,
  caption: NullableBoundText,
  sourceUrl: NullableBoundText,
  operationId: string,
) {
  database.prepare(`
    INSERT INTO project_contents (
      id, project_id, content_type, attachment_caption, attachment_source_url,
      last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, 'project-safe', 'attachment', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, caption, sourceUrl, operationId, ACTOR, ACTOR, NOW, NOW);
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

function insertReferenceItem(
  database: Database,
  id: string,
  referenceTargetId: BoundText,
  sequence: number,
  operationId: string,
) {
  database.prepare(`
    INSERT INTO project_items (
      id, project_id, item_type, reference_target_id, created_sequence,
      last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (?, 'project-safe', 'reference', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, referenceTargetId, sequence, operationId, ACTOR, ACTOR, NOW, NOW);
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
  label: NullableBoundText,
  operationId: string,
) {
  database.prepare(`
    INSERT INTO project_edges (
      id, project_id, source_item_id, target_item_id,
      source_handle, target_handle, marker_start, marker_end, label,
      last_mutation_id, created_by, updated_by, created_at, updated_at
    ) VALUES (
      ?, 'project-safe', ?, ?, 'right', 'left', 'none', 'arrow', ?,
      ?, ?, ?, ?, ?
    )
  `).run(
    id,
    sourceItemId,
    targetItemId,
    label,
    operationId,
    ACTOR,
    ACTOR,
    NOW,
    NOW,
  );
}

function seedEdgeEndpoints(database: Database) {
  insertProject(database);
  insertMarkdownContent(database, "content-a", "# A", "create-content-a");
  insertContentItem(database, "item-a", "content-a", 1, "create-item-a");
  insertPlacement(database, "placement-a", "item-a", "create-placement-a");
  insertMarkdownContent(database, "content-b", "# B", "create-content-b");
  insertContentItem(database, "item-b", "content-b", 2, "create-item-b");
  insertPlacement(database, "placement-b", "item-b", "create-placement-b");
}

function insertReferenceTarget(
  database: Database,
  id: BoundText,
  targetId: string,
) {
  database.prepare(`
    INSERT INTO reference_targets (
      id, registry_version, target_type, target_id,
      first_registered_at, last_validated_at, last_known_contexts_json
    ) VALUES (?, 1, 'sample', ?, ?, ?, '[]')
  `).run(id, targetId, NOW, NOW);
}

function insertAsset(database: Database, id: BoundText, key: string) {
  database.prepare(`
    INSERT INTO assets (
      id, r2_key, original_name, mime_type, byte_size,
      status, actor_email, created_at, sha256
    ) VALUES (
      ?, ?, 'guard.bin', 'application/octet-stream', 4,
      'ready', ?, ?, NULL
    )
  `).run(id, key, ACTOR, NOW);
}

function insertManagedStorageObject(
  database: Database,
  id: BoundText,
  objectKey: string,
  sha256: string,
) {
  database.prepare(`
    INSERT INTO managed_storage_objects (
      id, provider, object_key, original_name, mime_type, byte_size,
      sha256, status, actor_email, created_at
    ) VALUES (
      ?, 'switchdrive', ?, 'guard.bin', 'application/octet-stream', 4,
      ?, 'ready', ?, ?
    )
  `).run(id, objectKey, sha256, ACTOR, NOW);
}

function insertAttachmentBinding(
  database: Database,
  contentId: string,
  assetId: NullableBoundText,
  storageObjectId: NullableBoundText,
  operationId: string,
) {
  database.prepare(`
    INSERT INTO project_content_attachments (
      project_content_id, asset_id, storage_object_id,
      original_name, mime_type, byte_size,
      created_by, created_at, creation_operation_id
    ) VALUES (
      ?, ?, ?, 'guard.bin', 'application/octet-stream', 4,
      ?, ?, ?
    )
  `).run(contentId, assetId, storageObjectId, ACTOR, NOW, operationId);
}

describe("Project payload and external identity guards", () => {
  it("rejects BLOB and embedded-NUL Project titles on insert and update", () => {
    const database = referenceTestDatabase();
    const nulOversizedTitle = `x\u0000${"y".repeat(MAX_PROJECT_TITLE_LENGTH + 1)}`;

    expect(() => insertProject(
      database,
      "project-blob-title",
      blob("Blob title"),
      "create-project-blob-title",
    )).toThrow(/title must be text/);
    expect(() => insertProject(
      database,
      "project-nul-title",
      nulOversizedTitle,
      "create-project-nul-title",
    )).toThrow(/title must not contain NUL/);

    insertProject(database);
    expect(() => database.prepare(`
      UPDATE projects
      SET title = ?, revision = 2,
          last_mutation_id = 'rename-project-blob-title',
          updated_by = ?, updated_at = ?
      WHERE id = 'project-safe'
    `).run(blob("Blob title"), ACTOR, NOW)).toThrow(/title must be text/);
    expect(() => database.prepare(`
      UPDATE projects
      SET title = ?, revision = 2,
          last_mutation_id = 'rename-project-nul-title',
          updated_by = ?, updated_at = ?
      WHERE id = 'project-safe'
    `).run(nulOversizedTitle, ACTOR, NOW)).toThrow(/title must not contain NUL/);

    expect(database.prepare(`
      SELECT title, revision, last_mutation_id
      FROM projects WHERE id = 'project-safe'
    `).get()).toEqual({
      title: "Safe Project",
      revision: 1,
      last_mutation_id: "create-project-safe",
    });
    database.close();
  });

  it("rejects BLOB and embedded-NUL content payloads on insert and update", () => {
    const database = referenceTestDatabase();
    insertProject(database);
    const nulOversizedMarkdown = `x\u0000${"y".repeat(MAX_PROJECT_MARKDOWN_LENGTH + 1)}`;
    const nulOversizedCaption = `x\u0000${"y".repeat(MAX_PROJECT_ATTACHMENT_CAPTION_LENGTH + 1)}`;
    const nulOversizedUrl = `https://x\u0000${"y".repeat(3000)}`;

    expect(() => insertMarkdownContent(
      database,
      "content-blob-markdown",
      blob("# Blob"),
      "create-content-blob-markdown",
    )).toThrow(/Markdown must be text/);
    expect(() => insertMarkdownContent(
      database,
      "content-nul-markdown",
      nulOversizedMarkdown,
      "create-content-nul-markdown",
    )).toThrow(/Markdown must not contain NUL/);

    insertMarkdownContent(
      database,
      "content-markdown-safe",
      "# Safe",
      "create-content-markdown-safe",
    );
    expect(() => database.prepare(`
      UPDATE project_contents
      SET markdown_source = ?, revision = 2,
          last_mutation_id = 'update-content-blob-markdown',
          updated_by = ?, updated_at = ?
      WHERE id = 'content-markdown-safe'
    `).run(blob("# Blob"), ACTOR, NOW)).toThrow(/Markdown must be text/);
    expect(() => database.prepare(`
      UPDATE project_contents
      SET markdown_source = ?, revision = 2,
          last_mutation_id = 'update-content-nul-markdown',
          updated_by = ?, updated_at = ?
      WHERE id = 'content-markdown-safe'
    `).run(nulOversizedMarkdown, ACTOR, NOW)).toThrow(/Markdown must not contain NUL/);

    expect(() => insertAttachmentContent(
      database,
      "content-blob-caption",
      blob("Blob caption"),
      null,
      "create-content-blob-caption",
    )).toThrow(/caption must be text/);
    expect(() => insertAttachmentContent(
      database,
      "content-nul-caption",
      nulOversizedCaption,
      null,
      "create-content-nul-caption",
    )).toThrow(/caption must not contain NUL/);
    expect(() => insertAttachmentContent(
      database,
      "content-blob-url",
      null,
      blob("https://example.test/source"),
      "create-content-blob-url",
    )).toThrow(/http or https/);
    expect(() => insertAttachmentContent(
      database,
      "content-nul-url",
      null,
      nulOversizedUrl,
      "create-content-nul-url",
    )).toThrow(/http or https/);

    insertAttachmentContent(
      database,
      "content-attachment-safe",
      "Safe caption",
      "https://example.test/source",
      "create-content-attachment-safe",
    );
    expect(() => database.prepare(`
      UPDATE project_contents
      SET attachment_caption = ?, revision = 2,
          last_mutation_id = 'update-content-blob-caption',
          updated_by = ?, updated_at = ?
      WHERE id = 'content-attachment-safe'
    `).run(blob("Blob caption"), ACTOR, NOW)).toThrow(/caption must be text/);
    expect(() => database.prepare(`
      UPDATE project_contents
      SET attachment_source_url = ?, revision = 2,
          last_mutation_id = 'update-content-nul-url',
          updated_by = ?, updated_at = ?
      WHERE id = 'content-attachment-safe'
    `).run(nulOversizedUrl, ACTOR, NOW)).toThrow(/http or https/);

    expect(database.prepare(`
      SELECT markdown_source, revision, last_mutation_id
      FROM project_contents WHERE id = 'content-markdown-safe'
    `).get()).toEqual({
      markdown_source: "# Safe",
      revision: 1,
      last_mutation_id: "create-content-markdown-safe",
    });
    expect(database.prepare(`
      SELECT attachment_caption, attachment_source_url, revision, last_mutation_id
      FROM project_contents WHERE id = 'content-attachment-safe'
    `).get()).toEqual({
      attachment_caption: "Safe caption",
      attachment_source_url: "https://example.test/source",
      revision: 1,
      last_mutation_id: "create-content-attachment-safe",
    });
    database.close();
  });

  it("rejects BLOB and embedded-NUL edge labels on insert and update", () => {
    const database = referenceTestDatabase();
    seedEdgeEndpoints(database);
    const nulOversizedLabel = `x\u0000${"y".repeat(MAX_PROJECT_EDGE_LABEL_LENGTH + 1)}`;

    expect(() => insertEdge(
      database,
      "edge-blob-label",
      "item-a",
      "item-b",
      blob("Blob label"),
      "create-edge-blob-label",
    )).toThrow(/label must be text/);
    expect(() => insertEdge(
      database,
      "edge-nul-label",
      "item-a",
      "item-b",
      nulOversizedLabel,
      "create-edge-nul-label",
    )).toThrow(/label must not contain NUL/);

    insertEdge(
      database,
      "edge-safe",
      "item-a",
      "item-b",
      "Safe label",
      "create-edge-safe",
    );
    expect(() => database.prepare(`
      UPDATE project_edges
      SET label = ?, revision = 2,
          last_mutation_id = 'update-edge-blob-label',
          updated_by = ?, updated_at = ?
      WHERE id = 'edge-safe'
    `).run(blob("Blob label"), ACTOR, NOW)).toThrow(/label must be text/);
    expect(() => database.prepare(`
      UPDATE project_edges
      SET label = ?, revision = 2,
          last_mutation_id = 'update-edge-nul-label',
          updated_by = ?, updated_at = ?
      WHERE id = 'edge-safe'
    `).run(nulOversizedLabel, ACTOR, NOW)).toThrow(/label must not contain NUL/);

    expect(database.prepare(`
      SELECT label, revision, last_mutation_id
      FROM project_edges WHERE id = 'edge-safe'
    `).get()).toEqual({
      label: "Safe label",
      revision: 1,
      last_mutation_id: "create-edge-safe",
    });
    database.close();
  });

  it("applies API-safe character, type, and NUL guards to external Project FKs", () => {
    const database = referenceTestDatabase();
    insertProject(database);

    const unsafeReferenceIds: Array<[BoundText, string]> = [
      ["../registry", "path"],
      [blob("registry-blob"), "blob"],
      ["registry\u0000unsafe", "nul"],
    ];
    unsafeReferenceIds.forEach(([referenceId, suffix], index) => {
      insertReferenceTarget(database, referenceId, `sample-${suffix}`);
      expect(() => insertReferenceItem(
        database,
        `item-reference-${suffix}`,
        referenceId,
        index + 1,
        `create-item-reference-${suffix}`,
      )).toThrow(/API-safe/);
    });

    const unsafeAssetIds: Array<[BoundText, string]> = [
      ["../asset", "path"],
      [blob("asset-blob"), "blob"],
      ["asset\u0000unsafe", "nul"],
    ];
    unsafeAssetIds.forEach(([assetId, suffix]) => {
      insertAsset(database, assetId, `projects/asset-${suffix}.bin`);
      const contentId = `content-asset-${suffix}`;
      insertAttachmentContent(
        database,
        contentId,
        null,
        null,
        `create-${contentId}`,
      );
      expect(() => insertAttachmentBinding(
        database,
        contentId,
        assetId,
        null,
        `bind-${contentId}`,
      )).toThrow(/API-safe/);
    });

    const unsafeStorageIds: Array<[BoundText, string]> = [
      ["../storage", "path"],
      [blob("storage-blob"), "blob"],
      ["storage\u0000unsafe", "nul"],
    ];
    unsafeStorageIds.forEach(([storageId, suffix], index) => {
      insertManagedStorageObject(
        database,
        storageId,
        `projects/storage-${suffix}.bin`,
        String(index + 1).repeat(64),
      );
      const contentId = `content-storage-${suffix}`;
      insertAttachmentContent(
        database,
        contentId,
        null,
        null,
        `create-${contentId}`,
      );
      expect(() => insertAttachmentBinding(
        database,
        contentId,
        null,
        storageId,
        `bind-${contentId}`,
      )).toThrow(/API-safe/);
    });

    expect(database.prepare("SELECT COUNT(*) AS count FROM project_items").get())
      .toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM project_content_attachments",
    ).get()).toEqual({ count: 0 });
    database.close();
  });
});
