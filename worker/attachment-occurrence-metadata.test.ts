import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker from "./index";
import {
  referenceTestDatabase,
  seedReferenceGraph,
  SqliteD1Database,
} from "./reference-test-support";
import {
  createAttachmentProjectItem,
  createProject,
} from "./projects/service";
import { copyAttachmentProjectItem } from "./projects/attachment-copy";
import type { Env } from "./types";

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

function projectGeometry(x: number) {
  return { x, y: 0, width: 320, height: 220, zIndex: 1 };
}

describe("attachment occurrence metadata", () => {
  it("keeps Project presentation independent from one shared physical asset and preserves it on copy", async () => {
    const database = referenceTestDatabase();
    database.exec(`
      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size,
        status, actor_email, created_at, sha256
      ) VALUES (
        'slice-c-asset', 'slice-c/shared.bin', 'registration.bin',
        'application/octet-stream', 4, 'ready', 'local-development',
        '2026-08-19T15:00:00.000Z', '${"a".repeat(64)}'
      );
    `);
    const db = new SqliteD1Database(database) as unknown as D1Database;
    await createProject(db, {
      id: "slice-c-project",
      title: "Slice C",
      operationId: "slice-c-project-create",
    }, "local-development", "2026-08-19T15:01:00.000Z");

    const first = await createAttachmentProjectItem(db, "slice-c-project", {
      contentId: "slice-c-content-a",
      itemId: "slice-c-item-a",
      placementId: "slice-c-placement-a",
      locator: { assetId: "slice-c-asset" },
      presentation: {
        originalName: "AFM before cleaning.tif",
        mimeType: "image/tiff",
        byteSize: 4,
      },
      caption: null,
      sourceUrl: null,
      geometry: projectGeometry(0),
      expectedProjectRevision: 1,
      operationId: "slice-c-create-a",
    }, "local-development", "2026-08-19T15:02:00.000Z");
    expect(first.attachment).toMatchObject({
      originalName: "AFM before cleaning.tif",
      mimeType: "image/tiff",
      byteSize: 4,
    });

    await expect(createAttachmentProjectItem(db, "slice-c-project", {
      contentId: "slice-c-content-a",
      itemId: "slice-c-item-a",
      placementId: "slice-c-placement-a",
      locator: { assetId: "slice-c-asset" },
      caption: null,
      sourceUrl: null,
      geometry: projectGeometry(0),
      expectedProjectRevision: 1,
      operationId: "slice-c-create-a",
    }, "local-development", "2026-08-19T15:02:30.000Z"))
      .rejects.toMatchObject({ code: "conflict" });

    const second = await createAttachmentProjectItem(db, "slice-c-project", {
      contentId: "slice-c-content-b",
      itemId: "slice-c-item-b",
      placementId: "slice-c-placement-b",
      locator: { assetId: "slice-c-asset" },
      presentation: {
        originalName: "Surface morphology.dat",
        mimeType: "application/x-surface-scan",
        byteSize: 4,
      },
      caption: "Same bytes, different context",
      sourceUrl: null,
      geometry: projectGeometry(360),
      expectedProjectRevision: 2,
      operationId: "slice-c-create-b",
    }, "local-development", "2026-08-19T15:03:00.000Z");
    expect(second.attachment).toMatchObject({
      originalName: "Surface morphology.dat",
      mimeType: "application/x-surface-scan",
      byteSize: 4,
    });

    const copied = await copyAttachmentProjectItem(db, "slice-c-project", {
      sourceContentId: "slice-c-content-a",
      contentId: "slice-c-content-copy",
      itemId: "slice-c-item-copy",
      placementId: "slice-c-placement-copy",
      caption: null,
      sourceUrl: null,
      geometry: projectGeometry(720),
      expectedProjectRevision: 3,
      operationId: "slice-c-copy",
    }, "local-development", "2026-08-19T15:04:00.000Z");
    expect(copied.attachment).toMatchObject({
      originalName: "AFM before cleaning.tif",
      mimeType: "image/tiff",
      byteSize: 4,
    });

    expect(database.prepare(`
      SELECT original_name, mime_type, byte_size
      FROM assets WHERE id = 'slice-c-asset'
    `).get()).toEqual({
      original_name: "registration.bin",
      mime_type: "application/octet-stream",
      byte_size: 4,
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM project_content_attachments WHERE asset_id = 'slice-c-asset'
    `).get()).toEqual({ count: 3 });

    await expect(createAttachmentProjectItem(db, "slice-c-project", {
      contentId: "slice-c-content-bad",
      itemId: "slice-c-item-bad",
      placementId: "slice-c-placement-bad",
      locator: { assetId: "slice-c-asset" },
      presentation: {
        originalName: "wrong-size.bin",
        mimeType: "application/octet-stream",
        byteSize: 5,
      },
      caption: null,
      sourceUrl: null,
      geometry: projectGeometry(1080),
      expectedProjectRevision: 4,
      operationId: "slice-c-bad-size",
    }, "local-development", "2026-08-19T15:05:00.000Z"))
      .rejects.toThrow("byte size does not match");
    database.close();
  });

  it("stores contextual Run metadata through the real update route and rejects size mismatch", async () => {
    const database = referenceTestDatabase();
    seedReferenceGraph(database);
    database.exec(`
      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size,
        status, actor_email, created_at, sha256
      ) VALUES (
        'slice-c-run-asset', 'slice-c/run.bin', 'registered-run.bin',
        'application/octet-stream', 6, 'ready', 'local-development',
        '2026-08-19T15:10:00.000Z', '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      );
    `);
    const run = database.prepare(`
      SELECT r.id AS run_id, r.sample_id,
             COALESCE(MAX(rs.position), -1) + 1 AS next_position
      FROM runs r
      JOIN samples s ON s.id = r.sample_id AND s.deleted_at IS NULL
      LEFT JOIN run_steps rs ON rs.run_id = r.id
      WHERE r.status = 'active' AND r.deleted_at IS NULL
      GROUP BY r.id, r.sample_id
      ORDER BY r.sequence_no DESC
      LIMIT 1
    `).get() as { run_id: string; sample_id: string; next_position: number } | undefined;
    expect(run).toBeTruthy();
    database.prepare(`
      INSERT INTO run_steps (
        id, run_id, position, origin, plan_status, title, status,
        notes, tool_name, parameters_text, comments_text, deviation_note,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'ad_hoc', 'current', 'Slice C route step', 'pending',
        '', '', '', '', '', ?, ?)
    `).run(
      'slice-c-route-step',
      run!.run_id,
      Number(run!.next_position),
      '2026-08-19T15:11:00.000Z',
      '2026-08-19T15:11:00.000Z',
    );

    const env = {
      AUTH_MODE: "disabled",
      DB: new SqliteD1Database(database) as unknown as D1Database,
      ASSETS: {} as R2Bucket,
    } satisfies Env;
    const response = await worker.fetch(new Request(
      `https://app.test/api/samples/${run!.sample_id}/runs/${run!.run_id}/steps/slice-c-route-step`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "pending",
          title: "Slice C route step",
          toolName: "",
          parametersText: "",
          commentsText: "",
          deviationNote: "",
          notes: "",
          expectedUpdatedAt: "2026-08-19T15:11:00.000Z",
          assetKey: "slice-c/run.bin",
          assetMetadata: {
            filename: "contextual-run-name.tif",
            mimeType: "image/tiff",
            byteSize: 6,
          },
        }),
      },
    ), env, executionContext);
    expect(response.status).toBe(200);
    const result = await response.json() as { updatedAt: string };
    expect(database.prepare(`
      SELECT filename, mime_type, byte_size
      FROM run_step_assets
      WHERE run_step_id = 'slice-c-route-step'
        AND asset_id = 'slice-c-run-asset' AND role = 'execution'
    `).get()).toEqual({
      filename: "contextual-run-name.tif",
      mime_type: "image/tiff",
      byte_size: 6,
    });

    const mismatch = await worker.fetch(new Request(
      `https://app.test/api/samples/${run!.sample_id}/runs/${run!.run_id}/steps/slice-c-route-step`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "pending",
          title: "Slice C route step",
          toolName: "",
          parametersText: "",
          commentsText: "",
          deviationNote: "",
          notes: "",
          expectedUpdatedAt: result.updatedAt,
          assetKey: "slice-c/run.bin",
          assetMetadata: {
            filename: "wrong-size.tif",
            mimeType: "image/tiff",
            byteSize: 7,
          },
        }),
      },
    ), env, executionContext);
    expect(mismatch.status).toBe(400);
    expect(database.prepare(`
      SELECT filename, mime_type, byte_size
      FROM run_step_assets
      WHERE run_step_id = 'slice-c-route-step'
        AND asset_id = 'slice-c-run-asset' AND role = 'execution'
    `).get()).toEqual({
      filename: "contextual-run-name.tif",
      mime_type: "image/tiff",
      byte_size: 6,
    });

    database.prepare(`
      INSERT INTO run_step_assets (
        id, run_step_id, asset_id, role, position, actor_email, created_at
      ) VALUES (
        'slice-c-fallback-occurrence', 'slice-c-route-step', 'slice-c-run-asset',
        'state_observation', 0, 'local-development', '2026-08-19T15:12:00.000Z'
      )
    `).run();
    expect(database.prepare(`
      SELECT filename, mime_type, byte_size
      FROM run_step_assets WHERE id = 'slice-c-fallback-occurrence'
    `).get()).toEqual({
      filename: "registered-run.bin",
      mime_type: "application/octet-stream",
      byte_size: 6,
    });
    expect(() => database.prepare(`
      UPDATE run_step_assets SET mime_type = ?
      WHERE id = 'slice-c-fallback-occurrence'
    `).run("image/png\r\nx-test: injected"))
      .toThrow("run step attachment MIME type is invalid");
    database.close();
  });


  it("rejects unsafe occurrence MIME before persistence and serves validated MIME without header failure", async () => {
    const database = referenceTestDatabase();
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    database.exec(`
      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size,
        status, actor_email, created_at, sha256
      ) VALUES (
        'slice-c-mime-asset', 'slice-c/safe.png', 'registered.png',
        'application/octet-stream', 4, 'ready', 'local-development',
        '2026-08-19T15:20:00.000Z', '${"b".repeat(64)}'
      );
    `);
    const db = new SqliteD1Database(database) as unknown as D1Database;
    await createProject(db, {
      id: "slice-c-mime-project",
      title: "MIME safety",
      operationId: "slice-c-mime-project-create",
    }, "local-development", "2026-08-19T15:21:00.000Z");

    const object = {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      size: bytes.byteLength,
      httpEtag: '"slice-c-mime"',
      writeHttpMetadata(headers: Headers) {
        headers.set("content-type", "application/octet-stream");
      },
    };
    const env = {
      AUTH_MODE: "disabled",
      DB: db,
      ASSETS: {
        get: async (key: string) => key === "slice-c/safe.png" ? object : null,
        head: async (key: string) => key === "slice-c/safe.png" ? object : null,
        put: async () => undefined,
        delete: async () => undefined,
        list: async () => ({ objects: [], truncated: false }),
      } as unknown as R2Bucket,
    } satisfies Env;
    const base = {
      contentId: "slice-c-mime-content",
      itemId: "slice-c-mime-item",
      placementId: "slice-c-mime-placement",
      locator: { assetId: "slice-c-mime-asset" },
      caption: null,
      sourceUrl: null,
      geometry: projectGeometry(0),
      expectedProjectRevision: 1,
      operationId: "slice-c-mime-create",
    };

    const rejected = await worker.fetch(new Request(
      "https://app.test/api/projects/slice-c-mime-project/items/attachment",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...base,
          presentation: {
            originalName: "unsafe.png",
            mimeType: "image/png\r\nx-test: injected",
            byteSize: 4,
          },
        }),
      },
    ), env, executionContext);
    expect(rejected.status).toBe(400);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM project_content_attachments
    `).get()).toEqual({ count: 0 });

    const created = await worker.fetch(new Request(
      "https://app.test/api/projects/slice-c-mime-project/items/attachment",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...base,
          presentation: {
            originalName: "safe.png",
            mimeType: "image/png",
            byteSize: 4,
          },
        }),
      },
    ), env, executionContext);
    expect(created.status).toBe(201);

    expect(() => database.prepare(`
      UPDATE project_content_attachments
      SET mime_type = ?
      WHERE project_content_id = 'slice-c-mime-content'
    `).run("image/png\r\nx-test: injected"))
      .toThrow("project attachment MIME type is invalid");

    const media = await worker.fetch(new Request(
      "https://app.test/api/projects/slice-c-mime-project/contents/slice-c-mime-content/file",
    ), env, executionContext);
    expect(media.status).toBe(200);
    expect(media.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(bytes);
    database.close();
  });

  it("keeps current clients responsible for freezing contextual Run metadata", () => {
    const grid = readFileSync(new URL("../src/components/MultiSampleRunGrid.tsx", import.meta.url), "utf8");
    const projectPage = readFileSync(new URL("../src/pages/ProjectPage.tsx", import.meta.url), "utf8");
    expect(grid).toContain("assetMetadata = {");
    expect(grid).toContain("byteSize: compressed.size");
    expect(grid).toContain("assetMetadata,");
    expect(projectPage).toContain("presentation: {");
    expect(projectPage).toContain("byteSize: file.size");
  });

  it("keeps safe parameterized legacy MIME compatible while new Run JSON stays canonical", async () => {
    const database = referenceTestDatabase();
    seedReferenceGraph(database);
    database.exec(`
      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size,
        status, actor_email, created_at, sha256
      ) VALUES (
        'slice-c-legacy-mime-asset', 'slice-c/legacy-mime.png', 'legacy-mime.png',
        'image/png; charset=binary', 6, 'ready', 'local-development',
        '2026-08-20T05:00:00.000Z', '${"fedcba9876543210".repeat(4)}'
      );
    `);
    const run = database.prepare(`
      SELECT r.id AS run_id, r.sample_id,
             COALESCE(MAX(rs.position), 0) + 1000 AS next_position
      FROM runs r
      JOIN samples s ON s.id = r.sample_id AND s.deleted_at IS NULL
      LEFT JOIN run_steps rs ON rs.run_id = r.id
      WHERE r.status = 'active' AND r.deleted_at IS NULL
      GROUP BY r.id, r.sample_id
      ORDER BY r.sequence_no DESC
      LIMIT 1
    `).get() as { run_id: string; sample_id: string; next_position: number } | undefined;
    expect(run).toBeTruthy();
    database.prepare(`
      INSERT INTO run_steps (
        id, run_id, position, origin, plan_status, title, status,
        notes, tool_name, parameters_text, comments_text, deviation_note,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'ad_hoc', 'current', 'Legacy MIME route step', 'pending',
        '', '', '', '', '', ?, ?)
    `).run(
      "slice-c-legacy-mime-step",
      run!.run_id,
      Number(run!.next_position),
      "2026-08-20T05:01:00.000Z",
      "2026-08-20T05:01:00.000Z",
    );
    const db = new SqliteD1Database(database) as unknown as D1Database;
    const env = {
      AUTH_MODE: "disabled",
      DB: db,
      ASSETS: {} as R2Bucket,
    } satisfies Env;
    const patchBody = (expectedUpdatedAt: string, assetMetadata?: {
      filename: string;
      mimeType: string;
      byteSize: number;
    }) => ({
      status: "pending",
      title: "Legacy MIME route step",
      toolName: "",
      parametersText: "",
      commentsText: "",
      deviationNote: "",
      notes: "",
      expectedUpdatedAt,
      assetKey: "slice-c/legacy-mime.png",
      ...(assetMetadata ? { assetMetadata } : {}),
    });

    const legacyPatch = await worker.fetch(new Request(
      `https://app.test/api/samples/${run!.sample_id}/runs/${run!.run_id}/steps/slice-c-legacy-mime-step`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patchBody("2026-08-20T05:01:00.000Z")),
      },
    ), env, executionContext);
    expect(legacyPatch.status).toBe(200);
    expect(database.prepare(`
      SELECT filename, mime_type, byte_size
      FROM run_step_assets
      WHERE run_step_id = 'slice-c-legacy-mime-step'
        AND asset_id = 'slice-c-legacy-mime-asset'
        AND role = 'execution'
    `).get()).toEqual({
      filename: "legacy-mime.png",
      mime_type: "image/png; charset=binary",
      byte_size: 6,
    });

    const afterLegacy = database.prepare(`
      SELECT updated_at FROM run_steps WHERE id = 'slice-c-legacy-mime-step'
    `).get() as { updated_at: string };
    const renamedPatch = await worker.fetch(new Request(
      `https://app.test/api/samples/${run!.sample_id}/runs/${run!.run_id}/steps/slice-c-legacy-mime-step`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patchBody(afterLegacy.updated_at, {
          filename: "renamed-context.png",
          mimeType: "image/png",
          byteSize: 6,
        })),
      },
    ), env, executionContext);
    expect(renamedPatch.status).toBe(200);
    expect(database.prepare(`
      SELECT filename, mime_type, byte_size
      FROM run_step_assets
      WHERE run_step_id = 'slice-c-legacy-mime-step'
        AND asset_id = 'slice-c-legacy-mime-asset'
        AND role = 'execution'
    `).get()).toEqual({
      filename: "renamed-context.png",
      mime_type: "image/png",
      byte_size: 6,
    });

    const afterRename = database.prepare(`
      SELECT updated_at FROM run_steps WHERE id = 'slice-c-legacy-mime-step'
    `).get() as { updated_at: string };
    const invalidPatch = await worker.fetch(new Request(
      `https://app.test/api/samples/${run!.sample_id}/runs/${run!.run_id}/steps/slice-c-legacy-mime-step`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patchBody(afterRename.updated_at, {
          filename: "new-client.png",
          mimeType: "image/png; charset=binary",
          byteSize: 6,
        })),
      },
    ), env, executionContext);
    expect(invalidPatch.status).toBe(400);

    const beforeStepCount = database.prepare(`
      SELECT COUNT(*) AS count FROM run_steps WHERE run_id = ?
    `).get(run!.run_id) as { count: number };
    const invalidPost = await worker.fetch(new Request(
      `https://app.test/api/samples/${run!.sample_id}/runs/${run!.run_id}/steps`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Rejected MIME step",
          toolName: "",
          parametersText: "",
          commentsText: "",
          deviationNote: "",
          assetKey: "slice-c/legacy-mime.png",
          assetMetadata: {
            filename: "new-client.png",
            mimeType: "image/png\r\nx-test: injected",
            byteSize: 6,
          },
        }),
      },
    ), env, executionContext);
    expect(invalidPost.status).toBe(400);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM run_steps WHERE run_id = ?
    `).get(run!.run_id)).toEqual(beforeStepCount);

    await createProject(db, {
      id: "slice-c-legacy-mime-project",
      title: "Legacy MIME project",
      operationId: "slice-c-legacy-mime-project-create",
    }, "local-development", "2026-08-20T05:10:00.000Z");
    const projectOccurrence = await createAttachmentProjectItem(
      db,
      "slice-c-legacy-mime-project",
      {
        contentId: "slice-c-legacy-mime-content",
        itemId: "slice-c-legacy-mime-item",
        placementId: "slice-c-legacy-mime-placement",
        locator: { assetId: "slice-c-legacy-mime-asset" },
        caption: null,
        sourceUrl: null,
        geometry: projectGeometry(0),
        expectedProjectRevision: 1,
        operationId: "slice-c-legacy-mime-create",
      },
      "local-development",
      "2026-08-20T05:11:00.000Z",
    );
    expect(projectOccurrence.attachment?.mimeType).toBe("image/png; charset=binary");
    const copied = await copyAttachmentProjectItem(
      db,
      "slice-c-legacy-mime-project",
      {
        sourceContentId: "slice-c-legacy-mime-content",
        contentId: "slice-c-legacy-mime-copy-content",
        itemId: "slice-c-legacy-mime-copy-item",
        placementId: "slice-c-legacy-mime-copy-placement",
        caption: null,
        sourceUrl: null,
        geometry: projectGeometry(360),
        expectedProjectRevision: 2,
        operationId: "slice-c-legacy-mime-copy",
      },
      "local-development",
      "2026-08-20T05:12:00.000Z",
    );
    expect(copied.attachment?.mimeType).toBe("image/png; charset=binary");
    database.close();
  });

});
