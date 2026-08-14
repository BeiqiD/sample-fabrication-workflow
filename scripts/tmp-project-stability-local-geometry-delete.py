from pathlib import Path
from textwrap import dedent


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one anchor in {path}, found {count}: {old[:160]!r}")
    target.write_text(text.replace(old, new, 1))


# Project client: expose the already-authoritative Project soft-delete lifecycle.
replace_once(
    "src/lib/project-client.ts",
    "  ProjectItemLifecycleInput,\n  ProjectItemMutationResponse,",
    "  ProjectItemLifecycleInput,\n  ProjectItemMutationResponse,\n  ProjectLifecycleInput,",
)
replace_once(
    "src/lib/project-client.ts",
    '''  read: (projectId: string, signal?: AbortSignal) => projectRequest<ProjectSnapshot>(
    `/projects/${encodeURIComponent(projectId)}`,
    signal ? { signal } : undefined,
  ),
''',
    '''  read: (projectId: string, signal?: AbortSignal) => projectRequest<ProjectSnapshot>(
    `/projects/${encodeURIComponent(projectId)}`,
    signal ? { signal } : undefined,
  ),
  deleteProject: (
    projectId: string,
    input: ProjectLifecycleInput,
  ) => projectRequest<ProjectMutationResponse>(
    `/projects/${encodeURIComponent(projectId)}`,
    jsonRequest("DELETE", input),
  ),
''',
)

# Confirm dialog: allow reversible lifecycle wording and an uncertainty lock without
# changing existing hard-delete call sites.
replace_once(
    "src/components/ConfirmDeleteDialog.tsx",
    '''export function ConfirmDeleteDialog({ title, description, summary, deleting, error, eyebrow = "Confirm deletion", confirmLabel = "Delete", busyLabel = "Deleting…", confirmation, onCancel, onConfirm }: {
''',
    '''export function ConfirmDeleteDialog({ title, description, summary, deleting, error, eyebrow = "Confirm deletion", confirmLabel = "Delete", busyLabel = "Deleting…", appendIrreversibleWarning = true, cancelDisabled = false, confirmation, onCancel, onConfirm }: {
''',
)
replace_once(
    "src/components/ConfirmDeleteDialog.tsx",
    '''  busyLabel?: string;
  confirmation?: {
''',
    '''  busyLabel?: string;
  appendIrreversibleWarning?: boolean;
  cancelDisabled?: boolean;
  confirmation?: {
''',
)
replace_once(
    "src/components/ConfirmDeleteDialog.tsx",
    '''    blocked: deleting,
''',
    '''    blocked: deleting || cancelDisabled,
''',
)
replace_once(
    "src/components/ConfirmDeleteDialog.tsx",
    '''  return <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) onCancel(); }}>
''',
    '''  return <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting && !cancelDisabled) onCancel(); }}>
''',
)
replace_once(
    "src/components/ConfirmDeleteDialog.tsx",
    '''      <p id="confirm-delete-description">{description} This cannot be undone.</p>
''',
    '''      <p id="confirm-delete-description">{description}{appendIrreversibleWarning ? " This cannot be undone." : ""}</p>
''',
)
replace_once(
    "src/components/ConfirmDeleteDialog.tsx",
    '''        <button ref={cancelRef} type="button" className="button" disabled={deleting} onClick={onCancel}>Cancel</button>
''',
    '''        <button ref={cancelRef} type="button" className="button" disabled={deleting || cancelDisabled} onClick={onCancel}>Cancel</button>
''',
)

# Project page imports and deletion state.
replace_once(
    "src/pages/ProjectPage.tsx",
    '''  useBeforeUnload,
  useBlocker,
  useParams,
''',
    '''  useBeforeUnload,
  useBlocker,
  useNavigate,
  useParams,
''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''  ProjectItemLifecycleInput,
  ProjectItemMutationResponse,
''',
    '''  ProjectItemLifecycleInput,
  ProjectItemMutationResponse,
  ProjectLifecycleInput,
''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''import { ReferenceSearchSurface } from "../components/ReferenceSearchSurface";
''',
    '''import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { ReferenceSearchSurface } from "../components/ReferenceSearchSurface";
''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''function referenceInsertionFailureStatus(caught: unknown): "uncertain" | "error" | "conflict" {
  if (caught instanceof ProjectApiError) {
    if (caught.status === 409) return "conflict";
    if (caught.status >= 400 && caught.status < 500 && caught.status !== 408 && caught.status !== 429) {
      return "error";
    }
  }
  return "uncertain";
}

export function ProjectPage() {
  const { projectId = "" } = useParams();
''',
    '''function referenceInsertionFailureStatus(caught: unknown): "uncertain" | "error" | "conflict" {
  if (caught instanceof ProjectApiError) {
    if (caught.status === 409) return "conflict";
    if (caught.status >= 400 && caught.status < 500 && caught.status !== 408 && caught.status !== 429) {
      return "error";
    }
  }
  return "uncertain";
}

function projectDeletionOutcomeIsUncertain(caught: unknown) {
  if (!(caught instanceof ProjectApiError)) return true;
  return caught.status === 408 || caught.status === 429 || caught.status >= 500;
}

export function ProjectPage() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const [ownedContentActionError, setOwnedContentActionError] = useState("");
  const [desktopView, setDesktopView] = useState<ProjectWorkspaceView>("map");

  const baselineRef = useRef<Record<string, ProjectPlacementRecord>>({});
''',
    '''  const [ownedContentActionError, setOwnedContentActionError] = useState("");
  const [desktopView, setDesktopView] = useState<ProjectWorkspaceView>("map");
  const [confirmingProjectDeletion, setConfirmingProjectDeletion] = useState(false);
  const [projectDeleteConfirmation, setProjectDeleteConfirmation] = useState("");
  const [projectDeleteError, setProjectDeleteError] = useState("");
  const [projectDeleteUncertain, setProjectDeleteUncertain] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);

  const baselineRef = useRef<Record<string, ProjectPlacementRecord>>({});
''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const ownedContentGenerationRef = useRef(0);
  const mapSurfaceRef = useRef<ProjectMapSurfaceHandle | null>(null);
''',
    '''  const ownedContentGenerationRef = useRef(0);
  const projectDeleteInputRef = useRef<ProjectLifecycleInput | null>(null);
  const mapSurfaceRef = useRef<ProjectMapSurfaceHandle | null>(null);
''',
)

# Geometry dirtiness is local working state, not a structural/edge conflict domain.
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
''',
    '''  const edgeController = useProjectEdgeController({
    projectId,
    snapshot,
    setSnapshot,
    // Placement geometry is an immediate local working copy with independent
    // asynchronous persistence. Dirty/saving placement state must not serialize
    // edge operations, which are revisioned against Project item identities.
    externalBusy: pendingReference !== null
      || pendingReferenceRemoval !== null
      || markdownEditor !== null
      || pendingAttachment !== null
      || attachmentEditor !== null,
    onHistory: recordEdgeHistory,
  });
''',
)

# Clear deletion identity on unmount.
replace_once(
    "src/pages/ProjectPage.tsx",
    '''      attachmentEditorRef.current = null;
      attachmentUpdateInputRef.current = null;
      if (autosaveTimerRef.current !== null) {
''',
    '''      attachmentEditorRef.current = null;
      attachmentUpdateInputRef.current = null;
      projectDeleteInputRef.current = null;
      if (autosaveTimerRef.current !== null) {
''',
)

# Add the Project lifecycle UI state machine after the authoritative loader exists.
replace_once(
    "src/pages/ProjectPage.tsx",
    '''  useEffect(() => {
    const controller = new AbortController();
    void loadProject(controller.signal);
    return () => controller.abort();
  }, [loadProject]);
''',
    '''  useEffect(() => {
    const controller = new AbortController();
    void loadProject(controller.signal);
    return () => controller.abort();
  }, [loadProject]);

  const performProjectDeletion = useCallback(async (input: ProjectLifecycleInput) => {
    if (!projectId || !pageActiveRef.current) return;
    setDeletingProject(true);
    setProjectDeleteError("");
    try {
      await projectApi.deleteProject(projectId, input);
      if (!pageActiveRef.current) return;
      projectDeleteInputRef.current = null;
      setProjectDeleteUncertain(false);
      navigate("/projects", { replace: true });
    } catch (caught) {
      if (!pageActiveRef.current) return;
      if (caught instanceof ProjectApiError && caught.status === 404) {
        projectDeleteInputRef.current = null;
        setProjectDeleteUncertain(false);
        navigate("/projects", { replace: true });
        return;
      }
      if (caught instanceof ProjectApiError && caught.status === 409) {
        projectDeleteInputRef.current = null;
        setProjectDeleteUncertain(false);
        setProjectDeleteError("The Project changed before it could be moved to trash. The latest authoritative state has been reloaded; review it and confirm again.");
        await loadProject();
        return;
      }
      const uncertain = projectDeletionOutcomeIsUncertain(caught);
      setProjectDeleteUncertain(uncertain);
      setProjectDeleteError(caught instanceof Error
        ? caught.message
        : "The Project could not be moved to trash");
    } finally {
      if (pageActiveRef.current) setDeletingProject(false);
    }
  }, [loadProject, navigate, projectId]);

  const openProjectDeletion = useCallback(() => {
    if (saveStateRef.current !== "saved"
      || pendingReferenceRef.current
      || pendingReferenceRemovalRef.current
      || markdownEditorRef.current
      || pendingAttachmentRef.current
      || attachmentEditorRef.current
      || edgeController.unsafeRef.current) return;
    projectDeleteInputRef.current = null;
    setProjectDeleteConfirmation("");
    setProjectDeleteError("");
    setProjectDeleteUncertain(false);
    setConfirmingProjectDeletion(true);
  }, [edgeController.unsafeRef]);

  const cancelProjectDeletion = useCallback(() => {
    if (deletingProject || projectDeleteUncertain) return;
    projectDeleteInputRef.current = null;
    setProjectDeleteConfirmation("");
    setProjectDeleteError("");
    setConfirmingProjectDeletion(false);
  }, [deletingProject, projectDeleteUncertain]);

  const moveProjectToTrash = useCallback(() => {
    if (!snapshot || deletingProject || projectDeleteConfirmation !== snapshot.project.title) return;
    if (!projectDeleteInputRef.current) {
      if (saveStateRef.current !== "saved"
        || pendingReferenceRef.current
        || pendingReferenceRemovalRef.current
        || markdownEditorRef.current
        || pendingAttachmentRef.current
        || attachmentEditorRef.current
        || edgeController.unsafeRef.current) return;
      projectDeleteInputRef.current = {
        expectedRevision: snapshot.project.revision,
        operationId: createProjectApiId("operation"),
      };
    }
    void performProjectDeletion(projectDeleteInputRef.current);
  }, [deletingProject, edgeController.unsafeRef, performProjectDeletion, projectDeleteConfirmation, snapshot]);
''',
)

# Make Project deletion reachable on both projections/platform sizes.
replace_once(
    "src/pages/ProjectPage.tsx",
    '''      {desktop && <div className="project-workspace-header-actions">
        <div className="project-view-toggle" role="group" aria-label="Project view">
''',
    '''      <div className="project-workspace-header-actions">
        {desktop && <>
        <div className="project-view-toggle" role="group" aria-label="Project view">
''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''          >Save</button>
        </div>}
      </div>}
    </header>
''',
    '''          >Save</button>
        </div>}
        </>}
        <button
          type="button"
          className="button danger compact-button"
          disabled={viewSwitchDisabled || deletingProject}
          onClick={openProjectDeletion}
        >Move to trash</button>
      </div>
    </header>
''',
)

# Add the reversible confirmation dialog at the page level.
replace_once(
    "src/pages/ProjectPage.tsx",
    '''      onAttachmentCancel={() => cancelAttachmentEdit(false)}
    />}
  </div>;
}
''',
    '''      onAttachmentCancel={() => cancelAttachmentEdit(false)}
    />}

    {confirmingProjectDeletion && <ConfirmDeleteDialog
      eyebrow="Project lifecycle"
      title="Move Project to trash"
      description="Move this Project out of the active workspace. Its normalized Project data is soft-deleted and can be restored later."
      summary={snapshot.project.title}
      deleting={deletingProject}
      error={projectDeleteError}
      confirmLabel={projectDeleteUncertain ? "Retry exact move" : "Move to trash"}
      busyLabel="Moving…"
      appendIrreversibleWarning={false}
      cancelDisabled={projectDeleteUncertain}
      confirmation={{
        label: "Type the Project title to confirm",
        target: snapshot.project.title,
        value: projectDeleteConfirmation,
        onChange: setProjectDeleteConfirmation,
      }}
      onCancel={cancelProjectDeletion}
      onConfirm={moveProjectToTrash}
    />}
  </div>;
}
''',
)

# Client contract for the lifecycle route.
replace_once(
    "src/lib/project-client.test.ts",
    '''  it("uses Project-owned reference insertion and item-lifecycle routes", async () => {
''',
    '''  it("uses the authoritative Project lifecycle route to move a Project to trash", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      project: { id: "project-a", title: "Project A", deletedAt: "2026-08-14T08:00:00.000Z" },
      replayed: false,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const input = { expectedRevision: 4, operationId: "operation-delete-project" };
    await projectApi.deleteProject("project-a", input);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-a",
      expect.objectContaining({ method: "DELETE", body: JSON.stringify(input) }),
    );
  });

  it("uses Project-owned reference insertion and item-lifecycle routes", async () => {
''',
)

# Edge contract: dirty placement is explicitly not an edge serialization condition.
replace_once(
    "src/project-edges-contract.test.ts",
    '''    expect(page).toContain("edgeInteractionDisabled={edgeController.interactionDisabled}");
''',
    '''    expect(page).toContain("edgeInteractionDisabled={edgeController.interactionDisabled}");
    expect(page).not.toContain('externalBusy: saveState !== "saved"');
    expect(page).toContain("Dirty/saving placement state must not serialize");
''',
)

# Real React Flow regression: a local geometry projection update must not destabilize
# existing edge selection or disable handles before persistence.
edge_surface = Path("src/project-edge-surface.mount.test.tsx")
edge_text = edge_surface.read_text()
anchor = '''  it("disables connection handles independently from node geometry interaction", async () => {
'''
insert = dedent(r'''
  it("keeps edge selection and connection handles stable after local geometry moves before persistence", async () => {
    const snapshot = projectTestSnapshot();
    const edge = edgeRecord();
    const originalNodes = projectMapNodes(snapshot);
    const movedNodes = originalNodes.map((node) => node.itemId === "item-note"
      ? { ...node, geometry: { ...node.geometry, x: node.geometry.x + 96 } }
      : node);
    const onEdgeSelect = vi.fn();
    const { container, rerender } = render(<div style={{ width: 900, height: 700 }}>
      <ProjectMapSurface
        nodes={originalNodes}
        edges={[edge]}
        selectedItemId={null}
        selectedEdgeId={null}
        edgeInteractionDisabled={false}
        onSelect={() => undefined}
        onEdgeSelect={onEdgeSelect}
        onGeometryCommit={() => undefined}
      />
    </div>);

    await waitFor(() => expect(container.querySelectorAll(".project-edge-handle.connectable").length).toBe(8));
    rerender(<div style={{ width: 900, height: 700 }}>
      <ProjectMapSurface
        nodes={movedNodes}
        edges={[edge]}
        selectedItemId={null}
        selectedEdgeId={null}
        edgeInteractionDisabled={false}
        onSelect={() => undefined}
        onEdgeSelect={onEdgeSelect}
        onGeometryCommit={() => undefined}
      />
    </div>);

    await waitFor(() => expect(container.querySelectorAll(".project-edge-handle.connectable").length).toBe(8));
    const renderedEdge = await waitFor(() => {
      const candidate = container.querySelector<SVGGElement>('.react-flow__edge[data-id="edge-a"]');
      expect(candidate).toBeTruthy();
      return candidate!;
    });
    fireEvent.click(renderedEdge);
    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledWith("edge-a"));
  });

''')
if edge_text.count(anchor) != 1:
    raise SystemExit("edge surface insertion anchor mismatch")
edge_surface.write_text(edge_text.replace(anchor, insert + anchor, 1))

# Page-level regression: local geometry can remain dirty while a structurally
# independent edge mutation starts immediately, before the placement autosave.
Path("src/project-local-working-state.mount.test.tsx").write_text(dedent(r'''
// @vitest-environment jsdom
import { forwardRef, useImperativeHandle } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEdgeRecord } from "../shared/project-api";
import type { ProjectMapGeometry } from "../shared/project-types";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/ReferenceSearchSurface", () => ({
  ReferenceSearchSurface: () => <div>Reference search fixture</div>,
}));

vi.mock("./components/project/ProjectMapSurface", () => ({
  ProjectMapSurface: forwardRef(function LocalWorkingMap(props: {
    edgeInteractionDisabled?: boolean;
    onGeometryCommit: (command: { placementId: string; before: ProjectMapGeometry; after: ProjectMapGeometry }) => void;
    onEdgeConnect?: (connection: { sourceItemId: string; targetItemId: string; sourceHandle: "right"; targetHandle: "left" }) => void;
  }, ref) {
    useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 400, y: 300 }) }));
    const before = { x: 20, y: 40, width: 250, height: 180, zIndex: 0 };
    return <div>
      <p>Edge interaction: {props.edgeInteractionDisabled ? "disabled" : "enabled"}</p>
      <button type="button" onClick={() => props.onGeometryCommit({
        placementId: "placement-note",
        before,
        after: { ...before, x: 116 },
      })}>Move note locally</button>
      <button type="button" disabled={props.edgeInteractionDisabled} onClick={() => props.onEdgeConnect?.({
        sourceItemId: "item-note",
        targetItemId: "item-reference",
        sourceHandle: "right",
        targetHandle: "left",
      })}>Connect local edge</button>
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

function edgeRecord(): ProjectEdgeRecord {
  const now = "2026-08-14T08:00:00.000Z";
  return {
    id: "edge-local",
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
  };
}

function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }], { initialEntries: ["/projects/project-a"] });
  return render(<RouterProvider router={router} />);
}

describe("Project local working state", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("matchMedia", desktopMatchMedia());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("allows an edge mutation while geometry is locally dirty and before placement autosave", async () => {
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(projectTestSnapshot());
      if (String(path) === "/api/projects/project-a/edges" && init?.method === "POST") {
        return jsonResponse({ value: edgeRecord(), replayed: false }, 201);
      }
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500);
    });

    renderProjectPage();
    expect(await screen.findByText("Edge interaction: enabled")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move note locally" }));
    expect(await screen.findByText("Unsaved")).toBeTruthy();
    expect(screen.getByText("Edge interaction: enabled")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect local edge" }).hasAttribute("disabled")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Connect local edge" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/projects/project-a/edges");
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes("/placements/"))).toBe(false);
  });
});
'''))

# Project lifecycle mounted regression: exact retry identity survives uncertain
# deletion outcome, and success exits the active workspace.
Path("src/project-deletion.mount.test.tsx").write_text(dedent(r'''
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/ReferenceSearchSurface", () => ({ ReferenceSearchSurface: () => <div /> }));
vi.mock("./components/project/ProjectMapSurface", async () => {
  const React = await import("react");
  return {
    ProjectMapSurface: React.forwardRef((_props, ref) => {
      React.useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 400, y: 300 }) }));
      return <div>Project Map fixture</div>;
    }),
  };
});

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
    element: <div>Projects destination</div>,
  }], { initialEntries: ["/projects/project-a"] });
  return render(<RouterProvider router={router} />);
}

describe("Project lifecycle UI", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("matchMedia", desktopMatchMedia());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("moves a Project to trash and exact-retries the same lifecycle request after an uncertain outcome", async () => {
    const snapshot = projectTestSnapshot();
    let deleteCount = 0;
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshot);
      if (String(path) === "/api/projects/project-a" && init?.method === "DELETE") {
        deleteCount += 1;
        if (deleteCount === 1) return jsonResponse({ error: "Temporary Project deletion failure" }, 503);
        return jsonResponse({
          project: {
            ...snapshot.project,
            revision: snapshot.project.revision + 1,
            deletedAt: "2026-08-14T08:00:00.000Z",
            deletedBy: "user@example.com",
          },
          replayed: true,
        });
      }
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500);
    });

    renderProjectPage();
    await screen.findByText("Project Map fixture");
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
    expect(await screen.findByRole("alertdialog", { name: "Move Project to trash" })).toBeTruthy();
    expect(screen.getByText(/can be restored later/)).toBeTruthy();
    expect(screen.queryByText(/cannot be undone/i)).toBeNull();
    fireEvent.change(screen.getByLabelText("Type the Project title to confirm"), {
      target: { value: snapshot.project.title },
    });
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));

    expect(await screen.findByText("Temporary Project deletion failure")).toBeTruthy();
    const firstDelete = fetchMock.mock.calls[1];
    expect(firstDelete[0]).toBe("/api/projects/project-a");
    expect(firstDelete[1]?.method).toBe("DELETE");
    const firstBody = JSON.parse(String(firstDelete[1]?.body));
    expect(firstBody.expectedRevision).toBe(snapshot.project.revision);
    expect(firstBody.operationId).toMatch(/^operation-/);
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Retry exact move" }));
    await screen.findByText("Projects destination");
    const secondBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(secondBody).toEqual(firstBody);
  });
});
'''))

# Permanent mounted Map gate runs the two stability regressions.
replace_once(
    "package.json",
    '    "test:project-map-mounted": "vitest run --config vitest.mounted.config.ts src/project-page.mobile.mount.test.tsx src/project-map-save.mount.test.tsx src/project-map-surface.mount.test.tsx",',
    '    "test:project-map-mounted": "vitest run --config vitest.mounted.config.ts src/project-page.mobile.mount.test.tsx src/project-map-save.mount.test.tsx src/project-map-surface.mount.test.tsx src/project-local-working-state.mount.test.tsx src/project-deletion.mount.test.tsx",',
)

# Canonical docs: Phase 3C is landed; freeze the local-working-copy concurrency rule
# before entering Phase 3D.
replace_once(
    "docs/PROJECT_CANVAS_INTERACTION_CONTRACT.md",
    '''Status: canonical product and architecture contract; Phase 3B4 is complete in PR #136 and Phase 3C Reading is the active implementation slice

Last reviewed: 2026-08-13 after Phase 3A persistence in PRs #131/#132, the Map
kernel in PR #133, reference placement in PR #134, and Project-owned content in
PR #135 were completed; Phase 3B4 basic Project-local edges are complete in
squash-merged PR #136 and Phase 3C Reading is now the active implementation slice
''',
    '''Status: canonical product and architecture contract; Phase 3C Reading is complete in squash-merged PR #138, with stability fixes landing before Phase 3D

Last reviewed: 2026-08-14 after Phase 3A persistence in PRs #131/#132, the Map
kernel in PR #133, reference placement in PR #134, Project-owned content in PR #135,
basic edges in PR #136, and Reading projection in squash-merged PR #138
''',
)
replace_once(
    "docs/PROJECT_CANVAS_INTERACTION_CONTRACT.md",
    '''Drag and resize update local state continuously but persist only at semantic
boundaries such as drag stop and resize end. Text and attachment-description
edits use an idle debounce, blur, explicit Save, or another documented flush
boundary.
''',
    '''Drag and resize update the local working copy immediately. Placement persistence
is asynchronous and may remain `Unsaved` or `Saving` after the geometry already
behaves as the current UI truth. Text and attachment-description edits use an
idle debounce, blur, explicit Save, or another documented flush boundary.

Dirty or in-flight placement persistence is not a global workspace mutation lock.
Operations whose optimistic-concurrency tokens are independent of placement
revision — notably selecting or creating Project-local edges from stable item
occurrences — remain usable while geometry waits for autosave. Structural/content
mutations that share identity or authoritative revision domains keep their existing
serialization and retry rules.
''',
)
replace_once(
    "docs/PROJECT_READING_IMPLEMENTATION_PLAN.md",
    '''Status: Phase 3C implemented in Draft PR #138; pending independent review

Last reviewed: 2026-08-14 after implementing the shared desktop/mobile Reading projection and responsive projection safety
''',
    '''Status: Phase 3C complete in squash-merged PR #138; Project stability fixes land before Phase 3D

Last reviewed: 2026-08-14 after the exact-head review and squash merge of PR #138
''',
)
replace_once(
    "docs/PRODUCT_ROADMAP.md",
    '''completed; Phase 3B4 basic Project-local edges are complete in squash-merged PR #136,
and Phase 3C Reading projection is the active implementation target
''',
    '''completed; Phase 3B4 basic Project-local edges are complete in squash-merged PR #136,
and Phase 3C Reading projection is complete in squash-merged PR #138
''',
)
replace_once(
    "docs/PRODUCT_ROADMAP.md",
    '''1. Complete the no-creation **Reading projection** as Phase 3C.
2. Harden **Markdown/TeX, mixed media, save/conflict UX, and export** as Phase 3D.
3. Add advanced **Inspector/Canvas/previews/performance**.
4. Run the dedicated Docker portability implementation after Project content
''',
    '''1. Land the bounded **Project stability fixes** discovered after Phase 3C: local-working-copy interaction safety and Project lifecycle UI.
2. Harden **Markdown/TeX, mixed media, save/conflict UX, and export** as Phase 3D.
3. Add advanced **Inspector/Canvas/previews/performance**.
4. Run the dedicated Docker portability implementation after Project content
''',
)
