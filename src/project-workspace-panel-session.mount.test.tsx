// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceSearchSurfaceProps } from "./components/ReferenceSearchSurface";
import type { ProjectMapSurfaceProps } from "./components/project/ProjectMapSurface";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshotWithAttachment } from "./project-test-fixture";

// Keep ProjectPage, its panel session, and the real Inspector. The lightweight
// surfaces expose actual Page callbacks and parent-owned Reference search state.
vi.mock("./components/ReferenceSearchSurface", () => ({
  ReferenceSearchSurface: (props: ReferenceSearchSurfaceProps) => {
    const draft = props.draftState?.value ?? props.value;
    return <div>
      <label>Reference search draft<input value={draft.query} onChange={(event) => {
        (props.draftState?.onChange ?? props.onChange)({ ...draft, query: event.target.value });
      }} /></label>
      <button onClick={() => props.onChange(draft)}>Commit Reference search</button>
      <output aria-label="Committed Reference search">{props.value.query}</output>
      <output aria-label="Reference recommendation context">
        {props.mode === "place" && props.suggestionSeeds?.map((seed) => (
          `${seed.origin}:${seed.target.id}`
        )).join(",")}
      </output>
    </div>;
  },
}));
vi.mock("./components/project/ProjectMapSurface", async () => {
  const React = await import("react");
  return {
    ProjectMapSurface: React.forwardRef((props: ProjectMapSurfaceProps, ref: React.ForwardedRef<unknown>) => {
      React.useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 400, y: 300 }) }));
      return <div data-testid="panel-session-map">
        <button onClick={() => props.onSelect("item-note")}>Select note</button>
        <button onClick={() => props.onSelect("item-reference")}>Select reference</button>
        <button onClick={() => props.onSelect(null)}>Clear fixture selection</button>
      </div>;
    }),
  };
});

const fetchMock = vi.fn<typeof fetch>();
const panelCases = [
  { name: "References", label: "Reference search and placement", close: "Close References" },
  { name: "Inspector", label: "Project Inspector", close: "Close Inspector" },
] as const;
type PanelCase = typeof panelCases[number];

function fixture(projectId = "project-a") {
  const snapshot = projectTestSnapshotWithAttachment();
  snapshot.project.id = projectId;
  snapshot.project.title = projectId === "project-a" ? "Project A fixture" : "Project B fixture";
  for (const collection of [snapshot.items, snapshot.contents]) {
    for (const value of collection) value.projectId = projectId;
  }
  snapshot.references[0]!.resolution.contexts = [{ segments: [{
    type: "sample", id: "sample-a", label: "Sample A", deletedAt: null, archivedAt: null,
  }] }];
  return snapshot;
}

function responsiveMedia(initialWidth = 1400) {
  let width = initialWidth;
  const records = new Map<string, { media: MediaQueryList; listeners: Set<(event: MediaQueryListEvent) => void> }>();
  const matches = (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const max = /max-width:\s*(\d+)px/.exec(query);
    return (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
  };
  return {
    matchMedia: (query: string) => {
      if (!records.has(query)) {
        const listeners = new Set<(event: MediaQueryListEvent) => void>();
        const media = {
          get matches() { return matches(query); }, media: query, onchange: null,
          addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
          removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
          addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
          removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
          dispatchEvent: () => true,
        } as unknown as MediaQueryList;
        records.set(query, { media, listeners });
      }
      return records.get(query)!.media;
    },
    setWidth(next: number) {
      const previous = new Map([...records.keys()].map((query) => [query, matches(query)]));
      width = next;
      for (const [query, { listeners }] of records) {
        if (previous.get(query) === matches(query)) continue;
        for (const listener of [...listeners]) listener({ media: query, matches: matches(query) } as MediaQueryListEvent);
      }
    },
  };
}
let media: ReturnType<typeof responsiveMedia>;
function panel(target: PanelCase) { return screen.getByRole("complementary", { name: target.label }); }
function absent(target: PanelCase) { expect(screen.queryByRole("complementary", { name: target.label })).toBeNull(); }
function open(target: PanelCase) { fireEvent.click(screen.getByRole("button", { name: target.name })); }
function select(name: "note" | "reference") { fireEvent.click(screen.getByRole("button", { name: `Select ${name}` })); }
function clearSelection() { fireEvent.click(screen.getByRole("button", { name: "Clear fixture selection" })); }
async function renderProject() {
  const router = createMemoryRouter([{ path: "/projects/:projectId", element: <ProjectPage /> }], {
    initialEntries: ["/projects/project-a"],
  });
  render(<RouterProvider router={router} />);
  await screen.findByTestId("panel-session-map");
  return router;
}

beforeAll(async () => { await import("./components/project/ProjectReadingSurface"); });
beforeEach(() => {
  media = responsiveMedia();
  vi.stubGlobal("matchMedia", media.matchMedia);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (path) => new Response(JSON.stringify(fixture(String(path).includes("project-b") ? "project-b" : "project-a")), {
    headers: { "content-type": "application/json" },
  }));
});
afterEach(() => { cleanup(); fetchMock.mockReset(); vi.unstubAllGlobals(); });

describe.each(panelCases)("$name workspace panel session", (target) => {
  it("opens only explicitly, tolerates an initially empty selection, and restores after temporary selection loss", async () => {
    await renderProject();
    absent(target);
    select("note");
    absent(target);
    clearSelection();
    open(target);
    expect(panel(target)).toBeTruthy();
    select("reference");
    expect(panel(target)).toBeTruthy();
    select("note");
    expect(panel(target)).toBeTruthy();
    clearSelection();
    absent(target);
    select("reference");
    expect(panel(target)).toBeTruthy();
    fireEvent.click(within(panel(target)).getByRole("button", { name: target.close }));
    select("note");
    absent(target);
  });

  it("keeps Pin through empty selection and explicit close without reopening a closed panel", async () => {
    await renderProject();
    select("note");
    open(target);
    fireEvent.click(within(panel(target)).getByRole("button", { name: "Pin" }));
    clearSelection();
    expect(panel(target)).toBeTruthy();
    fireEvent.click(within(panel(target)).getByRole("button", { name: target.close }));
    select("reference");
    absent(target);
    clearSelection();
    absent(target);
    open(target);
    expect(within(panel(target)).getByRole("button", { name: "Unpin" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("isolates panel and Pin preferences between Projects while restoring the earlier Project", async () => {
    const router = await renderProject();
    open(target);
    fireEvent.click(within(panel(target)).getByRole("button", { name: "Pin" }));
    await act(() => router.navigate("/projects/project-b"));
    await screen.findByRole("heading", { name: "Project B fixture" });
    absent(target);
    open(target);
    expect(within(panel(target)).getByRole("button", { name: "Pin" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(within(panel(target)).getByRole("button", { name: target.close }));
    await act(() => router.navigate("/projects/project-a"));
    await screen.findByRole("heading", { name: "Project A fixture" });
    await waitFor(() => expect(within(panel(target)).getByRole("button", { name: "Unpin" })).toBeTruthy());
  });

  it("does not inherit the previous Project selection while restoring an explicitly opened empty panel", async () => {
    const router = await renderProject();
    await act(() => router.navigate("/projects/project-b"));
    await screen.findByRole("heading", { name: "Project B fixture" });
    open(target);
    expect(panel(target)).toBeTruthy();
    await act(() => router.navigate("/projects/project-a"));
    await screen.findByRole("heading", { name: "Project A fixture" });
    select("note");

    let completeReturn: (() => void) | undefined;
    fetchMock.mockImplementation(async (path) => {
      const response = new Response(JSON.stringify(fixture(String(path).includes("project-b") ? "project-b" : "project-a")), {
        headers: { "content-type": "application/json" },
      });
      if (String(path).includes("project-b")) {
        return new Promise<Response>((resolve) => { completeReturn = () => resolve(response); });
      }
      return response;
    });
    await act(() => router.navigate("/projects/project-b"));
    await waitFor(() => expect(completeReturn).toBeTypeOf("function"));
    await act(async () => { completeReturn!(); });
    await screen.findByRole("heading", { name: "Project B fixture" });
    expect(panel(target)).toBeTruthy();
    expect(within(panel(target)).getByRole("button", { name: "Pin" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("does not reopen a temporarily hidden Map panel when a Reading card starts inline editing", async () => {
    await renderProject();
    select("note");
    open(target);
    expect(panel(target)).toBeTruthy();
    clearSelection();
    absent(target);
    fireEvent.click(screen.getByRole("button", { name: "Reading" }));
    const reading = await screen.findByRole("region", { name: "Project Reading" });
    absent(target);
    fireEvent.click(within(reading).getByRole("button", { name: "Edit Markdown" }));
    const editor = await within(reading).findByRole("textbox", { name: "Reading Markdown editor" });
    expect(editor.closest(".project-reading-item")).toBeTruthy();
    for (const candidate of panelCases) absent(candidate);
    expect(screen.queryByRole("dialog", { name: "Project Inspector" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "References" })).toBeNull();
    fireEvent.click(within(reading).getByRole("button", { name: "Cancel" }));
    for (const candidate of panelCases) absent(candidate);
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    await screen.findByTestId("panel-session-map");
    expect(panel(target)).toBeTruthy();
  });
});

describe("References and Inspector presentation consistency", () => {
  it("keeps committed Reference searches and unsubmitted drafts separate for each Project", async () => {
    const target = panelCases[0];
    const router = await renderProject();
    const queryInput = () => within(panel(target)).getByRole("textbox", { name: "Reference search draft" }) as HTMLInputElement;
    const committedQuery = () => within(panel(target)).getByLabelText("Committed Reference search").textContent;
    open(target);
    fireEvent.change(queryInput(), { target: { value: "committed silicon query" } });
    fireEvent.click(within(panel(target)).getByRole("button", { name: "Commit Reference search" }));
    fireEvent.change(queryInput(), { target: { value: "unsubmitted silicon query" } });
    expect(committedQuery()).toBe("committed silicon query");

    await act(() => router.navigate("/projects/project-b"));
    await screen.findByRole("heading", { name: "Project B fixture" });
    open(target);
    expect(queryInput().value).toBe("");
    expect(committedQuery()).toBe("");
    fireEvent.change(queryInput(), { target: { value: "committed germanium query" } });
    fireEvent.click(within(panel(target)).getByRole("button", { name: "Commit Reference search" }));
    fireEvent.change(queryInput(), { target: { value: "unsubmitted germanium query" } });

    await act(() => router.navigate("/projects/project-a"));
    await screen.findByRole("heading", { name: "Project A fixture" });
    await waitFor(() => expect(queryInput().value).toBe("unsubmitted silicon query"));
    expect(committedQuery()).toBe("committed silicon query");
    await act(() => router.navigate("/projects/project-b"));
    await screen.findByRole("heading", { name: "Project B fixture" });
    await waitFor(() => expect(queryInput().value).toBe("unsubmitted germanium query"));
    expect(committedQuery()).toBe("committed germanium query");
  });

  it("follows Reference selection context without losing the unsubmitted search draft across temporary hiding", async () => {
    const target = panelCases[0];
    await renderProject();
    select("reference");
    open(target);
    expect(within(panel(target)).getByLabelText("Reference recommendation context").textContent).toBe("selection:sample-a");
    fireEvent.change(within(panel(target)).getByRole("textbox", { name: "Reference search draft" }), { target: { value: "unsubmitted silicon query" } });
    select("note");
    expect(within(panel(target)).getByLabelText("Reference recommendation context").textContent).toBe("project:sample-a");
    clearSelection();
    absent(target);
    select("reference");
    expect(within(panel(target)).getByLabelText("Reference recommendation context").textContent).toBe("selection:sample-a");
    expect((within(panel(target)).getByRole("textbox", { name: "Reference search draft" }) as HTMLInputElement).value).toBe("unsubmitted silicon query");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET")).toHaveLength(0);
  });

  it("shows only the last explicitly opened panel on narrow Map, even when the other is pinned, and restores both on wide Map", async () => {
    const [references, inspector] = panelCases;
    await renderProject();
    select("note");
    open(inspector);
    fireEvent.click(within(panel(inspector)).getByRole("button", { name: "Pin" }));
    open(references);
    expect(panel(inspector)).toBeTruthy();
    expect(panel(references)).toBeTruthy();
    act(() => media.setWidth(1000));
    absent(inspector);
    expect(within(panel(references)).getByRole("button", { name: "Pin" })).toBeTruthy();
    fireEvent.click(within(panel(references)).getByRole("button", { name: "Pin" }));
    open(inspector);
    absent(references);
    expect(within(panel(inspector)).getByRole("button", { name: "Unpin" })).toBeTruthy();
    select("reference");
    absent(references);
    expect(panel(inspector)).toBeTruthy();
    act(() => media.setWidth(1400));
    expect(within(panel(references)).getByRole("button", { name: "Unpin" })).toBeTruthy();
    expect(within(panel(inspector)).getByRole("button", { name: "Unpin" })).toBeTruthy();
  });

  it("omits Pin in Reading and does not reopen Inspector when References closes", async () => {
    const [references, inspector] = panelCases;
    await renderProject();
    select("note");
    open(inspector);
    fireEvent.click(screen.getByRole("button", { name: "Reading" }));
    await screen.findByRole("region", { name: "Project Reading" });
    expect(within(panel(inspector)).queryByRole("button", { name: /^(?:Pin|Unpin)$/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Reference from research record" }));
    absent(inspector);
    expect(within(panel(references)).queryByRole("button", { name: /^(?:Pin|Unpin)$/ })).toBeNull();
    fireEvent.click(within(panel(references)).getByRole("button", { name: references.close }));
    absent(references);
    absent(inspector);
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    await screen.findByTestId("panel-session-map");
    expect(panel(inspector)).toBeTruthy();
  });
});
