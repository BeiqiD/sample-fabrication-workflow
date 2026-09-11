import { describe, expect, it } from "vitest";
import type { UpdateProjectEdgeInput } from "../shared/project-api";
import {
  createMarkdownProjectItem,
  createProject,
  createProjectEdge,
  deleteProject,
  removeProjectItem,
  restoreProjectItem,
  updateProjectEdge,
} from "./projects/service";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";

const ACTOR = "researcher@example.com";
const NOW = "2026-09-11T12:00:00.000Z";
const geometry = { x: 0, y: 0, width: 320, height: 180, zIndex: 0 };
const reconnect: UpdateProjectEdgeInput = {
  sourceItemId: "item-a",
  targetItemId: "item-c",
  sourceHandle: "bottom",
  targetHandle: "top",
  expectedSourceItemRevision: 1,
  expectedTargetItemRevision: 1,
  markerStart: "none",
  markerEnd: "arrow",
  label: "supports",
  expectedRevision: 1,
  operationId: "reconnect-edge-a",
};

async function fixture() {
  const database = referenceTestDatabase();
  const adapter = new SqliteD1Database(database);
  const db = adapter as unknown as D1Database;
  for (const projectId of ["project-a", "project-b"]) {
    await createProject(db, {
      id: projectId, title: projectId, operationId: `create-${projectId}`,
    }, ACTOR, NOW);
  }
  for (const [index, suffix] of ["a", "b", "c", "d"].entries()) {
    await createMarkdownProjectItem(db, suffix === "d" ? "project-b" : "project-a", {
      contentId: `content-${suffix}`,
      itemId: `item-${suffix}`,
      placementId: `placement-${suffix}`,
      markdownSource: `# ${suffix}`,
      geometry,
      expectedProjectRevision: suffix === "d" ? 1 : index + 1,
      operationId: `create-item-${suffix}`,
    }, ACTOR, NOW);
  }
  await createProjectEdge(db, "project-a", {
    edgeId: "edge-a",
    sourceItemId: "item-a",
    targetItemId: "item-b",
    sourceHandle: "right",
    targetHandle: "left",
    markerStart: "none",
    markerEnd: "arrow",
    label: "supports",
    expectedSourceItemRevision: 1,
    expectedTargetItemRevision: 1,
    operationId: "create-edge-a",
  }, ACTOR, NOW);
  return { database, adapter, db };
}

function readEdge(database: ReturnType<typeof referenceTestDatabase>) {
  return database.prepare("SELECT * FROM project_edges WHERE id = 'edge-a'").get();
}

describe("Project edge reconnection", () => {
  it("reconnects in place, replays once, and keeps creation provenance", async () => {
    const { database, db } = await fixture();
    const before = readEdge(database);
    const result = await updateProjectEdge(db, "project-a", "edge-a", reconnect, ACTOR, NOW);
    expect(result.replayed).toBe(false);
    expect(result.value).toMatchObject({
      id: "edge-a", sourceItemId: "item-a", targetItemId: "item-c",
      sourceHandle: "bottom", targetHandle: "top", label: "supports", revision: 2,
    });
    expect(readEdge(database)).toMatchObject({
      created_at: before?.created_at, created_by: before?.created_by,
    });
    const replay = await updateProjectEdge(db, "project-a", "edge-a", reconnect, ACTOR, NOW);
    expect(replay.replayed).toBe(true);
    expect(replay.value.revision).toBe(2);
    await expect(updateProjectEdge(db, "project-a", "edge-a", {
      ...reconnect, targetItemId: "item-b",
    }, ACTOR, NOW)).rejects.toMatchObject({ code: "conflict" });
    await expect(updateProjectEdge(db, "project-a", "edge-a", {
      ...reconnect, targetHandle: "left",
    }, ACTOR, NOW)).rejects.toMatchObject({ code: "conflict" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM project_edges").get())
      .toEqual({ count: 1 });
    database.close();
  });

  it("supports source and handle changes while preserving metadata-only updates", async () => {
    const { database, db } = await fixture();
    const movedSource = await updateProjectEdge(db, "project-a", "edge-a", {
      ...reconnect, sourceItemId: "item-c", targetItemId: "item-b",
    }, ACTOR, NOW);
    expect(movedSource.value).toMatchObject({ sourceItemId: "item-c", targetItemId: "item-b", revision: 2 });
    const changedHandle = await updateProjectEdge(db, "project-a", "edge-a", {
      ...reconnect, sourceItemId: "item-c", targetItemId: "item-b", sourceHandle: "left",
      expectedRevision: 2, operationId: "move-edge-handle",
    }, ACTOR, NOW);
    expect(changedHandle.value).toMatchObject({ sourceHandle: "left", revision: 3 });
    const metadata = await updateProjectEdge(db, "project-a", "edge-a", {
      markerStart: "arrow", markerEnd: "none", label: "explains",
      expectedRevision: 3, operationId: "edit-edge-label",
    }, ACTOR, NOW);
    expect(metadata.value).toMatchObject({
      sourceItemId: "item-c", targetItemId: "item-b", sourceHandle: "left", targetHandle: "top",
      markerStart: "arrow", markerEnd: "none", label: "explains", revision: 4,
    });
    database.close();
  });

  it.each([
    ["foreign target", { targetItemId: "item-d" }],
    ["foreign source", { sourceItemId: "item-d" }],
    ["missing endpoint", { targetItemId: "item-missing" }],
    ["self edge", { targetItemId: "item-a" }],
    ["stale edge", { expectedRevision: 9 }],
    ["stale source", { expectedSourceItemRevision: 9 }],
    ["stale target", { expectedTargetItemRevision: 9 }],
  ])("rejects %s without changing endpoints, metadata, or revision", async (_label, changed) => {
    const { database, db } = await fixture();
    const before = readEdge(database);
    await expect(updateProjectEdge(db, "project-a", "edge-a", {
      ...reconnect, label: "must not commit", ...changed,
    }, ACTOR, NOW)).rejects.toMatchObject({ code: "conflict" });
    expect(readEdge(database)).toEqual(before);
    database.close();
  });

  it("rejects deleted endpoints and stale remove/restore endpoints atomically", async () => {
    const { database, db } = await fixture();
    const before = readEdge(database);
    await removeProjectItem(db, "project-a", "item-c", {
      expectedItemRevision: 1, expectedContentRevision: 1, operationId: "remove-item-c",
    }, ACTOR, NOW);
    await expect(updateProjectEdge(db, "project-a", "edge-a", reconnect, ACTOR, NOW))
      .rejects.toMatchObject({ code: "conflict" });
    await restoreProjectItem(db, "project-a", "item-c", {
      expectedItemRevision: 2, expectedContentRevision: 2, operationId: "restore-item-c",
    }, ACTOR, NOW);
    await expect(updateProjectEdge(db, "project-a", "edge-a", reconnect, ACTOR, NOW))
      .rejects.toMatchObject({ code: "conflict" });
    expect(readEdge(database)).toEqual(before);
    const result = await updateProjectEdge(db, "project-a", "edge-a", {
      ...reconnect, expectedTargetItemRevision: 3,
    }, ACTOR, NOW);
    expect(result.value).toMatchObject({ targetItemId: "item-c", revision: 2 });
    database.close();
  });

  it("rejects a duplicate connection without partially saving its presentation", async () => {
    const { database, db } = await fixture();
    const before = readEdge(database);
    await createProjectEdge(db, "project-a", {
      edgeId: "edge-duplicate",
      sourceItemId: "item-a", targetItemId: "item-c", sourceHandle: "bottom", targetHandle: "top",
      expectedSourceItemRevision: 1, expectedTargetItemRevision: 1,
      markerStart: "none", markerEnd: "arrow", label: "supports", operationId: "create-duplicate",
    }, ACTOR, NOW);
    await expect(updateProjectEdge(db, "project-a", "edge-a", reconnect, ACTOR, NOW))
      .rejects.toMatchObject({ code: "conflict" });
    expect(readEdge(database)).toEqual(before);
    database.close();
  });

  it.each(["endpoint", "project"])("rejects a %s removed between the read and write", async (kind) => {
    const { database, db } = await fixture();
    const before = readEdge(database);
    const racingDb = {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        if (!/^\s*UPDATE project_edges\b/.test(sql)) return statement;
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            return {
              async run() {
                if (kind === "endpoint") {
                  await removeProjectItem(db, "project-a", "item-c", {
                    expectedItemRevision: 1, expectedContentRevision: 1,
                    operationId: "concurrent-remove-c",
                  }, ACTOR, NOW);
                } else {
                  await deleteProject(db, "project-a", {
                    expectedRevision: 4, operationId: "concurrent-remove-project",
                  }, ACTOR, NOW);
                }
                return bound.run();
              },
            };
          },
        } as D1PreparedStatement;
      },
    } as D1Database;
    await expect(updateProjectEdge(racingDb, "project-a", "edge-a", reconnect, ACTOR, NOW))
      .rejects.toMatchObject({ code: "conflict" });
    expect(readEdge(database)).toEqual(before);
    database.close();
  });

  it("retains database guards for endpoint updates and stable edge identity", async () => {
    const { database } = await fixture();
    const before = readEdge(database);
    expect(() => database.prepare(`
      UPDATE project_edges SET target_item_id = 'item-c' WHERE id = 'edge-a'
    `).run()).toThrow(/next revision/);
    expect(() => database.prepare(`
      UPDATE project_edges SET target_handle = 'top' WHERE id = 'edge-a'
    `).run()).toThrow(/next revision/);
    expect(() => database.prepare(`
      UPDATE project_edges SET target_item_id = 'item-d', revision = 2,
        last_mutation_id = 'foreign-endpoint' WHERE id = 'edge-a'
    `).run()).toThrow(/same project/);
    for (const [column, value] of [
      ["id", "renamed-edge"],
      ["project_id", "project-b"],
      ["created_by", "other@example.com"],
      ["created_at", "2026-09-12T12:00:00.000Z"],
    ]) {
      expect(() => database.prepare(`
        UPDATE project_edges SET ${column} = ?, label = 'renamed', revision = 2,
          last_mutation_id = 'change-identity' WHERE id = 'edge-a'
      `).run(value)).toThrow();
    }
    expect(readEdge(database)).toEqual(before);
    database.close();
  });
});
