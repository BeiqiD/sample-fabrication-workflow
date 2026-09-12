// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectMapSurfaceProps } from "./components/project/ProjectMapSurface";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshotWithAttachment } from "./project-test-fixture";

vi.mock("./components/ReferenceSearchSurface", () => ({ ReferenceSearchSurface: () => null }));
vi.mock("./components/project/ProjectMapSurface", async () => {
  const React = await import("react");
  return {
    ProjectMapSurface: React.forwardRef((props: ProjectMapSurfaceProps, ref: React.ForwardedRef<unknown>) => {
      React.useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 400, y: 300 }) }));
      return <div data-testid="inspector-preference-map">
        <button onClick={() => props.onSelect("item-note")}>Select note</button>
        <button onClick={() => props.onSelect("item-reference")}>Select reference</button>
        <button onClick={() => props.onSelect(null)}>Clear fixture selection</button>
        <button onClick={() => props.onEdgeSelect?.("edge-a")}>Select edge</button>
        <button onClick={() => props.contextCommands?.inspectItem("item-note")}>Inspect note</button>
      </div>;
    }),
  };
});

const fetchMock = vi.fn<typeof fetch>();
function fixture(projectId = "project-a") {
  const snapshot = projectTestSnapshotWithAttachment();
  snapshot.project.id = projectId;
  for (const collection of [snapshot.items, snapshot.contents]) {
    for (const value of collection) value.projectId = projectId;
  }
  snapshot.edges = [{
    id: "edge-a", projectId, sourceItemId: "item-note", targetItemId: "item-reference",
    sourceHandle: "right", targetHandle: "left", markerStart: "none", markerEnd: "arrow",
    label: "supports", revision: 1, createdBy: "qa@example.com", updatedBy: "qa@example.com",
    createdAt: snapshot.project.createdAt, updatedAt: snapshot.project.createdAt, deletedAt: null, deletedBy: null,
  }];
  return snapshot;
}

function panel() { return screen.getByRole("complementary", { name: "Project Inspector" }); }
function disclosure(title: string) { return within(panel()).getByText(title, { selector: "summary" }).parentElement as HTMLDetailsElement; }
function toggleDisclosure(title: string) { fireEvent.click(within(panel()).getByText(title, { selector: "summary" })); }
function renderProject() {
  const router = createMemoryRouter([{ path: "/projects/:projectId", element: <ProjectPage /> }], {
    initialEntries: ["/projects/project-a"],
  });
  render(<RouterProvider router={router} />);
  return router;
}
async function openNote() {
  renderProject();
  await screen.findByTestId("inspector-preference-map");
  fireEvent.click(screen.getByRole("button", { name: "Inspect note" }));
  await within(panel()).findByRole("button", { name: "Expand note" });
}

beforeAll(async () => {
  await Promise.all([import("./components/project/ProjectMarkdownEditor"), import("./components/project/ProjectReadingSurface")]);
});
beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (path) => new Response(JSON.stringify(fixture(String(path).includes("project-b") ? "project-b" : "project-a")), {
    headers: { "content-type": "application/json" },
  }));
});
afterEach(() => { cleanup(); fetchMock.mockReset(); vi.unstubAllGlobals(); });

describe("Inspector Project session preferences", () => {
  it("retains expanded and collapsed sections through card/edge changes, editing and closing the panel", async () => {
    await openNote();
    toggleDisclosure("Details");
    toggleDisclosure("More actions");
    toggleDisclosure("Arrange on Map");
    fireEvent.click(within(panel()).getByRole("button", { name: "Expand note" }));
    fireEvent.click(screen.getByRole("button", { name: "Select reference" }));
    expect(disclosure("Details").open).toBe(true);
    expect(disclosure("More actions").open).toBe(true);
    expect(disclosure("Arrange on Map").open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Select edge" }));
    expect(disclosure("Technical details").open).toBe(true);
    expect(disclosure("More actions").open).toBe(true);
    toggleDisclosure("Technical details");
    fireEvent.click(screen.getByRole("button", { name: "Select note" }));
    expect(disclosure("Details").open).toBe(false);
    expect(within(panel()).getByRole("button", { name: "Collapse note" })).toBeTruthy();
    fireEvent.click(within(panel()).getByRole("button", { name: "Edit Markdown" }));
    const editor = await within(panel()).findByLabelText("Inspector Markdown editor");
    fireEvent.change(editor, { target: { value: "Discard this temporary draft" } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Cancel" }));
    expect(disclosure("Details").open).toBe(false);
    expect(disclosure("Arrange on Map").open).toBe(true);
    expect(within(panel()).getByRole("button", { name: "Collapse note" })).toBeTruthy();
    fireEvent.click(within(panel()).getByRole("button", { name: "Close Inspector" }));
    fireEvent.click(screen.getByRole("button", { name: "Inspector" }));
    expect(disclosure("Details").open).toBe(false);
    expect(disclosure("More actions").open).toBe(true);
    expect(disclosure("Arrange on Map").open).toBe(true);
    expect(within(panel()).getByRole("button", { name: "Collapse note" })).toBeTruthy();
    expect(within(panel()).queryByText("Discard this temporary draft")).toBeNull();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET")).toHaveLength(0);
  });

  it("keeps selection lightweight until explicitly opened and restores an open panel after a temporary empty selection", async () => {
    renderProject();
    await screen.findByTestId("inspector-preference-map");
    fireEvent.click(screen.getByRole("button", { name: "Select note" }));
    expect(screen.queryByRole("complementary", { name: "Project Inspector" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Inspector" }));
    toggleDisclosure("Details");
    fireEvent.click(screen.getByRole("button", { name: "Clear fixture selection" }));
    expect(screen.queryByRole("complementary", { name: "Project Inspector" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select reference" }));
    expect(disclosure("Details").open).toBe(true);
    fireEvent.click(within(panel()).getByRole("button", { name: "Close Inspector" }));
    fireEvent.click(screen.getByRole("button", { name: "Select note" }));
    expect(screen.queryByRole("complementary", { name: "Project Inspector" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select edge" }));
    expect(screen.queryByRole("complementary", { name: "Project Inspector" })).toBeNull();
  });

  it("remembers Pin across explicit close and restores it only when Inspector is reopened", async () => {
    await openNote();
    fireEvent.click(within(panel()).getByRole("button", { name: "Pin" }));
    fireEvent.click(within(panel()).getByRole("button", { name: "Close Inspector" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear fixture selection" }));
    expect(screen.queryByRole("complementary", { name: "Project Inspector" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Inspector" }));
    expect(within(panel()).getByRole("button", { name: "Unpin" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("preserves the Map preference while Reading replaces Inspector with References, without reopening a Reading modal", async () => {
    await openNote();
    toggleDisclosure("Details");
    fireEvent.click(screen.getByRole("button", { name: "Reading" }));
    await screen.findByRole("region", { name: "Project Reading" });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Reference from research record" }));
    expect(screen.queryByRole("complementary", { name: "Project Inspector" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close References" }));
    expect(screen.queryByRole("complementary", { name: "Project Inspector" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    await screen.findByTestId("inspector-preference-map");
    expect(disclosure("Details").open).toBe(true);
  });

  it("keeps each Project's choices separate during route reuse", async () => {
    const router = renderProject();
    await screen.findByTestId("inspector-preference-map");
    fireEvent.click(screen.getByRole("button", { name: "Inspect note" }));
    toggleDisclosure("Details");
    await act(() => router.navigate("/projects/project-b"));
    await screen.findByTestId("inspector-preference-map");
    expect(screen.queryByRole("complementary", { name: "Project Inspector" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Inspect note" }));
    expect(disclosure("Details").open).toBe(false);
    await act(() => router.navigate("/projects/project-a?focus=item-note"));
    await screen.findByTestId("inspector-preference-map");
    await waitFor(() => expect(disclosure("Details").open).toBe(true));
  });
});
