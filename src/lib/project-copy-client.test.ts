import { afterEach, describe, expect, it, vi } from "vitest";
import { projectApi } from "./project-client";

const input = {
  sourceContentId: "source-content",
  contentId: "copied-content",
  itemId: "copied-item",
  placementId: "copied-placement",
  caption: null,
  sourceUrl: null,
  geometry: { x: 32, y: 32, width: 320, height: 180, zIndex: 1 },
  expectedProjectRevision: 2,
  operationId: "copy-attachment",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Project attachment copy client", () => {
  it("uses the source-content copy route without serializing a blob locator", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      item: {},
      content: {},
      attachment: {},
      placement: {},
      project: {},
      replayed: false,
    }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await projectApi.copyAttachmentItem("project-a", input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/projects/project-a/items/attachment/copy");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(input);
    expect(String(init?.body)).not.toContain("locator");
  });
});
