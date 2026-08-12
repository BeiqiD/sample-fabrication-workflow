// @vitest-environment jsdom
import { forwardRef, useImperativeHandle } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectItemMutationResponse } from "../shared/project-api";
import type { ProjectGeometryCommand, ProjectNodeDescriptor } from "./lib/project-map-model";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/ReferenceSearchSurface", () => ({
  ReferenceSearchSurface: () => <div>Reference search fixture</div>,
}));

vi.mock("./components/project/ProjectMapSurface", () => ({
  ProjectMapSurface: forwardRef(function MockProjectMapSurface({
    nodes,
    geometryInteractionDisabled,
    onSelect,
    onGeometryCommit,
  }: {
    nodes: ProjectNodeDescriptor[];
    geometryInteractionDisabled?: boolean;
    onSelect: (itemId: string | null) => void;
    onGeometryCommit: (command: ProjectGeometryCommand) => void;
  }, ref) {
    useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 500, y: 300 }) }));
    const note = nodes.find((node) => node.itemId === "item-note");
    return <div>
      <p>Map ready</p>
      <p>Map node count: {nodes.length}</p>
      <p>Geometry locked: {geometryInteractionDisabled ? "yes" : "no"}</p>
      <button type="button" onClick={() => onSelect("item-reference")}>Select existing reference</button>
      <button type="button" onClick={() => {
        if (!note) return;
        onGeometryCommit({
          placementId: note.placementId,
          before: note.geometry,
          after: { ...note.geometry, x: note.geometry.x + 80 },
        });
      }}>Attempt geometry mutation</button>
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

function removalResponse(replayed = false): ProjectItemMutationResponse {
  const snapshot = projectTestSnapshot();
  const item = snapshot.items.find((candidate) => candidate.id === "item-reference")!;
  const placement = snapshot.placements.find((candidate) => candidate.projectItemId === item.id)!;
  return {
    item: { ...item, revision: 2, deletedAt: "2026-08-11T13:00:00.000Z", deletedBy: "user@example.com" },
    content: null,
    attachment: null,
    placement,
    project: snapshot.project,
    replayed,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }], { initialEntries: ["/projects/project-a"] });
  return render(<RouterProvider router={router} />);
}

describe("Project reference removal safety", () => {
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

  it("freezes geometry for the whole Map while DELETE is in flight", async () => {
    const pendingDelete = deferred<Response>();
    fetchMock.mockImplementation((_path, init) => {
      if (!init?.method) return jsonResponse(projectTestSnapshot());
      if (init.method === "DELETE") return pendingDelete.promise;
      if (init.method === "PATCH") return jsonResponse({ error: "stale placement write" }, 409);
      return jsonResponse({ error: "unexpected request" }, 500);
    });

    renderProjectPage();
    await screen.findByText("Map ready");
    fireEvent.click(screen.getByRole("button", { name: "Select existing reference" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from Project" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    expect(screen.getByText("Geometry locked: yes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Attempt geometry mutation" }));
    await Promise.resolve();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.queryByText("Conflict")).toBeNull();

    pendingDelete.resolve(new Response(JSON.stringify(removalResponse()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await waitFor(() => expect(screen.getByText("Map node count: 1")).toBeTruthy());
    expect(screen.getByText("Geometry locked: no")).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("retries response-lost removal with the exact original lifecycle request", async () => {
    let deleteCount = 0;
    fetchMock.mockImplementation((_path, init) => {
      if (!init?.method) return jsonResponse(projectTestSnapshot());
      if (init.method === "DELETE") {
        deleteCount += 1;
        return deleteCount === 1
          ? jsonResponse({ error: "Temporary removal failure" }, 500)
          : jsonResponse(removalResponse(true));
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    });

    renderProjectPage();
    await screen.findByText("Map ready");
    fireEvent.click(screen.getByRole("button", { name: "Select existing reference" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from Project" }));

    expect(await screen.findByText("Temporary removal failure")).toBeTruthy();
    expect(screen.getByText("Geometry locked: yes")).toBeTruthy();
    const deletes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");
    const originalBody = JSON.parse(String(deletes()[0][1]?.body));
    fireEvent.click(screen.getByRole("button", { name: "Retry removal" }));
    await waitFor(() => expect(deletes()).toHaveLength(2));
    expect(JSON.parse(String(deletes()[1][1]?.body))).toEqual(originalBody);
    expect(deletes()[1][0]).toBe(deletes()[0][0]);

    await waitFor(() => expect(screen.getByText("Map node count: 1")).toBeTruthy());
    expect(screen.getByText("Geometry locked: no")).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
  });
});
