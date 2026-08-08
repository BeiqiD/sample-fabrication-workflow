// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchReferencesResponse } from "../shared/reference-search";
import type { ReferenceSearchResult } from "../shared/reference-search";
import type { ReferenceTarget } from "../shared/reference-types";
import { ReferenceSearchSurface } from "./components/ReferenceSearchSurface";
import { defaultReferenceSearchUiState } from "./lib/reference-search-ui";

function result(
  id: string,
  title: string,
  referenceUrl = `/references/sample/${id}`,
): ReferenceSearchResult {
  return {
    target: { type: "sample", id },
    match: { tier: "exact_id", matchedAt: "2026-08-09T12:00:00.000Z" },
    resolution: {
      target: { type: "sample", id },
      resolution: "resolved",
      source: {
        title,
        subtitle: "Stored sample",
        excerpt: "Reference search fixture",
        kind: "sample",
        state: "stored",
        updatedAt: "2026-08-09T12:00:00.000Z",
        deletedAt: null,
        archivedAt: null,
      },
      contexts: [{
        segments: [{
          type: "sample",
          id,
          label: title,
          deletedAt: null,
          archivedAt: null,
        }],
      }],
      destination: {
        referenceUrl,
        mode: "source",
        openSourceUrl: `/samples/${id}`,
        contextOpenSourceUrls: [`/samples/${id}`],
      },
    },
  };
}

function response(results: ReferenceSearchResult[], truncated = false): SearchReferencesResponse {
  return { query: "fixture", results, truncated };
}

function jsonResponse(payload: unknown) {
  return Promise.resolve(new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

describe("mounted reference search surface", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("waits for committed state, sends the exact Phase 2C1 payload, and preserves server order", async () => {
    const first = result("sample-first", "First server result");
    const second = result("sample-second", "Second server result");
    fetchMock.mockImplementation(() => jsonResponse(response([first, second], true)));
    const onChange = vi.fn();
    const idle = defaultReferenceSearchUiState();

    const view = render(<MemoryRouter>
      <ReferenceSearchSurface value={idle} onChange={onChange} />
    </MemoryRouter>);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Search the research record" })).toBeTruthy();

    const committed = {
      query: "Case-ID",
      types: ["sample" as const],
      sampleId: "sample-first",
      from: "2026-08-01",
      to: "2026-08-09",
    };
    view.rerender(<MemoryRouter>
      <ReferenceSearchSurface value={committed} onChange={onChange} />
    </MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "First server result" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/references/search");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "Case-ID",
      types: ["sample"],
      sampleId: "sample-first",
      from: "2026-08-01",
      to: "2026-08-09",
    });

    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "First server result",
      "Second server result",
    ]);
    expect(screen.getByText(/More matches may exist/)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Open source" })[0].getAttribute("href"))
      .toBe("/samples/sample-first");
    expect(screen.getAllByRole("link", { name: "Reference details" })[0].getAttribute("href"))
      .toBe("/references/sample/sample-first");
  });

  it("returns only the stable target in selection mode and performs no insertion write", async () => {
    const selectedResult = result("sample-a", "Selectable sample");
    fetchMock.mockImplementation(() => jsonResponse(response([selectedResult])));
    const onSelect = vi.fn<(target: ReferenceTarget) => void>();
    const onChange = vi.fn();
    const committed = { ...defaultReferenceSearchUiState(), query: "sample-a" };

    const view = render(<MemoryRouter>
      <ReferenceSearchSurface
        mode="select"
        value={committed}
        onChange={onChange}
        selectedTarget={null}
        onSelect={onSelect}
      />
    </MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    expect(onSelect).toHaveBeenCalledWith({ type: "sample", id: "sample-a" });
    expect(screen.queryByText(/Add to project/i)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    view.rerender(<MemoryRouter>
      <ReferenceSearchSurface
        mode="select"
        value={committed}
        onChange={onChange}
        selectedTarget={{ type: "sample", id: "sample-a" }}
        onSelect={onSelect}
      />
    </MemoryRouter>);
    expect(screen.getByRole("button", { name: "Selected" }).getAttribute("aria-pressed"))
      .toBe("true");
  });

  it("aborts the stale request when committed state changes", async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<(value: Response) => void> = [];
    fetchMock.mockImplementation((_path, init) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise<Response>((resolve) => resolvers.push(resolve));
    });
    const onChange = vi.fn();
    const first = { ...defaultReferenceSearchUiState(), query: "first" };
    const second = { ...defaultReferenceSearchUiState(), query: "second" };

    const view = render(<MemoryRouter>
      <ReferenceSearchSurface value={first} onChange={onChange} />
    </MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    view.rerender(<MemoryRouter>
      <ReferenceSearchSurface value={second} onChange={onChange} />
    </MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);

    resolvers[1](new Response(JSON.stringify(response([result("sample-b", "Current result")])), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    expect(await screen.findByRole("heading", { name: "Current result" })).toBeTruthy();
  });
});
