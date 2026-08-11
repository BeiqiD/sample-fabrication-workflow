import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectApiError, projectApi } from "./project-api";

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

describe("Project client API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses stable encoded Project routes for list and snapshot reads", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => jsonResponse({ projects: [] }))
      .mockImplementationOnce(() => jsonResponse({ schemaVersion: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await projectApi.listProjects();
    await projectApi.getProject("project/id");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/projects/project%2Fid");
  });

  it("creates Projects and persists one normalized placement mutation", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => jsonResponse({ project: { id: "project-a" }, replayed: false }, 201))
      .mockImplementationOnce(() => jsonResponse({ value: { id: "placement-a", revision: 2 }, replayed: false }));
    vi.stubGlobal("fetch", fetchMock);

    await projectApi.createProject({ id: "project-a", title: "Project A", operationId: "create-a" });
    await projectApi.updatePlacement("project-a", "placement-a", {
      geometry: { x: 12, y: 20, width: 300, height: 180, zIndex: 0 },
      expectedRevision: 1,
      operationId: "move-a",
    });

    const createInit = fetchMock.mock.calls[0][1];
    expect(createInit?.method).toBe("POST");
    expect(JSON.parse(String(createInit?.body))).toEqual({
      id: "project-a",
      title: "Project A",
      operationId: "create-a",
    });

    const placementInit = fetchMock.mock.calls[1][1];
    expect(fetchMock.mock.calls[1][0]).toBe("/api/projects/project-a/placements/placement-a");
    expect(placementInit?.method).toBe("PATCH");
    expect(JSON.parse(String(placementInit?.body))).toEqual({
      geometry: { x: 12, y: 20, width: 300, height: 180, zIndex: 0 },
      expectedRevision: 1,
      operationId: "move-a",
    });
  });

  it("preserves HTTP status so the Map can distinguish conflicts", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(() =>
      jsonResponse({ error: "Project placement revision conflict" }, 409)));

    await expect(projectApi.updatePlacement("project-a", "placement-a", {
      geometry: { x: 0, y: 0, width: 300, height: 180, zIndex: 0 },
      expectedRevision: 2,
      operationId: "move-conflict",
    })).rejects.toMatchObject<ProjectApiError>({
      status: 409,
      message: "Project placement revision conflict",
    });
  });
});
