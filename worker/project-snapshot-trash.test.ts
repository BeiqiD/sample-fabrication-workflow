import { describe, expect, it } from "vitest";
import {
  createMarkdownProjectItem,
  createProject,
  createProjectEdge,
  readProjectSnapshot,
  removeProjectItem,
} from "./projects/service";
import {
  referenceTestDatabase,
  SqliteD1Database,
} from "./reference-test-support";

const ACTOR = "trash-user@example.com";
const NOW = "2026-08-09T23:45:00.000Z";
const geometry = { x: 0, y: 0, width: 320, height: 180, zIndex: 0 };

function fixture() {
  const database = referenceTestDatabase();
  const adapter = new SqliteD1Database(database);
  return { database, db: adapter as unknown as D1Database };
}

describe("Project Trash snapshot", () => {
  it("keeps recoverably removed content, placement, and edges discoverable only on request", async () => {
    const { database, db } = fixture();
    await createProject(db, {
      id: "project-trash",
      title: "Trash Project",
      operationId: "create-project-trash",
    }, ACTOR, NOW);
    await createMarkdownProjectItem(db, "project-trash", {
      contentId: "content-trash-a",
      itemId: "item-trash-a",
      placementId: "placement-trash-a",
      markdownSource: "# A",
      geometry,
      expectedProjectRevision: 1,
      operationId: "create-trash-a",
    }, ACTOR, NOW);
    await createMarkdownProjectItem(db, "project-trash", {
      contentId: "content-trash-b",
      itemId: "item-trash-b",
      placementId: "placement-trash-b",
      markdownSource: "# B",
      geometry: { ...geometry, x: 400 },
      expectedProjectRevision: 2,
      operationId: "create-trash-b",
    }, ACTOR, "2026-08-09T23:46:00.000Z");
    await createProjectEdge(db, "project-trash", {
      edgeId: "edge-trash",
      sourceItemId: "item-trash-a",
      targetItemId: "item-trash-b",
      sourceHandle: "right",
      targetHandle: "left",
      markerStart: "none",
      markerEnd: "arrow",
      label: "supports",
      expectedSourceItemRevision: 1,
      expectedTargetItemRevision: 1,
      operationId: "create-edge-trash",
    }, ACTOR, "2026-08-09T23:47:00.000Z");

    await removeProjectItem(db, "project-trash", "item-trash-a", {
      expectedItemRevision: 1,
      expectedContentRevision: 1,
      operationId: "remove-trash-a",
    }, ACTOR, "2026-08-09T23:48:00.000Z");

    const active = await readProjectSnapshot(db, "project-trash");
    expect(active.items.map((item) => item.id)).toEqual(["item-trash-b"]);
    expect(active.contents.map((content) => content.id)).toEqual(["content-trash-b"]);
    expect(active.placements.map((placement) => placement.id)).toEqual(["placement-trash-b"]);
    expect(active.edges).toEqual([]);

    const trash = await readProjectSnapshot(db, "project-trash", true);
    expect(trash.items.map((item) => item.id)).toEqual(["item-trash-a", "item-trash-b"]);
    expect(trash.contents.map((content) => content.id)).toEqual([
      "content-trash-a",
      "content-trash-b",
    ]);
    expect(trash.placements.map((placement) => placement.id)).toEqual([
      "placement-trash-a",
      "placement-trash-b",
    ]);
    expect(trash.edges.map((edge) => edge.id)).toEqual(["edge-trash"]);
    expect(trash.items[0]).toMatchObject({ id: "item-trash-a", revision: 2 });
    expect(trash.items[0].deletedAt).not.toBeNull();
    expect(trash.contents[0]).toMatchObject({ id: "content-trash-a", revision: 2 });
    expect(trash.contents[0].deletedAt).not.toBeNull();
    expect(trash.edges[0]).toMatchObject({ id: "edge-trash", revision: 2 });
    expect(trash.edges[0].deletedAt).not.toBeNull();
    database.close();
  });
});
