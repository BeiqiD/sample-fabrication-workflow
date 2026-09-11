// @vitest-environment jsdom
import { forwardRef, useImperativeHandle } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEdgeRecord, ProjectItemLifecycleInput, ProjectItemMutationResponse } from "../shared/project-api";
import type { ProjectMapContextCommands } from "./components/project/ProjectMapSurface";
import type { ProjectItemSelection } from "./lib/project-canvas-productivity";
import { projectActiveTrashSnapshot } from "./lib/project-item-trash";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/ReferenceSearchSurface", () => ({ ReferenceSearchSurface: () => <div /> }));
vi.mock("./components/project/ProjectMapSurface", () => ({
  ProjectMapSurface: forwardRef(function MockMap({ nodes, edges, geometryInteractionDisabled, onSelectionChange, contextCommands }: {
    nodes: Array<{ itemId: string }>;
    edges: ProjectEdgeRecord[];
    geometryInteractionDisabled: boolean;
    onSelectionChange: (selection: ProjectItemSelection) => void;
    contextCommands: ProjectMapContextCommands;
  }, ref) {
    useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 500, y: 300 }) }));
    return <div>
      <p>Active cards: {nodes.length}</p>
      <p>Active connections: {edges.length}</p>
      <p>Layout locked: {geometryInteractionDisabled ? "yes" : "no"}</p>
      <p>Connection commands locked: {contextCommands.edgeEditDisabled ? "yes" : "no"}</p>
      <button type="button" disabled={contextCommands.removeDisabled} onClick={() => contextCommands.removeItem("item-note")}>Remove note through existing command</button>
      <button type="button" onClick={() => onSelectionChange({ itemIds: ["item-note", "item-reference"], primaryItemId: "item-reference" })}>Select both cards</button>
      <button type="button" disabled={contextCommands.removeSelectionDisabled} onClick={contextCommands.removeSelection}>Remove selected cards</button>
    </div>;
  }),
}));

function fixture() {
  const snapshot = projectTestSnapshot();
  const item = snapshot.items[0]!;
  snapshot.edges = [{
    id: "edge-cascade", projectId: item.projectId, sourceItemId: "item-note", targetItemId: "item-reference",
    sourceHandle: "right", targetHandle: "left", markerStart: "none", markerEnd: "arrow", label: "supports",
    revision: 1, createdBy: item.createdBy, updatedBy: item.updatedBy,
    createdAt: item.createdAt, updatedAt: item.updatedAt, deletedAt: null, deletedBy: null,
  }];
  return snapshot;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function server() {
  const state = fixture();
  const acknowledgements = new Map<string, ProjectItemMutationResponse>();
  let loseNoteResponse = false;
  const mutate = (id: string, input: ProjectItemLifecycleInput, remove: boolean) => {
    const previous = acknowledgements.get(input.operationId);
    if (previous) return { ...structuredClone(previous), replayed: true };
    const item = state.items.find((candidate) => candidate.id === id)!;
    const content = state.contents.find((candidate) => candidate.id === item.projectContentId) ?? null;
    expect(input.expectedItemRevision).toBe(item.revision);
    if (content) expect(input.expectedContentRevision).toBe(content.revision);
    item.revision += 1;
    item.deletedAt = remove ? "2026-09-11T12:00:00Z" : null;
    item.deletedBy = remove ? item.updatedBy : null;
    item.deletionOperationId = remove ? input.operationId : null;
    if (content) { content.revision += 1; content.deletedAt = item.deletedAt; content.deletedBy = item.deletedBy; }
    if (remove) state.edges.forEach((edge) => {
      if (edge.deletedAt === null && (edge.sourceItemId === id || edge.targetItemId === id)) {
        edge.deletedAt = item.deletedAt; edge.deletedBy = item.deletedBy;
        edge.deletionOperationId = input.operationId; edge.revision += 1;
      }
    });
    const result = structuredClone({ item, content, attachment: null,
      placement: state.placements.find((placement) => placement.projectItemId === id)!,
      project: state.project, replayed: false });
    acknowledgements.set(input.operationId, result);
    return result;
  };
  const fetchMock = vi.fn<typeof fetch>(async (path, init) => {
    const url = String(path);
    if (!init?.method && url.startsWith("/api/projects/project-a")) {
      return json(url.includes("includeDeleted=1") ? state : projectActiveTrashSnapshot(state));
    }
    const itemMatch = url.match(/\/items\/([^/]+)(\/restore)?$/);
    if (itemMatch && (init?.method === "DELETE" || init?.method === "POST")) {
      const result = mutate(itemMatch[1]!, JSON.parse(String(init.body)), init.method === "DELETE");
      if (loseNoteResponse && itemMatch[1] === "item-note" && init.method === "DELETE") {
        loseNoteResponse = false;
        return json({ error: "Deletion acknowledgement lost" }, 500);
      }
      return json(result);
    }
    if (init?.method === "POST" && url.endsWith("/edges/edge-cascade/restore")) {
      const edge = state.edges[0]!;
      const input = JSON.parse(String(init.body));
      expect(input.expectedRevision).toBe(edge.revision);
      expect(state.items.every((item) => item.deletedAt === null)).toBe(true);
      edge.revision += 1; edge.deletedAt = null; edge.deletedBy = null; edge.deletionOperationId = null;
      return json({ value: edge, replayed: false });
    }
    throw new Error(`Unexpected ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { state, fetchMock, loseNextNoteResponse: () => { loseNoteResponse = true; } };
}

function renderPage() {
  const router = createMemoryRouter([
    { path: "/projects/:projectId", element: <ProjectPage /> },
    { path: "/projects", element: <p>Projects destination</p> },
  ], { initialEntries: ["/projects/project-a"] });
  return { router, ...render(<RouterProvider router={router} />) };
}

describe("Project page trash integration", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query.includes("min-width"), media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("uses Ctrl+Z to undo the existing single-card removal when there is no geometry history", async () => {
    const remote = server();
    renderPage();
    await screen.findByText("Active cards: 2");
    fireEvent.click(screen.getByRole("button", { name: "Remove note through existing command" }));
    await screen.findByText("Active cards: 1");
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await screen.findByText("Active cards: 2");
    await screen.findByText("Active connections: 1");
    expect(screen.getByText("Layout locked: no")).toBeTruthy();
    expect(screen.getByText("Connection commands locked: no")).toBeTruthy();
    expect(remote.fetchMock.mock.calls.filter(([path]) => String(path).endsWith("/items/item-note/restore"))).toHaveLength(1);
  });

  it("restores a batch through Project trash and releases both card and connection commands", async () => {
    const remote = server();
    const originalPlacements = structuredClone(remote.state.placements);
    renderPage();
    await screen.findByText("Active cards: 2");
    fireEvent.click(screen.getByRole("button", { name: "Select both cards" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove selected cards" }));
    await screen.findByText("Active cards: 0");
    await screen.findByRole("button", { name: "View trash" });
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Project trash" }));
    const panel = await screen.findByRole("region", { name: "Project trash" });
    await waitFor(() => expect(within(panel).getAllByRole("checkbox")).toHaveLength(2));
    within(panel).getAllByRole("checkbox").forEach((checkbox) => fireEvent.click(checkbox));
    fireEvent.click(within(panel).getByRole("button", { name: "Restore selected (2)" }));
    await screen.findByText("Active cards: 2");
    await screen.findByText("Active connections: 1");
    await within(panel).findByText("Trash is empty.");
    expect(screen.getByText("Layout locked: no")).toBeTruthy();
    expect(screen.getByText("Connection commands locked: no")).toBeTruthy();
    expect(remote.state.placements).toEqual(originalPlacements);
    expect(remote.state.items.every((item) => item.deletedAt === null)).toBe(true);
  });

  it("blocks route changes and beforeunload while a partial removal is uncertain, then resumes after exact retry", async () => {
    const remote = server();
    remote.loseNextNoteResponse();
    const view = renderPage();
    await screen.findByText("Active cards: 2");
    fireEvent.click(screen.getByRole("button", { name: "Select both cards" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove selected cards" }));
    await screen.findByRole("button", { name: "Retry safely" });
    expect(screen.getByText("Layout locked: yes")).toBeTruthy();
    expect(screen.getByText("Connection commands locked: yes")).toBeTruthy();
    const deletes = () => remote.fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(deletes()).toHaveLength(2);
    const uncertainBody = String(deletes()[1]![1]!.body);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await act(async () => { await view.router.navigate("/projects"); });
    expect(view.router.state.location.pathname).toBe("/projects/project-a");
    expect(await screen.findByRole("alertdialog", { name: "Unsaved Project changes" })).toBeTruthy();
    expect(screen.queryByText("Projects destination")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry safely" }));
    await screen.findByText("Projects destination");
    expect(deletes()).toHaveLength(3);
    expect(String(deletes()[2]![1]!.body)).toBe(uncertainBody);
    const afterUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterUnload);
    expect(afterUnload.defaultPrevented).toBe(false);
  });
});
