import { describe, expect, it, vi } from "vitest";
import type { ProjectSnapshot } from "../../shared/project-api";
import {
  dirtyPlacementDrafts,
  newProjectOperationId,
  placementDrafts,
  projectMapEdges,
  projectMapNodes,
  projectMobileItems,
} from "./project-map";

function snapshot(): ProjectSnapshot {
  return {
    schemaVersion: 1,
    project: {
      id: "project-a", title: "Project A", revision: 1, nextCreatedSequence: 4,
      createdBy: "a@example.test", updatedBy: "a@example.test",
      createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z",
      deletedAt: null, deletedBy: null,
    },
    contents: [
      {
        id: "content-markdown", projectId: "project-a", contentType: "markdown",
        markdownSource: "# Finding\nA useful observation about the sample.",
        attachmentCaption: null, attachmentSourceUrl: null, formatVersion: 1, revision: 1,
        createdBy: "a@example.test", updatedBy: "a@example.test",
        createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z",
        deletedAt: null, deletedBy: null,
      },
      {
        id: "content-file", projectId: "project-a", contentType: "attachment",
        markdownSource: null, attachmentCaption: "SEM overview", attachmentSourceUrl: null,
        formatVersion: 1, revision: 1, createdBy: "a@example.test", updatedBy: "a@example.test",
        createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z",
        deletedAt: null, deletedBy: null,
      },
    ],
    attachments: [{
      projectContentId: "content-file", originalName: "sem.png", mimeType: "image/png",
      byteSize: 2048, createdBy: "a@example.test", createdAt: "2026-08-10T12:00:00.000Z",
      fileUrl: "/api/projects/project-a/contents/content-file/file",
    }],
    items: [
      { id: "item-ref", projectId: "project-a", itemType: "reference", projectContentId: null, referenceTargetId: "registry-a", createdSequence: 1, revision: 1, createdBy: "a@example.test", updatedBy: "a@example.test", createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z", deletedAt: null, deletedBy: null },
      { id: "item-markdown", projectId: "project-a", itemType: "content", projectContentId: "content-markdown", referenceTargetId: null, createdSequence: 3, revision: 1, createdBy: "a@example.test", updatedBy: "a@example.test", createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z", deletedAt: null, deletedBy: null },
      { id: "item-file", projectId: "project-a", itemType: "content", projectContentId: "content-file", referenceTargetId: null, createdSequence: 2, revision: 1, createdBy: "a@example.test", updatedBy: "a@example.test", createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z", deletedAt: null, deletedBy: null },
    ],
    placements: [
      { id: "placement-ref", projectItemId: "item-ref", x: 10, y: 20, width: 220, height: 120, zIndex: 0, revision: 1, createdBy: "a@example.test", updatedBy: "a@example.test", createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z" },
      { id: "placement-file", projectItemId: "item-file", x: 300, y: 40, width: 240, height: 180, zIndex: 1, revision: 2, createdBy: "a@example.test", updatedBy: "a@example.test", createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z" },
      { id: "placement-markdown", projectItemId: "item-markdown", x: 100, y: 280, width: 320, height: 200, zIndex: 2, revision: 3, createdBy: "a@example.test", updatedBy: "a@example.test", createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z" },
    ],
    edges: [{
      id: "edge-a", projectId: "project-a", sourceItemId: "item-ref", targetItemId: "item-markdown",
      sourceHandle: "right", targetHandle: "left", markerStart: "none", markerEnd: "arrow", label: "motivates",
      revision: 1, createdBy: "a@example.test", updatedBy: "a@example.test",
      createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z",
      deletedAt: null, deletedBy: null,
    }],
    references: [{
      registryId: "registry-a",
      resolution: {
        target: { type: "sample", id: "sample-a" }, resolution: "resolved",
        source: { title: "Sample A", subtitle: "InP test", excerpt: "Reference excerpt", kind: "sample", state: "active", updatedAt: "2026-08-10T12:00:00.000Z", deletedAt: null, archivedAt: null },
        contexts: [],
        destination: { referenceUrl: "/references/sample/sample-a", mode: "source", openSourceUrl: "/samples/sample-a", contextOpenSourceUrls: [] },
      },
    }],
  };
}

describe("Project Map projection", () => {
  it("derives lightweight Markdown, attachment, and reference nodes from normalized snapshot rows", () => {
    const nodes = projectMapNodes(snapshot());
    expect(nodes.map((node) => [node.itemId, node.kind, node.title])).toEqual([
      ["item-ref", "reference", "Sample A"],
      ["item-markdown", "markdown", "Markdown"],
      ["item-file", "attachment", "SEM overview"],
    ]);
    expect(nodes.find((node) => node.itemId === "item-file")?.imageUrl)
      .toBe("/api/projects/project-a/contents/content-file/file");
    expect(nodes.find((node) => node.itemId === "item-ref")?.openUrl)
      .toBe("/references/sample/sample-a");
  });

  it("keeps read-only edges normalized instead of storing React Flow JSON", () => {
    expect(projectMapEdges(snapshot())).toEqual([{
      id: "edge-a",
      sourceItemId: "item-ref",
      targetItemId: "item-markdown",
      sourceHandle: "right",
      targetHandle: "left",
      markerStart: "none",
      markerEnd: "arrow",
      label: "motivates",
    }]);
  });

  it("builds placement drafts and reports only semantic geometry changes as dirty", () => {
    const drafts = placementDrafts(projectMapNodes(snapshot()));
    expect(dirtyPlacementDrafts(drafts)).toEqual([]);
    drafts["item-ref"].geometry = { ...drafts["item-ref"].geometry, x: 24 };
    expect(dirtyPlacementDrafts(drafts).map((draft) => draft.placementId)).toEqual(["placement-ref"]);
    expect(drafts["item-ref"].expectedRevision).toBe(1);
  });

  it("orders the mobile read-only projection by immutable creation sequence", () => {
    expect(projectMobileItems(snapshot()).map((node) => node.itemId)).toEqual([
      "item-ref", "item-file", "item-markdown",
    ]);
    vi.stubGlobal("crypto", { randomUUID: () => "1234" });
    expect(newProjectOperationId("move")).toBe("move-1234");
    vi.unstubAllGlobals();
  });
});
