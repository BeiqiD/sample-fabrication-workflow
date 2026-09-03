// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListReferenceChildrenResponse } from "../shared/reference-children";
import type { ReferenceResolution } from "../shared/reference-types";
import { ReferenceSearchSurface } from "./components/ReferenceSearchSurface";
import { PROJECT_REFERENCE_DRAG_MIME } from "./lib/project-reference-placement";
import { projectReferenceTargetKey } from "./lib/project-reference-suggestions";
import {
  defaultReferenceSearchUiState,
  type ReferenceSearchUiState,
} from "./lib/reference-search-ui";

const child: ReferenceResolution = {
  target: { type: "run", id: "run-a" },
  resolution: "resolved",
  source: {
    title: "Etch run",
    subtitle: "Sample A · Run 2",
    excerpt: "ICP etch followed by endpoint inspection",
    kind: "process",
    state: "active",
    updatedAt: "2026-09-03T10:00:00.000Z",
    deletedAt: null,
    archivedAt: null,
  },
  contexts: [{
    segments: [{
      type: "sample",
      id: "sample-a",
      label: "Sample A",
      deletedAt: null,
      archivedAt: null,
    }, {
      type: "run",
      id: "run-a",
      label: "Etch run",
      deletedAt: null,
      archivedAt: null,
    }],
  }],
  destination: {
    referenceUrl: "/references/run/r1_run-a",
    mode: "source",
    openSourceUrl: "/processing/sample-a?run=run-a",
    contextOpenSourceUrls: ["/processing/sample-a?run=run-a"],
  },
};

const childrenResponse: ListReferenceChildrenResponse = {
  parent: {
    target: { type: "sample", id: "sample-a" },
    resolution: "resolved",
    source: {
      title: "Sample A",
      subtitle: "Stored sample",
      excerpt: null,
      kind: "sample",
      state: "stored",
      updatedAt: "2026-09-03T09:00:00.000Z",
      deletedAt: null,
      archivedAt: null,
    },
    contexts: [],
    destination: {
      referenceUrl: "/references/sample/r1_sample-a",
      mode: "source",
      openSourceUrl: "/samples/sample-a",
      contextOpenSourceUrls: ["/samples/sample-a"],
    },
  },
  parentEligible: true,
  children: [child],
  truncated: false,
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

function jsonResponse(payload: unknown) {
  return Promise.resolve(new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

describe("Project suggested references", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => jsonResponse(childrenResponse));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens on explainable suggestions, keeps repeat placement visible, and uses compact scopes", async () => {
    const onPlace = vi.fn();

    function Harness() {
      const [value, setValue] = useState<ReferenceSearchUiState>(
        defaultReferenceSearchUiState(),
      );
      return <ReferenceSearchSurface
        mode="place"
        value={value}
        onChange={setValue}
        onPlaceAtCenter={vi.fn()}
        suggestionSeeds={[{
          target: { type: "sample", id: "sample-a" },
          title: "Sample A",
          origin: "selection",
        }]}
        placedTargetCounts={{ [projectReferenceTargetKey(child.target)]: 1 }}
        onPlaceResolutionAtCenter={onPlace}
      />;
    }

    render(<MemoryRouter><Harness /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Etch run" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Suggested references" })).toBeTruthy();
    expect(screen.getByText("Selected · Sample A")).toBeTruthy();
    expect(screen.getByText("On Map")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/references/children");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      parent: { type: "sample", id: "sample-a" },
      limit: 12,
    });

    const transfer = new TestDataTransfer();
    fireEvent.dragStart(screen.getByTitle("Drag reference to Map"), {
      dataTransfer: transfer,
    });
    expect(JSON.parse(transfer.getData(PROJECT_REFERENCE_DRAG_MIME))).toMatchObject({
      version: 1,
      target: child.target,
      preview: { title: "Etch run" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Place Etch run at Map center" }));
    expect(onPlace).toHaveBeenCalledWith(child);

    fireEvent.click(screen.getByRole("button", { name: "Files & data" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Etch run" })).toBeNull());
    expect(screen.getByText(/No suggested records match this type/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Process" }));
    expect(await screen.findByRole("heading", { name: "Etch run" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses search as a refinement path and returns cleanly to Suggested", async () => {
    fetchMock.mockImplementation((path) => {
      if (path === "/api/references/search") {
        return jsonResponse({
          query: "profile",
          results: [{
            target: child.target,
            match: { tier: "content", matchedAt: child.source?.updatedAt ?? null },
            resolution: child,
          }],
          truncated: false,
        });
      }
      return jsonResponse(childrenResponse);
    });

    function Harness() {
      const [value, setValue] = useState<ReferenceSearchUiState>(
        defaultReferenceSearchUiState(),
      );
      return <ReferenceSearchSurface
        mode="place"
        value={value}
        onChange={setValue}
        onPlaceAtCenter={vi.fn()}
        placedTargetCounts={{ [projectReferenceTargetKey(child.target)]: 2 }}
        suggestionSeeds={[{
          target: { type: "sample", id: "sample-a" },
          title: "Sample A",
          origin: "project",
        }]}
      />;
    }

    render(<MemoryRouter><Harness /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Suggested references" })).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Search records…"), {
      target: { value: "profile" },
    });
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    fireEvent.change(await screen.findByPlaceholderText("Optional exact Sample ID"), {
      target: { value: "sample-a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(screen.getByText("1 result")).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Suggested references" })).toBeNull();
    expect(screen.getByText("2 on Map")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(await screen.findByRole("heading", { name: "Suggested references" })).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => (
      path === "/api/references/children"
    ))).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "More filters" })).toBeNull();
  });

  it("aborts stale recommendation requests when the Project context changes", async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_path, init) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise<Response>(() => undefined);
    });
    const value = defaultReferenceSearchUiState();
    const view = render(<MemoryRouter>
      <ReferenceSearchSurface
        mode="place"
        value={value}
        onChange={vi.fn()}
        onPlaceAtCenter={vi.fn()}
        suggestionSeeds={[{
          target: { type: "sample", id: "sample-a" },
          title: "Sample A",
          origin: "project",
        }]}
      />
    </MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    view.rerender(<MemoryRouter>
      <ReferenceSearchSurface
        mode="place"
        value={value}
        onChange={vi.fn()}
        onPlaceAtCenter={vi.fn()}
        suggestionSeeds={[{
          target: { type: "sample", id: "sample-b" },
          title: "Sample B",
          origin: "selection",
        }]}
      />
    </MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });
});
