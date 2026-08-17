// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectGeometryCommand, ProjectNodeDescriptor } from "./lib/project-map-model";
import type { ProjectItemSelection } from "./lib/project-canvas-productivity";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/project/ProjectMapSurface", () => ({
  ProjectMapSurface: ({
    nodes,
    onGeometryBatchCommit,
    onSelectionChange,
  }: {
    nodes: ProjectNodeDescriptor[];
    onGeometryBatchCommit?: (commands: ProjectGeometryCommand[]) => void;
    onSelectionChange?: (selection: ProjectItemSelection) => void;
  }) => {
    const note = nodes.find((candidate) => candidate.itemId === "item-note")!;
    const reference = nodes.find((candidate) => candidate.itemId === "item-reference")!;
    return <div data-testid="project-flow-canvas">
      <p>Note x: {note.geometry.x}</p>
      <p>Reference x: {reference.geometry.x}</p>
      <button type="button" onClick={() => onSelectionChange?.({
        itemIds: [note.itemId, reference.itemId],
        primaryItemId: reference.itemId,
      })}>Select two items</button>
      <button type="button" onClick={() => onGeometryBatchCommit?.([{
        placementId: note.placementId,
        before: note.geometry,
        after: { ...note.geometry, x: note.geometry.x + 40 },
      }, {
        placementId: reference.placementId,
        before: reference.geometry,
        after: { ...reference.geometry, x: reference.geometry.x + 40 },
      }])}>Move selected items</button>
    </div>;
  },
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

function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }], { initialEntries: ["/projects/project-a"] });
  return render(<RouterProvider router={router} />);
}

describe("mounted Phase 4B Canvas productivity", () => {
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

  it("projects multi-selection into a bounded Inspector summary and returns to no selection", async () => {
    fetchMock.mockImplementation(() => jsonResponse(projectTestSnapshot()));
    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Select two items" }));
    expect(screen.getByRole("heading", { name: "2 items selected" })).toBeTruthy();
    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(screen.getByText("Sample A")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy stable link" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByText("Select a Map item or edge to inspect it.")).toBeTruthy();
    expect(screen.queryByText("2 selected")).toBeNull();
  });

  it("records grouped movement as one Undo/Redo history command", async () => {
    fetchMock.mockImplementation(() => jsonResponse(projectTestSnapshot()));
    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Select two items" }));
    fireEvent.click(screen.getByRole("button", { name: "Move selected items" }));
    expect(screen.getByText("Note x: 60")).toBeTruthy();
    expect(screen.getByText("Reference x: 360")).toBeTruthy();
    expect(screen.getByText("Unsaved")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByText("Note x: 20")).toBeTruthy();
    expect(screen.getByText("Reference x: 320")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(screen.getByText("Note x: 60")).toBeTruthy();
    expect(screen.getByText("Reference x: 360")).toBeTruthy();
  });

  it("supports select-all, Escape, and explicit keyboard save without a bulk backend API", async () => {
    const snapshot = projectTestSnapshot();
    fetchMock.mockImplementation((request, init) => {
      if (init?.method !== "PATCH") return jsonResponse(snapshot);
      const placementId = String(request).split("/").at(-1)!;
      const body = JSON.parse(String(init.body)) as {
        geometry: ProjectNodeDescriptor["geometry"];
      };
      const placement = snapshot.placements.find((candidate) => candidate.id === placementId)!;
      return jsonResponse({
        value: { ...placement, ...body.geometry, revision: placement.revision + 1 },
        replayed: false,
      });
    });
    renderProjectPage();

    await screen.findByTestId("project-flow-canvas");
    fireEvent.keyDown(document, { key: "a", code: "KeyA", ctrlKey: true });
    expect(screen.getByRole("heading", { name: "2 items selected" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    expect(screen.getByText("Select a Map item or edge to inspect it.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Select two items" }));
    fireEvent.click(screen.getByRole("button", { name: "Move selected items" }));
    expect(screen.getByText("Unsaved")).toBeTruthy();
    fireEvent.keyDown(document, { key: "s", code: "KeyS", ctrlKey: true });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const patchPaths = fetchMock.mock.calls.slice(1).map(([request]) => String(request)).sort();
    expect(patchPaths).toEqual([
      "/api/projects/project-a/placements/placement-note",
      "/api/projects/project-a/placements/placement-reference",
    ]);
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  });
});
