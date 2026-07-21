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

describe("sample split API", () => {
  it("submits every child as one parent-scoped operation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ children: [{ id: "child-1", code: "SOD-1-1" }], updatedAt: "now" }), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const input = {
      expectedUpdatedAt: "before",
      parentStatusAfter: "consumed" as const,
      pieces: [{ code: "SOD-1-1", title: "Piece", description: "", location: "Box B", status: "stored" as const }],
    };
    await api.splitSample("parent-1", input);

    expect(fetchMock).toHaveBeenCalledWith("/api/samples/parent-1/split", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  });
});

describe("processing sample API", () => {
  it("requests the execution-only sample view", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runs: [], stateVerifications: [] }), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.getProcessingSample("sample-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/samples/sample-1?view=processing", undefined);
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
