import { describe, expect, it } from "vitest";
import { projectEdgeHistoryTouchesItem, type ProjectEdgeHistoryCommand } from "./project-edge-history";

describe("Project edge history", () => {
  it("identifies commands that must be discarded when either endpoint occurrence is removed", () => {
    const command: ProjectEdgeHistoryCommand = {
      kind: "edge-update",
      edgeId: "edge-a",
      sourceItemId: "item-a",
      targetItemId: "item-b",
      before: { markerStart: "none", markerEnd: "none", label: null },
      after: { markerStart: "none", markerEnd: "arrow", label: "feeds" },
    };
    expect(projectEdgeHistoryTouchesItem(command, "item-a")).toBe(true);
    expect(projectEdgeHistoryTouchesItem(command, "item-b")).toBe(true);
    expect(projectEdgeHistoryTouchesItem(command, "item-c")).toBe(false);
  });
});
