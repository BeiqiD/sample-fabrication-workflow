import { describe, expect, it } from "vitest";
import {
  isProjectContentType,
  isProjectEdgeHandle,
  isProjectEdgeMarker,
  isProjectEdgeShape,
  isProjectItemType,
  isProjectMapGeometry,
  isProjectNonNegativeSafeInteger,
  isProjectPositiveSafeInteger,
  MAX_PROJECT_MAP_COORDINATE_ABS,
  MAX_PROJECT_MAP_NODE_SIZE,
  MAX_PROJECT_MAP_Z_INDEX_ABS,
  MAX_PROJECT_SAFE_INTEGER,
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

  it("keeps persisted counters inside the JavaScript safe-integer domain", () => {
    expect(MAX_PROJECT_SAFE_INTEGER).toBe(9_007_199_254_740_991);
    expect(isProjectPositiveSafeInteger(1)).toBe(true);
    expect(isProjectPositiveSafeInteger(MAX_PROJECT_SAFE_INTEGER)).toBe(true);
    expect(isProjectPositiveSafeInteger(0)).toBe(false);
    expect(isProjectPositiveSafeInteger(1.5)).toBe(false);
    expect(isProjectPositiveSafeInteger(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isProjectPositiveSafeInteger(MAX_PROJECT_SAFE_INTEGER + 1)).toBe(false);
    expect(isProjectNonNegativeSafeInteger(0)).toBe(true);
    expect(isProjectNonNegativeSafeInteger(MAX_PROJECT_SAFE_INTEGER)).toBe(true);
    expect(isProjectNonNegativeSafeInteger(-1)).toBe(false);
    expect(isProjectNonNegativeSafeInteger(Number.NaN)).toBe(false);
  });

  it("accepts only finite, bounded, positive Map geometry", () => {
    expect(isProjectMapGeometry({
      x: MAX_PROJECT_MAP_COORDINATE_ABS,
      y: -MAX_PROJECT_MAP_COORDINATE_ABS,
      width: MAX_PROJECT_MAP_NODE_SIZE,
      height: MAX_PROJECT_MAP_NODE_SIZE,
      zIndex: MAX_PROJECT_MAP_Z_INDEX_ABS,
    })).toBe(true);
    expect(isProjectMapGeometry({ x: Number.NaN, y: 0, width: 1, height: 1, zIndex: 0 })).toBe(false);
    expect(isProjectMapGeometry({ x: Number.POSITIVE_INFINITY, y: 0, width: 1, height: 1, zIndex: 0 })).toBe(false);
    expect(isProjectMapGeometry({ x: 0, y: Number.NEGATIVE_INFINITY, width: 1, height: 1, zIndex: 0 })).toBe(false);
    expect(isProjectMapGeometry({
      x: MAX_PROJECT_MAP_COORDINATE_ABS + 1,
      y: 0,
      width: 1,
      height: 1,
      zIndex: 0,
    })).toBe(false);
    expect(isProjectMapGeometry({ x: 0, y: 0, width: 0, height: 1, zIndex: 0 })).toBe(false);
    expect(isProjectMapGeometry({
      x: 0,
      y: 0,
      width: MAX_PROJECT_MAP_NODE_SIZE + 1,
      height: 1,
      zIndex: 0,
    })).toBe(false);
    expect(isProjectMapGeometry({ x: 0, y: 0, width: 1, height: 1, zIndex: 0.5 })).toBe(false);
    expect(isProjectMapGeometry({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      zIndex: MAX_PROJECT_MAP_Z_INDEX_ABS + 1,
    })).toBe(false);
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
