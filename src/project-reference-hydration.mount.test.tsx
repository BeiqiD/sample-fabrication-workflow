// @vitest-environment jsdom
import { forwardRef, useImperativeHandle } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateReferenceProjectItemInput, ProjectSnapshot } from "../shared/project-api";
import type { ReferenceResolution, ReferenceTargetType } from "../shared/reference-types";
import type { ProjectGeometryCommand, ProjectNodeDescriptor } from "./lib/project-map-model";
import { projectReferenceDragPayloadFromResolution, type ProjectReferenceDragPayload } from "./lib/project-reference-placement";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

function resolution(type: ReferenceTargetType, id: string): ReferenceResolution {
  const base = structuredClone(projectTestSnapshot().references[0].resolution);
  return {
    ...base,
    target: { type, id },
    source: { ...base.source!, title: id, kind: type },
    contexts: [{ segments: [{ type: "sample", id: "sample-a", label: "sample-a", deletedAt: null, archivedAt: null },
      ...(type === "execution_image" ? [{ type: "run_step" as const, id: "step-a", label: "step-a", deletedAt: null, archivedAt: null }] : [])] }],
  };
}

vi.mock("./components/project/ProjectMapSurface", () => ({
  ProjectMapSurface: forwardRef(function MockMap({ nodes, onSelect, onGeometryCommit, onReferenceDrop }: {
    nodes: ProjectNodeDescriptor[];
    onSelect: (id: string | null) => void;
    onGeometryCommit: (command: ProjectGeometryCommand) => void;
    onReferenceDrop: (payload: ProjectReferenceDragPayload, point: { x: number; y: number }) => void;
  }, ref) {
    useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 500, y: 300 }) }));
    return <div>
      <p>Map nodes: {nodes.length}</p>
      {nodes.map((node) => <div key={node.itemId}>
        <button onClick={() => onSelect(node.itemId)}>Select {node.title}</button>
        <span>{node.title} x: {node.geometry.x}</span>
        <button onClick={() => onGeometryCommit({ placementId: node.placementId, before: node.geometry,
          after: { ...node.geometry, x: node.geometry.x + 80 } })}>Move {node.title}</button>
      </div>)}
      <button onClick={() => onReferenceDrop(projectReferenceDragPayloadFromResolution(
        resolution("execution_image", "image-a")), { x: 500, y: 300 })}>Drop image</button>
    </div>;
  }),
}));

function emptySnapshot(projectId = "project-a") {
  const snapshot = projectTestSnapshot();
  snapshot.project.id = projectId;
  snapshot.references = [];
  snapshot.items = snapshot.items.filter((item) => item.itemType !== "reference");
  snapshot.placements = snapshot.placements.filter((placement) => placement.projectItemId === "item-note");
  return snapshot;
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("Project reference resolution after placement", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const pending = new Map<string, ReturnType<typeof deferred<Response>>>();
  let snapshots: Record<string, ProjectSnapshot>;
  let failResolution = false;

  beforeEach(() => {
    pending.clear();
    failResolution = false;
    snapshots = { "project-a": emptySnapshot(), "project-b": emptySnapshot("project-b") };
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, media: "(min-width: 860px)",
      addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path);
      if (url === "/api/references/search") {
        const { query } = JSON.parse(String(init?.body));
        const source = resolution("sample", query);
        return response({ query, results: [{ target: source.target,
          resolution: source, match: { tier: "exact_id", matchedAt: null } }], truncated: false });
      }
      if (url === "/api/references/resolve") {
        const { targets: [target] } = JSON.parse(String(init?.body));
        if (failResolution) throw new Error("Temporary resolution failure");
        return pending.get(target.id)?.promise ?? response({ results: [resolution(target.type, target.id)] });
      }
      if (url === "/api/references/children") {
        const { parent } = JSON.parse(String(init?.body));
        return response({ parent: resolution(parent.type, parent.id), parentEligible: true,
          children: [resolution("run", `related-${parent.id}`)], truncated: false });
      }
      const projectId = url.split("/")[3];
      const snapshot = snapshots[projectId];
      if (!init?.method) return response(snapshot);
      if (url.endsWith("/items/reference")) {
        const input = JSON.parse(String(init?.body)) as CreateReferenceProjectItemInput;
        const fixture = projectTestSnapshot();
        const item = { ...fixture.items[0], id: input.itemId, projectId,
          referenceTargetId: `registry-${input.target.id}`, createdSequence: ++snapshot.project.revision };
        const placement = { ...fixture.placements[0], id: input.placementId,
          projectItemId: item.id, ...input.geometry };
        snapshot.items.push(item);
        snapshot.placements.push(placement);
        snapshot.references.push({ registryId: item.referenceTargetId,
          resolution: resolution(input.target.type, input.target.id) });
        return response({ item, placement, project: snapshot.project,
          content: null, attachment: null, replayed: false }, 201);
      }
      return response({ error: "Unexpected request" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  function renderPage() {
    const router = createMemoryRouter([{ path: "/projects/:projectId", element: <ProjectPage /> }],
      { initialEntries: ["/projects/project-a"] });
    render(<RouterProvider router={router} />);
    return router;
  }

  async function place(id = "sample-a") {
    const references = await screen.findByRole("button", { name: "References" });
    if (references.getAttribute("aria-pressed") !== "true") fireEvent.click(references);
    fireEvent.change(await screen.findByPlaceholderText("Search records…"), { target: { value: id } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: `Place ${id} on Map` }));
    await screen.findByRole("button", { name: `Select ${id}` });
  }

  function readCalls(endpoint: string) {
    return fetchMock.mock.calls.filter(([path]) => String(path) === endpoint);
  }

  it("uses a newly placed first reference for suggestions without reloading the Project", async () => {
    renderPage();
    await screen.findByText("Map nodes: 1");
    await place();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(await screen.findByRole("heading", { name: "related-sample-a" })).toBeTruthy();
    expect(readCalls("/api/projects/project-a")).toHaveLength(1);
    expect(readCalls("/api/references/resolve")).toHaveLength(1);
  });

  it("hydrates a dropped leaf context while retaining subsequent local geometry and history", async () => {
    const request = deferred<Response>();
    pending.set("image-a", request);
    renderPage();
    await screen.findByText("Map nodes: 1");
    fireEvent.click(screen.getByRole("button", { name: "Drop image" }));
    await screen.findByRole("button", { name: "Select image-a" });
    fireEvent.click(screen.getByRole("button", { name: "Move Design note" }));
    await act(async () => request.resolve(response({ results: [resolution("execution_image", "image-a")] })));
    expect(await screen.findByRole("heading", { name: "related-step-a" })).toBeTruthy();
    expect(screen.getByText("Design note x: 100")).toBeTruthy();
    expect(screen.getByText("Unsaved")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps independent readbacks alive when two insertions complete before either resolves", async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    pending.set("sample-a", a);
    pending.set("sample-b", b);
    renderPage();
    await screen.findByText("Map nodes: 1");
    await place("sample-a");
    await place("sample-b");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await act(async () => b.resolve(response({ results: [resolution("sample", "sample-b")] })));
    await screen.findByRole("heading", { name: "related-sample-b" });
    await act(async () => a.resolve(response({ results: [resolution("sample", "sample-a")] })));
    expect(await screen.findByRole("heading", { name: "related-sample-a" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "related-sample-b" })).toBeTruthy();
  });

  it("does not overwrite a new Project snapshot with a late readback", async () => {
    const a = deferred<Response>();
    pending.set("sample-a", a);
    const router = renderPage();
    await screen.findByText("Map nodes: 1");
    await place();
    snapshots["project-b"] = structuredClone(snapshots["project-a"]);
    snapshots["project-b"].project.id = "project-b";
    snapshots["project-b"].references[0].resolution.source!.title = "Authoritative B";
    await act(async () => router.navigate("/projects/project-b"));
    await screen.findByRole("button", { name: "Select Authoritative B" });
    const late = resolution("sample", "sample-a");
    late.source!.title = "Stale A";
    await act(async () => a.resolve(response({ results: [late] })));
    expect(screen.getByRole("button", { name: "Select Authoritative B" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select Stale A" })).toBeNull();
  });

  it("reports immediate readback failures and retries only the read while the insertion stays committed", async () => {
    failResolution = true;
    renderPage();
    await screen.findByText("Map nodes: 1");
    await place();
    expect(await screen.findByText(/sample-a was placed, but its details could not be loaded/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.queryByText(/add the first reference/)).toBeNull();
    expect(screen.getByText("Map nodes: 2")).toBeTruthy();
    failResolution = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry details" }));
    await screen.findByRole("heading", { name: "related-sample-a" });
    expect(readCalls("/api/projects/project-a/items/reference")).toHaveLength(1);
    expect(readCalls("/api/references/resolve")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Retry details" })).toBeNull();
  });

  it("does not overwrite an authoritative reload of the same Project with an older readback", async () => {
    const a = deferred<Response>();
    pending.set("sample-a", a);
    renderPage();
    await screen.findByText("Map nodes: 1");
    await place();
    const ordinaryFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((path, init) => String(path).endsWith("/items/reference")
      ? Promise.resolve(response({ error: "Project changed" }, 409)) : ordinaryFetch(path, init));
    fireEvent.change(screen.getByPlaceholderText("Search records…"), { target: { value: "sample-b" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "Place sample-b on Map" }));
    snapshots["project-a"].references[0].resolution.source!.title = "Authoritative A";
    fireEvent.click((await screen.findAllByRole("button", { name: "Reload Project" }))[0]);
    await screen.findByRole("button", { name: "Select Authoritative A" });
    const late = resolution("sample", "sample-a");
    late.source!.title = "Stale A";
    await act(async () => a.resolve(response({ results: [late] })));
    expect(screen.getByRole("button", { name: "Select Authoritative A" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select Stale A" })).toBeNull();
  });

  it("rejects a resolution for a different target without corrupting the placed reference", async () => {
    const a = deferred<Response>();
    pending.set("sample-a", a);
    renderPage();
    await screen.findByText("Map nodes: 1");
    await place();
    await act(async () => a.resolve(response({ results: [resolution("sample", "wrong-target")] })));
    expect(await screen.findByRole("button", { name: "Retry details" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Select sample-a" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select wrong-target" })).toBeNull();
    expect(readCalls("/api/projects/project-a/items/reference")).toHaveLength(1);
  });

  it("keeps an existing authoritative registry when the same target is placed again", async () => {
    renderPage();
    await screen.findByText("Map nodes: 1");
    await place();
    await waitFor(() => expect(readCalls("/api/references/resolve")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Place sample-a on Map" }));
    await screen.findByText("Map nodes: 3");
    expect(readCalls("/api/references/resolve")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await screen.findByRole("heading", { name: "related-sample-a" });
  });
});
