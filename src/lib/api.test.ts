import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("comment deletion API", () => {
  it("deletes a run-step comment by id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, deleted: 1 }), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.deleteRunStepComment("comment-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/run-step-comments/comment-1", { method: "DELETE" });
  });

  it("deletes a sample-level record by id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, updatedAt: "now" }), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.deleteSampleRecord("sample-1", "event-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/samples/sample-1/records/event-1", { method: "DELETE" });
  });
});

describe("template removal API", () => {
  it("uses the guarded template delete endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, disposition: "deleted" }), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.removeTemplate("template-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/templates/template-1", { method: "DELETE" });
  });
});
