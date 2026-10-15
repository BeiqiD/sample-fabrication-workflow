import { afterEach, describe, expect, it, vi } from "vitest";
import { projectApi } from "./project-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Project edge client", () => {
  it("uses the normalized create, update, delete, and restore edge routes", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      value: { id: "edge-a", revision: 1 },
      replayed: false,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    vi.stubGlobal("fetch", fetchMock);

    const createInput = {
      edgeId: "edge-a",
      sourceItemId: "item-note",
      targetItemId: "item-reference",
      sourceHandle: "right" as const,
      targetHandle: "left" as const,
      markerStart: "none" as const,
      markerEnd: "none" as const,
      label: null,
      expectedSourceItemRevision: 1,
      expectedTargetItemRevision: 1,
      operationId: "operation-create",
    };
    const updateInput = {
      markerStart: "none" as const,
      markerEnd: "arrow" as const,
      label: "feeds",
      expectedRevision: 1,
      operationId: "operation-update",
    };
    const lifecycleInput = {
      expectedRevision: 2,
      operationId: "operation-lifecycle",
    };

    await projectApi.createEdge("project-a", createInput);
    await projectApi.updateEdge("project-a", "edge-a", updateInput);
    await projectApi.deleteEdge("project-a", "edge-a", lifecycleInput);
    await projectApi.restoreEdge("project-a", "edge-a", lifecycleInput);

    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/projects/project-a/edges",
      expect.objectContaining({ method: "POST", body: JSON.stringify(createInput) }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/projects/project-a/edges/edge-a",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify(updateInput) }),
    ]);
    expect(fetchMock.mock.calls[2]).toEqual([
      "/api/projects/project-a/edges/edge-a",
      expect.objectContaining({ method: "DELETE", body: JSON.stringify(lifecycleInput) }),
    ]);
    expect(fetchMock.mock.calls[3]).toEqual([
      "/api/projects/project-a/edges/edge-a/restore",
      expect.objectContaining({ method: "POST", body: JSON.stringify(lifecycleInput) }),
    ]);
  });
});
