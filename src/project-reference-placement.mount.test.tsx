// @vitest-environment jsdom
import { forwardRef, useImperativeHandle } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceSearchResult } from "../shared/reference-search";
import type { CreateReferenceProjectItemInput, ProjectItemMutationResponse } from "../shared/project-api";
import type { ProjectGeometryCommand, ProjectNodeDescriptor } from "./lib/project-map-model";
import type { ProjectPendingReferencePlacement, ProjectReferenceDragPayload } from "./lib/project-reference-placement";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

const searchResult: ReferenceSearchResult = {
  target: { type: "sample", id: "sample-new" },
  match: { tier: "exact_id", matchedAt: "2026-08-11T12:00:00.000Z" },
  resolution: {
    target: { type: "sample", id: "sample-new" },
    resolution: "resolved",
    source: {
      title: "Sample New",
      subtitle: "Fresh source",
      excerpt: "Placement fixture",
      kind: "sample",
      state: "stored",
      updatedAt: "2026-08-11T12:00:00.000Z",
      deletedAt: null,
      archivedAt: null,
    },
    contexts: [],
    destination: {
      referenceUrl: "/references/sample/sample-new",
      mode: "source",
      openSourceUrl: "/samples/sample-new",
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
  >Place fixture at center</button>,
}));

vi.mock("./components/project/ProjectMapSurface", () => ({
  ProjectMapSurface: forwardRef(function MockProjectMapSurface({
    nodes,
    pendingReference,
    onSelect,
    onGeometryCommit,
    onReferenceDrop,
  }: {
    nodes: ProjectNodeDescriptor[];
    pendingReference?: ProjectPendingReferencePlacement | null;
    onSelect: (itemId: string | null) => void;
    onGeometryCommit: (command: ProjectGeometryCommand) => void;
    onReferenceDrop?: (payload: ProjectReferenceDragPayload, point: { x: number; y: number }) => void;
  }, ref) {
    useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 500, y: 300 }) }));
    const note = nodes.find((node) => node.itemId === "item-note");
    return <div>
      <p>Map node count: {nodes.length}</p>
      <p>Note x: {note?.geometry.x}</p>
      {pendingReference && <p>Pending ghost: {pendingReference.status} · {pendingReference.preview.title}</p>}
      <button type="button" onClick={() => onSelect("item-reference")}>Select existing reference</button>
      <button type="button" onClick={() => {
        if (!note) return;
        onGeometryCommit({
          placementId: note.placementId,
          before: note.geometry,
          after: { ...note.geometry, x: note.geometry.x + 80 },
        });
      }}>Dirty existing geometry</button>
      <button type="button" onClick={() => onReferenceDrop?.({
        version: 1,
        target: searchResult.target,
        preview: {
          title: "Sample New",
          subtitle: "Fresh source",
          excerpt: "Placement fixture",
          referenceUrl: "/references/sample/sample-new",
          openSourceUrl: "/samples/sample-new",
        },
      }, { x: 650, y: 400 })}>Simulate exact drop</button>
    </div>;
  }),
}));

function desktopMatchMedia() {
  return vi.fn(() => ({
    matches: true,
    media: "(min-width: 860px)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

function insertionResponse(input: CreateReferenceProjectItemInput, revision = 3): ProjectItemMutationResponse {
  const snapshot = projectTestSnapshot();
  const now = "2026-08-11T12:30:00.000Z";
  return {
    item: {
      id: input.itemId,
      projectId: "project-a",
      itemType: "reference",
      projectContentId: null,
      referenceTargetId: "registry-new",
      createdSequence: revision,
      revision: 1,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedBy: null,
    },
    content: null,
    attachment: null,
    placement: {
      id: input.placementId,
      projectItemId: input.itemId,
      ...input.geometry,
      revision: 1,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt: now,
      updatedAt: now,
    },
    project: {
      ...snapshot.project,
      revision,
      nextCreatedSequence: revision + 1,
      updatedAt: now,
    },
    replayed: false,
  };
}

function removalResponse(): ProjectItemMutationResponse {
  const snapshot = projectTestSnapshot();
  const item = snapshot.items.find((candidate) => candidate.id === "item-reference")!;
  const placement = snapshot.placements.find((candidate) => candidate.projectItemId === item.id)!;
  return {
    item: { ...item, revision: 2, deletedAt: "2026-08-11T13:00:00.000Z", deletedBy: "user@example.com" },
    content: null,
    attachment: null,
    placement,
    project: snapshot.project,
    replayed: false,
  };
}

function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }], { initialEntries: ["/projects/project-a"] });
  return render(<RouterProvider router={router} />);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("mounted Project reference placement", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("matchMedia", desktopMatchMedia());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a ghost immediately and commits center placement only after the authoritative POST", async () => {
    const pending = deferred<Response>();
    fetchMock
      .mockImplementationOnce(() => jsonResponse(projectTestSnapshot()))
      .mockImplementationOnce((_path, init) => {
        const input = JSON.parse(String(init?.body)) as CreateReferenceProjectItemInput;
        void input;
        return pending.promise;
      });

    renderProjectPage();
    fireEvent.click(await screen.findByRole("button", { name: "Place fixture at center" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [path, init] = fetchMock.mock.calls[1];
    expect(path).toBe("/api/projects/project-a/items/reference");
    expect(init?.method).toBe("POST");
    const input = JSON.parse(String(init?.body)) as CreateReferenceProjectItemInput;
    expect(input.target).toEqual({ type: "sample", id: "sample-new" });
    expect(input.expectedProjectRevision).toBe(2);
    expect(input.geometry).toEqual({ x: 350, y: 210, width: 300, height: 180, zIndex: 2 });
    expect(screen.getByText("Pending ghost: placing · Sample New")).toBeTruthy();
    expect(screen.getByText("Map node count: 2")).toBeTruthy();

    pending.resolve(new Response(JSON.stringify(insertionResponse(input)), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));
    await waitFor(() => expect(screen.getByText("Map node count: 3")).toBeTruthy());
    expect(screen.queryByText(/Pending ghost:/)).toBeNull();
  });

  it("preserves unrelated dirty geometry while merging a successful structural insertion", async () => {
    fetchMock.mockImplementation((_path, init) => {
      if (!init?.method) return jsonResponse(projectTestSnapshot());
      if (init.method === "POST") {
        const input = JSON.parse(String(init.body)) as CreateReferenceProjectItemInput;
        return jsonResponse(insertionResponse(input), 201);
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });

    renderProjectPage();
    fireEvent.click(await screen.findByRole("button", { name: "Dirty existing geometry" }));
    expect(screen.getByText("Unsaved")).toBeTruthy();
    expect(screen.getByText("Note x: 100")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Place fixture at center" }));

    await waitFor(() => expect(screen.getByText("Map node count: 3")).toBeTruthy());
    expect(screen.getByText("Unsaved")).toBeTruthy();
    expect(screen.getByText("Note x: 100")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(false);
  });

  it("retries an uncertain reference insertion with the exact original mutation identity", async () => {
    fetchMock
      .mockImplementationOnce(() => jsonResponse(projectTestSnapshot()))
      .mockImplementationOnce(() => jsonResponse({ error: "Temporary insertion failure" }, 500))
      .mockImplementationOnce((_path, init) => {
        const input = JSON.parse(String(init?.body)) as CreateReferenceProjectItemInput;
        return jsonResponse(insertionResponse(input), 201);
      });

    renderProjectPage();
    fireEvent.click(await screen.findByRole("button", { name: "Place fixture at center" }));
    expect(await screen.findByText("Temporary insertion failure")).toBeTruthy();
    const first = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual(first);
    await waitFor(() => expect(screen.getByText("Map node count: 3")).toBeTruthy());
  });

  it("allows the same stable target to become two distinct Project occurrences", async () => {
    let revision = 3;
    fetchMock.mockImplementation((_path, init) => {
      if (!init?.method) return jsonResponse(projectTestSnapshot());
      const input = JSON.parse(String(init.body)) as CreateReferenceProjectItemInput;
      return jsonResponse(insertionResponse(input, revision++), 201);
    });

    renderProjectPage();
    const button = await screen.findByRole("button", { name: "Place fixture at center" });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText("Map node count: 3")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Place fixture at center" }));
    await waitFor(() => expect(screen.getByText("Map node count: 4")).toBeTruthy());

    const first = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as CreateReferenceProjectItemInput;
    const second = JSON.parse(String(fetchMock.mock.calls[2][1]?.body)) as CreateReferenceProjectItemInput;
    expect(first.target).toEqual(second.target);
    expect(first.itemId).not.toBe(second.itemId);
    expect(first.placementId).not.toBe(second.placementId);
    expect(first.operationId).not.toBe(second.operationId);
    expect(second.expectedProjectRevision).toBe(3);
  });

  it("removes only the Project occurrence through the Project lifecycle endpoint", async () => {
    fetchMock
      .mockImplementationOnce(() => jsonResponse(projectTestSnapshot()))
      .mockImplementationOnce(() => jsonResponse(removalResponse()));

    renderProjectPage();
    fireEvent.click(await screen.findByRole("button", { name: "Select existing reference" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from Project" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [path, init] = fetchMock.mock.calls[1];
    expect(path).toBe("/api/projects/project-a/items/item-reference");
    expect(init?.method).toBe("DELETE");
    expect(JSON.parse(String(init?.body))).toMatchObject({ expectedItemRevision: 1 });
    expect(fetchMock.mock.calls.some(([requestPath, requestInit]) => (
      String(requestPath).startsWith("/api/samples/") && requestInit?.method === "DELETE"
    ))).toBe(false);
    await waitFor(() => expect(screen.getByText("Map node count: 1")).toBeTruthy());
  });
});
