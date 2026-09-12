import { describe, expect, it } from "vitest";
import type { ReferenceSearchResult } from "../../shared/reference-search";
import {
  PROJECT_REFERENCE_DRAG_MIME,
  PROJECT_REFERENCE_NODE_HEIGHT,
  PROJECT_REFERENCE_NODE_WIDTH,
  findAvailableProjectReferencePoint,
  isProjectReferenceDragPayload,
  projectReferenceDragPayloadFromResolution,
  projectReferenceDragPayloadFromResult,
  projectReferenceGeometryAtPoint,
  projectReferenceRecordFromPreview,
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

  it("keeps Markdown preview format and paragraph boundaries through drag and optimistic placement", () => {
    const searchResult = result();
    const source = String.raw`Diffusion $L=\sqrt{2Dt}$.

$$
D=D_0 e^{-E_a/(k_B T)}
$$`;
    searchResult.resolution.source!.excerpt = source;
    searchResult.resolution.source!.excerptFormat = "markdown";
    const transfer = new TestDataTransfer() as unknown as DataTransfer;
    writeProjectReferenceDragPayload(transfer, searchResult);
    const payload = readProjectReferenceDragPayload(transfer)!;
    expect(payload.preview).toMatchObject({ excerpt: source, excerptFormat: "markdown" });
    expect(projectReferenceRecordFromPreview("registry-comment", payload).resolution.source)
      .toMatchObject({ excerpt: source, excerptFormat: "markdown" });
    expect(isProjectReferenceDragPayload({ ...payload, preview: { ...payload.preview, excerptFormat: "html" } })).toBe(false);
  });

  it("does not truncate Markdown source if an oversized external resolution reaches placement preview", () => {
    const searchResult = result();
    searchResult.resolution.source!.excerpt = `Context.\n\n$$\na=1\n\n${"x + ".repeat(300)}z\n$$`;
    searchResult.resolution.source!.excerptFormat = "markdown";
    expect(projectReferenceDragPayloadFromResult(searchResult).preview)
      .toMatchObject({ excerpt: "Context.", excerptFormat: "markdown" });
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

  it("places repeated button additions in separate nearby spaces without moving existing cards", () => {
    const center = { x: 500, y: 300 };
    const occupied = [projectReferenceGeometryAtPoint(center)!];
    const original = { ...occupied[0] };
    for (let index = 0; index < 20; index += 1) {
      const point = findAvailableProjectReferencePoint(center, occupied);
      expect(point).not.toBeNull();
      const next = projectReferenceGeometryAtPoint(point!)!;
      for (const previous of occupied) {
        expect(next.x + next.width <= previous.x
          || previous.x + previous.width <= next.x
          || next.y + next.height <= previous.y
          || previous.y + previous.height <= next.y).toBe(true);
      }
      occupied.push(next);
    }
    expect(occupied[0]).toEqual(original);
    expect(findAvailableProjectReferencePoint(center, [])).toEqual(center);
  });

  it("finds an edge outside a dense occupied area and rejects unsupported coordinates", () => {
    const center = { x: 500, y: 300 };
    const occupied = Array.from({ length: 100 }, (_, index) => ({
      x: (index % 10) * 1000 - 5000,
      y: Math.floor(index / 10) * 1000 - 5000,
      width: 1000,
      height: 1000,
      zIndex: 0,
    }));
    const point = findAvailableProjectReferencePoint(center, occupied);
    expect(point).not.toBeNull();
    const next = projectReferenceGeometryAtPoint(point!)!;
    expect(next.x >= 5000 || next.x + next.width <= -5000
      || next.y >= 5000 || next.y + next.height <= -5000).toBe(true);
    expect(findAvailableProjectReferencePoint({ x: Infinity, y: 0 }, [])).toBeNull();
    expect(findAvailableProjectReferencePoint({ x: 2_000_000, y: 0 }, [])).toBeNull();
  });

});
