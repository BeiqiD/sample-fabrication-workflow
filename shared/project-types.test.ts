import { describe, expect, it } from "vitest";
import {
  isProjectContentType,
  isProjectEdgeHandle,
  isProjectEdgeMarker,
  isProjectEdgeShape,
  isProjectItemType,
  isProjectMapGeometry,
  PROJECT_CONTENT_TYPES,
  PROJECT_EDGE_HANDLES,
  PROJECT_EDGE_MARKERS,
  PROJECT_ITEM_TYPES,
} from "./project-types";

describe("Project shared contract", () => {
  it("keeps schema enum values explicit and closed", () => {
    expect(PROJECT_CONTENT_TYPES).toEqual(["markdown", "attachment"]);
    expect(PROJECT_ITEM_TYPES).toEqual(["content", "reference"]);
    expect(PROJECT_EDGE_HANDLES).toEqual(["top", "right", "bottom", "left"]);
    expect(PROJECT_EDGE_MARKERS).toEqual(["none", "arrow"]);
    expect(PROJECT_CONTENT_TYPES.every(isProjectContentType)).toBe(true);
    expect(PROJECT_ITEM_TYPES.every(isProjectItemType)).toBe(true);
    expect(PROJECT_EDGE_HANDLES.every(isProjectEdgeHandle)).toBe(true);
    expect(PROJECT_EDGE_MARKERS.every(isProjectEdgeMarker)).toBe(true);
    expect(isProjectEdgeHandle("center")).toBe(false);
    expect(isProjectEdgeMarker("circle")).toBe(false);
  });

  it("accepts only finite positive Map geometry", () => {
    expect(isProjectMapGeometry({ x: 0, y: -4, width: 320, height: 180, zIndex: 2 })).toBe(true);
    expect(isProjectMapGeometry({ x: Number.NaN, y: 0, width: 1, height: 1, zIndex: 0 })).toBe(false);
    expect(isProjectMapGeometry({ x: 0, y: 0, width: 0, height: 1, zIndex: 0 })).toBe(false);
    expect(isProjectMapGeometry({ x: 0, y: 0, width: 1, height: 1, zIndex: 0.5 })).toBe(false);
  });

  it("validates the basic edge shape without inventing edge semantics", () => {
    expect(isProjectEdgeShape({
      sourceHandle: "right",
      targetHandle: "left",
      markerStart: "none",
      markerEnd: "arrow",
      label: "supports",
    })).toBe(true);
    expect(isProjectEdgeShape({
      sourceHandle: "center",
      targetHandle: "left",
      markerStart: "none",
      markerEnd: "arrow",
      label: null,
    })).toBe(false);
  });
});
