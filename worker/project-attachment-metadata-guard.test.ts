import { describe, expect, it } from "vitest";
import { referenceTestDatabase } from "./reference-test-support";

const ACTOR = "metadata-user@example.com";
const NOW = "2026-08-09T23:30:00.000Z";

describe("Project attachment metadata guard", () => {
  it("requires intrinsic attachment metadata to match the authoritative blob record", () => {
    const database = referenceTestDatabase();
    database.prepare(`
      INSERT INTO projects (
        id, title, last_mutation_id,
        created_by, updated_by, created_at, updated_at
      ) VALUES ('project-metadata', 'Metadata Project', 'create-project', ?, ?, ?, ?)
    `).run(ACTOR, ACTOR, NOW, NOW);
    database.prepare(`
      INSERT INTO project_contents (
        id, project_id, content_type, markdown_source,
        last_mutation_id, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'content-metadata', 'project-metadata', 'attachment', NULL,
        'create-content', ?, ?, ?, ?
      )
    `).run(ACTOR, ACTOR, NOW, NOW);
    database.prepare(`
      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size,
        status, actor_email, created_at, sha256
      ) VALUES (
        'asset-metadata', 'projects/metadata.bin', 'metadata.bin',
        'application/octet-stream', 4, 'ready', ?, ?, ?
      )
    `).run(ACTOR, NOW, "a".repeat(64));

    expect(() => database.prepare(`
      INSERT INTO project_content_attachments (
        project_content_id, asset_id, original_name, mime_type, byte_size,
        created_by, created_at, creation_operation_id
      ) VALUES (
        'content-metadata', 'asset-metadata', 'renamed.bin',
        'application/octet-stream', 4, ?, ?, 'bind-wrong-name'
      )
    `).run(ACTOR, NOW)).toThrow(/metadata must match/);
    expect(() => database.prepare(`
      INSERT INTO project_content_attachments (
        project_content_id, asset_id, original_name, mime_type, byte_size,
        created_by, created_at, creation_operation_id
      ) VALUES (
        'content-metadata', 'asset-metadata', 'metadata.bin',
        'application/octet-stream', 5, ?, ?, 'bind-wrong-size'
      )
    `).run(ACTOR, NOW)).toThrow(/metadata must match/);

    database.prepare(`
      INSERT INTO project_content_attachments (
        project_content_id, asset_id, original_name, mime_type, byte_size,
        created_by, created_at, creation_operation_id
      ) VALUES (
        'content-metadata', 'asset-metadata', 'metadata.bin',
        'application/octet-stream', 4, ?, ?, 'bind-correct'
      )
    `).run(ACTOR, NOW);
    expect(database.prepare(`
      SELECT original_name, mime_type, byte_size
      FROM project_content_attachments
      WHERE project_content_id = 'content-metadata'
    `).get()).toEqual({
      original_name: "metadata.bin",
      mime_type: "application/octet-stream",
      byte_size: 4,
    });
    database.close();
  });
});
