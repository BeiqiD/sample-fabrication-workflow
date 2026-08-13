// @vitest-environment jsdom
import { forwardRef, StrictMode, useImperativeHandle } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateProjectEdgeInput,
  ProjectEdgeRecord,
  ProjectSnapshot,
  UpdateProjectEdgeInput,
} from "../shared/project-api";
import type { ProjectPendingEdgePreview } from "./lib/project-edges";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/ReferenceSearchSurface", () => ({
  ReferenceSearchSurface: () => <div>Reference search fixture</div>,
}));

vi.mock("./components/project/ProjectMapSurface", () => ({
  ProjectMapSurface: forwardRef(function MockProjectMapSurface({
    edges = [],
    pendingEdge,
    onEdgeConnect,
    onEdgeSelect,
  }: {
    edges?: ProjectEdgeRecord[];
    pendingEdge?: ProjectPendingEdgePreview | null;
    onEdgeConnect?: (connection: {
      sourceItemId: string;
      targetItemId: string;
      sourceHandle: "top" | "right" | "bottom" | "left";
      targetHandle: "top" | "right" | "bottom" | "left";
    }) => void;
    onEdgeSelect?: (edgeId: string | null) => void;
  }, ref) {
    useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 500, y: 300 }) }));
    return <div>
      <p>Edge Map ready</p>
      <p>Edge count: {edges.length}</p>
      {pendingEdge && <p>Pending edge: {pendingEdge.status}</p>}
      <button type="button" onClick={() => onEdgeConnect?.({
        sourceItemId: "item-note",
        targetItemId: "item-reference",
        sourceHandle: "right",
        targetHandle: "left",
      })}>Connect edge fixture</button>
      {edges[0] && <button type="button" onClick={() => onEdgeSelect?.(edges[0].id)}>Select edge fixture</button>}
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

function edgeRecord(overrides: Partial<ProjectEdgeRecord> = {}): ProjectEdgeRecord {
  const now = "2026-08-13T11:30:00.000Z";
  return {
    id: "edge-a",
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
    ...overrides,
  };
}

function snapshotWithEdge(edge = edgeRecord()): ProjectSnapshot {
  const snapshot = projectTestSnapshot();
  snapshot.edges = [edge];
  return snapshot;
}

function renderProjectPage({ strict = false }: { strict?: boolean } = {}) {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }, {
    path: "/projects",
    element: <p>Projects route</p>,
  }], { initialEntries: ["/projects/project-a"] });
  const view = <RouterProvider router={router} />;
  return render(strict ? <StrictMode>{view}</StrictMode> : view);
}

async function waitForMap() {
  await screen.findByText("Edge Map ready");
}

describe("mounted Project edge behavior", () => {
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

  it("keeps edge mutations active after the React StrictMode setup-cleanup-setup cycle", async () => {
    let createCalls = 0;
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(projectTestSnapshot());
      if (String(path) === "/api/projects/project-a/edges" && init?.method === "POST") {
        createCalls += 1;
        const input = JSON.parse(String(init.body)) as CreateProjectEdgeInput;
        return jsonResponse({
          value: edgeRecord({
            id: input.edgeId,
            sourceItemId: input.sourceItemId,
            targetItemId: input.targetItemId,
            sourceHandle: input.sourceHandle,
            targetHandle: input.targetHandle,
            markerStart: input.markerStart,
            markerEnd: input.markerEnd,
            label: input.label,
          }),
          replayed: false,
        }, 201);
      }
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500);
    });

    renderProjectPage({ strict: true });
    await waitForMap();
    fireEvent.click(screen.getByRole("button", { name: "Connect edge fixture" }));

    await waitFor(() => expect(screen.getByText("Edge count: 1")).toBeTruthy());
    expect(createCalls).toBe(1);
  });

  it("exact-retries an uncertain edge create with the original endpoint revisions and operation identity", async () => {
    const createInputs: CreateProjectEdgeInput[] = [];
    let createAttempt = 0;
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(projectTestSnapshot());
      if (String(path) === "/api/projects/project-a/edges" && init?.method === "POST") {
        const input = JSON.parse(String(init.body)) as CreateProjectEdgeInput;
        createInputs.push(input);
        createAttempt += 1;
        if (createAttempt === 1) return jsonResponse({ error: "Temporary edge failure" }, 500);
        return jsonResponse({
          value: edgeRecord({
            id: input.edgeId,
            sourceItemId: input.sourceItemId,
            targetItemId: input.targetItemId,
            sourceHandle: input.sourceHandle,
            targetHandle: input.targetHandle,
            markerStart: input.markerStart,
            markerEnd: input.markerEnd,
            label: input.label,
          }),
          replayed: false,
        }, 201);
      }
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500);
    });

    renderProjectPage();
    await waitForMap();
    fireEvent.click(screen.getByRole("button", { name: "Connect edge fixture" }));

    expect(await screen.findByText("Temporary edge failure")).toBeTruthy();
    expect(screen.getByText("Pending edge: uncertain")).toBeTruthy();
    expect(createInputs).toHaveLength(1);
    expect(createInputs[0]).toMatchObject({
      sourceItemId: "item-note",
      targetItemId: "item-reference",
      sourceHandle: "right",
      targetHandle: "left",
      markerStart: "none",
      markerEnd: "none",
      label: null,
      expectedSourceItemRevision: 1,
      expectedTargetItemRevision: 1,
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Retry exact edge operation" })[0]);
    await waitFor(() => expect(screen.getByText("Edge count: 1")).toBeTruthy());
    expect(createInputs).toHaveLength(2);
    expect(createInputs[1]).toEqual(createInputs[0]);
    expect(screen.queryByText(/Pending edge:/)).toBeNull();
  });

  it("edits only direction and label while endpoint identity and handles remain fixed", async () => {
    const initial = edgeRecord();
    let updateInput: UpdateProjectEdgeInput | null = null;
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshotWithEdge(initial));
      if (String(path) === "/api/projects/project-a/edges/edge-a" && init?.method === "PATCH") {
        updateInput = JSON.parse(String(init.body)) as UpdateProjectEdgeInput;
        return jsonResponse({
          value: edgeRecord({
            markerStart: updateInput.markerStart,
            markerEnd: updateInput.markerEnd,
            label: updateInput.label,
            revision: 2,
          }),
          replayed: false,
        });
      }
      return jsonResponse({ error: "Unexpected request" }, 500);
    });

    renderProjectPage();
    await waitForMap();
    fireEvent.click(screen.getByRole("button", { name: "Select edge fixture" }));
    expect(screen.getByText("right → left")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit edge" }));
    fireEvent.change(screen.getByLabelText("Direction"), { target: { value: "forward" } });
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "feeds" } });
    fireEvent.click(screen.getByRole("button", { name: "Save edge" }));

    await waitFor(() => expect(updateInput).not.toBeNull());
    expect(updateInput).toMatchObject({
      markerStart: "none",
      markerEnd: "arrow",
      label: "feeds",
      expectedRevision: 1,
    });
    expect(Object.keys(updateInput!).sort()).toEqual([
      "expectedRevision",
      "label",
      "markerEnd",
      "markerStart",
      "operationId",
    ]);
    await screen.findByText("feeds");
  });

  it("undoes and redoes a committed edge deletion through authoritative restore and delete revisions", async () => {
    const lifecycle: Array<{ method: string; expectedRevision: number }> = [];
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshotWithEdge());
      if (String(path) === "/api/projects/project-a/edges/edge-a" && init?.method === "DELETE") {
        const input = JSON.parse(String(init.body)) as { expectedRevision: number };
        lifecycle.push({ method: "DELETE", expectedRevision: input.expectedRevision });
        const revision = lifecycle.length === 1 ? 2 : 4;
        return jsonResponse({
          value: edgeRecord({ revision, deletedAt: "2026-08-13T12:00:00.000Z", deletedBy: "user@example.com" }),
          replayed: false,
        });
      }
      if (String(path) === "/api/projects/project-a/edges/edge-a/restore" && init?.method === "POST") {
        const input = JSON.parse(String(init.body)) as { expectedRevision: number };
        lifecycle.push({ method: "RESTORE", expectedRevision: input.expectedRevision });
        return jsonResponse({ value: edgeRecord({ revision: 3 }), replayed: false });
      }
      return jsonResponse({ error: "Unexpected request" }, 500);
    });

    renderProjectPage();
    await waitForMap();
    fireEvent.click(screen.getByRole("button", { name: "Select edge fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete edge" }));
    await waitFor(() => expect(screen.getByText("Edge count: 0")).toBeTruthy());

    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo.hasAttribute("disabled")).toBe(false);
    fireEvent.click(undo);
    await waitFor(() => expect(screen.getByText("Edge count: 1")).toBeTruthy());

    const redo = screen.getByRole("button", { name: "Redo" });
    expect(redo.hasAttribute("disabled")).toBe(false);
    fireEvent.click(redo);
    await waitFor(() => expect(screen.getByText("Edge count: 0")).toBeTruthy());

    expect(lifecycle).toEqual([
      { method: "DELETE", expectedRevision: 1 },
      { method: "RESTORE", expectedRevision: 2 },
      { method: "DELETE", expectedRevision: 3 },
    ]);
  });

  it("blocks navigation for an edge draft and continues only after the explicit edge save succeeds", async () => {
    let patchCalls = 0;
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshotWithEdge());
      if (String(path) === "/api/projects/project-a/edges/edge-a" && init?.method === "PATCH") {
        patchCalls += 1;
        const input = JSON.parse(String(init.body)) as UpdateProjectEdgeInput;
        return jsonResponse({
          value: edgeRecord({ label: input.label, markerStart: input.markerStart, markerEnd: input.markerEnd, revision: 2 }),
          replayed: false,
        });
      }
      return jsonResponse({ error: "Unexpected request" }, 500);
    });

    renderProjectPage();
    await waitForMap();
    fireEvent.click(screen.getByRole("button", { name: "Select edge fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit edge" }));
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "causes" } });
    fireEvent.click(screen.getByRole("link", { name: "← Projects" }));

    expect(await screen.findByRole("alertdialog", { name: "Unsaved Project changes" })).toBeTruthy();
    expect(screen.queryByText("Projects route")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save edge and leave" }));

    expect(await screen.findByText("Projects route")).toBeTruthy();
    expect(patchCalls).toBe(1);
  });

  it("requires an authoritative reload after an edge update conflict", async () => {
    let reads = 0;
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) {
        reads += 1;
        return jsonResponse(snapshotWithEdge(edgeRecord({ revision: reads === 1 ? 1 : 2, label: reads === 1 ? null : "remote" })));
      }
      if (String(path) === "/api/projects/project-a/edges/edge-a" && init?.method === "PATCH") {
        return jsonResponse({ error: "Edge revision conflict" }, 409);
      }
      return jsonResponse({ error: "Unexpected request" }, 500);
    });

    renderProjectPage();
    await waitForMap();
    fireEvent.click(screen.getByRole("button", { name: "Select edge fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit edge" }));
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "local" } });
    fireEvent.click(screen.getByRole("button", { name: "Save edge" }));

    expect((await screen.findAllByText("Edge revision conflict")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Reload authoritative Project" }));
    await waitFor(() => expect(reads).toBe(2));
    await screen.findByText("Edge Map ready");
    expect(screen.queryByText("Edge revision conflict")).toBeNull();
  });
});
