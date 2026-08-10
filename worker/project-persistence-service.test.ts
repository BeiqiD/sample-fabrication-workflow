import { describe, expect, it } from "vitest";
import type {
  CreateMarkdownProjectItemInput,
} from "../shared/project-api";
import {
  createAttachmentProjectItem,
  createMarkdownProjectItem,
  createProject,
  createProjectEdge,
  createReferenceProjectItem,
  deleteProject,
  listProjects,
  readProjectAttachmentMediaSource,
  readProjectSnapshot,
  removeProjectItem,
  renameProject,
  restoreProject,
  restoreProjectEdge,
  restoreProjectItem,
  updateProjectAttachment,
  updateProjectMarkdown,
  updateProjectPlacement,
} from "./projects/service";
import {
  REFERENCE_FIXTURE_IDS,
  referenceTestDatabase,
  seedReferenceGraph,
  SqliteD1Database,
} from "./reference-test-support";

const ACTOR = "researcher@example.com";
const NOW = "2026-08-09T21:00:00.000Z";
const geometry = { x: 0, y: 0, width: 320, height: 180, zIndex: 0 };

function fixture(seedReferences = false) {
  const database = referenceTestDatabase();
  if (seedReferences) seedReferenceGraph(database);
  const adapter = new SqliteD1Database(database);
  return {
    database,
    db: adapter as unknown as D1Database,
  };
}

async function seedProject(db: D1Database, id = "project-a") {
  return createProject(db, {
    id,
    title: `Project ${id}`,
    operationId: `create-${id}`,
  }, ACTOR, NOW);
}

function markdownInput(
  suffix: string,
  expectedProjectRevision: number,
): CreateMarkdownProjectItemInput {
  return {
    contentId: `content-${suffix}`,
    itemId: `item-${suffix}`,
    placementId: `placement-${suffix}`,
    markdownSource: `# ${suffix}`,
    geometry: { ...geometry, x: expectedProjectRevision * 10 },
    expectedProjectRevision,
    operationId: `create-markdown-${suffix}`,
  };
}

function seedAsset(
  database: ReturnType<typeof referenceTestDatabase>,
  id = "asset-a",
  key = "projects/asset-a.bin",
) {
  database.prepare(`
    INSERT INTO assets (
      id, r2_key, original_name, mime_type, byte_size,
      status, actor_email, created_at, sha256
    ) VALUES (?, ?, ?, 'application/octet-stream', 4, 'ready', ?, ?, ?)
  `).run(id, key, `${id}.bin`, ACTOR, NOW, "a".repeat(64));
  database.prepare(`
    INSERT INTO blob_gc_ledger (
      store_kind, provider, object_key, blob_record_id, state,
      operation_id, orphaned_at, updated_at
    ) VALUES ('r2', 'r2', ?, ?, 'orphaned', 'gc-orphan', ?, ?)
  `).run(key, id, NOW, NOW);
}

describe("Project persistence service", () => {
  it("provides revisioned, retry-safe Project lifecycle operations", async () => {
    const { database, db } = fixture();
    const input = {
      id: "project-a",
      title: "Project A",
      operationId: "create-project-a",
    };
    const created = await createProject(db, input, ACTOR, NOW);
    expect(created.replayed).toBe(false);
    expect(created.project).toMatchObject({ revision: 1, nextCreatedSequence: 1 });

    const replay = await createProject(db, input, ACTOR, "2026-08-09T21:01:00.000Z");
    expect(replay.replayed).toBe(true);
    expect(replay.project.revision).toBe(1);

    const renamed = await renameProject(db, "project-a", {
      title: "Renamed Project",
      expectedRevision: 1,
      operationId: "rename-project-a",
    }, ACTOR, "2026-08-09T21:02:00.000Z");
    expect(renamed.project).toMatchObject({ title: "Renamed Project", revision: 2 });
    await expect(renameProject(db, "project-a", {
      title: "Stale title",
      expectedRevision: 1,
      operationId: "stale-rename",
    }, ACTOR, NOW)).rejects.toMatchObject({ code: "conflict" });

    const deleted = await deleteProject(db, "project-a", {
      expectedRevision: 2,
      operationId: "delete-project-a",
    }, ACTOR, "2026-08-09T21:03:00.000Z");
    expect(deleted.project).toMatchObject({ revision: 3 });
    expect(deleted.project.deletedAt).not.toBeNull();
    expect((await listProjects(db)).projects).toEqual([]);
    expect((await listProjects(db, true)).projects).toHaveLength(1);

    const restored = await restoreProject(db, "project-a", {
      expectedRevision: 3,
      operationId: "restore-project-a",
    }, ACTOR, "2026-08-09T21:04:00.000Z");
    expect(restored.project).toMatchObject({ revision: 4, deletedAt: null });
    database.close();
  });

  it("rolls back stale item creation and replays one committed Markdown insertion", async () => {
    const { database, db } = fixture();
    await seedProject(db);
    const stale = markdownInput("stale", 99);
    await expect(createMarkdownProjectItem(db, "project-a", stale, ACTOR, NOW))
      .rejects.toMatchObject({ code: "conflict" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM project_contents").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM project_items").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT revision, next_created_sequence FROM projects WHERE id = 'project-a'").get())
      .toEqual({ revision: 1, next_created_sequence: 1 });

    const input = markdownInput("a", 1);
    const created = await createMarkdownProjectItem(db, "project-a", input, ACTOR, NOW);
    expect(created.replayed).toBe(false);
    expect(created.item).toMatchObject({ createdSequence: 1, revision: 1 });
    expect(created.project).toMatchObject({ revision: 2, nextCreatedSequence: 2 });

    const replay = await createMarkdownProjectItem(
      db,
      "project-a",
      input,
      ACTOR,
      "2026-08-09T21:05:00.000Z",
    );
    expect(replay.replayed).toBe(true);
    expect(replay.project.nextCreatedSequence).toBe(2);

    await expect(createMarkdownProjectItem(db, "project-a", {
      ...input,
      markdownSource: "different payload",
    }, ACTOR, NOW)).rejects.toMatchObject({ code: "conflict" });

    const edited = await updateProjectMarkdown(db, "project-a", "content-a", {
      markdownSource: "# Edited",
      expectedRevision: 1,
      operationId: "edit-markdown-a",
    }, ACTOR, "2026-08-09T21:06:00.000Z");
    expect(edited.value).toMatchObject({ markdownSource: "# Edited", revision: 2 });
    await expect(updateProjectMarkdown(db, "project-a", "content-a", {
      markdownSource: "# Stale",
      expectedRevision: 1,
      operationId: "stale-edit-markdown-a",
    }, ACTOR, NOW)).rejects.toMatchObject({ code: "conflict" });
    database.close();
  });

  it("registers resolved references atomically and permits repeated occurrences", async () => {
    const { database, db } = fixture(true);
    await seedProject(db);
    const target = { type: "sample" as const, id: REFERENCE_FIXTURE_IDS.sampleA };
    const staleInput = {
      itemId: "item-reference-stale",
      placementId: "placement-reference-stale",
      target,
      geometry,
      expectedProjectRevision: 99,
      operationId: "insert-reference-stale",
    };
    await expect(createReferenceProjectItem(db, "project-a", staleInput, ACTOR, NOW, "registry-stale"))
      .rejects.toMatchObject({ code: "conflict" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM reference_targets
      WHERE target_type = 'sample' AND target_id = ?
    `).get(target.id)).toEqual({ count: 0 });

    const firstInput = {
      itemId: "item-reference-a",
      placementId: "placement-reference-a",
      target,
      geometry,
      expectedProjectRevision: 1,
      operationId: "insert-reference-a",
    };
    const first = await createReferenceProjectItem(
      db,
      "project-a",
      firstInput,
      ACTOR,
      NOW,
      "registry-reference-a",
    );
    expect(first.item).toMatchObject({ itemType: "reference", createdSequence: 1 });

    const second = await createReferenceProjectItem(db, "project-a", {
      itemId: "item-reference-b",
      placementId: "placement-reference-b",
      target,
      geometry: { ...geometry, x: 400 },
      expectedProjectRevision: 2,
      operationId: "insert-reference-b",
    }, ACTOR, "2026-08-09T21:01:00.000Z", "ignored-registry-id");
    expect(second.item.createdSequence).toBe(2);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM reference_targets
      WHERE target_type = 'sample' AND target_id = ?
    `).get(target.id)).toEqual({ count: 1 });

    const replay = await createReferenceProjectItem(
      db,
      "project-a",
      firstInput,
      ACTOR,
      "2026-08-09T21:02:00.000Z",
      "another-ignored-id",
    );
    expect(replay.replayed).toBe(true);
    expect(replay.project.nextCreatedSequence).toBe(3);

    const snapshot = await readProjectSnapshot(db, "project-a");
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.references).toHaveLength(1);
    expect(snapshot.references[0].resolution.target).toEqual(target);
    expect(snapshot.references[0].resolution.resolution).toBe("resolved");
    database.close();
  });

  it("binds authoritative attachment metadata and rolls back orphan claims on conflict", async () => {
    const { database, db } = fixture();
    await seedProject(db);
    seedAsset(database);
    const staleInput = {
      contentId: "content-attachment-stale",
      itemId: "item-attachment-stale",
      placementId: "placement-attachment-stale",
      locator: { assetId: "asset-a" },
      caption: null,
      sourceUrl: null,
      geometry,
      expectedProjectRevision: 99,
      operationId: "create-attachment-stale",
    } as const;
    await expect(createAttachmentProjectItem(db, "project-a", staleInput, ACTOR, NOW))
      .rejects.toMatchObject({ code: "conflict" });
    expect(database.prepare(`
      SELECT state FROM blob_gc_ledger
      WHERE store_kind = 'r2' AND object_key = 'projects/asset-a.bin'
    `).get()).toEqual({ state: "orphaned" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM project_content_attachments").get())
      .toEqual({ count: 0 });

    const input = {
      contentId: "content-attachment-a",
      itemId: "item-attachment-a",
      placementId: "placement-attachment-a",
      locator: { assetId: "asset-a" },
      caption: "Initial caption",
      sourceUrl: "https://example.test/source",
      geometry,
      expectedProjectRevision: 1,
      operationId: "create-attachment-a",
    } as const;
    const created = await createAttachmentProjectItem(db, "project-a", input, ACTOR, NOW);
    expect(created.attachment).toMatchObject({
      originalName: "asset-a.bin",
      mimeType: "application/octet-stream",
      byteSize: 4,
    });
    expect(database.prepare(`
      SELECT state FROM blob_gc_ledger
      WHERE store_kind = 'r2' AND object_key = 'projects/asset-a.bin'
    `).get()).toBeUndefined();
    expect(database.prepare(`
      SELECT retention_reason FROM blob_retention_edges
      WHERE object_key = 'projects/asset-a.bin'
    `).get()).toEqual({ retention_reason: "project_attachment" });

    const described = await updateProjectAttachment(db, "project-a", "content-attachment-a", {
      caption: "Updated caption",
      sourceUrl: null,
      expectedRevision: 1,
      operationId: "describe-attachment-a",
    }, ACTOR, "2026-08-09T21:02:00.000Z");
    expect(described.value).toMatchObject({
      attachmentCaption: "Updated caption",
      attachmentSourceUrl: null,
      revision: 2,
    });

    const media = await readProjectAttachmentMediaSource(db, "project-a", "content-attachment-a");
    expect(media).toMatchObject({
      locator: {
        storeKind: "r2",
        provider: "r2",
        objectKey: "projects/asset-a.bin",
        blobRecordId: "asset-a",
      },
      originalName: "asset-a.bin",
    });
    const serialized = JSON.stringify(await readProjectSnapshot(db, "project-a"));
    expect(serialized).not.toContain("projects/asset-a.bin");
    expect(serialized).not.toContain("r2_key");
    expect(serialized).toContain("/api/projects/project-a/contents/content-attachment-a/file");
    database.close();
  });

  it("keeps placement, edge, item, and owned-content lifecycle transactions consistent", async () => {
    const { database, db } = fixture();
    await seedProject(db);
    await createMarkdownProjectItem(db, "project-a", markdownInput("a", 1), ACTOR, NOW);
    await createMarkdownProjectItem(db, "project-a", markdownInput("b", 2), ACTOR, NOW);

    const moved = await updateProjectPlacement(db, "project-a", "placement-a", {
      geometry: { ...geometry, x: 100, y: 50, zIndex: 3 },
      expectedRevision: 1,
      operationId: "move-a",
    }, ACTOR, "2026-08-09T21:01:00.000Z");
    expect(moved.value).toMatchObject({ x: 100, y: 50, zIndex: 3, revision: 2 });

    const edge = await createProjectEdge(db, "project-a", {
      edgeId: "edge-a-b",
      sourceItemId: "item-a",
      targetItemId: "item-b",
      sourceHandle: "right",
      targetHandle: "left",
      markerStart: "none",
      markerEnd: "arrow",
      label: "supports",
      expectedSourceItemRevision: 1,
      expectedTargetItemRevision: 1,
      operationId: "create-edge-a-b",
    }, ACTOR, "2026-08-09T21:02:00.000Z");
    expect(edge.value.revision).toBe(1);

    await expect(removeProjectItem(db, "project-a", "item-a", {
      expectedItemRevision: 1,
      expectedContentRevision: 99,
      operationId: "stale-remove-a",
    }, ACTOR, "2026-08-09T21:03:00.000Z")).rejects.toBeDefined();
    expect(database.prepare("SELECT deleted_at, revision FROM project_items WHERE id = 'item-a'").get())
      .toEqual({ deleted_at: null, revision: 1 });
    expect(database.prepare("SELECT deleted_at, revision FROM project_contents WHERE id = 'content-a'").get())
      .toEqual({ deleted_at: null, revision: 1 });
    expect(database.prepare("SELECT deleted_at, revision FROM project_edges WHERE id = 'edge-a-b'").get())
      .toEqual({ deleted_at: null, revision: 1 });

    const removed = await removeProjectItem(db, "project-a", "item-a", {
      expectedItemRevision: 1,
      expectedContentRevision: 1,
      operationId: "remove-a",
    }, ACTOR, "2026-08-09T21:04:00.000Z");
    expect(removed.item).toMatchObject({ revision: 2 });
    expect(removed.item.deletedAt).not.toBeNull();
    expect(removed.content).toMatchObject({ revision: 2 });
    expect(database.prepare("SELECT deleted_at, revision FROM project_edges WHERE id = 'edge-a-b'").get())
      .toMatchObject({ revision: 2 });

    const activeSnapshot = await readProjectSnapshot(db, "project-a");
    expect(activeSnapshot.items.map((item) => item.id)).toEqual(["item-b"]);
    expect(activeSnapshot.edges).toEqual([]);

    const restored = await restoreProjectItem(db, "project-a", "item-a", {
      expectedItemRevision: 2,
      expectedContentRevision: 2,
      operationId: "restore-a",
    }, ACTOR, "2026-08-09T21:05:00.000Z");
    expect(restored.item).toMatchObject({ revision: 3, deletedAt: null });
    expect(restored.content).toMatchObject({ revision: 3, deletedAt: null });
    expect((await readProjectSnapshot(db, "project-a")).edges).toEqual([]);

    const restoredEdge = await restoreProjectEdge(db, "project-a", "edge-a-b", {
      expectedRevision: 2,
      operationId: "restore-edge-a-b",
    }, ACTOR, "2026-08-09T21:06:00.000Z");
    expect(restoredEdge.value).toMatchObject({ revision: 3, deletedAt: null });
    expect((await readProjectSnapshot(db, "project-a")).edges).toHaveLength(1);
    database.close();
  });

  it("rejects stale owned-content restore replays after later Markdown or attachment mutations", async () => {
    const { database, db } = fixture();
    await seedProject(db);
    await createMarkdownProjectItem(db, "project-a", markdownInput("restore", 1), ACTOR, NOW);
    seedAsset(database, "asset-restore", "projects/asset-restore.bin");
    await createAttachmentProjectItem(db, "project-a", {
      contentId: "content-attachment-restore",
      itemId: "item-attachment-restore",
      placementId: "placement-attachment-restore",
      locator: { assetId: "asset-restore" },
      caption: "Initial caption",
      sourceUrl: null,
      geometry: { ...geometry, x: 400 },
      expectedProjectRevision: 2,
      operationId: "create-attachment-restore",
    }, ACTOR, "2026-08-09T21:01:00.000Z");

    await removeProjectItem(db, "project-a", "item-restore", {
      expectedItemRevision: 1,
      expectedContentRevision: 1,
      operationId: "remove-markdown-restore",
    }, ACTOR, "2026-08-09T21:02:00.000Z");
    await restoreProjectItem(db, "project-a", "item-restore", {
      expectedItemRevision: 2,
      expectedContentRevision: 2,
      operationId: "restore-markdown-restore",
    }, ACTOR, "2026-08-09T21:03:00.000Z");
    await updateProjectMarkdown(db, "project-a", "content-restore", {
      markdownSource: "# Edited after restore",
      expectedRevision: 3,
      operationId: "edit-after-markdown-restore",
    }, ACTOR, "2026-08-09T21:04:00.000Z");
    await expect(restoreProjectItem(db, "project-a", "item-restore", {
      expectedItemRevision: 2,
      expectedContentRevision: 2,
      operationId: "restore-markdown-restore",
    }, ACTOR, "2026-08-09T21:05:00.000Z"))
      .rejects.toMatchObject({ code: "conflict" });

    await removeProjectItem(db, "project-a", "item-attachment-restore", {
      expectedItemRevision: 1,
      expectedContentRevision: 1,
      operationId: "remove-attachment-restore",
    }, ACTOR, "2026-08-09T21:06:00.000Z");
    await restoreProjectItem(db, "project-a", "item-attachment-restore", {
      expectedItemRevision: 2,
      expectedContentRevision: 2,
      operationId: "restore-attachment-restore",
    }, ACTOR, "2026-08-09T21:07:00.000Z");
    await updateProjectAttachment(db, "project-a", "content-attachment-restore", {
      caption: "Edited after restore",
      sourceUrl: "https://example.test/edited",
      expectedRevision: 3,
      operationId: "edit-after-attachment-restore",
    }, ACTOR, "2026-08-09T21:08:00.000Z");
    await expect(restoreProjectItem(db, "project-a", "item-attachment-restore", {
      expectedItemRevision: 2,
      expectedContentRevision: 2,
      operationId: "restore-attachment-restore",
    }, ACTOR, "2026-08-09T21:09:00.000Z"))
      .rejects.toMatchObject({ code: "conflict" });
    database.close();
  });
});
