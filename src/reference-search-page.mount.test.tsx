// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceSearchResult, SearchReferencesResponse } from "../shared/reference-search";
import { SearchPage } from "./pages/SearchPage";

function searchResult(query: string): ReferenceSearchResult {
  const id = `sample-${query}`;
  return {
    target: { type: "sample", id },
    match: { tier: "exact_id", matchedAt: "2026-08-09T12:00:00.000Z" },
    resolution: {
      target: { type: "sample", id },
      resolution: "resolved",
      source: {
        title: `${query} result`,
        subtitle: "Stored sample",
        excerpt: `Result for ${query}`,
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
          label: `${query} result`,
          deletedAt: null,
          archivedAt: null,
        }],
      }],
      destination: {
        referenceUrl: `/references/sample/${id}`,
        mode: "source",
        openSourceUrl: `/samples/${id}`,
        contextOpenSourceUrls: [`/samples/${id}`],
      },
    },
  };
}

function response(query: string): SearchReferencesResponse {
  return { query, results: [searchResult(query)], truncated: false };
}

function HistoryProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <div>
    <output aria-label="Current search URL">{`${location.pathname}${location.search}`}</output>
    <button type="button" onClick={() => navigate(-1)}>Back</button>
  </div>;
}

describe("mounted global Search page", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockImplementation((_path, init) => {
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      return Promise.resolve(new Response(JSON.stringify(response(query)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("pushes committed searches and restores URL, draft, and results through Back", async () => {
    render(<MemoryRouter initialEntries={["/search?q=first&type=sample"]}>
      <Routes>
        <Route path="/search" element={<>
          <SearchPage />
          <HistoryProbe />
        </>} />
      </Routes>
    </MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "first result" })).toBeTruthy();
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("first");
    expect(screen.getByLabelText("Current search URL").textContent)
      .toBe("/search?q=first&type=sample");

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "second" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByRole("heading", { name: "second result" })).toBeTruthy();
    expect(screen.getByLabelText("Current search URL").textContent)
      .toBe("/search?q=second&type=sample");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByRole("heading", { name: "first result" })).toBeTruthy();
    await waitFor(() => {
      expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("first");
      expect(screen.getByLabelText("Current search URL").textContent)
        .toBe("/search?q=first&type=sample");
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries an unchanged query without inserting a duplicate history entry", async () => {
    render(<MemoryRouter
      initialEntries={["/before", "/search?q=retry"]}
      initialIndex={1}
    >
      <Routes>
        <Route path="/before" element={<h1>Before route</h1>} />
        <Route path="/search" element={<>
          <SearchPage />
          <HistoryProbe />
        </>} />
      </Routes>
    </MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "retry result" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Current search URL").textContent)
      .toBe("/search?q=retry");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Before route" })).toBeTruthy();
  });

  it("clears an uncommitted draft without inserting a duplicate history entry", async () => {
    render(<MemoryRouter
      initialEntries={["/before", "/search"]}
      initialIndex={1}
    >
      <Routes>
        <Route path="/before" element={<h1>Before route</h1>} />
        <Route path="/search" element={<>
          <SearchPage />
          <HistoryProbe />
        </>} />
      </Routes>
    </MemoryRouter>);

    expect(screen.getByRole("heading", { name: "Search the research record" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "draft only" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("Current search URL").textContent).toBe("/search");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Before route" })).toBeTruthy();
  });
});
