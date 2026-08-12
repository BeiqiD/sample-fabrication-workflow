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

  it("uses Project-owned reference insertion and item-lifecycle routes", async () => {
    const responseBody = JSON.stringify({ replayed: false });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response(responseBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    vi.stubGlobal("fetch", fetchMock);

    const createInput = {
      itemId: "item-a",
      placementId: "placement-a",
      target: { type: "sample" as const, id: "sample-a" },
      geometry: { x: 10, y: 20, width: 300, height: 180, zIndex: 0 },
      expectedProjectRevision: 3,
      operationId: "operation-create",
    };
    await projectApi.createReferenceItem("project-a", createInput);
    await projectApi.removeItem("project-a", "item-a", {
      expectedItemRevision: 1,
      operationId: "operation-remove",
    });

    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/projects/project-a/items/reference",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(createInput),
      }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/projects/project-a/items/item-a",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({
          expectedItemRevision: 1,
          operationId: "operation-remove",
        }),
      }),
    ]);
  });

  it("uses an ASCII-safe filename header and snapshots current upload metadata onto the Project occurrence", async () => {
    const file = new File(["same bytes"], "实验结果.pdf", { type: "application/pdf" });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "asset-deduplicated",
        key: "2026-08-13/original.bin",
        deduplicated: true,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ replayed: false }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const asset = await projectApi.uploadAttachmentAsset(file);
    const createInput = {
      contentId: "content-a",
      itemId: "item-a",
      placementId: "placement-a",
      locator: { assetId: asset.id },
      caption: null,
      sourceUrl: null,
      geometry: { x: 10, y: 20, width: 340, height: 170, zIndex: 1 },
      expectedProjectRevision: 3,
      operationId: "operation-attachment",
    };
    await projectApi.createAttachmentItem("project-a", createInput);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/project-assets");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/pdf",
        "x-project-filename-uri": encodeURIComponent(file.name),
      },
      body: file,
    });
    const createBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(createBody).toEqual({
      ...createInput,
      intrinsicMetadata: {
        originalName: "实验结果.pdf",
        mimeType: "application/pdf",
        byteSize: file.size,
      },
    });
  });
});