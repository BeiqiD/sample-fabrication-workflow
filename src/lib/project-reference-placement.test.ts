import { describe, expect, it } from "vitest";
import type { ReferenceSearchResult } from "../../shared/reference-search";
import {
  PROJECT_REFERENCE_DRAG_MIME,
  PROJECT_REFERENCE_NODE_HEIGHT,
  PROJECT_REFERENCE_NODE_WIDTH,
  isProjectReferenceDragPayload,
  projectReferenceDragPayloadFromResolution,
  projectReferenceDragPayloadFromResult,
  projectReferenceGeometryAtPoint,
  readProjectReferenceDragPayload,
  writeProjectReferenceDragPayload,
} from "./project-reference-placement";

function result(): ReferenceSearchResult {
  return {
    target: { type: "sample", id: "sample-a" },
    match: { tier: "exact_id", matchedAt: "2026-08-11T12:00:00.000Z" },
    resolution: {
      target: { type: "sample", id: "sample-a" },
      resolution: "resolved",
      source: {
        title: "Sample A",
        subtitle: "Stored sample",
        excerpt: "Display-safe search excerpt",
        kind: "sample",
        state: "stored",
        updatedAt: "2026-08-11T12:00:00.000Z",
        deletedAt: null,
        archivedAt: null,
      },
      contexts: [{ segments: [{
        type: "sample",
        id: "sample-a",
        label: "Sample A",
        deletedAt: null,
        archivedAt: null,
      }] }],
      destination: {
        referenceUrl: "/references/sample/sample-a",
        mode: "source",
        openSourceUrl: "/samples/sample-a",
        contextOpenSourceUrls: ["/samples/sample-a"],
      },
    },
  };
}

class TestDataTransfer {
  effectAllowed = "none";
  private readonly values = new Map<string, string>();

  setData(type: string, value: string) {
    this.values.set(type, value);
  }

  getData(type: string) {
    return this.values.get(type) ?? "";
  }
}

describe("Project reference placement client contract", () => {
  it("serializes only stable target identity plus bounded display-safe preview", () => {
    const payload = projectReferenceDragPayloadFromResult(result());
    expect(payload).toEqual({
      version: 1,
      target: { type: "sample", id: "sample-a" },
      preview: {
        title: "Sample A",
        subtitle: "Stored sample",
        excerpt: "Display-safe search excerpt",
        referenceUrl: "/references/sample/sample-a",
        openSourceUrl: "/samples/sample-a",
      },
    });
    expect(JSON.stringify(payload)).not.toContain("updatedAt");
    expect(JSON.stringify(payload)).not.toContain("contexts");
    expect(JSON.stringify(payload)).not.toContain("registry");
    expect(JSON.stringify(payload)).not.toContain("r2");
  });

  it("builds the same bounded placement payload from an authoritative child resolution", () => {
    const searchResult = result();
    expect(projectReferenceDragPayloadFromResolution(searchResult.resolution))
      .toEqual(projectReferenceDragPayloadFromResult(searchResult));
  });

  it("round-trips the versioned custom drag payload and rejects malformed input", () => {
    const transfer = new TestDataTransfer() as unknown as DataTransfer;
    const payload = writeProjectReferenceDragPayload(transfer, result());
    expect((transfer as unknown as TestDataTransfer).effectAllowed).toBe("copy");
    expect(readProjectReferenceDragPayload(transfer)).toEqual(payload);

    (transfer as unknown as TestDataTransfer).setData(PROJECT_REFERENCE_DRAG_MIME, JSON.stringify({
      ...payload,
      target: { type: "sample", id: "" },
    }));
    expect(readProjectReferenceDragPayload(transfer)).toBeNull();
    expect(isProjectReferenceDragPayload({ ...payload, version: 2 })).toBe(false);
  });

  it("centers the deterministic reference card at drop or viewport-center coordinates", () => {
    expect(projectReferenceGeometryAtPoint({ x: 500, y: 300 }, 4)).toEqual({
      x: 500 - PROJECT_REFERENCE_NODE_WIDTH / 2,
      y: 300 - PROJECT_REFERENCE_NODE_HEIGHT / 2,
      width: PROJECT_REFERENCE_NODE_WIDTH,
      height: PROJECT_REFERENCE_NODE_HEIGHT,
      zIndex: 4,
    });
    expect(projectReferenceGeometryAtPoint({ x: Number.POSITIVE_INFINITY, y: 0 })).toBeNull();
  });
});
