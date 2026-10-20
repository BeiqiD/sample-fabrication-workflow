import { describe, expect, it } from "vitest";
import type { ProjectEdgeRecord } from "../../shared/project-api";
import {
  projectEdgeDirection,
  projectEdgeMarkers,
  projectEdgeWouldDuplicate,
  projectItemRevisionIndex,
} from "./project-edges";
import { projectTestSnapshot } from "../project-test-fixture";

function edge(overrides: Partial<ProjectEdgeRecord> = {}): ProjectEdgeRecord {
  return {
    id: "edge-a",
    projectId: "project-a",
    sourceItemId: "item-note",
    targetItemId: "item-reference",
    sourceHandle: "right",
    targetHandle: "left",
    markerStart: "none",
    markerEnd: "none",
    label: null,
    revision: 1,
    createdBy: "user@example.com",
    updatedBy: "user@example.com",
    createdAt: "2026-08-13T10:00:00.000Z",
    updatedAt: "2026-08-13T10:00:00.000Z",
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

describe("Project edge helpers", () => {
  it("maps all four semantic directions to endpoint markers and back", () => {
    for (const direction of ["undirected", "forward", "reverse", "bidirectional"] as const) {
      const markers = projectEdgeMarkers(direction);
      expect(projectEdgeDirection(markers.markerStart, markers.markerEnd)).toBe(direction);
    }
  });

  it("treats endpoint, handle, and direction identity as the duplicate key, not label text", () => {
    const existing = edge({ label: "first meaning" });
    expect(projectEdgeWouldDuplicate([existing], {
      sourceItemId: existing.sourceItemId,
      targetItemId: existing.targetItemId,
      sourceHandle: existing.sourceHandle,
      targetHandle: existing.targetHandle,
      markerStart: existing.markerStart,
      markerEnd: existing.markerEnd,
    })).toBe(true);

    expect(projectEdgeWouldDuplicate([existing], {
      sourceItemId: existing.sourceItemId,
      targetItemId: existing.targetItemId,
      sourceHandle: existing.sourceHandle,
      targetHandle: existing.targetHandle,
      markerStart: "none",
      markerEnd: "arrow",
    })).toBe(false);

    expect(projectEdgeWouldDuplicate([existing], {
      sourceItemId: existing.sourceItemId,
      targetItemId: existing.targetItemId,
      sourceHandle: "bottom",
      targetHandle: existing.targetHandle,
      markerStart: existing.markerStart,
      markerEnd: existing.markerEnd,
    })).toBe(false);
  });

  it("can exclude the edge being edited and exposes authoritative endpoint revisions", () => {
    const existing = edge();
    expect(projectEdgeWouldDuplicate([existing], {
      sourceItemId: existing.sourceItemId,
      targetItemId: existing.targetItemId,
      sourceHandle: existing.sourceHandle,
      targetHandle: existing.targetHandle,
      markerStart: existing.markerStart,
      markerEnd: existing.markerEnd,
    }, existing.id)).toBe(false);

    expect(projectItemRevisionIndex(projectTestSnapshot())).toEqual({
      "item-reference": 1,
      "item-note": 1,
    });
  });
});
