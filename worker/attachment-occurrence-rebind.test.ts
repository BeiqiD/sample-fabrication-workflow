import { describe, expect, it } from "vitest";
import {
  referenceTestDatabase,
  seedReferenceGraph,
} from "./reference-test-support";

describe("Run attachment occurrence rebinding", () => {
  it("synchronizes physical byte size without overwriting contextual filename or MIME", () => {
    const database = referenceTestDatabase();
    seedReferenceGraph(database);
    const step = database.prepare(
      "SELECT id FROM run_steps ORDER BY id LIMIT 1",
    ).get() as { id: string } | undefined;
    expect(step).toBeTruthy();

    database.exec(`
      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size,
        status, actor_email, created_at, sha256
      ) VALUES
        (
          'slice-c-rebind-a', 'slice-c/rebind-a.bin', 'registered-a.bin',
          'application/octet-stream', 4, 'ready', 'local-development',
          '2026-08-19T16:10:00.000Z',
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        ),
        (
          'slice-c-rebind-b', 'slice-c/rebind-b.bin', 'registered-b.bin',
          'application/octet-stream', 6, 'ready', 'local-development',
          '2026-08-19T16:10:01.000Z',
          'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
        );
    `);
    database.prepare(`
      INSERT INTO run_step_assets (
        id, run_step_id, asset_id, role, position,
        filename, mime_type, byte_size, actor_email, created_at
      ) VALUES (
        'slice-c-rebind-occurrence', ?, 'slice-c-rebind-a',
        'state_observation', 999,
        'contextual-surface-scan.tif', 'image/tiff', 4,
        'local-development', '2026-08-19T16:11:00.000Z'
      )
    `).run(step!.id);

    database.prepare(`
      UPDATE run_step_assets
      SET asset_id = 'slice-c-rebind-b'
      WHERE id = 'slice-c-rebind-occurrence'
    `).run();

    expect(database.prepare(`
      SELECT asset_id, filename, mime_type, byte_size
      FROM run_step_assets
      WHERE id = 'slice-c-rebind-occurrence'
    `).get()).toEqual({
      asset_id: "slice-c-rebind-b",
      filename: "contextual-surface-scan.tif",
      mime_type: "image/tiff",
      byte_size: 6,
    });
    database.close();
  });
});
