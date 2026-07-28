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

describe("sample deletion API", () => {
  it("sends the typed code and loaded revision to the guarded endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, deleted: { runs: 1, steps: 3, events: 5, verifications: 1, childrenDetached: 2 } }), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const input = { confirmationCode: "SOD-42", expectedUpdatedAt: "2026-07-22T14:00:00.000Z" };
    await api.deleteSample("sample-42", input);

    expect(fetchMock).toHaveBeenCalledWith("/api/samples/sample-42", {
      method: "DELETE",
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

  it("sends explicit confirmation when finishing will skip unfinished steps", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      completedAt: "2026-07-29T10:15:00.000Z",
      skippedStepCount: 3,
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      expectedSampleUpdatedAt: "2026-07-29T10:10:00.000Z",
      confirmSkipUnfinishedSteps: true,
    };

    await api.finishProcessRun("sample-1", "run-1", input);

    expect(fetchMock).toHaveBeenCalledWith("/api/samples/sample-1/runs/run-1/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  });
});

describe("paginated directory APIs", () => {
  it("encodes sample search, processing filters, and pagination in one request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      samples: [],
      pagination: { page: 3, pageSize: 50, total: 0, totalPages: 1 },
      facets: { active: 0, complete: 0, cancelled: 0, all: 0 },
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await api.listSamples({
      query: "AFM wafer",
      page: 3,
      pageSize: 50,
      view: "processing",
      status: "complete",
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/samples?q=AFM+wafer&page=3&pageSize=50&view=processing&status=complete",
      { signal: controller.signal },
    );
  });

  it("combines sample search, filters, and sorting in one paginated request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      samples: [],
      pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 },
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await api.listSamples({
      query: "InP",
      pageSize: 50,
      sampleStatus: "active",
      location: "Box A",
      parent: "7449",
      workflow: "Bonding",
      sort: "created-desc",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/samples?q=InP&pageSize=50&status=active&location=Box+A&parent=7449&process=Bonding&sort=created-desc",
      undefined,
    );
  });

  it("loads sample filter suggestions independently from the paginated list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      locations: [],
      parents: [],
      workflows: [],
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await api.listSampleDirectoryOptions();

    expect(fetchMock).toHaveBeenCalledWith("/api/sample-directory-options", undefined);
  });

  it("requests process families and metrology templates independently", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ families: [], pagination: { page: 2, pageSize: 20, total: 0, totalPages: 1 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ templates: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 } })));
    vi.stubGlobal("fetch", fetchMock);

    await api.listTemplateFamilies({ query: "etch", page: 2, pageSize: 20 });
    await api.listMetrologyTemplates({ query: "AFM", pageSize: 25 });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/template-families?q=etch&page=2&pageSize=20", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/metrology-templates?q=AFM&pageSize=25", undefined);
  });

  it("uses the lightweight picker view for run workspaces", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ templates: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await api.listTemplates();

    expect(fetchMock).toHaveBeenCalledWith("/api/templates?view=picker", undefined);
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
