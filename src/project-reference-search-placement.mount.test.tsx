// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceSearchResult, SearchReferencesResponse } from "../shared/reference-search";
import { ReferenceSearchSurface } from "./components/ReferenceSearchSurface";
import { PROJECT_REFERENCE_DRAG_MIME } from "./lib/project-reference-placement";
import { defaultReferenceSearchUiState } from "./lib/reference-search-ui";

const result: ReferenceSearchResult = {
  target: { type: "sample", id: "sample-a" },
  match: { tier: "exact_id", matchedAt: "2026-08-11T12:00:00.000Z" },
  resolution: {
    target: { type: "sample", id: "sample-a" },
    resolution: "resolved",
    source: {
      title: "Sample A",
      subtitle: "Stored sample",
      excerpt: "Reference search fixture",
      kind: "sample",
      state: "stored",
      updatedAt: "2026-08-11T12:00:00.000Z",
      deletedAt: null,
      archivedAt: null,
    },
    contexts: [],
    destination: {
      referenceUrl: "/references/sample/sample-a",
      mode: "source",
      openSourceUrl: "/samples/sample-a",
      contextOpenSourceUrls: [],
    },
  },
};

class TestDataTransfer {
  effectAllowed = "none";
  dropEffect = "none";
  types: string[] = [];
  private readonly values = new Map<string, string>();

  setData(type: string, value: string) {
    this.values.set(type, value);
    if (!this.types.includes(type)) this.types.push(type);
  }

  getData(type: string) {
    return this.values.get(type) ?? "";
  }
}

describe("Project placement mode on ReferenceSearchSurface", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      query: "sample-a",
      results: [result],
      truncated: false,
    } satisfies SearchReferencesResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("writes only the safe drag payload and performs no Project mutation at drag start", async () => {
    const onPlaceAtCenter = vi.fn();
    const committed = { ...defaultReferenceSearchUiState(), query: "sample-a" };
    render(<MemoryRouter>
      <ReferenceSearchSurface
        mode="place"
        value={committed}
        onChange={vi.fn()}
        onPlaceAtCenter={onPlaceAtCenter}
      />
    </MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Sample A" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/references/search");

    const transfer = new TestDataTransfer();
    fireEvent.dragStart(screen.getByTitle("Drag reference to Map"), {
      dataTransfer: transfer,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(transfer.getData(PROJECT_REFERENCE_DRAG_MIME));
    expect(payload).toEqual({
      version: 1,
      target: { type: "sample", id: "sample-a" },
      preview: {
        title: "Sample A",
        subtitle: "Stored sample",
        excerpt: "Reference search fixture",
        referenceUrl: "/references/sample/sample-a",
        openSourceUrl: "/samples/sample-a",
      },
    });
    expect(JSON.stringify(payload)).not.toContain("contexts");
    expect(JSON.stringify(payload)).not.toContain("updatedAt");

    fireEvent.click(screen.getByRole("button", { name: "Place Sample A at Map center" }));
    expect(onPlaceAtCenter).toHaveBeenCalledWith(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
