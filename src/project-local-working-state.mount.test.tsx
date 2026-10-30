
// @vitest-environment jsdom
import { forwardRef, useImperativeHandle } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEdgeRecord } from "../shared/project-api";
import type { ProjectMapGeometry } from "../shared/project-types";
import type { ProjectNodeDescriptor } from "./lib/project-map-model";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/ReferenceSearchSurface", () => ({
  ReferenceSearchSurface: () => <div>Reference search fixture</div>,
}));

vi.mock("./components/project/ProjectMapSurface", () => ({
  ProjectMapSurface: forwardRef(function LocalWorkingMap(props: {
    nodes: ProjectNodeDescriptor[];
    edgeInteractionDisabled?: boolean;
    onGeometryCommit: (command: { placementId: string; before: ProjectMapGeometry; after: ProjectMapGeometry }) => void;
    onEdgeConnect?: (connection: { sourceItemId: string; targetItemId: string; sourceHandle: "right"; targetHandle: "left" }) => void;
  }, ref) {
    useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 400, y: 300 }) }));
    const before = { x: 20, y: 40, width: 250, height: 180, zIndex: 0 };
    return <div>
      <p>Edge interaction: {props.edgeInteractionDisabled ? "disabled" : "enabled"}</p>
      <p>Note x: {props.nodes.find((node) => node.itemId === "item-note")?.geometry.x}</p>
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

  it.each(["keyboard", "toolbar"] as const)("allows edge undo and redo through the %s while an independent placement save is in flight", async (entry) => {
    fetchMock.mockImplementation((path, init) => {
      if (!init?.method) return jsonResponse(projectTestSnapshot());
      if (init.method === "PATCH") return new Promise<Response>(() => undefined);
      if (init.method === "POST" && String(path).endsWith("/edges")) {
        return jsonResponse({ value: edgeRecord(), replayed: false });
      }
      if (init.method === "DELETE") return jsonResponse({
        value: { ...edgeRecord(), revision: 2, deletedAt: "2026-09-12T19:00:00Z" }, replayed: false,
      });
      if (init.method === "POST" && String(path).endsWith("/restore")) {
        return jsonResponse({ value: { ...edgeRecord(), revision: 3 }, replayed: false });
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    });

    renderProjectPage();
    await screen.findByText("Edge interaction: enabled");
    fireEvent.click(screen.getByRole("button", { name: "Move note locally" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect local edge" }));
    await screen.findByText("Unsaved");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saving");
    expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(false);
    if (entry === "keyboard") fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    else fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Redo" }).hasAttribute("disabled")).toBe(false));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    if (entry === "keyboard") fireEvent.keyDown(document.body, { key: "z", ctrlKey: true, shiftKey: true });
    else fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith("/restore"))).toHaveLength(1));
    await screen.findByText("Saving");
    expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Note x: 116")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it("keeps geometry undo unavailable through the keyboard and toolbar until its save settles", async () => {
    let finishSave!: (response: Response) => void;
    const pendingSave = new Promise<Response>((resolve) => { finishSave = resolve; });
    fetchMock.mockImplementation((_path, init) => (
      init?.method === "PATCH" ? pendingSave : jsonResponse(projectTestSnapshot())
    ));

    renderProjectPage();
    await screen.findByText("Edge interaction: enabled");
    fireEvent.click(screen.getByRole("button", { name: "Move note locally" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saving");
    expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    expect(screen.getByText("Note x: 116")).toBeTruthy();
    const placement = projectTestSnapshot().placements.find((candidate) => candidate.id === "placement-note")!;
    finishSave(new Response(JSON.stringify({ value: { ...placement, x: 116, revision: 2 }, replayed: false }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    await screen.findByText("Saved");
    expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(false);
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    expect(screen.getByText("Note x: 20")).toBeTruthy();
  });
});
