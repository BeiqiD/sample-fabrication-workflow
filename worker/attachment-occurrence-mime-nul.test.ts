import { describe, expect, it } from "vitest";
import {
  referenceTestDatabase,
  seedReferenceGraph,
} from "./reference-test-support";

const NOW = "2026-08-20T10:00:00.000Z";
const ACTOR = "local-development";

function seedAsset(database: ReturnType<typeof referenceTestDatabase>) {
  database.prepare(`
    INSERT INTO assets (
      id, r2_key, original_name, mime_type, byte_size,
      status, actor_email, created_at, sha256
    ) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)
  `).run(
    "nul-guard-asset",
    "slice-c/nul-guard.bin",
    "nul-guard.bin",
    "application/octet-stream",
    4,
    ACTOR,
    NOW,
    "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
  );
}

function invalidMimeValues() {
  return [
    "image/png\u0000\r\nx-test: injected",
    `image/png\u0000${"x".repeat(512)}`,
  ];
}

describe("attachment occurrence MIME NUL guards", () => {
  it("rejects embedded NUL on Run occurrence INSERT and UPDATE", () => {
    const database = referenceTestDatabase();
    seedReferenceGraph(database);
    seedAsset(database);
    const step = database.prepare(`
      SELECT rs.id
      FROM run_steps rs
      JOIN runs r ON r.id = rs.run_id
      WHERE r.deleted_at IS NULL AND rs.deleted_at IS NULL
      ORDER BY rs.created_at, rs.id
      LIMIT 1
    `).get() as { id: string } | undefined;
    expect(step).toBeTruthy();

    invalidMimeValues().forEach((mimeType, index) => {
      expect(() => database.prepare(`
        INSERT INTO run_step_assets (
          id, run_step_id, asset_id, role, position,
          filename, mime_type, byte_size, actor_email, created_at
        ) VALUES (?, ?, 'nul-guard-asset', 'state_observation', ?,
          'nul-guard.bin', ?, 4, ?, ?)
      `).run(`nul-run-insert-${index}`, step!.id, 900 + index, mimeType, ACTOR, NOW))
        .toThrow("run step attachment MIME type is invalid");
    });

    database.prepare(`
      INSERT INTO run_step_assets (
        id, run_step_id, asset_id, role, position,
        filename, mime_type, byte_size, actor_email, created_at
      ) VALUES (
        'nul-run-update', ?, 'nul-guard-asset', 'state_observation', 910,
        'nul-guard.bin', 'image/png', 4, ?, ?
      )
    `).run(step!.id, ACTOR, NOW);

    for (const mimeType of invalidMimeValues()) {
      expect(() => database.prepare(`
        UPDATE run_step_assets SET mime_type = ? WHERE id = 'nul-run-update'
      `).run(mimeType)).toThrow("run step attachment MIME type is invalid");
    }
    expect(database.prepare(`
      SELECT mime_type FROM run_step_assets WHERE id = 'nul-run-update'
    `).get()).toEqual({ mime_type: "image/png" });
    database.close();
  });

  it("rejects embedded NUL on Project occurrence INSERT and UPDATE", () => {
    const database = referenceTestDatabase();
    seedAsset(database);
    database.prepare(`
      INSERT INTO projects (
        id, title, revision, next_created_sequence, last_mutation_id,
        created_by, updated_by, created_at, updated_at
      ) VALUES ('nul-project', 'NUL Project', 1, 1, 'create-nul-project', ?, ?, ?, ?)
    `).run(ACTOR, ACTOR, NOW, NOW);

    database.prepare(`
      INSERT INTO project_contents (
        id, project_id, content_type, markdown_source,
        attachment_caption, attachment_source_url, format_version,
        revision, last_mutation_id, created_by, updated_by, created_at, updated_at
      ) VALUES (?, 'nul-project', 'attachment', NULL, NULL, NULL, 1, 1, ?, ?, ?, ?, ?)
    `).run('nul-project-content-insert', 'op-insert', ACTOR, ACTOR, NOW, NOW);

    for (const mimeType of invalidMimeValues()) {
      expect(() => database.prepare(`
        INSERT INTO project_content_attachments (
          project_content_id, asset_id, storage_object_id,
          original_name, mime_type, byte_size,
          created_by, created_at, creation_operation_id
        ) VALUES (
          'nul-project-content-insert', 'nul-guard-asset', NULL,
          'nul-guard.bin', ?, 4, ?, ?, 'op-insert'
        )
      `).run(mimeType, ACTOR, NOW)).toThrow("project attachment MIME type is invalid");
    }

    database.prepare(`
      INSERT INTO project_contents (
        id, project_id, content_type, markdown_source,
        attachment_caption, attachment_source_url, format_version,
        revision, last_mutation_id, created_by, updated_by, created_at, updated_at
      ) VALUES (?, 'nul-project', 'attachment', NULL, NULL, NULL, 1, 1, ?, ?, ?, ?, ?)
    `).run('nul-project-content-update', 'op-update', ACTOR, ACTOR, NOW, NOW);
    database.prepare(`
      INSERT INTO project_content_attachments (
        project_content_id, asset_id, storage_object_id,
        original_name, mime_type, byte_size,
        created_by, created_at, creation_operation_id
      ) VALUES (
        'nul-project-content-update', 'nul-guard-asset', NULL,
        'nul-guard.bin', 'image/png', 4, ?, ?, 'op-update'
      )
    `).run(ACTOR, NOW);

    for (const mimeType of invalidMimeValues()) {
      expect(() => database.prepare(`
        UPDATE project_content_attachments
        SET mime_type = ?
        WHERE project_content_id = 'nul-project-content-update'
      `).run(mimeType)).toThrow("project attachment MIME type is invalid");
    }
    expect(database.prepare(`
      SELECT mime_type FROM project_content_attachments
      WHERE project_content_id = 'nul-project-content-update'
    `).get()).toEqual({ mime_type: "image/png" });
    database.close();
  });
});
