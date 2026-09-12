// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectGeometryCommand, ProjectNodeDescriptor } from "./lib/project-map-model";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/ReferenceSearchSurface", () => ({ ReferenceSearchSurface: () => null }));
vi.mock("./components/project/ProjectMapSurface", () => ({
  ProjectMapSurface: ({ nodes, selectedItemIds, onGeometryCommit, onMarkdownEditRequest, markdownEditor, onMarkdownCancel, onMarkdownSave }: {
    nodes: ProjectNodeDescriptor[];
    selectedItemIds: string[];
    onGeometryCommit: (command: ProjectGeometryCommand) => void;
    onMarkdownEditRequest: (id: string) => void;
    markdownEditor: { status: string } | null;
    onMarkdownCancel: () => void;
    onMarkdownSave: () => void;
  }) => <div>
    <output aria-label="Map selection">{selectedItemIds.join(",")}</output>
    <output aria-label="Current note x">{nodes.find((node) => node.placementId === "placement-note")?.geometry.x}</output>
    <button onClick={() => {
      const node = nodes.find((candidate) => candidate.placementId === "placement-note")!;
      onGeometryCommit({ placementId: node.placementId, before: node.geometry, after: { ...node.geometry, x: 100 } });
    }}>Move fixture</button>
    <button onClick={() => onMarkdownEditRequest("item-note")}>Edit fixture</button>
    {markdownEditor && <>
      <output aria-label="Editor state">{markdownEditor.status}</output>
      <button onClick={onMarkdownSave}>Save fixture</button>
      <button onClick={onMarkdownCancel}>Cancel fixture</button>
    </>}
  </div>,
}));

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function renderProject() {
  const router = createMemoryRouter([{ path: "/projects/:projectId", element: <ProjectPage /> }], { initialEntries: ["/projects/project-a"] });
  render(<RouterProvider router={router} />);
  return router;
}

describe("Project workspace command scope", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query.includes("min-width"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { cleanup(); fetchMock.mockReset(); vi.unstubAllGlobals(); });

  it("does not submit the previous Project's placement from history while the next Project is loading", async () => {
    const nextRead = deferred<Response>();
    const snapshot = projectTestSnapshot();
    fetchMock.mockImplementation(async (path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return response(snapshot);
      if (String(path) === "/api/projects/project-b" && !init?.method) return nextRead.promise;
      if (String(path) === "/api/projects/project-a/placements/placement-note" && init?.method === "PATCH") return response({ value: { ...snapshot.placements[1], x: 100, revision: 2 }, replayed: false });
      return response({ error: "Placement not in project" }, 404);
    });
    const router = renderProject();
    fireEvent.click(await screen.findByRole("button", { name: "Move fixture" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText("Saved");
    await act(async () => { await router.navigate("/projects/project-b"); });
    await screen.findByText("Loading Project…");
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock.mock.calls.filter(([path, init]) => String(path).startsWith("/api/projects/project-b/") && init?.method === "PATCH")).toHaveLength(0);
  });

  it("keeps history shortcuts inert while a discarded conflict is reloading its authoritative snapshot", async () => {
    const reload = deferred<Response>();
    const snapshot = projectTestSnapshot();
    let readCount = 0;
    fetchMock.mockImplementation(async (path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return ++readCount === 1 ? response(snapshot) : reload.promise;
      if (String(path) === "/api/projects/project-a/placements/placement-note" && init?.method === "PATCH") return response({ value: { ...snapshot.placements[1], ...JSON.parse(String(init.body)).geometry, revision: 2 }, replayed: false });
      if (String(path).endsWith("/markdown") && init?.method === "PATCH") return response({ error: "Markdown changed" }, 409);
      return response({ error: "Unexpected request" }, 500);
    });
    renderProject();
    fireEvent.click(await screen.findByRole("button", { name: "Move fixture" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText("Saved");
    fireEvent.click(screen.getByRole("button", { name: "Edit fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Save fixture" }));
    await waitFor(() => expect(screen.getByLabelText("Editor state").textContent).toBe("conflict"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel fixture" }));
    await screen.findByText("Loading Project…");
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock.mock.calls.filter(([path, init]) => String(path).endsWith("/placements/placement-note") && init?.method === "PATCH")).toHaveLength(1);
  });
  it("does not undo or save the Map underneath an open Project deletion confirmation", async () => {
    const snapshot = projectTestSnapshot();
    fetchMock.mockImplementation(async (path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return response(snapshot);
      if (String(path) === "/api/projects/project-a/placements/placement-note" && init?.method === "PATCH") return response({ value: { ...snapshot.placements[1], ...JSON.parse(String(init.body)).geometry, revision: 2 }, replayed: false });
      return response({ error: "Unexpected request" }, 500);
    });
    renderProject();
    fireEvent.click(await screen.findByRole("button", { name: "Move fixture" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText("Saved");
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    fireEvent.click(screen.getByRole("button", { name: /^Move to trash$/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Move Project to trash" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "a", ctrlKey: true });
    fireEvent.keyDown(cancel, { key: "z", ctrlKey: true });
    fireEvent.keyDown(cancel, { key: "s", ctrlKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock.mock.calls.filter(([path, init]) => String(path).endsWith("/placements/placement-note") && init?.method === "PATCH")).toHaveLength(1);
    expect(screen.getByLabelText("Current note x").textContent).toBe("100");
    expect(screen.getByLabelText("Map selection").textContent).toBe("");
  });

});
