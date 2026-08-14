
// @vitest-environment jsdom
import { forwardRef, useImperativeHandle } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEdgeRecord } from "../shared/project-api";
import type { ProjectMapGeometry } from "../shared/project-types";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/ReferenceSearchSurface", () => ({
  ReferenceSearchSurface: () => <div>Reference search fixture</div>,
}));

vi.mock("./components/project/ProjectMapSurface", () => ({
  ProjectMapSurface: forwardRef(function LocalWorkingMap(props: {
    edgeInteractionDisabled?: boolean;
    onGeometryCommit: (command: { placementId: string; before: ProjectMapGeometry; after: ProjectMapGeometry }) => void;
    onEdgeConnect?: (connection: { sourceItemId: string; targetItemId: string; sourceHandle: "right"; targetHandle: "left" }) => void;
  }, ref) {
    useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 400, y: 300 }) }));
    const before = { x: 20, y: 40, width: 250, height: 180, zIndex: 0 };
    return <div>
      <p>Edge interaction: {props.edgeInteractionDisabled ? "disabled" : "enabled"}</p>
      <button type="button" onClick={() => props.onGeometryCommit({
        placementId: "placement-note",
        before,
        after: { ...before, x: 116 },
      })}>Move note locally</button>
      <button type="button" disabled={props.edgeInteractionDisabled} onClick={() => props.onEdgeConnect?.({
        sourceItemId: "item-note",
        targetItemId: "item-reference",
        sourceHandle: "right",
        targetHandle: "left",
      })}>Connect local edge</button>
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

function edgeRecord(): ProjectEdgeRecord {
  const now = "2026-08-14T08:00:00.000Z";
  return {
    id: "edge-local",
    projectId: "project-a",
    sourceItemId: "item-note",
    targetItemId: "item-reference",
    sourceHandle: "right",
    targetHandle: "left",
    markerStart: "none",
    markerEnd: "none",
    label: null,
    revision: 1,
    createdBy: "user@example.com",
    updatedBy: "user@example.com",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedBy: null,
  };
}

function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }], { initialEntries: ["/projects/project-a"] });
  return render(<RouterProvider router={router} />);
}

describe("Project local working state", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("matchMedia", desktopMatchMedia());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("allows an edge mutation while geometry is locally dirty and before placement autosave", async () => {
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(projectTestSnapshot());
      if (String(path) === "/api/projects/project-a/edges" && init?.method === "POST") {
        return jsonResponse({ value: edgeRecord(), replayed: false }, 201);
      }
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500);
    });

    renderProjectPage();
    expect(await screen.findByText("Edge interaction: enabled")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move note locally" }));
    expect(await screen.findByText("Unsaved")).toBeTruthy();
    expect(screen.getByText("Edge interaction: enabled")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect local edge" }).hasAttribute("disabled")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Connect local edge" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/projects/project-a/edges");
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes("/placements/"))).toBe(false);
  });
});
