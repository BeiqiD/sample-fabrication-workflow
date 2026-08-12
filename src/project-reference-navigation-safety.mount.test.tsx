// @vitest-environment jsdom
import { forwardRef, useImperativeHandle } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceSearchResult } from "../shared/reference-search";
import type { CreateReferenceProjectItemInput, ProjectItemMutationResponse, ProjectSnapshot } from "../shared/project-api";
import type { ProjectGeometryCommand, ProjectNodeDescriptor } from "./lib/project-map-model";
import type { ProjectPendingReferencePlacement } from "./lib/project-reference-placement";
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
    onGeometryCommit,
  }: {
    nodes: ProjectNodeDescriptor[];
    pendingReference?: ProjectPendingReferencePlacement | null;
    onGeometryCommit: (command: ProjectGeometryCommand) => void;
  }, ref) {
    useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 500, y: 300 }) }));
    const note = nodes.find((node) => node.itemId === "item-note");
    return <div>
      <p>Map ready</p>
      <p>Note x: {note?.geometry.x}</p>
      {pendingReference && <p>Pending reference: {pendingReference.status}</p>}
      <button type="button" onClick={() => {
        if (!note) return;
        onGeometryCommit({
          placementId: note.placementId,
          before: note.geometry,
          after: { ...note.geometry, x: note.geometry.x + 80 },
        });
      }}>Dirty existing geometry</button>
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

function placementResponse() {
  const placement = projectTestSnapshot().placements.find((candidate) => candidate.id === "placement-note")!;
  return {
    value: { ...placement, x: placement.x + 80, revision: 2 },
    replayed: false,
  };
}

function authoritativeSnapshotWithSavedGeometry(): ProjectSnapshot {
  const snapshot = projectTestSnapshot();
  return {
    ...snapshot,
    project: {
      ...snapshot.project,
      revision: 3,
      nextCreatedSequence: 4,
      updatedAt: "2026-08-11T12:31:00.000Z",
    },
    placements: snapshot.placements.map((placement) => placement.id === "placement-note"
      ? { ...placement, x: placement.x + 80, revision: 2, updatedAt: "2026-08-11T12:31:00.000Z" }
      : placement),
  };
}

function insertionResponse(input: CreateReferenceProjectItemInput): ProjectItemMutationResponse {
  const snapshot = projectTestSnapshot();
  const now = "2026-08-11T12:30:00.000Z";
  return {
    item: {
      id: input.itemId,
      projectId: "project-a",
      itemType: "reference",
      projectContentId: null,
      referenceTargetId: "registry-new",
      createdSequence: 3,
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
    project: { ...snapshot.project, revision: 3, nextCreatedSequence: 4, updatedAt: now },
    replayed: true,
  };
}

function removedInsertionResponse(created: ProjectItemMutationResponse): ProjectItemMutationResponse {
  return {
    ...created,
    item: {
      ...created.item,
      revision: created.item.revision + 1,
      deletedAt: "2026-08-11T12:31:00.000Z",
      deletedBy: "user@example.com",
    },
    replayed: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }, {
    path: "/projects",
    element: <p>Projects route</p>,
  }], { initialEntries: ["/projects/project-a"] });
  return render(<RouterProvider router={router} />);
}

describe("Project reference navigation safety", () => {
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

  it("reconciles an uncertain committed insertion before cancelling, then drains unrelated geometry before DELETE and leaving", async () => {
    const pendingPatch = deferred<Response>();
    let originalInput: CreateReferenceProjectItemInput | null = null;
    let created: ProjectItemMutationResponse | null = null;
    let postCount = 0;
    fetchMock.mockImplementation((_path, init) => {
      if (!init?.method) return jsonResponse(projectTestSnapshot());
      if (init.method === "PATCH") return pendingPatch.promise;
      if (init.method === "POST") {
        postCount += 1;
        const input = JSON.parse(String(init.body)) as CreateReferenceProjectItemInput;
        if (postCount === 1) {
          originalInput = input;
          created = insertionResponse(input);
          return jsonResponse({ error: "Temporary insertion failure" }, 500);
        }
        return jsonResponse(created, 201);
      }
      if (init.method === "DELETE" && created) return jsonResponse(removedInsertionResponse(created));
      return jsonResponse({ error: "unexpected request" }, 500);
    });

    renderProjectPage();
    await screen.findByText("Map ready");
    fireEvent.click(screen.getByRole("button", { name: "Dirty existing geometry" }));
    expect(screen.getByText("Unsaved")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Place fixture at center" }));
    expect(await screen.findByText("Temporary insertion failure")).toBeTruthy();
    expect(screen.getByText("Pending reference: uncertain")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "← Projects" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    expect(screen.queryByText("Projects route")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel placement and leave" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reconcile, cancel and leave" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2));
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(posts[1][1]?.body))).toEqual(originalInput);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
    expect(screen.queryByText("Projects route")).toBeNull();

    pendingPatch.resolve(new Response(JSON.stringify(placementResponse()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1));
    expect(await screen.findByText("Projects route")).toBeTruthy();
  });

  it("saves dirty geometry before a cancellation DELETE conflict can reconcile authoritative structure", async () => {
    const pendingPatch = deferred<Response>();
    let readCount = 0;
    let postCount = 0;
    let created: ProjectItemMutationResponse | null = null;
    fetchMock.mockImplementation((_path, init) => {
      if (!init?.method) {
        readCount += 1;
        return jsonResponse(readCount === 1 ? projectTestSnapshot() : authoritativeSnapshotWithSavedGeometry());
      }
      if (init.method === "PATCH") return pendingPatch.promise;
      if (init.method === "POST") {
        postCount += 1;
        const input = JSON.parse(String(init.body)) as CreateReferenceProjectItemInput;
        if (postCount === 1) {
          created = insertionResponse(input);
          return jsonResponse({ error: "Temporary insertion failure" }, 500);
        }
        return jsonResponse(created, 201);
      }
      if (init.method === "DELETE") return jsonResponse({ error: "Project item is already removed" }, 409);
      return jsonResponse({ error: "unexpected request" }, 500);
    });

    renderProjectPage();
    await screen.findByText("Map ready");
    expect(screen.getByText("Note x: 20")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dirty existing geometry" }));
    expect(screen.getByText("Note x: 100")).toBeTruthy();
    expect(screen.getByText("Unsaved")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Place fixture at center" }));
    expect(await screen.findByText("Temporary insertion failure")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reconcile and cancel" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
    expect(readCount).toBe(1);
    expect(screen.getByText("Pending reference: reconciling")).toBeTruthy();

    pendingPatch.resolve(new Response(JSON.stringify(placementResponse()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1));
    await waitFor(() => expect(readCount).toBe(2));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    expect(screen.getByText("Note x: 100")).toBeTruthy();
    expect(screen.queryByText("Pending reference: reconciling")).toBeNull();
  });

  it("cannot reload a reference conflict over unsaved geometry", async () => {
    fetchMock.mockImplementation((_path, init) => {
      if (!init?.method) return jsonResponse(projectTestSnapshot());
      if (init.method === "POST") return jsonResponse({ error: "Project revision conflict" }, 409);
      if (init.method === "PATCH") return jsonResponse(placementResponse());
      return jsonResponse({ error: "unexpected request" }, 500);
    });

    renderProjectPage();
    await screen.findByText("Map ready");
    fireEvent.click(screen.getByRole("button", { name: "Dirty existing geometry" }));
    fireEvent.click(screen.getByRole("button", { name: "Place fixture at center" }));

    expect(await screen.findByText("Project revision conflict")).toBeTruthy();
    expect(screen.getByText("Resolve existing placement changes before reloading the Project.")).toBeTruthy();
    let reload = screen.getByRole("button", { name: "Reload Project" });
    expect(reload.hasAttribute("disabled")).toBe(true);
    fireEvent.click(reload);
    await Promise.resolve();
    expect(fetchMock.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    reload = screen.getByRole("button", { name: "Reload Project" });
    expect(reload.hasAttribute("disabled")).toBe(false);
    fireEvent.click(reload);

    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText("Pending reference: conflict")).toBeNull());
  });
});
