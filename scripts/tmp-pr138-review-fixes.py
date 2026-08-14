from pathlib import Path
from textwrap import dedent


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one anchor in {path}, found {count}: {old[:140]!r}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "src/pages/ProjectPage.tsx",
    '''function useDesktopProjectMap() {
  const query = "(min-width: 860px)";
  const [desktop, setDesktop] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return desktop;
}
''',
    '''function useDesktopProjectMap(
  projectionLocked: boolean,
  projectionLockedNow: () => boolean,
) {
  const query = "(min-width: 860px)";
  const lockCheckRef = useRef(projectionLockedNow);
  lockCheckRef.current = projectionLockedNow;
  const [desktop, setDesktop] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => {
      if (lockCheckRef.current()) return;
      setDesktop(media.matches);
    };
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (projectionLocked) return;
    setDesktop(window.matchMedia(query).matches);
  }, [projectionLocked]);

  return desktop;
}
''',
)

replace_once(
    "src/pages/ProjectPage.tsx",
    '''export function ProjectPage() {
  const { projectId = "" } = useParams();
  const desktop = useDesktopProjectMap();
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
''',
    '''export function ProjectPage() {
  const { projectId = "" } = useParams();
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
''',
)

replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const edgeController = useProjectEdgeController({
    projectId,
    snapshot,
    setSnapshot,
    externalBusy: saveState !== "saved"
      || pendingReference !== null
      || pendingReferenceRemoval !== null
      || markdownEditor !== null
      || pendingAttachment !== null
      || attachmentEditor !== null,
    onHistory: recordEdgeHistory,
  });

  const shouldBlockNavigation = useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => (
''',
    '''  const edgeController = useProjectEdgeController({
    projectId,
    snapshot,
    setSnapshot,
    externalBusy: saveState !== "saved"
      || pendingReference !== null
      || pendingReferenceRemoval !== null
      || markdownEditor !== null
      || pendingAttachment !== null
      || attachmentEditor !== null,
    onHistory: recordEdgeHistory,
  });

  const projectionSwitchLocked = saveState !== "saved"
    || pendingReference !== null
    || pendingReferenceRemoval !== null
    || markdownEditor !== null
    || pendingAttachment !== null
    || attachmentEditor !== null
    || edgeController.unsafe;
  const desktop = useDesktopProjectMap(projectionSwitchLocked, () => (
    saveStateRef.current !== "saved"
      || pendingReferenceRef.current !== null
      || pendingReferenceRemovalRef.current !== null
      || markdownEditorRef.current !== null
      || pendingAttachmentRef.current !== null
      || attachmentEditorRef.current !== null
      || edgeController.unsafeRef.current
  ));

  const shouldBlockNavigation = useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => (
''',
)

replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const viewSwitchDisabled = saveState !== "saved"
    || pendingReference !== null
    || pendingReferenceRemoval !== null
    || markdownEditor !== null
    || pendingAttachment !== null
    || attachmentEditor !== null
    || edgeController.unsafe;
''',
    '''  const viewSwitchDisabled = projectionSwitchLocked;
''',
)

replace_once(
    "package.json",
    '    "test:project-reading-mounted": "vitest run --config vitest.mounted.config.ts src/project-reading.mount.test.tsx src/project-page.mobile.mount.test.tsx src/project-map-surface.mount.test.tsx",',
    '    "test:project-reading-mounted": "vitest run --config vitest.mounted.config.ts src/project-reading.mount.test.tsx src/project-responsive-projection-safety.mount.test.tsx src/project-page.mobile.mount.test.tsx src/project-map-surface.mount.test.tsx",',
)

replace_once(
    "README.md",
    '- Create and open Projects, inspect existing occurrences on a desktop Map, move or resize nodes with explicit Save and bounded autosave, and review the deterministic read-only occurrence projection on mobile.',
    '- Create and open Projects, organize occurrences on a desktop Map with explicit Save and bounded autosave, switch desktop into deterministic Reading, and use Reading as the mobile default while editing only existing Project-owned Markdown and attachment metadata.',
)
replace_once(
    "README.md",
    '- Use one reusable, Project-oriented search and selection surface to find stable targets. The current `/search` reference browser remains integration scaffolding until Phase 3B2 embeds discovery and authoritative insertion inside Project.',
    '- Use one reusable, Project-oriented search and selection surface to find stable targets. Project now embeds discovery and authoritative repeated-reference insertion; the current `/search` page remains a thin reference browser and integration harness.',
)
replace_once(
    "README.md",
    'The reusable reference-search surface keeps committed state separate from form drafts, submits explicitly instead of scanning on every keystroke, renders server order without client-side scoring, and returns a stable `ReferenceTarget` without registering it or writing source data. Its long-term host is the Project workspace. The current URL-owned `/search` page remains a thin browser and integration harness until Phase 3B2 embeds Project-owned discovery and insertion UI.',
    'The reusable reference-search surface keeps committed state separate from form drafts, submits explicitly instead of scanning on every keystroke, renders server order without client-side scoring, and returns a stable `ReferenceTarget` without registering it or writing source data. Project embeds that surface for authoritative repeated-reference placement, while the URL-owned `/search` page remains a thin browser and integration harness rather than a second insertion workflow.',
)
replace_once(
    "README.md",
    'The Map-first Project model stores one immutable per-Project `created_sequence` on each item occurrence. The desktop Map dynamically loads React Flow and persists compact placement mutations rather than frontend graph JSON. The temporary mobile occurrence projection follows insertion sequence directly; it has no separate Reading-placement table, manual reorder, or edge-derived ordering until real use justifies a later dedicated design.',
    'The Map-first Project model stores one immutable per-Project `created_sequence` on each item occurrence. The desktop Map dynamically loads React Flow and persists compact placement mutations rather than frontend graph JSON. Reading projects those same occurrences in insertion order, is selectable on desktop and the default on mobile, keeps references read-only, and allows only existing Project-owned Markdown plus attachment caption/source-URL edits. It has no separate Reading-placement table, creation flow, manual reorder, or edge-derived ordering until real use justifies a later dedicated design.',
)

replace_once(
    "docs/PROJECT_READING_IMPLEMENTATION_PLAN.md",
    '''Status: Phase 3C active implementation; Phase 3B4 is complete in squash-merged PR #136

Last reviewed: 2026-08-14 before implementing the shared desktop/mobile Reading projection
''',
    '''Status: Phase 3C implemented in Draft PR #138; pending independent review

Last reviewed: 2026-08-14 after implementing the shared desktop/mobile Reading projection and responsive projection safety
''',
)
replace_once(
    "docs/PROJECT_READING_IMPLEMENTATION_PLAN.md",
    '''Desktop keeps Map as the default creation/organization surface and adds one explicit Map / Reading view switch. The switch is disabled while placement state is unsaved or any Project mutation/editor is unresolved, so an in-progress Map or content operation cannot disappear behind another projection.

Mobile defaults directly to Reading and never initializes React Flow. Mobile does not expose Map placement, reference insertion, attachment upload, edge authoring, occurrence removal, or any other creation/structural mutation.
''',
    '''Desktop keeps Map as the default creation/organization surface and adds one explicit Map / Reading view switch. The switch is disabled while placement state is unsaved or any Project mutation/editor is unresolved, so an in-progress Map or content operation cannot disappear behind another projection.

Responsive breakpoint changes obey the same lock. While an operation is unresolved or placement state is not saved, the current desktop/mobile projection is frozen even if `matchMedia` changes. Once the lock clears, the page immediately reconciles to the current media query. This keeps Map-only retry, cancel, and reconciliation controls reachable instead of stranding a pending operation in mobile Reading.

Mobile defaults directly to Reading and never initializes React Flow. Mobile does not expose Map placement, reference insertion, attachment upload, edge authoring, occurrence removal, or any other creation/structural mutation.
''',
)
replace_once(
    "docs/PROJECT_READING_IMPLEMENTATION_PLAN.md",
    '''- references remaining read-only;
- the folded Map double-click regression;
''',
    '''- references remaining read-only;
- responsive breakpoint changes preserving the current projection during pending reference placement, pending attachment upload/create, and unsaved geometry;
- the folded Map double-click regression;
''',
)

replace_once(
    "src/project-reading-contract.test.ts",
    '''  it("keeps the Map double-click regression fix folded into the Phase 3C branch", () => {
''',
    '''  it("keeps responsive projection changes behind the same unresolved-operation guard", () => {
    const page = read("src/pages/ProjectPage.tsx");
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(page).toContain("if (lockCheckRef.current()) return;");
    expect(page).toContain("const viewSwitchDisabled = projectionSwitchLocked;");
    expect(page).toContain("setDesktop(window.matchMedia(query).matches)");
    expect(pkg.scripts["test:project-reading-mounted"]).toContain("src/project-responsive-projection-safety.mount.test.tsx");
  });

  it("keeps the Map double-click regression fix folded into the Phase 3C branch", () => {
''',
)

Path("src/project-responsive-projection-safety.mount.test.tsx").write_text(dedent(r'''// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceSearchResult } from "../shared/reference-search";
import type { ProjectGeometryCommand, ProjectNodeDescriptor } from "./lib/project-map-model";
import type { ProjectPendingAttachmentPlacement } from "./lib/project-owned-content";
import type { ProjectPendingReferencePlacement } from "./lib/project-reference-placement";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

const searchResult: ReferenceSearchResult = {
  target: { type: "sample", id: "sample-responsive" },
  match: { tier: "exact_id", matchedAt: "2026-08-14T07:00:00.000Z" },
  resolution: {
    target: { type: "sample", id: "sample-responsive" },
    resolution: "resolved",
    source: {
      title: "Responsive sample",
      subtitle: "Projection lock fixture",
      excerpt: "Pending reference placement",
      kind: "sample",
      state: "stored",
      updatedAt: "2026-08-14T07:00:00.000Z",
      deletedAt: null,
      archivedAt: null,
    },
    contexts: [],
    destination: {
      referenceUrl: "/references/sample/sample-responsive",
      mode: "source",
      openSourceUrl: "/samples/sample-responsive",
      contextOpenSourceUrls: [],
    },
  },
};

vi.mock("./components/ReferenceSearchSurface", () => ({
  ReferenceSearchSurface: ({
    placementDisabled,
    onPlaceAtCenter,
  }: {
    placementDisabled?: boolean;
    onPlaceAtCenter: (result: ReferenceSearchResult) => void;
  }) => <button
    type="button"
    disabled={placementDisabled}
    onClick={() => onPlaceAtCenter(searchResult)}
  >Start pending reference</button>,
}));

vi.mock("./components/project/ProjectMapSurface", async () => {
  const React = await import("react");
  return {
    ProjectMapSurface: React.forwardRef((props: {
      nodes: ProjectNodeDescriptor[];
      pendingReference?: ProjectPendingReferencePlacement | null;
      pendingAttachment?: ProjectPendingAttachmentPlacement | null;
      onGeometryCommit?: (command: ProjectGeometryCommand) => void;
      onAttachmentRequest?: (point: { x: number; y: number }) => void;
    }, ref: React.ForwardedRef<{ getViewportCenter: () => { x: number; y: number } }>) => {
      React.useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 400, y: 300 }) }));
      const note = props.nodes.find((node) => node.itemId === "item-note");
      return <div data-testid="responsive-project-map">
        <p>Responsive Map fixture</p>
        {props.pendingReference && <p>Pending reference state: {props.pendingReference.status}</p>}
        {props.pendingAttachment && <p>Pending attachment state: {props.pendingAttachment.status}</p>}
        <button type="button" onClick={() => {
          if (!note) return;
          props.onGeometryCommit?.({
            placementId: note.placementId,
            before: note.geometry,
            after: { ...note.geometry, x: note.geometry.x + 40 },
          });
        }}>Dirty geometry</button>
        <button type="button" onClick={() => props.onAttachmentRequest?.({ x: 300, y: 240 })}>Request attachment</button>
      </div>;
    }),
  };
});

function controllableMatchMedia(initialMatches = true) {
  const query = "(min-width: 860px)";
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    get matches() { return matches; },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener as (event: MediaQueryListEvent) => void);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener as (event: MediaQueryListEvent) => void);
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;

  return {
    matchMedia: vi.fn(() => media),
    setMatches(next: boolean) {
      matches = next;
      const event = { matches: next, media: query } as MediaQueryListEvent;
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }], { initialEntries: ["/projects/project-a"] });
  return render(<RouterProvider router={router} />);
}

function expectDesktopMapFrozen() {
  expect(screen.getByTestId("responsive-project-map")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Project Reading" })).toBeNull();
  expect(document.querySelector(".project-page")?.className).toContain("desktop");
  expect(screen.getByRole("button", { name: "Reading" }).hasAttribute("disabled")).toBe(true);
}

describe("responsive Project projection safety", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let media = controllableMatchMedia(true);

  beforeEach(() => {
    fetchMock.mockReset();
    media = controllableMatchMedia(true);
    vi.stubGlobal("matchMedia", media.matchMedia);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps desktop Map visible when the breakpoint changes during pending reference placement", async () => {
    const pending = deferred<Response>();
    fetchMock
      .mockImplementationOnce(() => jsonResponse(projectTestSnapshot()))
      .mockImplementationOnce(() => pending.promise);

    renderProjectPage();
    await screen.findByText("Responsive Map fixture");
    fireEvent.click(screen.getByRole("button", { name: "Start pending reference" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Pending reference state: placing")).toBeTruthy();

    act(() => media.setMatches(false));
    expectDesktopMapFrozen();
  });

  it("keeps desktop Map visible when the breakpoint changes during pending attachment upload", async () => {
    const pending = deferred<Response>();
    const file = new File(["data"], "pending.pdf", { type: "application/pdf" });
    fetchMock
      .mockImplementationOnce(() => jsonResponse(projectTestSnapshot()))
      .mockImplementationOnce(() => pending.promise);

    renderProjectPage();
    await screen.findByText("Responsive Map fixture");
    fireEvent.click(screen.getByRole("button", { name: "Request attachment" }));
    fireEvent.change(screen.getByLabelText("Choose Project attachment"), { target: { files: [file] } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Pending attachment state: uploading")).toBeTruthy();

    act(() => media.setMatches(false));
    expectDesktopMapFrozen();
  });

  it("keeps desktop Map visible when the breakpoint changes with unsaved geometry", async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse(projectTestSnapshot()));

    renderProjectPage();
    await screen.findByText("Responsive Map fixture");
    fireEvent.click(screen.getByRole("button", { name: "Dirty geometry" }));
    expect(await screen.findByText("Unsaved")).toBeTruthy();

    act(() => media.setMatches(false));
    expectDesktopMapFrozen();
  });
});
'''))
