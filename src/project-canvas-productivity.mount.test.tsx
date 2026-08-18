// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectGeometryCommand, ProjectNodeDescriptor } from "./lib/project-map-model";
import type { ProjectItemSelection } from "./lib/project-canvas-productivity";
import type { ProjectMapMarkdownEditorState } from "./lib/project-owned-content";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/project/ProjectMapSurface", () => ({
  ProjectMapSurface: ({
    nodes,
    markdownEditor,
    onGeometryBatchCommit,
    onMarkdownCreateRequest,
    onSelectionChange,
  }: {
    nodes: ProjectNodeDescriptor[];
    markdownEditor?: ProjectMapMarkdownEditorState | null;
    onGeometryBatchCommit?: (commands: ProjectGeometryCommand[]) => void;
    onMarkdownCreateRequest?: (point: { x: number; y: number }) => void;
    onSelectionChange?: (selection: ProjectItemSelection) => boolean | void;
  }) => {
    const note = nodes.find((candidate) => candidate.itemId === "item-note")!;
    const reference = nodes.find((candidate) => candidate.itemId === "item-reference")!;
    return <div data-testid="project-flow-canvas">
      <p>Note x: {note.geometry.x}</p>
      <p>Reference x: {reference.geometry.x}</p>
      <p>Note z: {note.geometry.zIndex}</p>
      <p>Reference z: {reference.geometry.zIndex}</p>
      <p>{markdownEditor ? "Markdown editor active" : "Markdown editor inactive"}</p>
      <p>Markdown draft z: {markdownEditor?.geometry?.zIndex ?? "none"}</p>
      <button type="button" onClick={() => onSelectionChange?.({
        itemIds: [note.itemId, reference.itemId],
        primaryItemId: reference.itemId,
      })}>Select two items</button>
      <button type="button" onClick={() => onSelectionChange?.({
        itemIds: [note.itemId],
        primaryItemId: note.itemId,
      })}>Select note</button>
      <button type="button" onClick={() => onGeometryBatchCommit?.([{
        placementId: note.placementId,
        before: note.geometry,
        after: { ...note.geometry, x: note.geometry.x + 40 },
      }, {
        placementId: reference.placementId,
        before: reference.geometry,
        after: { ...reference.geometry, x: reference.geometry.x + 40 },
      }])}>Move selected items</button>
      <button type="button" onClick={() => onMarkdownCreateRequest?.({ x: 500, y: 500 })}>
        Start Markdown draft
      </button>
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
  }, {
    path: "/projects",
    element: <p>Projects destination</p>,
  }], { initialEntries: ["/projects/project-a"] });
  return { router, ...render(<RouterProvider router={router} />) };
}

const actor = "user@example.com";
const createdAt = "2026-08-11T08:00:00.000Z";

function createProjectItemResponse(snapshot: ReturnType<typeof projectTestSnapshot>, path: string, body: Record<string, any>) {
  const project = { ...snapshot.project, revision: snapshot.project.revision + 1, nextCreatedSequence: snapshot.project.nextCreatedSequence + 1, updatedAt: createdAt };
  const placement = { id: body.placementId, projectItemId: body.itemId, ...body.geometry, revision: 1, createdBy: actor, updatedBy: actor, createdAt, updatedAt: createdAt };
  const reference = path.endsWith("/items/reference");
  const content = reference ? null : { id: body.contentId, projectId: snapshot.project.id, contentType: "markdown" as const, markdownSource: body.markdownSource, attachmentCaption: null, attachmentSourceUrl: null, formatVersion: 1, revision: 1, createdBy: actor, updatedBy: actor, createdAt, updatedAt: createdAt, deletedAt: null, deletedBy: null };
  const item = { id: body.itemId, projectId: snapshot.project.id, itemType: reference ? "reference" as const : "content" as const, projectContentId: reference ? null : body.contentId, referenceTargetId: reference ? "registry-sample" : null, createdSequence: snapshot.project.nextCreatedSequence, revision: 1, createdBy: actor, updatedBy: actor, createdAt, updatedAt: createdAt, deletedAt: null, deletedBy: null };
  const result = { project, item, content, attachment: null, placement, replayed: false };
  const next = { ...snapshot, project, contents: content ? [...snapshot.contents, content] : snapshot.contents, items: [...snapshot.items, item], placements: [...snapshot.placements, placement] };
  return { result, next };
}

function dispatchSaveShortcut() {
  const event = new KeyboardEvent("keydown", {
    key: "s",
    code: "KeyS",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  fireEvent(document, event);
  return event;
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

  it("aligns a multi-selection through one ordinary grouped geometry history command", async () => {
    fetchMock.mockImplementation(() => jsonResponse(projectTestSnapshot()));
    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Select two items" }));
    fireEvent.click(screen.getByRole("button", { name: "Align left" }));
    expect(screen.getByText("Note x: 20")).toBeTruthy();
    expect(screen.getByText("Reference x: 20")).toBeTruthy();
    expect(screen.getByText("Unsaved")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByText("Reference x: 320")).toBeTruthy();
  });

  it("changes explicit z-order through the existing geometry history and save model", async () => {
    fetchMock.mockImplementation(() => jsonResponse(projectTestSnapshot()));
    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Select note" }));
    fireEvent.click(screen.getByRole("button", { name: "Bring to front" }));
    expect(screen.getByText("Note z: 2")).toBeTruthy();
    expect(screen.getByText("Reference z: 1")).toBeTruthy();
    expect(screen.getByText("Unsaved")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByText("Note z: 0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(screen.getByText("Note z: 2")).toBeTruthy();
  });

  it("projects an acknowledged z-order save into subsequent Canvas creation", async () => {
    let authoritative = projectTestSnapshot();
    fetchMock.mockImplementation((request, init) => {
      if (init?.method !== "PATCH") return jsonResponse(authoritative);
      const placementId = String(request).split("/").at(-1)!;
      const body = JSON.parse(String(init.body)) as {
        geometry: ProjectNodeDescriptor["geometry"];
      };
      const current = authoritative.placements.find((candidate) => candidate.id === placementId)!;
      const value = {
        ...current,
        ...body.geometry,
        revision: current.revision + 1,
      };
      authoritative = {
        ...authoritative,
        placements: authoritative.placements.map((placement) => (
          placement.id === placementId ? value : placement
        )),
      };
      return jsonResponse({ value, replayed: false });
    });
    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Select note" }));
    fireEvent.click(screen.getByRole("button", { name: "Bring to front" }));
    expect(screen.getByText("Note z: 2")).toBeTruthy();
    dispatchSaveShortcut();
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Start Markdown draft" }));
    expect(screen.getByText("Markdown draft z: 3")).toBeTruthy();
  });

  it("copies acknowledged aligned geometry instead of the pre-save snapshot", async () => {
    let authoritative = projectTestSnapshot();
    const createdBodies: Record<string, any>[] = [];
    fetchMock.mockImplementation((request, init) => {
      const path = String(request);
      if (!init?.method || init.method === "GET") return jsonResponse(authoritative);
      const body = JSON.parse(String(init.body)) as Record<string, any>;
      if (init.method === "PATCH") {
        const placementId = path.split("/").at(-1)!;
        const current = authoritative.placements.find((candidate) => candidate.id === placementId)!;
        const value = {
          ...current,
          ...body.geometry,
          revision: current.revision + 1,
        };
        authoritative = {
          ...authoritative,
          placements: authoritative.placements.map((placement) => (
            placement.id === placementId ? value : placement
          )),
        };
        return jsonResponse({ value, replayed: false });
      }
      if (init.method !== "POST") throw new Error("Unexpected " + init.method + " " + path);
      createdBodies.push(body);
      const created = createProjectItemResponse(authoritative, path, body);
      authoritative = created.next;
      return jsonResponse(created.result, 201);
    });
    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Select two items" }));
    fireEvent.click(screen.getByRole("button", { name: "Align left" }));
    dispatchSaveShortcut();
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());

    fireEvent.keyDown(document, { key: "c", code: "KeyC", ctrlKey: true });
    fireEvent.keyDown(document, { key: "v", code: "KeyV", ctrlKey: true });

    await waitFor(() => expect(createdBodies).toHaveLength(2));
    expect(createdBodies.map((body) => body.geometry.x)).toEqual([52, 52]);
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

  it("consumes the save shortcut while the Map is saved or an owned-content operation is blocking commands", async () => {
    fetchMock.mockImplementation(() => jsonResponse(projectTestSnapshot()));
    renderProjectPage();

    await screen.findByTestId("project-flow-canvas");
    const savedEvent = dispatchSaveShortcut();
    expect(savedEvent.defaultPrevented).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Start Markdown draft" }));
    await screen.findByText("Markdown editor active");
    const blockedEvent = dispatchSaveShortcut();
    expect(blockedEvent.defaultPrevented).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("continues consuming the save shortcut while a placement save is in flight and after it conflicts", async () => {
    const snapshot = projectTestSnapshot();
    let resolvePatch!: (response: Response) => void;
    const patchResponse = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    fetchMock.mockImplementation((_request, init) => (
      init?.method === "PATCH" ? patchResponse : jsonResponse(snapshot)
    ));
    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Select two items" }));
    fireEvent.click(screen.getByRole("button", { name: "Move selected items" }));
    expect(screen.getByText("Unsaved")).toBeTruthy();

    const initialSaveEvent = dispatchSaveShortcut();
    expect(initialSaveEvent.defaultPrevented).toBe(true);
    await screen.findByText("Saving");
    const savingEvent = dispatchSaveShortcut();
    expect(savingEvent.defaultPrevented).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolvePatch(new Response(JSON.stringify({ error: "Placement revision conflict" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }));
    await screen.findByText("Conflict");
    const conflictEvent = dispatchSaveShortcut();
    expect(conflictEvent.defaultPrevented).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("copies the authoritative selection and pastes fresh Markdown and Reference occurrences", async () => {
    let authoritative = projectTestSnapshot();
    const writes: Array<{ path: string; body: Record<string, any> }> = [];
    fetchMock.mockImplementation((request, init) => {
      const path = String(request);
      if (!init?.method || init.method === "GET") return jsonResponse(authoritative);
      if (init.method !== "POST") throw new Error(`Unexpected ${init.method} ${path}`);
      const body = JSON.parse(String(init.body)) as Record<string, any>;
      writes.push({ path, body });
      const created = createProjectItemResponse(authoritative, path, body);
      authoritative = created.next;
      return jsonResponse(created.result, 201);
    });
    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Select two items" }));
    fireEvent.keyDown(document, { key: "c", code: "KeyC", ctrlKey: true });
    expect(screen.getByText("2 copied")).toBeTruthy();
    fireEvent.keyDown(document, { key: "v", code: "KeyV", ctrlKey: true });

    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes.map(({ path }) => path)).toEqual([
      "/api/projects/project-a/items/markdown",
      "/api/projects/project-a/items/reference",
    ]);
    expect(writes[0].body.expectedProjectRevision).toBe(2);
    expect(writes[1].body.expectedProjectRevision).toBe(3);
    expect(writes[0].body.itemId).not.toBe("item-note");
    expect(writes[1].body.itemId).not.toBe("item-reference");
    await screen.findByText("Pasted 2 Project items.");
    expect(screen.getByRole("heading", { name: "2 items selected" })).toBeTruthy();
  });

  it("retains a paused journal, retries a lost response exactly, and protects navigation", async () => {
    let authoritative = projectTestSnapshot();
    let lostReferenceBody: Record<string, any> | null = null;
    let referenceAttempts = 0;
    let markdownAttempts = 0;
    fetchMock.mockImplementation((request, init) => {
      const path = String(request);
      if (!init?.method || init.method === "GET") return jsonResponse(authoritative);
      if (init.method !== "POST") throw new Error(`Unexpected ${init.method} ${path}`);
      const body = JSON.parse(String(init.body)) as Record<string, any>;
      if (path.endsWith("/items/markdown")) {
        markdownAttempts += 1;
        const created = createProjectItemResponse(authoritative, path, body);
        authoritative = created.next;
        return jsonResponse(created.result, 201);
      }
      if (path.endsWith("/items/reference")) {
        referenceAttempts += 1;
        if (referenceAttempts === 1) {
          lostReferenceBody = structuredClone(body);
          const created = createProjectItemResponse(authoritative, path, body);
          authoritative = created.next;
          return Promise.reject(new TypeError("simulated response loss"));
        }
        expect(body).toEqual(lostReferenceBody);
        const existing = authoritative.items.find((item) => item.id === body.itemId)!;
        const placement = authoritative.placements.find((candidate) => candidate.id === body.placementId)!;
        return jsonResponse({
          project: authoritative.project,
          item: existing,
          content: null,
          attachment: null,
          placement,
          replayed: true,
        });
      }
      throw new Error(`Unexpected POST ${path}`);
    });
    const { router } = renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Select two items" }));
    fireEvent.keyDown(document, { key: "c", code: "KeyC", ctrlKey: true });
    fireEvent.keyDown(document, { key: "v", code: "KeyV", ctrlKey: true });
    await screen.findByText(/Paste paused after 1\/2 acknowledged writes/);
    expect(markdownAttempts).toBe(1);
    expect(referenceAttempts).toBe(1);

    void router.navigate("/projects");
    const dialog = await screen.findByRole("alertdialog", { name: "Unsaved Project changes" });
    expect(within(dialog).getByText(/Project paste is paused after 1\/2 acknowledged writes/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry exact paste" }));

    await screen.findByText("Projects destination");
    expect(markdownAttempts).toBe(1);
    expect(referenceAttempts).toBe(2);
  });
});
