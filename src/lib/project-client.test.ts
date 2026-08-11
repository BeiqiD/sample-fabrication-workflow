import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectApiError, createProjectApiId, projectApi } from "./project-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Project client", () => {
  it("creates API-safe client identities", () => {
    const id = createProjectApiId("operation");
    expect(id).toMatch(/^operation-[A-Za-z0-9-]+$/);
    expect(id.length).toBeLessThanOrEqual(256);
  });

  it("preserves HTTP conflict status and sends one compact placement mutation", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: "Placement revision conflict" }),
      { status: 409, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const input = {
      geometry: { x: 1, y: 2, width: 200, height: 120, zIndex: 0 },
      expectedRevision: 4,
      operationId: "operation-a",
    };
    await expect(projectApi.updatePlacement("project-a", "placement-a", input))
      .rejects.toMatchObject<ProjectApiError>({ status: 409, message: "Placement revision conflict" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/project-a/placements/placement-a");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify(input),
    });
  });

  it("uses the authoritative Project collection for list and create", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ projects: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        project: { id: "project-a", title: "Project A" },
        replayed: false,
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await projectApi.list();
    await projectApi.create({
      id: "project-a",
      title: "Project A",
      operationId: "operation-a",
    });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects");
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/projects",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          id: "project-a",
          title: "Project A",
          operationId: "operation-a",
        }),
      }),
    ]);
  });
});
