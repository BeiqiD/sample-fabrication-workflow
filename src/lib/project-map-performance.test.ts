import { describe, expect, it } from "vitest";
import {
  PROJECT_MAP_ENVELOPE_EDGE_COUNT,
  PROJECT_MAP_ENVELOPE_NODE_COUNT,
  PROJECT_MAP_TARGET_EDGE_COUNT,
  PROJECT_MAP_TARGET_NODE_COUNT,
  projectMapDetailLevelForZoom,
  projectMapPerformancePolicy,
} from "./project-map-performance";

describe("Project Map performance policy", () => {
  it("keeps ordinary maps unculled and starts them at full detail", () => {
    expect(projectMapPerformancePolicy(12, 18)).toEqual({
      nodeCount: 12,
      edgeCount: 18,
      scale: "ordinary",
      onlyRenderVisibleElements: false,
      initialDetailLevel: "full",
    });
  });

  it("activates visible-element rendering at the representative target", () => {
    expect(projectMapPerformancePolicy(PROJECT_MAP_TARGET_NODE_COUNT, 0).scale).toBe("target");
    expect(projectMapPerformancePolicy(0, PROJECT_MAP_TARGET_EDGE_COUNT)).toMatchObject({
      scale: "target",
      onlyRenderVisibleElements: true,
      initialDetailLevel: "compact",
    });
  });

  it("recognizes the larger 500-node and 800-edge envelope", () => {
    expect(projectMapPerformancePolicy(PROJECT_MAP_ENVELOPE_NODE_COUNT, 0).scale).toBe("envelope");
    expect(projectMapPerformancePolicy(0, PROJECT_MAP_ENVELOPE_EDGE_COUNT).scale).toBe("envelope");
  });

  it("normalizes invalid counts rather than widening the policy accidentally", () => {
    expect(projectMapPerformancePolicy(Number.NaN, -5)).toMatchObject({
      nodeCount: 0,
      edgeCount: 0,
      scale: "ordinary",
    });
  });
});

describe("Project Map contextual zoom", () => {
  it("keeps ordinary maps at full detail independently of viewport zoom", () => {
    expect(projectMapDetailLevelForZoom(0.1, "compact", "ordinary")).toBe("full");
    expect(projectMapDetailLevelForZoom(1.5, "overview", "ordinary")).toBe("full");
    expect(projectMapDetailLevelForZoom(Number.NaN, "compact", "ordinary")).toBe("full");
  });

  it("uses hysteresis so small viewport changes do not remount rich node content", () => {
    expect(projectMapDetailLevelForZoom(0.29, "compact", "target")).toBe("overview");
    expect(projectMapDetailLevelForZoom(0.35, "overview", "target")).toBe("overview");
    expect(projectMapDetailLevelForZoom(0.4, "overview", "target")).toBe("compact");
    expect(projectMapDetailLevelForZoom(0.7, "full", "target")).toBe("full");
    expect(projectMapDetailLevelForZoom(0.66, "full", "target")).toBe("compact");
    expect(projectMapDetailLevelForZoom(0.78, "compact", "target")).toBe("full");
  });

  it("handles large direct zoom jumps and ignores invalid zoom values", () => {
    expect(projectMapDetailLevelForZoom(1, "overview", "target")).toBe("full");
    expect(projectMapDetailLevelForZoom(0.1, "full", "target")).toBe("overview");
    expect(projectMapDetailLevelForZoom(Number.NaN, "compact", "target")).toBe("compact");
  });
});
