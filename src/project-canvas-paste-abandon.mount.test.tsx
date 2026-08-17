// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectNodeDescriptor } from "./lib/project-map-model";
import type { ProjectItemSelection } from "./lib/project-canvas-productivity";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/project/ProjectMapSurface", () => ({
  ProjectMapSurface: ({
    nodes,
    selectedItemIds = [],
    selectedEdgeId = null,
    onSelectionChange,
    onEdgeSelect,
  }: {
    nodes: ProjectNodeDescriptor[];
    selectedItemIds?: string[];
    selectedEdgeId?: string | null;
    onSelectionChange?: (selection: ProjectItemSelection) => boolean | void;
    onEdgeSelect?: (edgeId: string | null) => void;
  }) => {
    const note = nodes.find((candidate) => candidate.itemId === "item-note")!;
    const reference = nodes.find((candidate) => candidate.itemId === "item-reference")!;
    return <div data-testid="project-flow-canvas">
      <p>Selected item count: {selectedItemIds.length}</p>
      <p>Selected edge: {selectedEdgeId ?? "none"}</p>
      <button type="button" onClick={() => onSelectionChange?.({
        itemIds: [note.itemId, reference.itemId],
        primaryItemId: reference.itemId,
      })}>Select two items</button>
      <button type="button" data-testid="clear-canvas-selection" onClick={() => onSelectionChange?.({
        itemIds: [],
        primaryItemId: null,
      })}>Clear canvas selection</button>
      <button type="button" data-testid="select-test-edge" onClick={() => onEdgeSelect?.("edge-note-reference")}>Select test edge</button>
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

const actor = "user@example.com";
const createdAt = "2026-08-11T08:00:00.000Z";

function pasteSnapshot() {
  const snapshot = projectTestSnapshot();
  return {
    ...snapshot,
    edges: [{
      id: "edge-note-reference",
      projectId: snapshot.project.id,
      sourceItemId: "item-note",
      targetItemId: "item-reference",
      sourceHandle: "right" as const,
      targetHandle: "left" as const,
      markerStart: "none" as const,
      markerEnd: "arrow" as const,
      label: "internal",
      revision: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      deletedBy: null,
    }],
  };
}

function createProjectItemResponse(
  snapshot: ReturnType<typeof pasteSnapshot>,
  path: string,
  body: Record<string, any>,
) {
  const project = {
    ...snapshot.project,
    revision: snapshot.project.revision + 1,
    nextCreatedSequence: snapshot.project.nextCreatedSequence + 1,
    updatedAt: createdAt,
  };
  const placement = {
    id: body.placementId,
    projectItemId: body.itemId,
    ...body.geometry,
    revision: 1,
    createdBy: actor,
    updatedBy: actor,
    createdAt,
    updatedAt: createdAt,
  };
  const reference = path.endsWith("/items/reference");
  const content = reference ? null : {
    id: body.contentId,
    projectId: snapshot.project.id,
    contentType: "markdown" as const,
    markdownSource: body.markdownSource,
    attachmentCaption: null,
    attachmentSourceUrl: null,
    formatVersion: 1,
    revision: 1,
    createdBy: actor,
    updatedBy: actor,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    deletedBy: null,
  };
  const item = {
    id: body.itemId,
    projectId: snapshot.project.id,
    itemType: reference ? "reference" as const : "content" as const,
    projectContentId: reference ? null : body.contentId,
    referenceTargetId: reference ? "registry-sample" : null,
    createdSequence: snapshot.project.nextCreatedSequence,
    revision: 1,
    createdBy: actor,
    updatedBy: actor,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    deletedBy: null,
  };
  const result = {
    project,
    item,
    content,
    attachment: null,
    placement,
    replayed: false,
  };
  const next = {
    ...snapshot,
    project,
    contents: content ? [...snapshot.contents, content] : snapshot.contents,
    items: [...snapshot.items, item],
    placements: [...snapshot.placements, placement],
  };
  return { result, next };
}

function copyAndPasteSelection() {
  fireEvent.click(screen.getByRole("button", { name: "Select two items" }));
  fireEvent.keyDown(document, { key: "c", code: "KeyC", ctrlKey: true });
  fireEvent.keyDown(document, { key: "v", code: "KeyV", ctrlKey: true });
}

describe("mounted uncertain Project Canvas paste abandonment", () => {
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

  it("settles an uncertain failed write exactly before GET, then abandons only later steps", async () => {
    let authoritative = pasteSnapshot();
    let getAttempts = 0;
    let markdownAttempts = 0;
    let referenceAttempts = 0;
    let edgeAttempts = 0;
    let failedReferenceBody: Record<string, any> | null = null;
    let resolveExactReplay!: (response: Response) => void;
    const exactReplayResponse = new Promise<Response>((resolve) => {
      resolveExactReplay = resolve;
    });

    fetchMock.mockImplementation((request, init) => {
      const path = String(request);
      if (!init?.method || init.method === "GET") {
        getAttempts += 1;
        return jsonResponse(authoritative);
      }
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
          failedReferenceBody = structuredClone(body);
          return Promise.reject(new TypeError("simulated response loss before a late commit"));
        }
        expect(body).toEqual(failedReferenceBody);
        return exactReplayResponse;
      }
      if (path.endsWith("/edges")) {
        edgeAttempts += 1;
        throw new Error("The later edge step must remain unattempted during abandon reconciliation");
      }
      throw new Error(`Unexpected POST ${path}`);
    });

    renderProjectPage();
    await screen.findByTestId("project-flow-canvas");
    copyAndPasteSelection();

    await screen.findByText(/Paste paused after 1\/3 acknowledged writes/);
    expect(markdownAttempts).toBe(1);
    expect(referenceAttempts).toBe(1);
    expect(edgeAttempts).toBe(0);
    expect(screen.getByText("Selected item count: 1")).toBeTruthy();
    expect(screen.getByText("Selected edge: none")).toBeTruthy();

    fireEvent.click(screen.getByTestId("clear-canvas-selection"));
    fireEvent.click(screen.getByTestId("select-test-edge"));
    expect(screen.getByText("Selected item count: 1")).toBeTruthy();
    expect(screen.getByText("Selected edge: none")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reload and abandon remaining paste" }));
    await waitFor(() => expect(referenceAttempts).toBe(2));
    expect(getAttempts).toBe(1);
    expect(edgeAttempts).toBe(0);

    if (!failedReferenceBody) throw new Error("The uncertain reference request was not captured");
    const lateCommit = createProjectItemResponse(
      authoritative,
      "/api/projects/project-a/items/reference",
      failedReferenceBody,
    );
    authoritative = lateCommit.next;
    resolveExactReplay(new Response(JSON.stringify({
      ...lateCommit.result,
      replayed: true,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await screen.findByText(
      "Authoritative Project state was loaded. 2 pasted items already committed to the Project remain; the later unattempted paste steps were abandoned.",
    );
    expect(getAttempts).toBe(2);
    expect(referenceAttempts).toBe(2);
    expect(edgeAttempts).toBe(0);
    expect(screen.getByText("Selected item count: 2")).toBeTruthy();
  });

  it("does not replay a deterministically rejected write before authoritative abandon reload", async () => {
    let authoritative = pasteSnapshot();
    let getAttempts = 0;
    let referenceAttempts = 0;
    let edgeAttempts = 0;

    fetchMock.mockImplementation((request, init) => {
      const path = String(request);
      if (!init?.method || init.method === "GET") {
        getAttempts += 1;
        return jsonResponse(authoritative);
      }
      if (init.method !== "POST") throw new Error(`Unexpected ${init.method} ${path}`);
      const body = JSON.parse(String(init.body)) as Record<string, any>;
      if (path.endsWith("/items/markdown")) {
        const created = createProjectItemResponse(authoritative, path, body);
        authoritative = created.next;
        return jsonResponse(created.result, 201);
      }
      if (path.endsWith("/items/reference")) {
        referenceAttempts += 1;
        return jsonResponse({ error: "Project state changed before the operation could commit" }, 409);
      }
      if (path.endsWith("/edges")) {
        edgeAttempts += 1;
        throw new Error("The later edge step must remain unattempted");
      }
      throw new Error(`Unexpected POST ${path}`);
    });

    renderProjectPage();
    await screen.findByTestId("project-flow-canvas");
    copyAndPasteSelection();

    await screen.findByText(/Paste paused after 1\/3 acknowledged writes/);
    expect(referenceAttempts).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Reload and abandon remaining paste" }));

    await screen.findByText(
      "Authoritative Project state was loaded. 1 pasted item already committed to the Project remains; the later unattempted paste steps were abandoned.",
    );
    expect(getAttempts).toBe(2);
    expect(referenceAttempts).toBe(1);
    expect(edgeAttempts).toBe(0);
  });
});
