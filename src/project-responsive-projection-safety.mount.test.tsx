// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceSearchResult } from "../shared/reference-search";
import type { ProjectGeometryCommand, ProjectNodeDescriptor } from "./lib/project-map-model";
import type { ProjectPendingAttachmentPlacement } from "./lib/project-owned-content";
import type { ProjectPendingReferencePlacement } from "./lib/project-reference-placement";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

const searchResult: ReferenceSearchResult = {
  target: { type: "sample", id: "sample-responsive" },
  match: { tier: "exact_id", matchedAt: "2026-08-14T07:00:00.000Z" },
  resolution: {
    target: { type: "sample", id: "sample-responsive" },
    resolution: "resolved",
    source: {
      title: "Responsive sample",
      subtitle: "Projection lock fixture",
      excerpt: "Pending reference placement",
      kind: "sample",
      state: "stored",
      updatedAt: "2026-08-14T07:00:00.000Z",
      deletedAt: null,
      archivedAt: null,
    },
    contexts: [],
    destination: {
      referenceUrl: "/references/sample/sample-responsive",
      mode: "source",
      openSourceUrl: "/samples/sample-responsive",
      contextOpenSourceUrls: [],
    },
  },
};

vi.mock("./components/ReferenceSearchSurface", () => ({
  ReferenceSearchSurface: ({
    placementDisabled,
    onPlaceAtCenter,
  }: {
    placementDisabled?: boolean;
    onPlaceAtCenter: (result: ReferenceSearchResult) => void;
  }) => <button
    type="button"
    disabled={placementDisabled}
    onClick={() => onPlaceAtCenter(searchResult)}
  >Start pending reference</button>,
}));

vi.mock("./components/project/ProjectMapSurface", async () => {
  const React = await import("react");
  return {
    ProjectMapSurface: React.forwardRef((props: {
      nodes: ProjectNodeDescriptor[];
      pendingReference?: ProjectPendingReferencePlacement | null;
      pendingAttachment?: ProjectPendingAttachmentPlacement | null;
      onGeometryCommit?: (command: ProjectGeometryCommand) => void;
      onAttachmentRequest?: (point: { x: number; y: number }) => void;
    }, ref: React.ForwardedRef<{ getViewportCenter: () => { x: number; y: number } }>) => {
      React.useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 400, y: 300 }) }));
      const note = props.nodes.find((node) => node.itemId === "item-note");
      return <div data-testid="responsive-project-map">
        <p>Responsive Map fixture</p>
        {props.pendingReference && <p>Pending reference state: {props.pendingReference.status}</p>}
        {props.pendingAttachment && <p>Pending attachment state: {props.pendingAttachment.status}</p>}
        <button type="button" onClick={() => {
          if (!note) return;
          props.onGeometryCommit?.({
            placementId: note.placementId,
            before: note.geometry,
            after: { ...note.geometry, x: note.geometry.x + 40 },
          });
        }}>Dirty geometry</button>
        <button type="button" onClick={() => props.onAttachmentRequest?.({ x: 300, y: 240 })}>Request attachment</button>
      </div>;
    }),
  };
});

function controllableMatchMedia(initialMatches = true) {
  const query = "(min-width: 860px)";
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    get matches() { return matches; },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener as (event: MediaQueryListEvent) => void);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener as (event: MediaQueryListEvent) => void);
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;

  return {
    matchMedia: vi.fn(() => media),
    setMatches(next: boolean) {
      matches = next;
      const event = { matches: next, media: query } as MediaQueryListEvent;
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }], { initialEntries: ["/projects/project-a"] });
  return render(<RouterProvider router={router} />);
}

function expectDesktopMapFrozen() {
  expect(screen.getByTestId("responsive-project-map")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Project Reading" })).toBeNull();
  expect(document.querySelector(".project-page")?.className).toContain("desktop");
  expect(screen.getByRole("button", { name: "Reading" }).hasAttribute("disabled")).toBe(true);
}

describe("responsive Project projection safety", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let media = controllableMatchMedia(true);

  beforeEach(() => {
    fetchMock.mockReset();
    media = controllableMatchMedia(true);
    vi.stubGlobal("matchMedia", media.matchMedia);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps desktop Map visible when the breakpoint changes during pending reference placement", async () => {
    const pending = deferred<Response>();
    fetchMock
      .mockImplementationOnce(() => jsonResponse(projectTestSnapshot()))
      .mockImplementationOnce(() => pending.promise);

    renderProjectPage();
    await screen.findByText("Responsive Map fixture");
    fireEvent.click(screen.getByRole("button", { name: "Start pending reference" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Pending reference state: placing")).toBeTruthy();

    act(() => media.setMatches(false));
    expectDesktopMapFrozen();
  });

  it("keeps desktop Map visible when the breakpoint changes during pending attachment upload", async () => {
    const pending = deferred<Response>();
    const file = new File(["data"], "pending.pdf", { type: "application/pdf" });
    fetchMock
      .mockImplementationOnce(() => jsonResponse(projectTestSnapshot()))
      .mockImplementationOnce(() => pending.promise);

    renderProjectPage();
    await screen.findByText("Responsive Map fixture");
    fireEvent.click(screen.getByRole("button", { name: "Request attachment" }));
    fireEvent.change(screen.getByLabelText("Choose Project attachment"), { target: { files: [file] } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Pending attachment state: uploading")).toBeTruthy();

    act(() => media.setMatches(false));
    expectDesktopMapFrozen();
  });

  it("keeps desktop Map visible when the breakpoint changes with unsaved geometry", async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse(projectTestSnapshot()));

    renderProjectPage();
    await screen.findByText("Responsive Map fixture");
    fireEvent.click(screen.getByRole("button", { name: "Dirty geometry" }));
    expect(await screen.findByText("Unsaved")).toBeTruthy();

    act(() => media.setMatches(false));
    expectDesktopMapFrozen();
  });
});
