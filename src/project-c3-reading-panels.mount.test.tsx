// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, Link, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSnapshot } from "../shared/project-api";
import type { ReferenceSearchResult } from "../shared/reference-search";
import type { ProjectReferenceSuggestionSeed } from "./lib/project-reference-suggestions";
import type { ReferenceSearchUiState } from "./lib/reference-search-ui";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshotWithAttachment } from "./project-test-fixture";

const readingMount = vi.hoisted(() => ({ onMount: null as (() => void) | null }));

vi.mock("./components/project/ProjectReadingSurface", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/project/ProjectReadingSurface")>();
  const React = await import("react");
  return {
    ...actual,
    ProjectReadingSurface: (props: Parameters<typeof actual.ProjectReadingSurface>[0]) => {
      React.useEffect(() => { readingMount.onMount?.(); }, []);
      return <actual.ProjectReadingSurface {...props} />;
    },
  };
});

vi.mock("./components/ReferenceSearchSurface", () => ({
  ReferenceSearchSurface: ({ value, onChange, suggestionSeeds, onPlaceAtCenter, placementDisabled }: {
    value: ReferenceSearchUiState;
    onChange: (next: ReferenceSearchUiState) => void;
    suggestionSeeds: ProjectReferenceSuggestionSeed[];
    onPlaceAtCenter: (result: ReferenceSearchResult) => void;
    placementDisabled: boolean;
  }) => <div>
    <label>Reference query<input value={value.query} onChange={(event) => onChange({ ...value, query: event.currentTarget.value })} /></label>
    <output aria-label="Selected suggestion seed">{suggestionSeeds.filter((seed) => seed.origin === "selection").map((seed) => `${seed.target.type}:${seed.target.id}`).join(", ")}</output>
    <button disabled={placementDisabled} onClick={() => onPlaceAtCenter({
      target: { type: "sample", id: "sample-a" },
      match: { tier: "exact_id", matchedAt: "2026-09-11T08:00:00.000Z" },
      resolution: projectTestSnapshotWithAttachment().references[0].resolution,
    })}>Place sample</button>
    <Link to="/samples/sample-a">Open sample source</Link>
  </div>,
}));

vi.mock("./components/project/ProjectMapSurface", async () => {
  const React = await import("react");
  return {
    ProjectMapSurface: React.forwardRef((props: { selectedItemId?: string | null; focusedItemId?: string | null }, ref: React.ForwardedRef<{ getViewportCenter: () => { x: number; y: number } }>) => {
      React.useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 400, y: 300 }) }));
      return <div data-testid="c3-project-map" data-selected-item-id={props.selectedItemId ?? ""} data-focused-item-id={props.focusedItemId ?? ""}>C3 Map fixture</div>;
    }),
  };
});

function responsiveMedia(initialWidth: number) {
  let width = initialWidth;
  const records = new Map<string, { media: MediaQueryList; listeners: Set<(event: MediaQueryListEvent) => void> }>();
  const matches = (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const max = /max-width:\s*(\d+)px/.exec(query);
    return (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
  };
  return {
    matchMedia: vi.fn((query: string) => {
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
    }),
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

function snapshotWithRelationships(): ProjectSnapshot {
  const snapshot = projectTestSnapshotWithAttachment();
  snapshot.references[0].resolution.contexts = [{ segments: [{ type: "sample", id: "sample-a", label: "Sample A", deletedAt: null, archivedAt: null }] }];
  snapshot.edges = [{
    id: "edge-related", projectId: snapshot.project.id, sourceItemId: "item-note", targetItemId: "item-reference",
    sourceHandle: "right", targetHandle: "left", markerStart: "none", markerEnd: "arrow", label: "supports",
    revision: 1, createdBy: "user@example.com", updatedBy: "user@example.com", createdAt: snapshot.project.createdAt,
    updatedAt: snapshot.project.createdAt, deletedAt: null, deletedBy: null,
  }];
  return snapshot;
}

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }));
}

function click(element: HTMLElement) {
  element.focus();
  fireEvent.click(element);
}

function renderProject(initialEntry = "/projects/project-a") {
  const router = createMemoryRouter([
    { path: "/projects/:projectId", element: <ProjectPage /> },
    { path: "/samples/:sampleId", element: <p>Source record</p> },
  ], { initialEntries: [initialEntry] });
  return { ...render(<RouterProvider router={router} />), router };
}

async function showReading() {
  if (screen.queryByTestId("c3-project-map")) click(screen.getByRole("button", { name: "Reading" }));
  return screen.findByRole("region", { name: "Project Reading" });
}

async function openDetails(title: string) {
  click(screen.getByRole("button", { name: `Details for ${title}` }));
  const inspector = await screen.findByRole("complementary", { name: "Project Inspector" });
  await waitFor(() => expect(inspector.contains(document.activeElement)).toBe(true));
  return inspector;
}

describe("C3 Reading details and responsive panel integration", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let media = responsiveMedia(1440);
  let snapshot: ProjectSnapshot;

  beforeEach(() => {
    readingMount.onMount = null;
    snapshot = snapshotWithRelationships();
    media = responsiveMedia(1440);
    fetchMock.mockReset();
    fetchMock.mockImplementation((path, init) => String(path) === "/api/projects/project-a" && !init?.method
      ? jsonResponse(snapshot)
      : jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", media.matchMedia);
    window.sessionStorage.clear();
  });

  afterEach(() => {
    readingMount.onMount = null;
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it("shows authoritative details for all three Reading occurrence kinds without opening on text selection", async () => {
    renderProject();
    await screen.findByTestId("c3-project-map");
    const reading = await showReading();
    fireEvent.click(within(reading).getByText("Preserve the occurrence identity."));
    expect(screen.queryByRole("complementary", { name: "Project Inspector" })).toBeNull();

    let inspector = await openDetails("Design note");
    expect(await within(inspector).findByRole("heading", { name: "Design note" })).toBeTruthy();
    expect(within(inspector).getByRole("button", { name: "outgoing relationship: supports; Sample A" })).toBeTruthy();
    expect(within(inspector).queryByText("Arrange on Map")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    click(within(inspector).getByRole("button", { name: "Close Inspector" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Details for Design note" })));

    inspector = await openDetails("Sample A");
    expect(within(inspector).getByRole("link", { name: "Open exact source" }).getAttribute("href")).toBe("/samples/sample-a");
    expect(within(inspector).getByRole("button", { name: "Browse related records" })).toBeTruthy();
    click(within(inspector).getByRole("button", { name: "Close Inspector" }));
    inspector = await openDetails("evidence.pdf");
    expect(within(inspector).getByRole("link", { name: "Open attachment" }).getAttribute("href")).toBe("/api/projects/project-a/contents/content-attachment/file");
    expect(within(inspector).getByRole("button", { name: "Edit metadata" })).toBeTruthy();
    expect(document.querySelectorAll("#project-inspector-panel")).toHaveLength(1);
  });

  it.each(["markdown", "attachment"] as const)("keeps %s editing in one mobile Inspector and restores its Details origin on close", async (kind) => {
    media.setWidth(390);
    const { container } = renderProject();
    const reading = await showReading();
    const title = kind === "markdown" ? "Design note" : "evidence.pdf";
    const detailsTrigger = within(reading).getByRole("button", { name: `Details for ${title}` });
    const detailsButtons = within(reading).getAllByRole("button", { name: /^Details for / });
    const inspector = await openDetails(title);
    const dialog = screen.getByRole("dialog", { name: "Project Inspector" });
    const editLabel = kind === "markdown" ? "Edit Markdown" : "Edit metadata";
    click(within(inspector).getByRole("button", { name: editLabel }));
    const fieldLabel = kind === "markdown" ? "Inspector Markdown editor" : "Caption";
    const editor = await within(inspector).findByLabelText(fieldLabel);
    await waitFor(() => expect(document.activeElement).toBe(editor));
    expect(screen.getAllByLabelText(fieldLabel)).toHaveLength(1);
    expect(screen.queryByLabelText(kind === "markdown" ? "Reading Markdown editor" : "Reading attachment caption")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Project Inspector" })).toBe(dialog);
    expect(screen.getByRole("complementary", { name: "Project Inspector" })).toBe(inspector);
    expect(editor.closest("#project-inspector-panel")).toBe(inspector);
    expect(editor.closest(".project-reading-item")).toBeNull();
    expect(container.hasAttribute("inert")).toBe(true);
    fireEvent.change(editor, { target: { value: "Draft stays in Inspector" } });
    expect((editor as HTMLTextAreaElement).value).toBe("Draft stays in Inspector");
    for (const details of detailsButtons) expect((details as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    click(within(inspector).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(within(inspector).queryByLabelText(fieldLabel)).toBeNull());
    expect(screen.getByRole("dialog", { name: "Project Inspector" })).toBe(dialog);
    expect(container.hasAttribute("inert")).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(within(inspector).getByRole("button", { name: editLabel })));
    expect(within(inspector).queryByText("Draft stays in Inspector")).toBeNull();
    click(within(inspector).getByRole("button", { name: "Close Inspector" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Project Inspector" })).toBeNull());
    expect(screen.queryByRole("complementary", { name: "Project Inspector" })).toBeNull();
    expect(container.hasAttribute("inert")).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(detailsTrigger));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("closes mobile details and focuses the related occurrence on every explicit request", async () => {
    media.setWidth(390);
    renderProject();
    await showReading();
    const target = document.querySelector<HTMLElement>('[data-project-item-id="item-reference"]')!;
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    for (let count = 1; count <= 2; count += 1) {
      const inspector = await openDetails("Design note");
      click(within(inspector).getByRole("button", { name: "outgoing relationship: supports; Sample A" }));
      await waitFor(() => expect(document.activeElement).toBe(target));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(target.getAttribute("aria-current")).toBe("location");
      expect(scroll).toHaveBeenCalledTimes(count);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a first-frame Details click after reconciling the initial empty selection", async () => {
    media.setWidth(390);
    // Resolve the real lazy Reading surface before the second page mounts, so
    // its controls and the initial empty selection commit in the same frame.
    const warm = renderProject();
    await showReading();
    warm.unmount();

    const earlyClick = vi.fn(() => {
      screen.getByRole("button", { name: "Details for Design note" }).click();
    });
    // Child passive effects run before parent passive effects. This exposes a
    // stale empty-selection close without relying on worker load or a sleep.
    readingMount.onMount = earlyClick;
    renderProject();
    const inspector = await screen.findByRole("complementary", { name: "Project Inspector" });
    expect(earlyClick).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Details for Design note" }).getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(inspector.contains(document.activeElement)).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("replaces mobile Inspector with one References modal while preserving the related source selection", async () => {
    media.setWidth(390);
    renderProject();
    await showReading();
    const inspector = await openDetails("Sample A");
    click(within(inspector).getByRole("button", { name: "Browse related records" }));
    const references = await screen.findByRole("dialog", { name: "References" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByRole("complementary", { name: "Project Inspector" })).toBeNull();
    expect(within(references).getByLabelText("Selected suggestion seed").textContent).toBe("sample:sample-a");
    await waitFor(() => expect(references.contains(document.activeElement)).toBe(true));
    fireEvent.change(within(references).getByLabelText("Reference query"), { target: { value: "GeSn" } });
    click(within(references).getByRole("button", { name: "Close References" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add" })));
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("preserves clean selection, canonical focus and query through the adjacent 860/859 boundary", async () => {
    media.setWidth(860);
    const { router } = renderProject("/projects/project-a?focus=item-reference");
    const map = await screen.findByTestId("c3-project-map");
    await waitFor(() => expect(map.getAttribute("data-selected-item-id")).toBe("item-reference"));
    click(screen.getByRole("button", { name: "References" }));
    fireEvent.change(screen.getByLabelText("Reference query"), { target: { value: "GeSn query" } });
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => media.setWidth(859));
    const references = await screen.findByRole("dialog", { name: "References" });
    expect((within(references).getByLabelText("Reference query") as HTMLInputElement).value).toBe("GeSn query");
    expect(document.querySelector('[data-project-item-id="item-reference"]')?.getAttribute("aria-current")).toBe("location");
    expect(screen.queryByTestId("c3-project-map")).toBeNull();
    expect(router.state.location.search).toBe("?focus=item-reference");

    act(() => media.setWidth(860));
    const returnedMap = await screen.findByTestId("c3-project-map");
    expect(returnedMap.getAttribute("data-selected-item-id")).toBe("item-reference");
    expect(returnedMap.getAttribute("data-focused-item-id")).toBe("item-reference");
    expect((screen.getByLabelText("Reference query") as HTMLInputElement).value).toBe("GeSn query");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(router.state.location.search).toBe("?focus=item-reference");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes the inspected occurrence and returns focus to Add when its Details trigger disappears", async () => {
    media.setWidth(390);
    const item = snapshot.items.find((candidate) => candidate.id === "item-note")!;
    const content = snapshot.contents.find((candidate) => candidate.id === "content-note")!;
    const placement = snapshot.placements.find((candidate) => candidate.projectItemId === item.id)!;
    const deletedAt = "2026-09-11T22:00:00.000Z";
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshot);
      if (String(path) === "/api/projects/project-a/items/item-note" && init?.method === "DELETE") return jsonResponse({
        project: { ...snapshot.project, revision: snapshot.project.revision + 1, updatedAt: deletedAt },
        item: { ...item, revision: item.revision + 1, deletedAt, deletedBy: "user@example.com", updatedAt: deletedAt },
        content: { ...content, revision: content.revision + 1, deletedAt, deletedBy: "user@example.com", updatedAt: deletedAt },
        attachment: null, placement, replayed: false,
      });
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500);
    });
    renderProject();
    await showReading();
    const inspector = await openDetails("Design note");
    click(within(inspector).getByText("More actions", { selector: "summary" }));
    click(within(inspector).getByRole("button", { name: "Move Markdown to trash" }));
    await waitFor(() => expect(document.querySelector('[data-project-item-id="item-note"]')).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Project Inspector" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add" })));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const deletionInput = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(deletionInput).toMatchObject({ expectedItemRevision: item.revision, expectedContentRevision: content.revision });
  });

  it("switches desktop Reading from trash to either contextual panel", async () => {
    fetchMock.mockImplementation((path) => String(path).includes("/trash")
      ? jsonResponse({ ...snapshot, items: [], contents: [], attachments: [], placements: [], edges: [] })
      : jsonResponse(snapshot));
    renderProject();
    await screen.findByTestId("c3-project-map");
    await showReading();
    for (const destination of ["details", "references"]) {
      click(screen.getByRole("button", { name: "Project actions" }));
      click(screen.getByRole("button", { name: "Project trash" }));
      await screen.findByRole("heading", { name: "Project trash" });
      if (destination === "details") {
        await openDetails("Design note");
        expect(screen.queryByRole("heading", { name: "Project trash" })).toBeNull();
        click(screen.getByRole("button", { name: "Close Inspector" }));
      } else {
        click(screen.getByRole("button", { name: "Add" }));
        click(screen.getByRole("button", { name: "Reference from research record" }));
        await screen.findByLabelText("Reference query");
        expect(screen.queryByRole("heading", { name: "Project trash" })).toBeNull();
      }
    }
  });

  it("keeps uncertain mobile placement recoverable beneath an accessible navigation confirmation", async () => {
    media.setWidth(390);
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshot);
      if (String(path).endsWith("/items/reference") && init?.method === "POST") return Promise.reject(new Error("Response lost"));
      return jsonResponse({ error: "Unexpected request" }, 500);
    });
    const { router, container } = renderProject();
    await showReading();
    click(screen.getByRole("button", { name: "Add" }));
    click(screen.getByRole("button", { name: "Reference from research record" }));
    const references = await screen.findByRole("dialog", { name: "References" });
    click(within(references).getByRole("button", { name: "Place sample" }));
    await within(references).findByRole("button", { name: "Reconcile and cancel" });
    expect((within(references).getByRole("button", { name: "Close References" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(within(references).getByRole("button", { name: "Retry" }), { key: "Escape" });
    fireEvent.click(references.parentElement!);
    expect(screen.getByRole("dialog", { name: "References" })).toBe(references);
    expect(container.hasAttribute("inert")).toBe(true);

    click(within(references).getByRole("link", { name: "Open sample source" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "Unsaved Project changes" });
    await waitFor(() => expect(confirmation.contains(document.activeElement)).toBe(true));
    expect(references.parentElement?.hasAttribute("inert")).toBe(true);
    expect(router.state.location.pathname).toBe("/projects/project-a");
    // Synthetic clicks also respect modal ownership; a lower backdrop cannot close its panel.
    fireEvent.click(references.parentElement!);
    click(within(confirmation).getByRole("button", { name: "Stay on Project" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(references.contains(document.activeElement)).toBe(true));
    expect(screen.getByRole("button", { name: "Reconcile and cancel" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
