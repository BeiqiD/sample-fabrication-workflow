import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  useBeforeUnload,
  useBlocker,
  useLocation,
  useNavigate,
  useParams,
  type BlockerFunction,
} from "react-router-dom";
import type { ReferenceSearchResult } from "../../shared/reference-search";
import type { ReferenceResolution } from "../../shared/reference-types";
import type {
  CreateAttachmentProjectItemInput,
  CreateMarkdownProjectItemInput,
  CreateReferenceProjectItemInput,
  ProjectItemLifecycleInput,
  ProjectItemMutationResponse,
  ProjectLifecycleInput,
  ProjectPlacementRecord,
  ProjectSnapshot,
  UpdateProjectAttachmentInput,
  UpdateProjectMarkdownInput,
  UpdateProjectPlacementInput,
} from "../../shared/project-api";
import type {
  ProjectMapGeometry,
} from "../../shared/project-types";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { ReferenceSearchSurface } from "../components/ReferenceSearchSurface";
import { ProjectInspectorChildren } from "../components/project/ProjectInspectorChildren";
import { ProjectEditorFeedback } from "../components/project/ProjectEditorFeedback";
import { ProjectInspectorDetails } from "../components/project/ProjectInspectorDetails";
import type {
  ProjectMapContextCommands,
  ProjectMapSurfaceHandle,
} from "../components/project/ProjectMapSurface";
import {
  ProjectApiError,
  createProjectApiId,
  projectApi,
} from "../lib/project-client";
import {
  applyProjectGeometryCommands,
  normalizeProjectGeometryCommands,
  projectDirtyPlacements,
  projectGeometryEquals,
  projectMapNodes,
  projectPlacementIndex,
  projectReadingNodes,
  type ProjectGeometryCommand,
} from "../lib/project-map-model";
import {
  normalizeProjectItemSelection,
  projectCanvasAlignmentCommands,
  projectCanvasKeyboardShortcutFromEvent,
  projectCanvasKeyboardTargetIsEditable,
  projectCanvasZOrderCommands,
  type ProjectCanvasAlignment,
  type ProjectCanvasZOrderAction,
  type ProjectItemSelection,
} from "../lib/project-canvas-productivity";
import { useProjectCanvasCopyPaste } from "../lib/use-project-canvas-copy-paste";
import {
  projectReferenceDragPayloadFromResolution,
  projectReferenceDragPayloadFromResult,
  projectReferenceGeometryAtPoint,
  projectReferenceRecordFromPreview,
  type ProjectPendingReferencePlacement,
  type ProjectReferenceDragPayload,
} from "../lib/project-reference-placement";
import { projectEdgeDirection } from "../lib/project-edges";
import {
  projectSessionHistoryTouchesItem,
  type ProjectEdgeHistoryCommand,
  type ProjectSessionHistoryCommand,
} from "../lib/project-edge-history";
import { useProjectEdgeController } from "../lib/use-project-edge-controller";
import { projectReferenceRemovalNeedsReconciliation } from "../lib/project-reference-removal";
import {
  projectAttachmentGeometryAtPoint,
  projectMarkdownGeometryAtPoint,
  projectOwnedContentFailureStatus,
  type ProjectMapMarkdownEditorState,
  type ProjectPendingAttachmentPlacement,
} from "../lib/project-owned-content";
import {
  defaultReferenceSearchUiState,
  type ReferenceSearchUiState,
} from "../lib/reference-search-ui";
import {
  projectItemFocusAbsoluteUrl,
  projectItemFocusRequest,
} from "../lib/project-item-navigation";
import "../project.css";

const DesktopProjectMap = lazy(() => import("../components/project/ProjectMapSurface")
  .then((module) => ({ default: module.ProjectMapSurface })));
const ProjectReadingSurface = lazy(() => import("../components/project/ProjectReadingSurface")
  .then((module) => ({ default: module.ProjectReadingSurface })));

type SaveState = "saved" | "unsaved" | "saving" | "error" | "conflict";
type ReferenceRemovalStatus = "removing" | "uncertain" | "reconciling" | "conflict";

type PendingReferenceRemoval = {
  itemId: string;
  input: ProjectItemLifecycleInput;
  status: ReferenceRemovalStatus;
  message: string | null;
};

type PendingReferenceCancellationRemoval = {
  itemId: string;
  expectedItemRevision: number;
  leave: boolean;
};


type MarkdownEditorState = ProjectMapMarkdownEditorState & {
  contentId: string;
  placementId: string | null;
};

type AttachmentEditorState = {
  itemId: string;
  contentId: string;
  caption: string;
  sourceUrl: string;
  status: "editing" | "saving" | "error" | "conflict" | "uncertain";
  message: string | null;
};

type ProjectWorkspaceView = "map" | "reading";

type ProjectDeletionRequest = {
  projectId: string;
  input: ProjectLifecycleInput;
};

function useDesktopProjectMap(
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

function geometryIndex(snapshot: ProjectSnapshot) {
  return Object.fromEntries(snapshot.placements.map((placement) => [placement.id, {
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    zIndex: placement.zIndex,
  }]));
}

function workingMaximumProjectZIndex(
  geometry: Readonly<Record<string, ProjectMapGeometry>>,
) {
  return Object.values(geometry).reduce(
    (maximum, placement) => Math.max(maximum, placement.zIndex),
    0,
  );
}

function snapshotWithPlacementProjection(
  snapshot: ProjectSnapshot,
  geometry: Readonly<Record<string, ProjectMapGeometry>>,
): ProjectSnapshot {
  let changed = false;
  const placements = snapshot.placements.map((placement) => {
    const projected = geometry[placement.id];
    if (!projected || projectGeometryEquals(placement, projected)) return placement;
    changed = true;
    return { ...placement, ...projected };
  });
  return changed ? { ...snapshot, placements } : snapshot;
}

function snapshotWithSavedPlacement(
  snapshot: ProjectSnapshot,
  placement: ProjectPlacementRecord,
): ProjectSnapshot {
  let found = false;
  const placements = snapshot.placements.map((current) => {
    if (current.id !== placement.id) return current;
    found = true;
    return placement;
  });
  return found ? { ...snapshot, placements } : snapshot;
}

function saveLabel(state: SaveState) {
  if (state === "saving") return "Saving";
  if (state === "unsaved") return "Unsaved";
  if (state === "conflict") return "Conflict";
  if (state === "error") return "Error";
  return "Saved";
}

function referenceInsertionFailureStatus(caught: unknown): "uncertain" | "error" | "conflict" {
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
  const location = useLocation();
  const navigate = useNavigate();
  const focusRequest = useMemo(() => projectItemFocusRequest(location.search), [location.search]);
  const focusedItemId = focusRequest.status === "valid" ? focusRequest.itemId : null;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const selectedItemId = selectedItemIds.at(-1) ?? null;
  const [navigationFocusItemId, setNavigationFocusItemId] = useState<string | null>(null);
  const [stableLinkCopyState, setStableLinkCopyState] = useState<{
    projectId: string;
    itemId: string;
    status: "copied" | "error";
  } | null>(null);
  const [geometry, setGeometry] = useState<Record<string, ProjectMapGeometry>>({});
  const [undoStack, setUndoStack] = useState<ProjectSessionHistoryCommand[]>([]);
  const [redoStack, setRedoStack] = useState<ProjectSessionHistoryCommand[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState("");
  const [referenceSearch, setReferenceSearch] = useState<ReferenceSearchUiState>(() => defaultReferenceSearchUiState());
  const [pendingReference, setPendingReferenceState] = useState<ProjectPendingReferencePlacement | null>(null);
  const [pendingReferenceRemoval, setPendingReferenceRemovalState] = useState<PendingReferenceRemoval | null>(null);
  const [referenceActionError, setReferenceActionError] = useState("");
  const [markdownEditor, setMarkdownEditorState] = useState<MarkdownEditorState | null>(null);
  const [pendingAttachment, setPendingAttachmentState] = useState<ProjectPendingAttachmentPlacement | null>(null);
  const [attachmentEditor, setAttachmentEditorState] = useState<AttachmentEditorState | null>(null);
  const [ownedContentActionError, setOwnedContentActionError] = useState("");
  const [desktopView, setDesktopView] = useState<ProjectWorkspaceView>("map");
  const [referencePanelOpen, setReferencePanelOpen] = useState(true);
  const [inspectorPanelOpen, setInspectorPanelOpen] = useState(false);
  const [inspectorPinned, setInspectorPinned] = useState(false);
  const [projectActionsOpen, setProjectActionsOpen] = useState(false);
  const [confirmingProjectDeletion, setConfirmingProjectDeletion] = useState(false);
  const [projectDeleteConfirmation, setProjectDeleteConfirmation] = useState("");
  const [projectDeleteError, setProjectDeleteError] = useState("");
  const [projectDeleteUncertain, setProjectDeleteUncertain] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);

  const baselineRef = useRef<Record<string, ProjectPlacementRecord>>({});
  const geometryRef = useRef<Record<string, ProjectMapGeometry>>({});
  const pendingMutationRef = useRef<Record<string, UpdateProjectPlacementInput>>({});
  const saveStateRef = useRef<SaveState>("saved");
  const autosaveTimerRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const saveAgainRef = useRef(false);
  const flushSaveRef = useRef<() => Promise<void>>(async () => undefined);
  const navigationSaveRequestedRef = useRef(false);
  const referenceNavigationRequestedRef = useRef(false);
  const pageActiveRef = useRef(true);
  const saveSessionGenerationRef = useRef(0);
  const pendingReferenceRef = useRef<ProjectPendingReferencePlacement | null>(null);
  const pendingReferenceInputRef = useRef<CreateReferenceProjectItemInput | null>(null);
  const pendingReferencePayloadRef = useRef<ProjectReferenceDragPayload | null>(null);
  const referenceInsertionGenerationRef = useRef(0);
  const pendingReferenceRemovalRef = useRef<PendingReferenceRemoval | null>(null);
  const pendingReferenceCancellationRemovalRef = useRef<PendingReferenceCancellationRemoval | null>(null);
  const referenceRemovalGenerationRef = useRef(0);
  const markdownEditorRef = useRef<MarkdownEditorState | null>(null);
  const markdownCreateInputRef = useRef<CreateMarkdownProjectItemInput | null>(null);
  const markdownUpdateInputRef = useRef<UpdateProjectMarkdownInput | null>(null);
  const pendingAttachmentRef = useRef<ProjectPendingAttachmentPlacement | null>(null);
  const pendingAttachmentInputRef = useRef<CreateAttachmentProjectItemInput | null>(null);
  const pendingAttachmentFileRef = useRef<File | null>(null);
  const attachmentRequestPointRef = useRef<{ x: number; y: number } | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentEditorRef = useRef<AttachmentEditorState | null>(null);
  const attachmentUpdateInputRef = useRef<UpdateProjectAttachmentInput | null>(null);
  const ownedContentGenerationRef = useRef(0);
  const projectDeleteRequestRef = useRef<ProjectDeletionRequest | null>(null);
  const projectDeletionNavigationRequestedRef = useRef(false);
  const mapSurfaceRef = useRef<ProjectMapSurfaceHandle | null>(null);
  const referencePanelRef = useRef<HTMLElement | null>(null);
  const inspectorPanelRef = useRef<HTMLElement | null>(null);
  const referencePanelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const inspectorPanelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const inspectorHadTargetRef = useRef(false);
  const projectActionsRef = useRef<HTMLDivElement | null>(null);
  const projectActionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const appliedFocusRef = useRef<string | null>(null);
  const stableLinkCopyGenerationRef = useRef(0);
  const installPasteSnapshotRef = useRef<(
    snapshot: ProjectSnapshot,
    destinationItemIds: readonly string[],
  ) => number>(() => 0);

  const updatePendingReference = useCallback((next: ProjectPendingReferencePlacement | null) => {
    pendingReferenceRef.current = next;
    setPendingReferenceState(next);
  }, []);

  const updatePendingReferenceRemoval = useCallback((next: PendingReferenceRemoval | null) => {
    pendingReferenceRemovalRef.current = next;
    setPendingReferenceRemovalState(next);
  }, []);

  const updateMarkdownEditor = useCallback((next: MarkdownEditorState | null) => {
    markdownEditorRef.current = next;
    setMarkdownEditorState(next);
  }, []);

  const updatePendingAttachment = useCallback((next: ProjectPendingAttachmentPlacement | null) => {
    pendingAttachmentRef.current = next;
    setPendingAttachmentState(next);
  }, []);

  const updateAttachmentEditor = useCallback((next: AttachmentEditorState | null) => {
    attachmentEditorRef.current = next;
    setAttachmentEditorState(next);
  }, []);

  const ownedContentMutationIsActive = useCallback((generation: number) => (
    pageActiveRef.current && ownedContentGenerationRef.current === generation
  ), []);

  const clearOwnedContentState = useCallback(() => {
    ownedContentGenerationRef.current += 1;
    markdownCreateInputRef.current = null;
    markdownUpdateInputRef.current = null;
    pendingAttachmentInputRef.current = null;
    pendingAttachmentFileRef.current = null;
    attachmentRequestPointRef.current = null;
    attachmentUpdateInputRef.current = null;
    updateMarkdownEditor(null);
    updatePendingAttachment(null);
    updateAttachmentEditor(null);
    setOwnedContentActionError("");
  }, [updateAttachmentEditor, updateMarkdownEditor, updatePendingAttachment]);

  const saveSessionIsActive = useCallback((generation: number) => (
    pageActiveRef.current && saveSessionGenerationRef.current === generation
  ), []);

  const referenceInsertionIsActive = useCallback((generation: number) => (
    pageActiveRef.current && referenceInsertionGenerationRef.current === generation
  ), []);

  const referenceRemovalIsActive = useCallback((generation: number) => (
    pageActiveRef.current && referenceRemovalGenerationRef.current === generation
  ), []);

  const updateSaveState = useCallback((next: SaveState) => {
    if (!pageActiveRef.current) return;
    saveStateRef.current = next;
    setSaveState(next);
  }, []);

  const recordEdgeHistory = useCallback((command: ProjectEdgeHistoryCommand) => {
    setUndoStack((current) => [...current, command].slice(-100));
    setRedoStack([]);
  }, []);

  const mergePasteItemAcknowledgement = useCallback((result: ProjectItemMutationResponse) => {
    baselineRef.current = {
      ...baselineRef.current,
      [result.placement.id]: result.placement,
    };
    const nextGeometry = {
      ...geometryRef.current,
      [result.placement.id]: {
        x: result.placement.x,
        y: result.placement.y,
        width: result.placement.width,
        height: result.placement.height,
        zIndex: result.placement.zIndex,
      },
    };
    geometryRef.current = nextGeometry;
    setGeometry(nextGeometry);
    setSnapshot((current) => current ? {
      ...current,
      project: result.project,
      contents: result.content
        ? [...current.contents.filter((content) => content.id !== result.content?.id), result.content]
        : current.contents,
      attachments: result.attachment
        ? [...current.attachments.filter((attachment) => (
          attachment.projectContentId !== result.attachment?.projectContentId
        )), result.attachment]
        : current.attachments,
      items: [...current.items.filter((item) => item.id !== result.item.id), result.item],
      placements: [
        ...current.placements.filter((placement) => placement.id !== result.placement.id),
        result.placement,
      ],
    } : current);
    setSelectedItemIds((current) => (
      current.includes(result.item.id) ? current : [...current, result.item.id]
    ));
  }, []);

  const mergePasteEdgeAcknowledgement = useCallback((
    result: Awaited<ReturnType<typeof projectApi.createEdge>>,
  ) => {
    setSnapshot((current) => current ? {
      ...current,
      edges: [...current.edges.filter((edge) => edge.id !== result.value.id), result.value],
    } : current);
  }, []);

  const handlePasteAuthoritativeSnapshot = useCallback((
    next: ProjectSnapshot,
    destinationItemIds: readonly string[],
  ) => installPasteSnapshotRef.current(next, destinationItemIds), []);

  const copyPaste = useProjectCanvasCopyPaste({
    projectId,
    onItemAcknowledged: mergePasteItemAcknowledgement,
    onEdgeAcknowledged: mergePasteEdgeAcknowledgement,
    onAuthoritativeSnapshot: handlePasteAuthoritativeSnapshot,
  });

  const edgeController = useProjectEdgeController({
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
      || attachmentEditor !== null
      || copyPaste.unsafe,
    onHistory: recordEdgeHistory,
  });

  const projectionSwitchLocked = saveState !== "saved"
    || pendingReference !== null
    || pendingReferenceRemoval !== null
    || markdownEditor !== null
    || pendingAttachment !== null
    || attachmentEditor !== null
    || copyPaste.unsafe
    || deletingProject
    || projectDeleteUncertain
    || edgeController.unsafe;
  const desktop = useDesktopProjectMap(projectionSwitchLocked, () => (
    saveStateRef.current !== "saved"
      || pendingReferenceRef.current !== null
      || pendingReferenceRemovalRef.current !== null
      || markdownEditorRef.current !== null
      || pendingAttachmentRef.current !== null
      || attachmentEditorRef.current !== null
      || projectDeleteRequestRef.current !== null
      || copyPaste.unsafeRef.current !== null
      || edgeController.unsafeRef.current
  ));
  const mapViewportActive = desktop && desktopView === "map" && snapshot !== null;

  useEffect(() => {
    const className = "project-map-viewport";
    if (mapViewportActive) document.documentElement.classList.add(className);
    else document.documentElement.classList.remove(className);
    return () => document.documentElement.classList.remove(className);
  }, [mapViewportActive]);

  useEffect(() => {
    if (!desktop || desktopView !== "map") return;
    if (pendingReference || pendingAttachment) setReferencePanelOpen(true);
    const hasInspectorTarget = selectedItemIds.length > 0
      || edgeController.selectedEdgeId !== null
      || attachmentEditor !== null
      || edgeController.editor !== null;
    const hadInspectorTarget = inspectorHadTargetRef.current;
    inspectorHadTargetRef.current = hasInspectorTarget;
    if (hasInspectorTarget) setInspectorPanelOpen(true);
    else if (!inspectorPinned) {
      const activeElement = document.activeElement;
      const restoreFocus = hadInspectorTarget && (
        !activeElement
        || activeElement === document.body
        || !document.contains(activeElement)
        || Boolean(inspectorPanelRef.current?.contains(activeElement))
      );
      setInspectorPanelOpen(false);
      if (restoreFocus) {
        window.requestAnimationFrame(() => inspectorPanelTriggerRef.current?.focus());
      }
    }
    // Pin state is deliberately not a trigger: explicitly closing a pinned
    // Inspector with a selection present must not immediately reopen it.
  }, [
    attachmentEditor,
    desktop,
    desktopView,
    edgeController.editor,
    edgeController.selectedEdgeId,
    pendingAttachment,
    pendingReference,
    selectedItemIds,
  ]);

  useEffect(() => {
    if (!desktop || desktopView !== "map") return;
    const closePanelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || projectionSwitchLocked) return;
      const target = event.target as Node;
      if (inspectorPanelOpen && inspectorPanelRef.current?.contains(target)) {
        event.preventDefault();
        event.stopPropagation();
        setInspectorPanelOpen(false);
        setInspectorPinned(false);
        window.requestAnimationFrame(() => inspectorPanelTriggerRef.current?.focus());
        return;
      }
      if (referencePanelOpen && referencePanelRef.current?.contains(target)) {
        event.preventDefault();
        event.stopPropagation();
        setReferencePanelOpen(false);
        window.requestAnimationFrame(() => referencePanelTriggerRef.current?.focus());
      }
    };
    document.addEventListener("keydown", closePanelOnEscape, true);
    return () => document.removeEventListener("keydown", closePanelOnEscape, true);
  }, [
    desktop,
    desktopView,
    inspectorPanelOpen,
    projectionSwitchLocked,
    referencePanelOpen,
  ]);

  useEffect(() => {
    if (!projectActionsOpen) return;

    const closeOnPointerDown = (event: PointerEvent) => {
      if (!projectActionsRef.current?.contains(event.target as Node)) setProjectActionsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setProjectActionsOpen(false);
      projectActionsTriggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [projectActionsOpen]);

  const shouldBlockNavigation = useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => (
    !projectDeletionNavigationRequestedRef.current
    && (saveState !== "saved"
      || pendingReference !== null
      || pendingReferenceRemoval !== null
      || markdownEditor !== null
      || pendingAttachment !== null
      || attachmentEditor !== null
      || copyPaste.unsafe
      || deletingProject
      || projectDeleteUncertain
      || edgeController.unsafe)
    && (
      currentLocation.pathname !== nextLocation.pathname
      || currentLocation.search !== nextLocation.search
      || currentLocation.hash !== nextLocation.hash
    )
  ), [attachmentEditor, copyPaste.unsafe, deletingProject, edgeController.unsafe, markdownEditor, pendingAttachment, pendingReference, pendingReferenceRemoval, projectDeleteUncertain, saveState]);
  const blocker = useBlocker(shouldBlockNavigation);

  useBeforeUnload(useCallback((event) => {
    if (saveStateRef.current === "saved"
      && pendingReferenceRef.current === null
      && pendingReferenceRemovalRef.current === null
      && markdownEditorRef.current === null
      && pendingAttachmentRef.current === null
      && attachmentEditorRef.current === null
      && projectDeleteRequestRef.current === null
      && copyPaste.unsafeRef.current === null
      && !edgeController.unsafeRef.current) return;
    event.preventDefault();
    event.returnValue = "";
  }, []), { capture: true });

  const clearReferenceInsertion = useCallback(() => {
    referenceInsertionGenerationRef.current += 1;
    pendingReferenceInputRef.current = null;
    pendingReferencePayloadRef.current = null;
    pendingReferenceCancellationRemovalRef.current = null;
    updatePendingReference(null);
  }, [updatePendingReference]);

  const clearReferenceRemoval = useCallback(() => {
    referenceRemovalGenerationRef.current += 1;
    updatePendingReferenceRemoval(null);
  }, [updatePendingReferenceRemoval]);

  const installSnapshot = useCallback((next: ProjectSnapshot) => {
    const baseline = projectPlacementIndex(next);
    const nextGeometry = geometryIndex(next);
    baselineRef.current = baseline;
    geometryRef.current = nextGeometry;
    pendingMutationRef.current = {};
    appliedFocusRef.current = null;
    clearReferenceInsertion();
    clearReferenceRemoval();
    clearOwnedContentState();
    edgeController.resetForAuthoritativeReload();
    setSnapshot(next);
    setGeometry(nextGeometry);
    setSelectedItemIds([]);
    setNavigationFocusItemId(null);
    setUndoStack([]);
    setRedoStack([]);
    setSaveError("");
    setReferenceActionError("");
    updateSaveState("saved");
  }, [clearOwnedContentState, clearReferenceInsertion, clearReferenceRemoval, edgeController.resetForAuthoritativeReload, updateSaveState]);

  installPasteSnapshotRef.current = (next, destinationItemIds) => {
    installSnapshot(next);
    const available = new Set(next.items
      .filter((item) => item.deletedAt === null)
      .map((item) => item.id));
    const selected = destinationItemIds.filter((itemId) => available.has(itemId));
    setSelectedItemIds(selected);
    return selected.length;
  };

  const loadProject = useCallback(async (signal?: AbortSignal) => {
    if (!projectId) return;
    setLoading(true);
    try {
      const next = await projectApi.read(projectId, signal);
      installSnapshot(next);
      setLoadError("");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      if (caught instanceof Error && caught.name === "AbortError") return;
      setLoadError(caught instanceof Error ? caught.message : "The Project could not be opened");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [installSnapshot, projectId]);

  useEffect(() => {
    projectDeleteRequestRef.current = null;
    projectDeletionNavigationRequestedRef.current = false;
    setConfirmingProjectDeletion(false);
    setProjectDeleteConfirmation("");
    setProjectDeleteError("");
    setProjectDeleteUncertain(false);
    setDeletingProject(false);
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadProject(controller.signal);
    return () => controller.abort();
  }, [loadProject]);

  const performProjectDeletion = useCallback(async (request: ProjectDeletionRequest) => {
    const requestIsCurrent = () => (
      pageActiveRef.current
      && projectIdRef.current === request.projectId
      && projectDeleteRequestRef.current === request
    );
    if (!request.projectId || !requestIsCurrent()) return;
    setDeletingProject(true);
    setProjectDeleteError("");
    try {
      await projectApi.deleteProject(request.projectId, request.input);
      if (!requestIsCurrent()) return;
      projectDeleteRequestRef.current = null;
      projectDeletionNavigationRequestedRef.current = true;
      setProjectDeleteUncertain(false);
      setDeletingProject(false);
      navigate("/projects", { replace: true });
    } catch (caught) {
      if (!requestIsCurrent()) return;
      if (caught instanceof ProjectApiError && caught.status === 404) {
        projectDeleteRequestRef.current = null;
        projectDeletionNavigationRequestedRef.current = true;
        setProjectDeleteUncertain(false);
        setDeletingProject(false);
        navigate("/projects", { replace: true });
        return;
      }
      if (caught instanceof ProjectApiError && caught.status === 409) {
        projectDeleteRequestRef.current = null;
        projectDeletionNavigationRequestedRef.current = false;
        setProjectDeleteUncertain(false);
        setProjectDeleteConfirmation("");
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
      if (pageActiveRef.current && projectIdRef.current === request.projectId) setDeletingProject(false);
    }
  }, [loadProject, navigate]);

  const openProjectDeletion = useCallback(() => {
    if (!snapshot || !projectId || snapshot.project.id !== projectId
      || saveStateRef.current !== "saved"
      || pendingReferenceRef.current
      || pendingReferenceRemovalRef.current
      || markdownEditorRef.current
      || pendingAttachmentRef.current
      || attachmentEditorRef.current
      || copyPaste.unsafeRef.current
      || edgeController.unsafeRef.current) return;
    projectDeleteRequestRef.current = null;
    projectDeletionNavigationRequestedRef.current = false;
    setProjectDeleteConfirmation("");
    setProjectDeleteError("");
    setProjectDeleteUncertain(false);
    setConfirmingProjectDeletion(true);
  }, [edgeController.unsafeRef, projectId, snapshot]);

  const cancelProjectDeletion = useCallback(() => {
    if (deletingProject || projectDeleteUncertain) return;
    projectDeleteRequestRef.current = null;
    projectDeletionNavigationRequestedRef.current = false;
    setProjectDeleteConfirmation("");
    setProjectDeleteError("");
    setConfirmingProjectDeletion(false);
  }, [deletingProject, projectDeleteUncertain]);

  const moveProjectToTrash = useCallback(() => {
    if (!projectId || !snapshot || snapshot.project.id !== projectId
      || deletingProject || projectDeleteConfirmation !== snapshot.project.title) return;
    let request = projectDeleteRequestRef.current;
    if (request && request.projectId !== projectId) {
      projectDeleteRequestRef.current = null;
      projectDeletionNavigationRequestedRef.current = false;
      setProjectDeleteUncertain(false);
      setProjectDeleteError("");
      return;
    }
    if (!request) {
      if (saveStateRef.current !== "saved"
        || pendingReferenceRef.current
        || pendingReferenceRemovalRef.current
        || markdownEditorRef.current
        || pendingAttachmentRef.current
        || attachmentEditorRef.current
        || copyPaste.unsafeRef.current
        || edgeController.unsafeRef.current) return;
      request = {
        projectId,
        input: {
          expectedRevision: snapshot.project.revision,
          operationId: createProjectApiId("operation"),
        },
      };
      projectDeleteRequestRef.current = request;
    }
    void performProjectDeletion(request);
  }, [deletingProject, edgeController.unsafeRef, performProjectDeletion, projectDeleteConfirmation, projectId, snapshot]);

  useEffect(() => {
    pageActiveRef.current = true;
    return () => {
      pageActiveRef.current = false;
      saveSessionGenerationRef.current += 1;
      referenceInsertionGenerationRef.current += 1;
      referenceRemovalGenerationRef.current += 1;
      ownedContentGenerationRef.current += 1;
      stableLinkCopyGenerationRef.current += 1;
      navigationSaveRequestedRef.current = false;
      referenceNavigationRequestedRef.current = false;
      saveAgainRef.current = false;
      savingRef.current = false;
      pendingReferenceInputRef.current = null;
      pendingReferencePayloadRef.current = null;
      pendingReferenceRef.current = null;
      pendingReferenceRemovalRef.current = null;
      pendingReferenceCancellationRemovalRef.current = null;
      markdownEditorRef.current = null;
      markdownCreateInputRef.current = null;
      markdownUpdateInputRef.current = null;
      pendingAttachmentRef.current = null;
      pendingAttachmentInputRef.current = null;
      pendingAttachmentFileRef.current = null;
      attachmentRequestPointRef.current = null;
      attachmentEditorRef.current = null;
      attachmentUpdateInputRef.current = null;
      projectDeleteRequestRef.current = null;
      projectDeletionNavigationRequestedRef.current = false;
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, []);

  const scheduleAutosave = useCallback(() => {
    if (!pageActiveRef.current || saveStateRef.current === "conflict") return;
    const generation = saveSessionGenerationRef.current;
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      if (!saveSessionIsActive(generation)) return;
      void flushSaveRef.current();
    }, 1_600);
  }, [saveSessionIsActive]);

  const flushSave = useCallback(async () => {
    const generation = saveSessionGenerationRef.current;
    if (!saveSessionIsActive(generation) || !projectId || saveStateRef.current === "conflict") return;
    if (savingRef.current) {
      saveAgainRef.current = true;
      return;
    }
    const dirty = projectDirtyPlacements(baselineRef.current, geometryRef.current);
    const placementIds = new Set([
      ...Object.keys(pendingMutationRef.current),
      ...dirty.map(([placementId]) => placementId),
    ]);
    if (!placementIds.size) {
      if (!saveSessionIsActive(generation)) return;
      updateSaveState("saved");
      setSaveError("");
      return;
    }

    savingRef.current = true;
    saveAgainRef.current = false;
    updateSaveState("saving");
    setSaveError("");
    let succeeded = false;
    try {
      for (const placementId of placementIds) {
        if (!saveSessionIsActive(generation)) return;
        const baseline = baselineRef.current[placementId];
        const attemptedGeometry = geometryRef.current[placementId];
        if (!baseline || !attemptedGeometry) continue;
        let mutation = pendingMutationRef.current[placementId];
        if (!mutation) {
          if (projectGeometryEquals(baseline, attemptedGeometry)) continue;
          mutation = {
            geometry: attemptedGeometry,
            expectedRevision: baseline.revision,
            operationId: createProjectApiId("operation"),
          };
          pendingMutationRef.current[placementId] = mutation;
        }
        const result = await projectApi.updatePlacement(projectId, placementId, mutation);
        if (!saveSessionIsActive(generation)) return;
        baselineRef.current = { ...baselineRef.current, [placementId]: result.value };
        setSnapshot((current) => current
          ? snapshotWithSavedPlacement(current, result.value)
          : current);
        delete pendingMutationRef.current[placementId];
      }
      succeeded = true;
    } catch (caught) {
      if (!saveSessionIsActive(generation)) return;
      const message = caught instanceof Error ? caught.message : "Project placements could not be saved";
      navigationSaveRequestedRef.current = false;
      setSaveError(message);
      updateSaveState(caught instanceof ProjectApiError && caught.status === 409 ? "conflict" : "error");
    } finally {
      if (saveSessionIsActive(generation)) savingRef.current = false;
    }

    if (!saveSessionIsActive(generation) || !succeeded) return;
    const remainsDirty = Object.keys(pendingMutationRef.current).length > 0
      || projectDirtyPlacements(baselineRef.current, geometryRef.current).length > 0;
    if (remainsDirty) {
      updateSaveState("unsaved");
      if (navigationSaveRequestedRef.current || saveAgainRef.current) {
        if (autosaveTimerRef.current !== null) {
          window.clearTimeout(autosaveTimerRef.current);
          autosaveTimerRef.current = null;
        }
        void flushSaveRef.current();
      } else {
        scheduleAutosave();
      }
    } else {
      updateSaveState("saved");
    }
  }, [projectId, saveSessionIsActive, scheduleAutosave, updateSaveState]);

  useEffect(() => {
    flushSaveRef.current = flushSave;
  }, [flushSave]);

  useEffect(() => {
    if (blocker.state !== "blocked") {
      navigationSaveRequestedRef.current = false;
      referenceNavigationRequestedRef.current = false;
      return;
    }
    if (pendingReferenceRef.current || pendingReferenceRemovalRef.current
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current
      || copyPaste.unsafeRef.current
      || edgeController.unsafeRef.current) {
      referenceNavigationRequestedRef.current = true;
    }
    const state = saveStateRef.current;
    if (state !== "unsaved" && state !== "saving") return;
    navigationSaveRequestedRef.current = true;
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    if (state === "unsaved") void flushSaveRef.current();
  }, [blocker.state]);

  useEffect(() => {
    if (blocker.state !== "blocked"
      || pendingReference !== null
      || pendingReferenceRemoval !== null
      || markdownEditor !== null
      || pendingAttachment !== null
      || attachmentEditor !== null
      || copyPaste.unsafe
      || edgeController.unsafe) return;
    if (saveState === "error" || saveState === "conflict") return;
    if (saveState !== "saved") return;
    if (navigationSaveRequestedRef.current || referenceNavigationRequestedRef.current) {
      navigationSaveRequestedRef.current = false;
      referenceNavigationRequestedRef.current = false;
      blocker.proceed();
    } else {
      blocker.reset();
    }
  }, [attachmentEditor, blocker, copyPaste.unsafe, edgeController.unsafe, markdownEditor, pendingAttachment, pendingReference, pendingReferenceRemoval, saveState]);

  const commitGeometryBatch = useCallback((commands: readonly ProjectGeometryCommand[]) => {
    if (pendingReferenceRemovalRef.current
      || pendingReferenceRef.current?.status === "reconciling"
      || markdownEditorRef.current
      || pendingAttachmentRef.current
      || attachmentEditorRef.current
      || copyPaste.unsafeRef.current
      || edgeController.unsafeRef.current) return;
    const normalized = normalizeProjectGeometryCommands(commands);
    if (normalized.length === 0) return;
    const next = { ...geometryRef.current };
    for (const command of normalized) next[command.placementId] = command.after;
    geometryRef.current = next;
    setGeometry(next);
    setUndoStack((current) => [...current, {
      kind: "geometry" as const,
      commands: normalized,
    }].slice(-100));
    setRedoStack([]);
    if (saveStateRef.current !== "conflict") {
      setSaveError("");
      updateSaveState("unsaved");
      scheduleAutosave();
    }
  }, [scheduleAutosave, updateSaveState]);

  const commitGeometry = useCallback((command: ProjectGeometryCommand) => {
    commitGeometryBatch([command]);
  }, [commitGeometryBatch]);

  const undo = useCallback(() => {
    if (pendingReferenceRemovalRef.current || pendingReferenceRef.current?.status === "reconciling"
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current
      || copyPaste.unsafeRef.current
      || edgeController.unsafeRef.current) return;
    const command = undoStack.at(-1);
    if (!command) return;
    if (command.kind === "geometry") {
      const next = applyProjectGeometryCommands(geometryRef.current, command.commands, "undo");
      geometryRef.current = next;
      setGeometry(next);
      setUndoStack((current) => current.slice(0, -1));
      setRedoStack((current) => [...current, command].slice(-100));
      if (saveStateRef.current !== "conflict") {
        setSaveError("");
        updateSaveState("unsaved");
        scheduleAutosave();
      }
      return;
    }
    if (edgeController.interactionDisabled) return;
    edgeController.applyHistory(command, "undo", () => {
      setUndoStack((current) => current.slice(0, -1));
      setRedoStack((current) => [...current, command].slice(-100));
    });
  }, [edgeController, scheduleAutosave, undoStack, updateSaveState]);

  const redo = useCallback(() => {
    if (pendingReferenceRemovalRef.current || pendingReferenceRef.current?.status === "reconciling"
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current
      || copyPaste.unsafeRef.current
      || edgeController.unsafeRef.current) return;
    const command = redoStack.at(-1);
    if (!command) return;
    if (command.kind === "geometry") {
      const next = applyProjectGeometryCommands(geometryRef.current, command.commands, "redo");
      geometryRef.current = next;
      setGeometry(next);
      setRedoStack((current) => current.slice(0, -1));
      setUndoStack((current) => [...current, command].slice(-100));
      if (saveStateRef.current !== "conflict") {
        setSaveError("");
        updateSaveState("unsaved");
        scheduleAutosave();
      }
      return;
    }
    if (edgeController.interactionDisabled) return;
    edgeController.applyHistory(command, "redo", () => {
      setRedoStack((current) => current.slice(0, -1));
      setUndoStack((current) => [...current, command].slice(-100));
    });
  }, [edgeController, redoStack, scheduleAutosave, updateSaveState]);

  const mergeReferenceInsertion = useCallback((
    result: ProjectItemMutationResponse,
    payload: ProjectReferenceDragPayload,
  ) => {
    const registryId = result.item.referenceTargetId;
    if (!registryId) throw new Error("Inserted reference has no registry identity");
    baselineRef.current = {
      ...baselineRef.current,
      [result.placement.id]: result.placement,
    };
    const nextGeometry = {
      ...geometryRef.current,
      [result.placement.id]: {
        x: result.placement.x,
        y: result.placement.y,
        width: result.placement.width,
        height: result.placement.height,
        zIndex: result.placement.zIndex,
      },
    };
    geometryRef.current = nextGeometry;
    setGeometry(nextGeometry);
    setSnapshot((current) => {
      if (!current) return current;
      const references = current.references.some((reference) => reference.registryId === registryId)
        ? current.references
        : [...current.references, projectReferenceRecordFromPreview(registryId, payload)];
      return {
        ...current,
        project: result.project,
        items: [...current.items.filter((item) => item.id !== result.item.id), result.item],
        placements: [
          ...current.placements.filter((placement) => placement.id !== result.placement.id),
          result.placement,
        ],
        references,
      };
    });
    setSelectedItemIds([result.item.id]);
  }, []);

  const performReferenceInsertion = useCallback(async (
    generation: number,
    input: CreateReferenceProjectItemInput,
    payload: ProjectReferenceDragPayload,
  ) => {
    if (!projectId || !referenceInsertionIsActive(generation)) return;
    updatePendingReference({
      localId: `pending-${input.itemId}`,
      target: payload.target,
      preview: payload.preview,
      geometry: input.geometry,
      status: "placing",
      message: null,
    });
    setReferenceActionError("");
    try {
      const result = await projectApi.createReferenceItem(projectId, input);
      if (!referenceInsertionIsActive(generation)) return;
      mergeReferenceInsertion(result, payload);
      pendingReferenceInputRef.current = null;
      pendingReferencePayloadRef.current = null;
      updatePendingReference(null);
    } catch (caught) {
      if (!referenceInsertionIsActive(generation)) return;
      const status = referenceInsertionFailureStatus(caught);
      const message = caught instanceof Error ? caught.message : "The reference could not be placed";
      updatePendingReference({
        localId: `pending-${input.itemId}`,
        target: payload.target,
        preview: payload.preview,
        geometry: input.geometry,
        status,
        message,
      });
      setReferenceActionError(message);
    }
  }, [mergeReferenceInsertion, projectId, referenceInsertionIsActive, updatePendingReference]);

  const startReferencePlacement = useCallback((
    payload: ProjectReferenceDragPayload,
    point: { x: number; y: number },
  ) => {
    if (!snapshot || pendingReferenceRef.current || pendingReferenceRemovalRef.current
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current
      || edgeController.unsafeRef.current) return;
    const maxZ = workingMaximumProjectZIndex(geometryRef.current);
    const geometry = projectReferenceGeometryAtPoint(point, Math.min(1_000_000, maxZ + 1));
    if (!geometry) {
      setReferenceActionError("The requested Map coordinate is outside the supported Project geometry range");
      return;
    }
    const input: CreateReferenceProjectItemInput = {
      itemId: createProjectApiId("item"),
      placementId: createProjectApiId("placement"),
      target: payload.target,
      geometry,
      expectedProjectRevision: snapshot.project.revision,
      operationId: createProjectApiId("operation"),
    };
    const generation = referenceInsertionGenerationRef.current + 1;
    referenceInsertionGenerationRef.current = generation;
    pendingReferenceInputRef.current = input;
    pendingReferencePayloadRef.current = payload;
    void performReferenceInsertion(generation, input, payload);
  }, [performReferenceInsertion, snapshot]);

  const placeReferencePayloadAtCenter = useCallback((payload: ProjectReferenceDragPayload) => {
    const point = mapSurfaceRef.current?.getViewportCenter();
    if (!point) {
      setReferenceActionError("The Map viewport is not ready for placement yet");
      return;
    }
    startReferencePlacement(payload, point);
  }, [startReferencePlacement]);

  const placeReferenceAtCenter = useCallback((result: ReferenceSearchResult) => {
    placeReferencePayloadAtCenter(projectReferenceDragPayloadFromResult(result));
  }, [placeReferencePayloadAtCenter]);

  const placeInspectorChildAtCenter = useCallback((resolution: ReferenceResolution) => {
    placeReferencePayloadAtCenter(projectReferenceDragPayloadFromResolution(resolution));
  }, [placeReferencePayloadAtCenter]);

  const retryReferencePlacement = useCallback(() => {
    const input = pendingReferenceInputRef.current;
    const payload = pendingReferencePayloadRef.current;
    const status = pendingReferenceRef.current?.status;
    if (!input || !payload || (status !== "error" && status !== "uncertain")) return;
    void performReferenceInsertion(referenceInsertionGenerationRef.current, input, payload);
  }, [performReferenceInsertion]);

  const continueReferenceNavigation = useCallback((leave: boolean) => {
    if (blocker.state !== "blocked") return;
    if (!leave) {
      referenceNavigationRequestedRef.current = false;
      blocker.reset();
      return;
    }
    referenceNavigationRequestedRef.current = true;
    const state = saveStateRef.current;
    if (state !== "unsaved" && state !== "saving") return;
    navigationSaveRequestedRef.current = true;
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    if (state === "unsaved") void flushSaveRef.current();
  }, [blocker]);

  const cancelReferencePlacement = useCallback((leave = false) => {
    const status = pendingReferenceRef.current?.status;
    if (status !== "error" && status !== "conflict") return;
    clearReferenceInsertion();
    setReferenceActionError("");
    continueReferenceNavigation(leave);
  }, [clearReferenceInsertion, continueReferenceNavigation]);

  const finalizeReferenceRemoval = useCallback((
    result: ProjectItemMutationResponse,
    itemId: string,
  ) => {
    const removed = new Set<string>([result.placement.id]);
    for (const [placementId, placement] of Object.entries(baselineRef.current)) {
      if (placement.projectItemId === itemId) removed.add(placementId);
    }
    baselineRef.current = Object.fromEntries(
      Object.entries(baselineRef.current).filter(([placementId]) => !removed.has(placementId)),
    );
    geometryRef.current = Object.fromEntries(
      Object.entries(geometryRef.current).filter(([placementId]) => !removed.has(placementId)),
    );
    for (const placementId of removed) delete pendingMutationRef.current[placementId];
    setGeometry(geometryRef.current);
    const removeHistoryForItem = (current: ProjectSessionHistoryCommand[]) => current.reduce<
      ProjectSessionHistoryCommand[]
    >((next, command) => {
      if (command.kind !== "geometry") {
        if (!projectSessionHistoryTouchesItem(command, itemId)) next.push(command);
        return next;
      }
      const commands = command.commands.filter((geometryCommand) => (
        !removed.has(geometryCommand.placementId)
      ));
      if (commands.length > 0) next.push({ ...command, commands });
      return next;
    }, []);
    setUndoStack(removeHistoryForItem);
    setRedoStack(removeHistoryForItem);
    setSnapshot((current) => {
      if (!current) return current;
      const removedContentId = result.content?.id
        ?? current.items.find((item) => item.id === itemId)?.projectContentId
        ?? null;
      return {
        ...current,
        project: result.project,
        contents: removedContentId
          ? current.contents.filter((content) => content.id !== removedContentId)
          : current.contents,
        attachments: removedContentId
          ? current.attachments.filter((attachment) => attachment.projectContentId !== removedContentId)
          : current.attachments,
        items: current.items.filter((item) => item.id !== itemId),
        placements: current.placements.filter((placement) => placement.projectItemId !== itemId),
        edges: current.edges.filter((edge) => edge.sourceItemId !== itemId && edge.targetItemId !== itemId),
      };
    });
    setSelectedItemIds((current) => normalizeProjectItemSelection(
      current.filter((candidate) => candidate !== itemId),
    ).itemIds);
    setNavigationFocusItemId((current) => current === itemId ? null : current);
    setSaveError("");
    setReferenceActionError("");
    setOwnedContentActionError("");
    clearReferenceRemoval();

    const remainsDirty = Object.keys(pendingMutationRef.current).length > 0
      || projectDirtyPlacements(baselineRef.current, geometryRef.current).length > 0;
    if (remainsDirty) {
      updateSaveState("unsaved");
      scheduleAutosave();
    } else {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      updateSaveState("saved");
    }
  }, [clearReferenceRemoval, scheduleAutosave, updateSaveState]);

  const reconcileReferenceRemoval = useCallback(async (
    generation: number,
    itemId: string,
    input: ProjectItemLifecycleInput,
    failureMessage: string,
  ) => {
    if (!projectId || !referenceRemovalIsActive(generation)) return;
    updatePendingReferenceRemoval({
      itemId,
      input,
      status: "reconciling",
      message: "Reloading authoritative Project state after the removal conflict…",
    });
    setReferenceActionError("");
    try {
      const authoritative = await projectApi.read(projectId);
      if (!referenceRemovalIsActive(generation)) return;
      const authoritativeItem = authoritative.items.find((item) => item.id === itemId) ?? null;
      installSnapshot(authoritative);
      if (authoritativeItem) {
        referenceNavigationRequestedRef.current = false;
        setReferenceActionError(
          "The occurrence changed elsewhere. The latest Project state was loaded; review it before starting a new removal.",
        );
      }
    } catch (caught) {
      if (!referenceRemovalIsActive(generation)) return;
      if (caught instanceof ProjectApiError && caught.status === 404) {
        referenceNavigationRequestedRef.current = false;
        clearReferenceRemoval();
        setReferenceActionError("");
        setLoadError("Project is no longer available");
        return;
      }
      const detail = caught instanceof Error ? caught.message : "The authoritative Project could not be loaded";
      const message = `${failureMessage}. Authoritative reconciliation failed: ${detail}`;
      updatePendingReferenceRemoval({ itemId, input, status: "conflict", message });
      setReferenceActionError(message);
    }
  }, [
    clearReferenceRemoval,
    installSnapshot,
    projectId,
    referenceRemovalIsActive,
    updatePendingReferenceRemoval,
  ]);

  const performReferenceRemoval = useCallback(async (
    generation: number,
    itemId: string,
    input: ProjectItemLifecycleInput,
  ) => {
    if (!projectId || !referenceRemovalIsActive(generation)) return;
    updatePendingReferenceRemoval({ itemId, input, status: "removing", message: null });
    setReferenceActionError("");
    try {
      const result = await projectApi.removeItem(projectId, itemId, input);
      if (!referenceRemovalIsActive(generation)) return;
      finalizeReferenceRemoval(result, itemId);
    } catch (caught) {
      if (!referenceRemovalIsActive(generation)) return;
      const message = caught instanceof Error ? caught.message : "The Project occurrence could not be removed";
      if (projectReferenceRemovalNeedsReconciliation(caught)) {
        await reconcileReferenceRemoval(generation, itemId, input, message);
        return;
      }
      updatePendingReferenceRemoval({ itemId, input, status: "uncertain", message });
      setReferenceActionError(message);
    }
  }, [
    finalizeReferenceRemoval,
    projectId,
    reconcileReferenceRemoval,
    referenceRemovalIsActive,
    updatePendingReferenceRemoval,
  ]);

  const startReferenceRemoval = useCallback((
    itemId: string,
    expectedItemRevision: number,
    expectedContentRevision?: number,
  ) => {
    if (pendingReferenceRemovalRef.current) return;
    const input: ProjectItemLifecycleInput = {
      expectedItemRevision,
      ...(expectedContentRevision === undefined ? {} : { expectedContentRevision }),
      operationId: createProjectApiId("operation"),
    };
    const generation = referenceRemovalGenerationRef.current + 1;
    referenceRemovalGenerationRef.current = generation;
    void performReferenceRemoval(generation, itemId, input);
  }, [performReferenceRemoval]);

  const beginQueuedReferenceCancellationRemoval = useCallback(() => {
    const pending = pendingReferenceCancellationRemovalRef.current;
    if (!pending || saveStateRef.current !== "saved" || pendingReferenceRemovalRef.current) return;
    pendingReferenceCancellationRemovalRef.current = null;
    clearReferenceInsertion();
    startReferenceRemoval(pending.itemId, pending.expectedItemRevision);
  }, [clearReferenceInsertion, startReferenceRemoval]);

  const queueReferenceCancellationRemoval = useCallback((
    itemId: string,
    expectedItemRevision: number,
    leave: boolean,
  ) => {
    pendingReferenceCancellationRemovalRef.current = { itemId, expectedItemRevision, leave };
    if (leave && blocker.state === "blocked") referenceNavigationRequestedRef.current = true;

    const current = pendingReferenceRef.current;
    if (current) {
      const state = saveStateRef.current;
      updatePendingReference({
        ...current,
        status: "reconciling",
        message: state === "saved"
          ? "Starting the confirmed Project-local cancellation removal…"
          : state === "error" || state === "conflict"
            ? "Resolve the existing placement save state before the confirmed occurrence can be cancelled."
            : "Saving existing placement changes before the confirmed occurrence is cancelled…",
      });
    }

    const state = saveStateRef.current;
    if (state === "saved") {
      beginQueuedReferenceCancellationRemoval();
      return;
    }
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    if (state === "unsaved") {
      void flushSaveRef.current();
    } else if (state === "saving") {
      saveAgainRef.current = true;
    }
  }, [blocker.state, beginQueuedReferenceCancellationRemoval, updatePendingReference]);

  useEffect(() => {
    if (saveState === "saved") beginQueuedReferenceCancellationRemoval();
  }, [beginQueuedReferenceCancellationRemoval, saveState]);

  const retryReferenceRemoval = useCallback(() => {
    const pending = pendingReferenceRemovalRef.current;
    if (!pending || pending.status !== "uncertain") return;
    void performReferenceRemoval(referenceRemovalGenerationRef.current, pending.itemId, pending.input);
  }, [performReferenceRemoval]);

  const retryReferenceRemovalReconciliation = useCallback(() => {
    const pending = pendingReferenceRemovalRef.current;
    if (!pending || pending.status !== "conflict") return;
    void reconcileReferenceRemoval(
      referenceRemovalGenerationRef.current,
      pending.itemId,
      pending.input,
      pending.message || "The Project occurrence removal conflicted",
    );
  }, [reconcileReferenceRemoval]);

  const reconcileAndCancelUncertainReference = useCallback(async (leave = false) => {
    const input = pendingReferenceInputRef.current;
    const payload = pendingReferencePayloadRef.current;
    const current = pendingReferenceRef.current;
    const generation = referenceInsertionGenerationRef.current;
    if (!projectId || !input || !payload || current?.status !== "uncertain"
      || !referenceInsertionIsActive(generation) || pendingReferenceRemovalRef.current) return;

    if (leave && blocker.state === "blocked") referenceNavigationRequestedRef.current = true;
    updatePendingReference({
      ...current,
      status: "reconciling",
      message: "Reconciling the original insertion before cancelling it…",
    });
    setReferenceActionError("");

    try {
      try {
        const result = await projectApi.createReferenceItem(projectId, input);
        if (!referenceInsertionIsActive(generation)) return;
        setSnapshot((local) => local ? { ...local, project: result.project } : local);
        queueReferenceCancellationRemoval(result.item.id, result.item.revision, leave);
        return;
      } catch (caught) {
        if (!(caught instanceof ProjectApiError) || caught.status !== 409) throw caught;
      }

      const authoritative = await projectApi.read(projectId);
      if (!referenceInsertionIsActive(generation)) return;
      const item = authoritative.items.find((candidate) => candidate.id === input.itemId) ?? null;
      setSnapshot((local) => local ? { ...local, project: authoritative.project } : local);
      if (!item) {
        clearReferenceInsertion();
        setReferenceActionError("");
        continueReferenceNavigation(leave);
        return;
      }
      const placement = authoritative.placements.find((candidate) => candidate.projectItemId === item.id) ?? null;
      const reference = item.referenceTargetId
        ? authoritative.references.find((candidate) => candidate.registryId === item.referenceTargetId) ?? null
        : null;
      const target = reference?.resolution.target;
      const exactOccurrence = item.itemType === "reference"
        && placement?.id === input.placementId
        && target?.type === input.target.type
        && target.id === input.target.id;
      if (!exactOccurrence) {
        const message = "The original insertion could not be reconciled to the same Project occurrence. Reload authoritative Project state before continuing.";
        updatePendingReference({ ...current, status: "conflict", message });
        setReferenceActionError(message);
        return;
      }
      queueReferenceCancellationRemoval(item.id, item.revision, leave);
    } catch (caught) {
      if (!referenceInsertionIsActive(generation)) return;
      const message = caught instanceof Error ? caught.message : "The insertion outcome could not be reconciled";
      updatePendingReference({ ...current, status: "uncertain", message });
      setReferenceActionError(message);
    }
  }, [
    blocker.state,
    clearReferenceInsertion,
    continueReferenceNavigation,
    projectId,
    queueReferenceCancellationRemoval,
    referenceInsertionIsActive,
    updatePendingReference,
  ]);

  const mergeOwnedContentInsertion = useCallback((result: ProjectItemMutationResponse) => {
    const insertedContent = result.content;
    const insertedAttachment = result.attachment;
    if (!insertedContent) throw new Error("Inserted Project-owned content has no content record");
    baselineRef.current = {
      ...baselineRef.current,
      [result.placement.id]: result.placement,
    };
    const nextGeometry = {
      ...geometryRef.current,
      [result.placement.id]: {
        x: result.placement.x,
        y: result.placement.y,
        width: result.placement.width,
        height: result.placement.height,
        zIndex: result.placement.zIndex,
      },
    };
    geometryRef.current = nextGeometry;
    setGeometry(nextGeometry);
    setSnapshot((current) => current ? {
      ...current,
      project: result.project,
      contents: [...current.contents.filter((content) => content.id !== insertedContent.id), insertedContent],
      attachments: insertedAttachment
        ? [...current.attachments.filter((attachment) => attachment.projectContentId !== insertedAttachment.projectContentId), insertedAttachment]
        : current.attachments,
      items: [...current.items.filter((item) => item.id !== result.item.id), result.item],
      placements: [...current.placements.filter((placement) => placement.id !== result.placement.id), result.placement],
    } : current);
    setSelectedItemIds([result.item.id]);
  }, []);

  const startMarkdownCreate = useCallback((point: { x: number; y: number }) => {
    if (!snapshot || !desktop || saveStateRef.current === "conflict"
      || pendingReferenceRef.current || pendingReferenceRemovalRef.current
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current
      || edgeController.unsafeRef.current) return;
    const maxZ = workingMaximumProjectZIndex(geometryRef.current);
    const draftGeometry = projectMarkdownGeometryAtPoint(point, Math.min(1_000_000, maxZ + 1));
    if (!draftGeometry) {
      setOwnedContentActionError("The requested Map coordinate is outside the supported Project geometry range");
      return;
    }
    ownedContentGenerationRef.current += 1;
    markdownCreateInputRef.current = null;
    markdownUpdateInputRef.current = null;
    setOwnedContentActionError("");
    const itemId = createProjectApiId("item");
    updateMarkdownEditor({
      itemId,
      contentId: createProjectApiId("content"),
      placementId: createProjectApiId("placement"),
      value: "",
      isNew: true,
      geometry: draftGeometry,
      status: "editing",
      message: null,
    });
    setSelectedItemIds([itemId]);
  }, [desktop, snapshot, updateMarkdownEditor]);

  const startMarkdownEdit = useCallback((itemId: string) => {
    if (!snapshot || saveStateRef.current === "conflict"
      || pendingReferenceRef.current || pendingReferenceRemovalRef.current
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current
      || edgeController.unsafeRef.current) return;
    const item = snapshot.items.find((candidate) => candidate.id === itemId);
    const content = item?.projectContentId
      ? snapshot.contents.find((candidate) => candidate.id === item.projectContentId)
      : null;
    if (!item || !content || content.contentType !== "markdown") return;
    ownedContentGenerationRef.current += 1;
    markdownCreateInputRef.current = null;
    markdownUpdateInputRef.current = null;
    setOwnedContentActionError("");
    updateMarkdownEditor({
      itemId,
      contentId: content.id,
      placementId: null,
      value: content.markdownSource ?? "",
      isNew: false,
      geometry: null,
      status: "editing",
      message: null,
    });
    setSelectedItemIds([itemId]);
  }, [snapshot, updateMarkdownEditor]);

  const changeMarkdown = useCallback((value: string) => {
    const current = markdownEditorRef.current;
    if (!current || current.status !== "editing") return;
    updateMarkdownEditor({ ...current, value, message: null });
  }, [updateMarkdownEditor]);

  const cancelMarkdown = useCallback((leave = false) => {
    const current = markdownEditorRef.current;
    if (!current || current.status === "saving" || current.status === "uncertain") return;
    markdownCreateInputRef.current = null;
    markdownUpdateInputRef.current = null;
    ownedContentGenerationRef.current += 1;
    updateMarkdownEditor(null);
    if (current.isNew) setSelectedItemIds([]);
    setOwnedContentActionError("");
    continueReferenceNavigation(leave);
  }, [continueReferenceNavigation, updateMarkdownEditor]);

  const saveMarkdown = useCallback(async () => {
    const current = markdownEditorRef.current;
    if (!projectId || !snapshot || !current || (current.status !== "editing" && current.status !== "uncertain") || !current.value.trim()) return;
    const generation = ownedContentGenerationRef.current;
    updateMarkdownEditor({ ...current, status: "saving", message: null });
    setOwnedContentActionError("");
    try {
      if (current.isNew) {
        let input = markdownCreateInputRef.current;
        if (!input) {
          if (!current.geometry || !current.placementId) throw new Error("The local Markdown draft has no placement");
          input = {
            contentId: current.contentId,
            itemId: current.itemId,
            placementId: current.placementId,
            markdownSource: current.value,
            geometry: current.geometry,
            expectedProjectRevision: snapshot.project.revision,
            operationId: createProjectApiId("operation"),
          };
          markdownCreateInputRef.current = input;
        }
        const result = await projectApi.createMarkdownItem(projectId, input);
        if (!ownedContentMutationIsActive(generation)) return;
        mergeOwnedContentInsertion(result);
      } else {
        const content = snapshot.contents.find((candidate) => candidate.id === current.contentId);
        if (!content || content.contentType !== "markdown") throw new Error("Project Markdown content is no longer available");
        let input = markdownUpdateInputRef.current;
        if (!input) {
          input = {
            markdownSource: current.value,
            expectedRevision: content.revision,
            operationId: createProjectApiId("operation"),
          };
          markdownUpdateInputRef.current = input;
        }
        const result = await projectApi.updateMarkdown(projectId, current.contentId, input);
        if (!ownedContentMutationIsActive(generation)) return;
        setSnapshot((local) => local ? {
          ...local,
          contents: [...local.contents.filter((candidate) => candidate.id !== result.value.id), result.value],
        } : local);
      }
      markdownCreateInputRef.current = null;
      markdownUpdateInputRef.current = null;
      updateMarkdownEditor(null);
    } catch (caught) {
      if (!ownedContentMutationIsActive(generation)) return;
      const status = projectOwnedContentFailureStatus(caught);
      const message = caught instanceof Error ? caught.message : "Project Markdown could not be saved";
      updateMarkdownEditor({ ...current, status, message });
      setOwnedContentActionError(message);
    }
  }, [mergeOwnedContentInsertion, ownedContentMutationIsActive, projectId, snapshot, updateMarkdownEditor]);

  const retryMarkdownSave = useCallback(() => {
    const current = markdownEditorRef.current;
    if (!current || current.status !== "uncertain") return;
    void saveMarkdown();
  }, [saveMarkdown]);

  const requestAttachmentAt = useCallback((point: { x: number; y: number }) => {
    if (!snapshot || !desktop || saveStateRef.current === "conflict"
      || pendingReferenceRef.current || pendingReferenceRemovalRef.current
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current
      || edgeController.unsafeRef.current) return;
    attachmentRequestPointRef.current = point;
    attachmentInputRef.current?.click();
  }, [desktop, snapshot]);

  const requestAttachmentAtCenter = useCallback(() => {
    const point = mapSurfaceRef.current?.getViewportCenter();
    if (!point) {
      setOwnedContentActionError("The Map viewport is not ready for attachment placement yet");
      return;
    }
    requestAttachmentAt(point);
  }, [requestAttachmentAt]);

  const performAttachmentProjectCreate = useCallback(async (
    generation: number,
    input: CreateAttachmentProjectItemInput,
    file: File,
  ) => {
    if (!projectId || !ownedContentMutationIsActive(generation)) return;
    updatePendingAttachment({
      localId: `pending-${input.itemId}`,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      geometry: input.geometry,
      status: "saving",
      message: null,
    });
    try {
      const result = await projectApi.createAttachmentItem(projectId, input);
      if (!ownedContentMutationIsActive(generation)) return;
      mergeOwnedContentInsertion(result);
      pendingAttachmentInputRef.current = null;
      pendingAttachmentFileRef.current = null;
      updatePendingAttachment(null);
      setOwnedContentActionError("");
    } catch (caught) {
      if (!ownedContentMutationIsActive(generation)) return;
      const status = projectOwnedContentFailureStatus(caught);
      const message = caught instanceof Error ? caught.message : "The attachment occurrence could not be created";
      updatePendingAttachment({
        localId: `pending-${input.itemId}`,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        geometry: input.geometry,
        status,
        message,
      });
      setOwnedContentActionError(message);
    }
  }, [mergeOwnedContentInsertion, ownedContentMutationIsActive, projectId, updatePendingAttachment]);

  const uploadAndCreateAttachment = useCallback(async (file: File, point: { x: number; y: number }) => {
    if (!snapshot || pendingAttachmentRef.current) return;
    const maxZ = workingMaximumProjectZIndex(geometryRef.current);
    const attachmentGeometry = projectAttachmentGeometryAtPoint(
      point,
      Math.min(1_000_000, maxZ + 1),
      file.type || "application/octet-stream",
    );
    if (!attachmentGeometry) {
      setOwnedContentActionError("The requested Map coordinate is outside the supported Project geometry range");
      return;
    }
    const generation = ownedContentGenerationRef.current + 1;
    ownedContentGenerationRef.current = generation;
    pendingAttachmentInputRef.current = null;
    pendingAttachmentFileRef.current = file;
    setOwnedContentActionError("");
    const itemId = createProjectApiId("item");
    updatePendingAttachment({
      localId: `pending-${itemId}`,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      geometry: attachmentGeometry,
      status: "uploading",
      message: null,
    });
    try {
      const asset = await projectApi.uploadAttachmentAsset(file);
      if (!ownedContentMutationIsActive(generation)) return;
      const input: CreateAttachmentProjectItemInput = {
        contentId: createProjectApiId("content"),
        itemId,
        placementId: createProjectApiId("placement"),
        locator: { assetId: asset.id },
        presentation: {
          originalName: file.name,
          mimeType: file.type || "application/octet-stream",
          byteSize: file.size,
        },
        caption: null,
        sourceUrl: null,
        geometry: attachmentGeometry,
        expectedProjectRevision: snapshot.project.revision,
        operationId: createProjectApiId("operation"),
      };
      pendingAttachmentInputRef.current = input;
      await performAttachmentProjectCreate(generation, input, file);
    } catch (caught) {
      if (!ownedContentMutationIsActive(generation)) return;
      const message = caught instanceof Error ? caught.message : "The attachment file could not be uploaded";
      updatePendingAttachment({
        localId: `pending-${itemId}`,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        geometry: attachmentGeometry,
        status: projectOwnedContentFailureStatus(caught),
        message,
      });
      setOwnedContentActionError(message);
    }
  }, [ownedContentMutationIsActive, performAttachmentProjectCreate, snapshot, updatePendingAttachment]);

  const handleAttachmentFile = useCallback((file: File | null) => {
    const point = attachmentRequestPointRef.current;
    attachmentRequestPointRef.current = null;
    if (!file || !point) return;
    void uploadAndCreateAttachment(file, point);
  }, [uploadAndCreateAttachment]);

  const retryAttachment = useCallback(() => {
    const file = pendingAttachmentFileRef.current;
    const input = pendingAttachmentInputRef.current;
    const current = pendingAttachmentRef.current;
    if (!file || !current || current.status !== "uncertain") return;
    if (input) {
      void performAttachmentProjectCreate(ownedContentGenerationRef.current, input, file);
      return;
    }
    const point = {
      x: current.geometry.x + current.geometry.width / 2,
      y: current.geometry.y + Math.min(72, current.geometry.height / 3),
    };
    updatePendingAttachment(null);
    void uploadAndCreateAttachment(file, point);
  }, [performAttachmentProjectCreate, updatePendingAttachment, uploadAndCreateAttachment]);

  const cancelAttachment = useCallback((leave = false) => {
    const current = pendingAttachmentRef.current;
    if (!current || current.status === "uploading" || current.status === "saving"
      || (current.status === "uncertain" && pendingAttachmentInputRef.current)) return;
    ownedContentGenerationRef.current += 1;
    pendingAttachmentInputRef.current = null;
    pendingAttachmentFileRef.current = null;
    updatePendingAttachment(null);
    setOwnedContentActionError("");
    continueReferenceNavigation(leave);
  }, [continueReferenceNavigation, updatePendingAttachment]);

  const startAttachmentEdit = useCallback((itemId: string) => {
    if (!snapshot || pendingReferenceRef.current || pendingReferenceRemovalRef.current
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current
      || edgeController.unsafeRef.current) return;
    const item = snapshot.items.find((candidate) => candidate.id === itemId);
    const content = item?.projectContentId
      ? snapshot.contents.find((candidate) => candidate.id === item.projectContentId)
      : null;
    if (!item || !content || content.contentType !== "attachment") return;
    ownedContentGenerationRef.current += 1;
    attachmentUpdateInputRef.current = null;
    const caption = content.attachmentCaption ?? "";
    const sourceUrl = content.attachmentSourceUrl ?? "";
    updateAttachmentEditor({
      itemId,
      contentId: content.id,
      caption,
      sourceUrl,
      status: "editing",
      message: null,
    });
    setSelectedItemIds([itemId]);
    setOwnedContentActionError("");
  }, [snapshot, updateAttachmentEditor]);

  const updateAttachmentDraft = useCallback((field: "caption" | "sourceUrl", value: string) => {
    const current = attachmentEditorRef.current;
    if (!current || current.status !== "editing") return;
    updateAttachmentEditor({ ...current, [field]: value, message: null });
  }, [updateAttachmentEditor]);

  const cancelAttachmentEdit = useCallback((leave = false) => {
    const current = attachmentEditorRef.current;
    if (!current || current.status === "saving" || current.status === "uncertain") return;
    attachmentUpdateInputRef.current = null;
    ownedContentGenerationRef.current += 1;
    updateAttachmentEditor(null);
    setOwnedContentActionError("");
    continueReferenceNavigation(leave);
  }, [continueReferenceNavigation, updateAttachmentEditor]);

  const saveAttachmentMetadata = useCallback(async () => {
    const current = attachmentEditorRef.current;
    if (!projectId || !snapshot || !current || (current.status !== "editing" && current.status !== "uncertain")) return;
    const content = snapshot.contents.find((candidate) => candidate.id === current.contentId);
    if (!content || content.contentType !== "attachment") return;
    const generation = ownedContentGenerationRef.current;
    updateAttachmentEditor({ ...current, status: "saving", message: null });
    setOwnedContentActionError("");
    try {
      let input = attachmentUpdateInputRef.current;
      if (!input) {
        input = {
          caption: current.caption === "" ? null : current.caption,
          sourceUrl: current.sourceUrl.trim() === "" ? null : current.sourceUrl.trim(),
          expectedRevision: content.revision,
          operationId: createProjectApiId("operation"),
        };
        attachmentUpdateInputRef.current = input;
      }
      const result = await projectApi.updateAttachment(projectId, current.contentId, input);
      if (!ownedContentMutationIsActive(generation)) return;
      setSnapshot((local) => local ? {
        ...local,
        contents: [...local.contents.filter((candidate) => candidate.id !== result.value.id), result.value],
      } : local);
      attachmentUpdateInputRef.current = null;
      updateAttachmentEditor(null);
    } catch (caught) {
      if (!ownedContentMutationIsActive(generation)) return;
      const status = projectOwnedContentFailureStatus(caught);
      const message = caught instanceof Error ? caught.message : "Attachment metadata could not be saved";
      updateAttachmentEditor({ ...current, status, message });
      setOwnedContentActionError(message);
    }
  }, [ownedContentMutationIsActive, projectId, snapshot, updateAttachmentEditor]);

  const retryAttachmentMetadata = useCallback(() => {
    const current = attachmentEditorRef.current;
    if (!current || current.status !== "uncertain") return;
    void saveAttachmentMetadata();
  }, [saveAttachmentMetadata]);

  const reloadAfterEdgeConflict = useCallback(() => {
    edgeController.resetForAuthoritativeReload();
    referenceNavigationRequestedRef.current = false;
    if (blocker.state === "blocked") blocker.reset();
    void loadProject();
  }, [blocker, edgeController.resetForAuthoritativeReload, loadProject]);

  const reloadAfterReferenceConflict = useCallback(() => {
    if (saveStateRef.current !== "saved" || pendingReferenceRemovalRef.current) return;
    clearReferenceInsertion();
    setReferenceActionError("");
    referenceNavigationRequestedRef.current = false;
    if (blocker.state === "blocked") blocker.reset();
    void loadProject();
  }, [blocker, clearReferenceInsertion, loadProject]);

  const stayOnProject = useCallback(() => {
    navigationSaveRequestedRef.current = false;
    referenceNavigationRequestedRef.current = false;
    if (blocker.state === "blocked") blocker.reset();
  }, [blocker]);

  const leaveWithoutSaving = useCallback(() => {
    if (blocker.state !== "blocked" || pendingReferenceRef.current || pendingReferenceRemovalRef.current
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current
      || edgeController.unsafeRef.current) return;
    const state = saveStateRef.current;
    if (state !== "error" && state !== "conflict") return;
    navigationSaveRequestedRef.current = false;
    saveAgainRef.current = false;
    saveSessionGenerationRef.current += 1;
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    blocker.proceed();
  }, [blocker]);

  const retrySaveAndLeave = useCallback(() => {
    if (blocker.state !== "blocked") return;
    navigationSaveRequestedRef.current = true;
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    void flushSave();
  }, [blocker.state, flushSave]);

  const selectProjectItems = useCallback((selection: ProjectItemSelection) => {
    const normalized = normalizeProjectItemSelection(
      selection.itemIds,
      selection.primaryItemId,
    );
    const lockedItemId = markdownEditorRef.current?.itemId
      ?? attachmentEditorRef.current?.itemId
      ?? null;
    if (lockedItemId && (
      normalized.itemIds.length !== 1
      || normalized.primaryItemId !== lockedItemId
    )) return false;
    if ((edgeController.unsafeRef.current || copyPaste.unsafeRef.current) && normalized.itemIds.length > 0) return false;
    if (normalized.itemIds.length > 0) edgeController.selectEdge(null);
    setSelectedItemIds(normalized.itemIds);
    setNavigationFocusItemId((current) => (
      normalized.itemIds.length === 1
      && normalized.primaryItemId === current
        ? current
        : null
    ));
    return true;
  }, [edgeController.selectEdge, edgeController.unsafeRef]);

  const selectProjectItem = useCallback((itemId: string | null) => {
    return selectProjectItems({
      itemIds: itemId ? [itemId] : [],
      primaryItemId: itemId,
    });
  }, [selectProjectItems]);

  const selectProjectEdge = useCallback((edgeId: string | null) => {
    if (markdownEditorRef.current || attachmentEditorRef.current) return false;
    if (edgeController.selectEdge(edgeId) === false) return false;
    if (edgeId !== null) {
      setSelectedItemIds([]);
      setNavigationFocusItemId(null);
    }
    return true;
  }, [edgeController.selectEdge]);

  const descriptors = useMemo(() => snapshot ? projectMapNodes(snapshot).map((node) => ({
    ...node,
    geometry: geometry[node.placementId] ?? node.geometry,
  })) : [], [geometry, snapshot]);
  const readingNodes = useMemo(() => snapshot ? projectReadingNodes(snapshot).map((node) => ({
    ...node,
    geometry: geometry[node.placementId] ?? node.geometry,
  })) : [], [geometry, snapshot]);
  const selectedDescriptors = selectedItemIds.flatMap((itemId) => {
    const descriptor = descriptors.find((node) => node.itemId === itemId);
    return descriptor ? [descriptor] : [];
  });
  const selected = selectedDescriptors.length === 1 ? selectedDescriptors[0] : null;
  const selectedItem = selected
    ? snapshot?.items.find((item) => item.id === selected.itemId) ?? null
    : null;
  const selectedReferenceTarget = selectedItem?.referenceTargetId
    ? snapshot?.references.find((reference) => (
      reference.registryId === selectedItem.referenceTargetId
    ))?.resolution.target ?? null
    : null;
  const selectedEdgeSource = edgeController.selectedEdge
    ? descriptors.find((node) => node.itemId === edgeController.selectedEdge?.sourceItemId) ?? null
    : null;
  const selectedEdgeTarget = edgeController.selectedEdge
    ? descriptors.find((node) => node.itemId === edgeController.selectedEdge?.targetItemId) ?? null
    : null;
  const focusedItem = focusedItemId
    ? descriptors.find((node) => node.itemId === focusedItemId) ?? null
    : null;

  const alignSelectedItems = useCallback((alignment: ProjectCanvasAlignment) => {
    commitGeometryBatch(projectCanvasAlignmentCommands(
      descriptors,
      selectedItemIds,
      alignment,
    ));
  }, [commitGeometryBatch, descriptors, selectedItemIds]);

  const changeSelectedZOrder = useCallback((action: ProjectCanvasZOrderAction) => {
    commitGeometryBatch(projectCanvasZOrderCommands(
      descriptors,
      selectedItemIds,
      action,
    ));
  }, [commitGeometryBatch, descriptors, selectedItemIds]);

  useEffect(() => {
    if (!snapshot || focusRequest.status !== "valid") {
      appliedFocusRef.current = null;
      setNavigationFocusItemId(null);
      return;
    }
    const focusKey = `${projectId}\u0000${location.search}`;
    if (appliedFocusRef.current === focusKey) return;
    appliedFocusRef.current = focusKey;
    const target = descriptors.find((node) => node.itemId === focusRequest.itemId) ?? null;
    if (!target) {
      setNavigationFocusItemId(null);
      return;
    }
    selectProjectItem(target.itemId);
    setNavigationFocusItemId(target.itemId);
  }, [descriptors, focusRequest, location.search, projectId, selectProjectItem, snapshot]);

  useLayoutEffect(() => {
    stableLinkCopyGenerationRef.current += 1;
    setStableLinkCopyState(null);
  }, [projectId, selectedItemId]);

  const copyProjectItemLink = useCallback(async (itemId: string) => {
    if (!descriptors.some((descriptor) => descriptor.itemId === itemId)) return;
    const requestProjectId = projectId;
    const generation = stableLinkCopyGenerationRef.current + 1;
    stableLinkCopyGenerationRef.current = generation;
    setStableLinkCopyState(null);
    const requestIsCurrent = () => (
      pageActiveRef.current
      && stableLinkCopyGenerationRef.current === generation
      && projectIdRef.current === requestProjectId
    );
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(projectItemFocusAbsoluteUrl(
        window.location.origin,
        location.pathname,
        itemId,
      ));
      if (!requestIsCurrent()) return;
      setStableLinkCopyState({ projectId: requestProjectId, itemId, status: "copied" });
    } catch {
      if (!requestIsCurrent()) return;
      setStableLinkCopyState({ projectId: requestProjectId, itemId, status: "error" });
    }
  }, [descriptors, location.pathname, projectId]);

  const copySelectedItemLink = useCallback(() => {
    if (!selected) return;
    return copyProjectItemLink(selected.itemId);
  }, [copyProjectItemLink, selected]);

  const selectedStableLinkCopyStatus = stableLinkCopyState?.projectId === projectId
    && stableLinkCopyState.itemId === selectedItemId
    ? stableLinkCopyState.status
    : "idle";

  const removeReferenceItem = useCallback((itemId: string) => {
    if (!snapshot || saveStateRef.current !== "saved"
      || pendingReferenceRef.current || pendingReferenceRemovalRef.current
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current
      || edgeController.unsafeRef.current) return;
    const item = snapshot.items.find((candidate) => candidate.id === itemId);
    if (!item || item.itemType !== "reference") return;
    setSelectedItemIds([item.id]);
    startReferenceRemoval(item.id, item.revision);
  }, [snapshot, startReferenceRemoval]);

  const removeSelectedReference = useCallback(() => {
    if (!selectedItem) return;
    removeReferenceItem(selectedItem.id);
  }, [removeReferenceItem, selectedItem]);

  const removeMarkdownItem = useCallback((itemId: string) => {
    if (!snapshot || saveStateRef.current !== "saved"
      || pendingReferenceRef.current || pendingReferenceRemovalRef.current
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current
      || edgeController.unsafeRef.current) return;
    const item = snapshot.items.find((candidate) => candidate.id === itemId);
    const content = item?.projectContentId
      ? snapshot.contents.find((candidate) => candidate.id === item.projectContentId)
      : null;
    if (!item || item.itemType !== "content" || !content || content.contentType !== "markdown") return;
    setSelectedItemIds([item.id]);
    startReferenceRemoval(item.id, item.revision, content.revision);
  }, [snapshot, startReferenceRemoval]);

  const removeAttachmentItem = useCallback((itemId: string) => {
    if (!snapshot || saveStateRef.current !== "saved"
      || pendingReferenceRef.current || pendingReferenceRemovalRef.current
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current
      || edgeController.unsafeRef.current) return;
    const item = snapshot.items.find((candidate) => candidate.id === itemId);
    const content = item?.projectContentId
      ? snapshot.contents.find((candidate) => candidate.id === item.projectContentId)
      : null;
    if (!item || item.itemType !== "content" || !content || content.contentType !== "attachment") return;
    setSelectedItemIds([item.id]);
    startReferenceRemoval(item.id, item.revision, content.revision);
  }, [snapshot, startReferenceRemoval]);

  const canvasCommandOperationBlocked = useCallback(() => Boolean(
    pendingReferenceRef.current
    || pendingReferenceRemovalRef.current
    || markdownEditorRef.current
    || pendingAttachmentRef.current
    || attachmentEditorRef.current
    || projectDeleteRequestRef.current
    || copyPaste.unsafeRef.current
    || edgeController.unsafeRef.current
  ), [copyPaste.unsafeRef, edgeController.unsafeRef]);

  const copyCanvasSelection = useCallback(() => {
    if (canvasCommandOperationBlocked() || saveStateRef.current !== "saved"
      || !snapshot || selectedItemIds.length === 0) return false;
    copyPaste.copySelection(
      snapshotWithPlacementProjection(snapshot, geometryRef.current),
      selectedItemIds,
    );
    return true;
  }, [
    canvasCommandOperationBlocked,
    copyPaste.copySelection,
    selectedItemIds,
    snapshot,
  ]);

  const pasteCanvasSelection = useCallback(() => {
    if (canvasCommandOperationBlocked() || saveStateRef.current !== "saved" || !snapshot) return false;
    if (!copyPaste.pasteClipboard(
      snapshotWithPlacementProjection(snapshot, geometryRef.current),
    )) return false;
    setSelectedItemIds([]);
    setNavigationFocusItemId(null);
    edgeController.selectEdge(null);
    return true;
  }, [
    canvasCommandOperationBlocked,
    copyPaste.pasteClipboard,
    edgeController.selectEdge,
    snapshot,
  ]);

  const selectAllCanvasItems = useCallback(() => {
    if (canvasCommandOperationBlocked() || descriptors.length === 0) return false;
    const primaryItemId = selectedItemId
      && descriptors.some((descriptor) => descriptor.itemId === selectedItemId)
      ? selectedItemId
      : descriptors.at(-1)?.itemId ?? null;
    return selectProjectItems({
      itemIds: descriptors.map((descriptor) => descriptor.itemId),
      primaryItemId,
    }) !== false;
  }, [
    canvasCommandOperationBlocked,
    descriptors,
    selectProjectItems,
    selectedItemId,
  ]);

  const clearCanvasSelection = useCallback(() => {
    if (canvasCommandOperationBlocked()
      || (selectedItemIds.length === 0 && !edgeController.selectedEdgeId)) return false;
    selectProjectItems({ itemIds: [], primaryItemId: null });
    edgeController.selectEdge(null);
    return true;
  }, [
    canvasCommandOperationBlocked,
    edgeController.selectEdge,
    edgeController.selectedEdgeId,
    selectProjectItems,
    selectedItemIds.length,
  ]);

  const focusReferencePanel = useCallback(() => {
    window.requestAnimationFrame(() => referencePanelRef.current?.focus());
  }, []);

  const focusInspectorPanel = useCallback(() => {
    window.requestAnimationFrame(() => inspectorPanelRef.current?.focus());
  }, []);

  const inspectContextItem = useCallback((itemId: string) => {
    if (selectProjectItem(itemId) === false) return;
    setInspectorPanelOpen(true);
    focusInspectorPanel();
  }, [focusInspectorPanel, selectProjectItem]);

  const editContextItem = useCallback((itemId: string) => {
    const descriptor = descriptors.find((candidate) => candidate.itemId === itemId);
    if (!descriptor) return;
    setInspectorPanelOpen(true);
    if (descriptor.kind === "markdown") startMarkdownEdit(itemId);
    else if (descriptor.kind === "attachment") {
      startAttachmentEdit(itemId);
      focusInspectorPanel();
    }
  }, [descriptors, focusInspectorPanel, startAttachmentEdit, startMarkdownEdit]);

  const removeContextItem = useCallback((itemId: string) => {
    const descriptor = descriptors.find((candidate) => candidate.itemId === itemId);
    if (!descriptor) return;
    if (descriptor.kind === "reference") removeReferenceItem(itemId);
    else if (descriptor.kind === "markdown") removeMarkdownItem(itemId);
    else removeAttachmentItem(itemId);
  }, [
    descriptors,
    removeAttachmentItem,
    removeMarkdownItem,
    removeReferenceItem,
  ]);

  const inspectContextEdge = useCallback((edgeId: string) => {
    if (selectProjectEdge(edgeId) === false) return;
    setInspectorPanelOpen(true);
    focusInspectorPanel();
  }, [focusInspectorPanel, selectProjectEdge]);

  const openReferencePanel = useCallback(() => {
    setReferencePanelOpen(true);
    focusReferencePanel();
  }, [focusReferencePanel]);

  const openInspectorPanel = useCallback(() => {
    setInspectorPanelOpen(true);
    setInspectorPinned(true);
    focusInspectorPanel();
  }, [focusInspectorPanel]);

  // Keyboard shortcuts and context menus share these route commands, so
  // selection, paste, and history never gain a second mutation path.
  useLayoutEffect(() => {
    if (!desktop || desktopView !== "map") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || projectCanvasKeyboardTargetIsEditable(event.target)) return;
      const shortcut = projectCanvasKeyboardShortcutFromEvent(event);
      if (!shortcut) return;
      if (shortcut === "save") event.preventDefault();

      if (shortcut === "copy") {
        if (copyCanvasSelection()) event.preventDefault();
        return;
      }
      if (shortcut === "paste") {
        if (pasteCanvasSelection()) event.preventDefault();
        return;
      }

      const operationBlocked = canvasCommandOperationBlocked();
      if (operationBlocked) return;
      if (shortcut === "select-all") {
        if (selectAllCanvasItems()) event.preventDefault();
        return;
      }
      if (shortcut === "clear-selection") {
        if (clearCanvasSelection()) event.preventDefault();
        return;
      }
      if (shortcut === "undo") {
        if (saveStateRef.current === "saving" || undoStack.length === 0) return;
        event.preventDefault();
        undo();
        return;
      }
      if (shortcut === "redo") {
        if (saveStateRef.current === "saving" || redoStack.length === 0) return;
        event.preventDefault();
        redo();
        return;
      }
      if (shortcut === "save") {
        const state = saveStateRef.current;
        if (state !== "unsaved" && state !== "error") return;
        if (autosaveTimerRef.current !== null) {
          window.clearTimeout(autosaveTimerRef.current);
          autosaveTimerRef.current = null;
        }
        void flushSaveRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    canvasCommandOperationBlocked,
    clearCanvasSelection,
    copyCanvasSelection,
    desktop,
    desktopView,
    pasteCanvasSelection,
    redo,
    redoStack.length,
    selectAllCanvasItems,
    undo,
    undoStack.length,
  ]);

  if (loading) return <div className="page project-page"><p className="muted">Loading Project…</p></div>;
  if (loadError || !snapshot) return <div className="page project-page">
    <Link className="back-link" to="/projects">← Projects</Link>
    <p className="error-banner">{loadError || "Project not found"}</p>
  </div>;

  const ownedContentBusy = Boolean(markdownEditor || pendingAttachment || attachmentEditor);
  const workspaceOperationBusy = ownedContentBusy || edgeController.unsafe || copyPaste.unsafe;
  const referencePlacementDisabled = Boolean(pendingReference || pendingReferenceRemoval || workspaceOperationBusy || saveState === "conflict");
  const referenceConflictReloadDisabled = saveState !== "saved" || pendingReferenceRemoval !== null || workspaceOperationBusy;
  const geometryInteractionDisabled = pendingReferenceRemoval !== null
    || pendingReference?.status === "reconciling"
    || workspaceOperationBusy;
  const undoCommand = undoStack.at(-1) ?? null;
  const redoCommand = redoStack.at(-1) ?? null;
  const undoDisabled = !undoCommand
    || (undoCommand.kind === "geometry" && saveState === "saving")
    || geometryInteractionDisabled
    || (undoCommand.kind !== "geometry" && edgeController.interactionDisabled);
  const redoDisabled = !redoCommand
    || (redoCommand.kind === "geometry" && saveState === "saving")
    || geometryInteractionDisabled
    || (redoCommand.kind !== "geometry" && edgeController.interactionDisabled);
  const viewSwitchDisabled = projectionSwitchLocked;
  const readingInteractionDisabled = saveState !== "saved"
    || pendingReference !== null
    || pendingReferenceRemoval !== null
    || pendingAttachment !== null
    || copyPaste.unsafe
    || edgeController.unsafe;
  const alignmentActionDisabled = (alignment: ProjectCanvasAlignment) => (
    geometryInteractionDisabled
    || selectedDescriptors.length < 2
    || projectCanvasAlignmentCommands(descriptors, selectedItemIds, alignment).length === 0
  );
  const zOrderActionDisabled = (action: ProjectCanvasZOrderAction) => (
    geometryInteractionDisabled
    || projectCanvasZOrderCommands(descriptors, selectedItemIds, action).length === 0
  );
  const canvasCommandsBlocked = canvasCommandOperationBlocked();
  const createCommandDisabled = geometryInteractionDisabled
    || pendingReference !== null
    || saveState === "conflict";
  const edgeInspectDisabled = markdownEditor !== null
    || attachmentEditor !== null
    || edgeController.unsafe;
  const edgeMutationCommandsDisabled = edgeController.interactionDisabled
    || saveState !== "saved";
  const contextCommands: ProjectMapContextCommands = {
    createDisabled: createCommandDisabled,
    selectAllDisabled: canvasCommandsBlocked || descriptors.length === 0,
    clearSelectionDisabled: canvasCommandsBlocked
      || (selectedItemIds.length === 0 && edgeController.selectedEdgeId === null),
    copyDisabled: workspaceOperationBusy
      || pendingReference !== null
      || pendingReferenceRemoval !== null
      || saveState !== "saved"
      || selectedItemIds.length === 0,
    pasteDisabled: workspaceOperationBusy
      || pendingReference !== null
      || pendingReferenceRemoval !== null
      || saveState !== "saved"
      || copyPaste.clipboard?.status !== "ready",
    editDisabled: workspaceOperationBusy
      || pendingReference !== null
      || pendingReferenceRemoval !== null
      || saveState === "conflict",
    removeDisabled: workspaceOperationBusy
      || pendingReference !== null
      || pendingReferenceRemoval !== null
      || saveState !== "saved",
    edgeInspectDisabled,
    edgeEditDisabled: edgeMutationCommandsDisabled,
    edgeDeleteDisabled: edgeMutationCommandsDisabled,
    panelCommandsDisabled: false,
    alignmentDisabled: alignmentActionDisabled,
    zOrderDisabled: zOrderActionDisabled,
    inspectItem: inspectContextItem,
    editItem: editContextItem,
    copyItemLink: copyProjectItemLink,
    copySelection: copyCanvasSelection,
    pasteSelection: pasteCanvasSelection,
    selectAll: selectAllCanvasItems,
    clearSelection: clearCanvasSelection,
    alignSelection: alignSelectedItems,
    changeZOrder: changeSelectedZOrder,
    removeItem: removeContextItem,
    inspectEdge: inspectContextEdge,
    editEdge: () => {
      if (edgeController.startEdit() === false) return;
      setInspectorPanelOpen(true);
      focusInspectorPanel();
    },
    deleteEdge: () => {
      edgeController.deleteSelected();
    },
    openReferences: openReferencePanel,
    openInspector: openInspectorPanel,
  };
  const alignmentControls = <div className="project-canvas-command-group">
    <p className="card-label">Align selection</p>
    <div className="project-canvas-command-grid align" role="group" aria-label="Align selected items">
      <button type="button" className="button compact-button" aria-label="Align left" disabled={alignmentActionDisabled("left")} onClick={() => alignSelectedItems("left")}>Left</button>
      <button type="button" className="button compact-button" aria-label="Align horizontal centers" disabled={alignmentActionDisabled("center-x")} onClick={() => alignSelectedItems("center-x")}>Center X</button>
      <button type="button" className="button compact-button" aria-label="Align right" disabled={alignmentActionDisabled("right")} onClick={() => alignSelectedItems("right")}>Right</button>
      <button type="button" className="button compact-button" aria-label="Align top" disabled={alignmentActionDisabled("top")} onClick={() => alignSelectedItems("top")}>Top</button>
      <button type="button" className="button compact-button" aria-label="Align vertical centers" disabled={alignmentActionDisabled("center-y")} onClick={() => alignSelectedItems("center-y")}>Center Y</button>
      <button type="button" className="button compact-button" aria-label="Align bottom" disabled={alignmentActionDisabled("bottom")} onClick={() => alignSelectedItems("bottom")}>Bottom</button>
    </div>
  </div>;
  const zOrderControls = <div className="project-canvas-command-group">
    <p className="card-label">Layer order</p>
    <div className="project-canvas-command-grid order" role="group" aria-label="Change selected item layer order">
      <button type="button" className="button compact-button" aria-label="Send to back" disabled={zOrderActionDisabled("send-to-back")} onClick={() => changeSelectedZOrder("send-to-back")}>Back</button>
      <button type="button" className="button compact-button" aria-label="Send backward" disabled={zOrderActionDisabled("send-backward")} onClick={() => changeSelectedZOrder("send-backward")}>Backward</button>
      <button type="button" className="button compact-button" aria-label="Bring forward" disabled={zOrderActionDisabled("bring-forward")} onClick={() => changeSelectedZOrder("bring-forward")}>Forward</button>
      <button type="button" className="button compact-button" aria-label="Bring to front" disabled={zOrderActionDisabled("bring-to-front")} onClick={() => changeSelectedZOrder("bring-to-front")}>Front</button>
    </div>
  </div>;

  const navigationBlockMessage = projectDeleteUncertain
    ? "The Project trash operation outcome is uncertain. Retry the exact move before leaving this Project."
    : deletingProject
      ? "Finishing the Project trash operation before leaving this Project…"
      : copyPaste.paste
        ? copyPaste.paste.status === "pasting"
          ? "Finishing the authoritative Project paste before leaving…"
          : copyPaste.paste.status === "paused"
            ? `The Project paste is paused after ${copyPaste.acknowledgedWrites}/${copyPaste.totalWrites} acknowledged writes. Retry the exact paste or reload authoritative state and abandon the remaining steps before leaving.`
            : copyPaste.paste.status === "reconcile-error"
              ? "All paste writes were acknowledged, but authoritative reload still needs to succeed before leaving."
              : "Reconciling the Project paste against authoritative state before leaving…"
      : edgeController.pending
    ? edgeController.pending.status === "saving"
      ? "Finishing the Project edge operation before leaving…"
      : edgeController.pending.status === "uncertain"
        ? "The Project edge outcome is uncertain. Retry the exact operation before leaving."
        : edgeController.pending.status === "conflict"
          ? "The Project edge conflicted with authoritative state. Reload the Project before continuing."
          : "The Project edge operation failed deterministically. Dismiss it before leaving."
    : edgeController.editor
      ? edgeController.editor.status === "saving"
        ? "Finishing the Project edge metadata save before leaving…"
        : edgeController.editor.status === "uncertain"
          ? "The Project edge metadata outcome is uncertain. Retry the exact save before leaving."
          : edgeController.editor.status === "conflict"
            ? "The Project edge edit conflicted with authoritative state. Reload the Project before continuing."
            : "Save or discard the open Project edge edit before leaving."
      : pendingReferenceRemoval
    ? pendingReferenceRemoval.status === "removing"
      ? "Finishing the Project occurrence removal before leaving this Project…"
      : pendingReferenceRemoval.status === "reconciling"
        ? "Reconciling the Project occurrence against authoritative state before leaving…"
        : pendingReferenceRemoval.status === "uncertain"
          ? "The Project occurrence removal outcome is uncertain. Retry the exact removal before leaving."
          : "The Project occurrence removal conflict needs authoritative reconciliation before leaving."
    : pendingReference
      ? pendingReference.status === "placing" || pendingReference.status === "reconciling"
        ? "Finishing the reference placement reconciliation before leaving this Project…"
        : pendingReference.status === "uncertain"
          ? "The reference insertion outcome is uncertain. Retry the exact insertion or reconcile it before cancelling and leaving."
          : "The pending reference placement must be retried, reloaded, or explicitly cancelled before leaving."
      : pendingAttachment
        ? pendingAttachment.status === "uploading" || pendingAttachment.status === "saving"
          ? "Finishing the Project attachment operation before leaving this Project…"
          : pendingAttachment.status === "uncertain" && pendingAttachmentInputRef.current
            ? "The Project attachment creation outcome is uncertain. Retry the exact creation before leaving."
            : "The attachment operation failed deterministically. Cancel it before leaving, then start a new attachment operation if needed."
        : markdownEditor
          ? markdownEditor.status === "saving"
            ? "Finishing the Project Markdown save before leaving…"
            : markdownEditor.status === "uncertain"
              ? "The Project Markdown save outcome is uncertain. Retry the exact save before leaving."
              : "The open Project Markdown editor must be saved or discarded before leaving; deterministic save failures must be discarded and restarted."
          : attachmentEditor
            ? attachmentEditor.status === "saving"
              ? "Finishing the attachment metadata save before leaving…"
              : attachmentEditor.status === "uncertain"
                ? "The attachment metadata save outcome is uncertain. Retry the exact save before leaving."
                : "The attachment metadata editor must be saved or discarded before leaving; deterministic save failures must be discarded and restarted."
            : saveState === "conflict"
              ? "This Project has a save conflict. Resolve it or explicitly leave without the local placement changes."
              : saveState === "error"
                ? "The placement changes could not be saved. Retry before leaving, stay on the Project, or explicitly discard them."
                : "Saving placement changes before leaving this Project…";

  return <div
    className={`project-page ${desktop ? `desktop ${desktopView}` : "mobile reading"}`}
    data-project-view={desktop ? desktopView : "reading"}
  >
    <header className="project-workspace-header" aria-label="Project workspace controls">
      <div className="project-workspace-identity">
        <Link className="back-link project-workspace-back" to="/projects">← Projects</Link>
        <h1 title={snapshot.project.title}>{snapshot.project.title}</h1>
      </div>
      {desktop && <div className="project-view-toggle" role="group" aria-label="Project view">
        <button type="button" className={`button compact-button${desktopView === "map" ? " active" : ""}`} aria-pressed={desktopView === "map"} disabled={viewSwitchDisabled} onClick={() => setDesktopView("map")}>Map</button>
        <button type="button" className={`button compact-button${desktopView === "reading" ? " active" : ""}`} aria-pressed={desktopView === "reading"} disabled={viewSwitchDisabled} onClick={() => setDesktopView("reading")}>Reading</button>
      </div>}
      <div className="project-workspace-header-actions">
        {desktop && desktopView === "map" && <div
          className="project-panel-toggle-group"
          role="group"
          aria-label="Workspace panels"
        >
          <button
            ref={referencePanelTriggerRef}
            type="button"
            className="button compact-button"
            aria-controls="project-reference-panel"
            aria-pressed={referencePanelOpen}
            aria-label="References"
            disabled={viewSwitchDisabled && referencePanelOpen}
            onClick={() => setReferencePanelOpen((open) => !open)}
          >
            <span className="project-control-label-full">References</span>
            <span className="project-control-label-compact" aria-hidden="true">Refs</span>
          </button>
          <button
            ref={inspectorPanelTriggerRef}
            type="button"
            className="button compact-button"
            aria-controls="project-inspector-panel"
            aria-pressed={inspectorPanelOpen}
            aria-label="Inspector"
            disabled={viewSwitchDisabled && inspectorPanelOpen}
            onClick={() => {
              if (inspectorPanelOpen) {
                setInspectorPanelOpen(false);
                setInspectorPinned(false);
              } else {
                setInspectorPanelOpen(true);
                setInspectorPinned(true);
              }
            }}
          >
            <span className="project-control-label-full">Inspector</span>
            <span className="project-control-label-compact" aria-hidden="true">Inspect</span>
          </button>
        </div>}
        {desktop && desktopView === "map" && <div className="project-save-toolbar">
          <span className={`project-save-state ${saveState}`}>{saveLabel(saveState)}</span>
          <button type="button" className="button compact-button" aria-label="Undo" aria-keyshortcuts="Control+Z Meta+Z" disabled={undoDisabled} onClick={undo}>
            <span className="project-control-label-full">Undo</span>
            <span className="project-control-label-compact" aria-hidden="true">↶</span>
          </button>
          <button type="button" className="button compact-button" aria-label="Redo" aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y Meta+Y" disabled={redoDisabled} onClick={redo}>
            <span className="project-control-label-full">Redo</span>
            <span className="project-control-label-compact" aria-hidden="true">↷</span>
          </button>
          <button
            type="button"
            className="button primary compact-button"
            aria-keyshortcuts="Control+S Meta+S"
            disabled={saveState === "saved" || saveState === "saving" || saveState === "conflict" || geometryInteractionDisabled}
            onClick={() => {
              if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
              autosaveTimerRef.current = null;
              void flushSave();
            }}
          >Save</button>
        </div>}
        <div ref={projectActionsRef} className="project-overflow">
          <button
            ref={projectActionsTriggerRef}
            type="button"
            className="button compact-button project-overflow-trigger"
            aria-label="Project actions"
            aria-expanded={projectActionsOpen}
            aria-controls="project-overflow-panel"
            onClick={() => setProjectActionsOpen((open) => !open)}
          >
            <span className="project-control-label-full">Project actions</span>
            <span className="project-control-label-compact" aria-hidden="true">More</span>
          </button>
          {projectActionsOpen && <div
            id="project-overflow-panel"
            className="project-overflow-panel"
            role="group"
            aria-label="Project actions"
          >
            <p className="card-label">Project</p>
            <button
              type="button"
              className="button danger compact-button"
              disabled={viewSwitchDisabled || deletingProject}
              onClick={() => {
                setProjectActionsOpen(false);
                openProjectDeletion();
              }}
            >Move to trash</button>
          </div>}
        </div>
      </div>
    </header>
    <div className="project-workspace-status-region">

    {focusRequest.status === "invalid" && <div className="project-save-banner warning" role="status">
      <p>The Project occurrence focus link is malformed and was not applied.</p>
      <Link className="button compact-button" to={location.pathname}>Open Project overview</Link>
    </div>}

    {focusRequest.status === "valid" && !focusedItem && <div className="project-save-banner warning" role="status">
      <p>The linked Project occurrence is no longer available in this active Project.</p>
      <Link className="button compact-button" to={location.pathname}>Open Project overview</Link>
    </div>}

    {saveError && <div className={`project-save-banner ${saveState}`}>
      <p>{saveError}</p>
      {saveState === "conflict" && <button
        type="button"
        className="button compact-button"
        disabled={pendingReferenceRemoval !== null || workspaceOperationBusy}
        onClick={() => void loadProject()}
      >
        Reload authoritative Project
      </button>}
      {saveState === "error" && <button
        type="button"
        className="button compact-button"
        disabled={pendingReferenceRemoval !== null || workspaceOperationBusy}
        onClick={() => void flushSave()}
      >
        Retry save
      </button>}
    </div>}

    {pendingReferenceRemoval?.status === "uncertain" && <div className="project-save-banner error">
      <p>{pendingReferenceRemoval.message || "The Project occurrence removal outcome is uncertain."}</p>
      <button type="button" className="button primary compact-button" onClick={retryReferenceRemoval}>Retry exact removal</button>
    </div>}

    {pendingReferenceRemoval?.status === "conflict" && <div className="project-save-banner error">
      <p>{pendingReferenceRemoval.message || "The Project occurrence removal conflict needs authoritative reconciliation."}</p>
      <button type="button" className="button primary compact-button" onClick={retryReferenceRemovalReconciliation}>Retry reconciliation</button>
    </div>}

    {referenceActionError && !pendingReference && !pendingReferenceRemoval && <div className="project-save-banner error">
      <p>{referenceActionError}</p>
    </div>}

    {ownedContentActionError && !markdownEditor && !pendingAttachment && !attachmentEditor && <div className="project-save-banner error">
      <p>{ownedContentActionError}</p>
    </div>}

    {copyPaste.clipboard?.status === "error" && <div className="project-save-banner error">
      <p>{copyPaste.clipboard.message}</p>
    </div>}

    {copyPaste.notice && !copyPaste.paste && <div className="project-save-banner warning" role="status">
      <p>{copyPaste.notice}</p>
    </div>}

    {copyPaste.paste && <div className={`project-save-banner ${copyPaste.paste.status === "paused" || copyPaste.paste.status === "reconcile-error" ? "error" : "warning"}`} role="status">
      <p>{copyPaste.paste.status === "pasting"
        ? "Pasting the copied Project selection through authoritative item and edge writes…"
        : copyPaste.paste.status === "paused"
          ? `Paste paused after ${copyPaste.acknowledgedWrites}/${copyPaste.totalWrites} acknowledged writes. ${copyPaste.paste.message || "Retry the exact frozen journal or reconcile authoritative state."}`
          : copyPaste.paste.message || "Reconciling the Project paste against authoritative state…"}</p>
      {copyPaste.paste.status === "paused" && <div className="project-navigation-actions">
        <button type="button" className="button primary compact-button" onClick={copyPaste.retryExact}>Retry exact paste</button>
        <button type="button" className="button compact-button" onClick={copyPaste.reloadAndAbandon}>Reload and abandon remaining paste</button>
      </div>}
      {copyPaste.paste.status === "reconcile-error" && <div className="project-navigation-actions">
        <button type="button" className="button primary compact-button" onClick={copyPaste.retryAuthoritativeReload}>Retry authoritative reload</button>
      </div>}
    </div>}

    {edgeController.actionError && <div className="project-save-banner error">
      <p>{edgeController.actionError}</p>
      <div className="project-navigation-actions">
        {edgeController.pending?.status === "uncertain" && <button type="button" className="button primary compact-button" onClick={edgeController.retryExact}>Retry exact edge operation</button>}
        {edgeController.pending?.status === "error" && !edgeController.editor && <button type="button" className="button compact-button" onClick={edgeController.dismissDeterministic}>Dismiss failed edge operation</button>}
        {(edgeController.pending?.status === "conflict" || edgeController.editor?.status === "conflict") && <button type="button" className="button compact-button" onClick={reloadAfterEdgeConflict}>Reload authoritative Project</button>}
      </div>
    </div>}

    {blocker.state === "blocked" && <div className="project-save-banner warning" role="alertdialog" aria-label="Unsaved Project changes">
      <p>{navigationBlockMessage}</p>
      <div className="project-navigation-actions">
        <button type="button" className="button compact-button" onClick={stayOnProject}>Stay on Project</button>
        {copyPaste.paste?.status === "paused" && <button type="button" className="button primary compact-button" onClick={copyPaste.retryExact}>Retry exact paste</button>}
        {copyPaste.paste?.status === "paused" && <button type="button" className="button compact-button" onClick={copyPaste.reloadAndAbandon}>Reload and abandon remaining paste</button>}
        {copyPaste.paste?.status === "reconcile-error" && <button type="button" className="button primary compact-button" onClick={copyPaste.retryAuthoritativeReload}>Retry authoritative reload</button>}
        {edgeController.pending?.status === "uncertain" && <button type="button" className="button primary compact-button" onClick={edgeController.retryExact}>Retry exact edge operation</button>}
        {edgeController.pending?.status === "error" && !edgeController.editor && <button type="button" className="button compact-button" onClick={edgeController.dismissDeterministic}>Dismiss edge operation and leave</button>}
        {(edgeController.pending?.status === "conflict" || edgeController.editor?.status === "conflict") && <button type="button" className="button primary compact-button" onClick={reloadAfterEdgeConflict}>Reload Project</button>}
        {edgeController.editor?.status === "editing" && <button type="button" className="button primary compact-button" onClick={edgeController.saveEdit}>Save edge and leave</button>}
        {edgeController.editor?.status === "uncertain" && <button type="button" className="button primary compact-button" onClick={edgeController.retryExact}>Retry exact edge save</button>}
        {(edgeController.editor?.status === "editing" || edgeController.editor?.status === "error") && <button type="button" className="button compact-button" onClick={edgeController.cancelEdit}>Discard edge edit and leave</button>}
        {pendingReferenceRemoval?.status === "uncertain" && <button type="button" className="button primary compact-button" onClick={retryReferenceRemoval}>Retry exact removal</button>}
        {pendingReferenceRemoval?.status === "conflict" && <button type="button" className="button primary compact-button" onClick={retryReferenceRemovalReconciliation}>Retry reconciliation</button>}
        {(pendingReference?.status === "error" || pendingReference?.status === "uncertain") && <button type="button" className="button primary compact-button" onClick={retryReferencePlacement}>Retry placement</button>}
        {pendingReference?.status === "uncertain" && <button type="button" className="button compact-button" onClick={() => void reconcileAndCancelUncertainReference(true)}>Reconcile, cancel and leave</button>}
        {pendingReference?.status === "conflict" && <button type="button" className="button primary compact-button" disabled={referenceConflictReloadDisabled} onClick={reloadAfterReferenceConflict}>Reload Project</button>}
        {(pendingReference?.status === "error" || pendingReference?.status === "conflict") && <button type="button" className="button compact-button" onClick={() => cancelReferencePlacement(true)}>Cancel placement and leave</button>}
        {(pendingAttachment?.status === "error" || pendingAttachment?.status === "conflict" || (pendingAttachment?.status === "uncertain" && !pendingAttachmentInputRef.current)) && <button type="button" className="button compact-button" onClick={() => cancelAttachment(true)}>Cancel attachment and leave</button>}
        {pendingAttachment?.status === "uncertain" && <button type="button" className="button primary compact-button" onClick={retryAttachment}>Retry exact attachment</button>}
        {markdownEditor?.status === "uncertain" && <button type="button" className="button primary compact-button" onClick={retryMarkdownSave}>Retry exact Markdown save</button>}
        {markdownEditor && markdownEditor.status !== "saving" && markdownEditor.status !== "uncertain" && <button type="button" className="button compact-button" onClick={() => cancelMarkdown(true)}>Discard Markdown and leave</button>}
        {attachmentEditor?.status === "uncertain" && <button type="button" className="button primary compact-button" onClick={retryAttachmentMetadata}>Retry exact metadata save</button>}
        {attachmentEditor && attachmentEditor.status !== "saving" && attachmentEditor.status !== "uncertain" && <button type="button" className="button compact-button" onClick={() => cancelAttachmentEdit(true)}>Discard metadata edits and leave</button>}
        {!pendingReference && !pendingReferenceRemoval && !workspaceOperationBusy && saveState === "error" && <button type="button" className="button primary compact-button" onClick={retrySaveAndLeave}>Retry save and leave</button>}
        {!pendingReference && !pendingReferenceRemoval && !workspaceOperationBusy && (saveState === "error" || saveState === "conflict") && <button type="button" className="button compact-button" onClick={leaveWithoutSaving}>Leave without saving</button>}
      </div>
    </div>}

    </div>

    {desktop ? <div className="project-desktop-workspace with-reference-sidebar"
      data-reference-open={desktopView === "map" && referencePanelOpen}
      data-inspector-open={desktopView === "map" && inspectorPanelOpen}
    >
      {desktopView === "map" ? <>
      <input
        ref={attachmentInputRef}
        className="project-hidden-file-input"
        type="file"
        aria-label="Choose Project attachment"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0] ?? null;
          event.currentTarget.value = "";
          handleAttachmentFile(file);
        }}
      />
      {(selectedItemIds.length > 1 || copyPaste.clipboard?.status === "ready") && <div
        className="project-canvas-transient-status"
        role="status"
        aria-label="Canvas selection and clipboard status"
      >
        {selectedItemIds.length > 1 && <span className="project-selection-count">
          {selectedItemIds.length} selected
        </span>}
        {copyPaste.clipboard?.status === "ready" && <span className="project-selection-count">
          {copyPaste.clipboard.itemCount} copied
        </span>}
      </div>}
      {referencePanelOpen && <aside
        ref={referencePanelRef}
        id="project-reference-panel"
        className="project-reference-sidebar"
        aria-label="Reference search and placement"
        tabIndex={-1}
        data-panel-presentation="floating"
      >
        <div className="project-workspace-panel-toolbar">
          <p className="card-label">References &amp; content</p>
          <button
            type="button"
            className="button compact-button"
            aria-label="Close References"
            aria-keyshortcuts="Escape"
            disabled={viewSwitchDisabled}
            onClick={() => {
              setReferencePanelOpen(false);
              window.requestAnimationFrame(() => referencePanelTriggerRef.current?.focus());
            }}
          >Close</button>
        </div>
        <div className="project-reference-sidebar-heading">
          <p className="card-label">Add Project content</p>
          <p className="card-meta">Double-click empty Map space for Markdown, or add a generic file at the visible Map center.</p>
        </div>
        <div className="project-owned-content-actions">
          <button type="button" className="button wide" disabled={workspaceOperationBusy || Boolean(pendingReference) || Boolean(pendingReferenceRemoval) || saveState === "conflict"} onClick={requestAttachmentAtCenter}>Add attachment</button>
        </div>
        {pendingAttachment && <div className={`project-owned-content-pending ${pendingAttachment.status}`}>
          <strong>{pendingAttachment.filename}</strong>
          <span>{pendingAttachment.status === "uploading"
            ? "Uploading file…"
            : pendingAttachment.status === "saving"
              ? "Creating Project attachment…"
              : pendingAttachment.message}</span>
          {(pendingAttachment.status === "error" || pendingAttachment.status === "conflict" || pendingAttachment.status === "uncertain") && <div className="project-owned-content-pending-actions">
            {pendingAttachment.status === "uncertain" && <button type="button" className="button primary compact-button" onClick={retryAttachment}>Retry exact attachment</button>}
            {(pendingAttachment.status !== "uncertain" || !pendingAttachmentInputRef.current) && <button type="button" className="button compact-button" onClick={() => cancelAttachment(false)}>Cancel</button>}
          </div>}
          {pendingAttachment.status === "uncertain" && pendingAttachmentInputRef.current && <small className="muted">The Project occurrence may already be committed. Retry replays the exact original creation request.</small>}
        </div>}
        <div className="project-reference-sidebar-heading">
          <p className="card-label">Add references</p>
          <p className="card-meta">Search the research record, then drag a result onto the Map or place it at the visible Map center.</p>
        </div>
        {pendingReference && <div className={`project-reference-pending ${pendingReference.status}`}>
          <strong>{pendingReference.preview.title}</strong>
          <span>{pendingReference.status === "placing"
            ? "Placing reference…"
            : pendingReference.status === "reconciling"
              ? pendingReference.message || "Reconciling the original insertion…"
              : pendingReference.message}</span>
          {(pendingReference.status === "error" || pendingReference.status === "uncertain") && <div className="project-reference-pending-actions">
            <button type="button" className="button primary compact-button" onClick={retryReferencePlacement}>Retry</button>
            {pendingReference.status === "error" && <button type="button" className="button compact-button" onClick={() => cancelReferencePlacement(false)}>Cancel</button>}
            {pendingReference.status === "uncertain" && <button type="button" className="button compact-button" onClick={() => void reconcileAndCancelUncertainReference(false)}>Reconcile and cancel</button>}
          </div>}
          {pendingReference.status === "uncertain" && <small className="muted">The server may already have committed this occurrence. Cancellation first replays the original operation and removes any confirmed occurrence.</small>}
          {pendingReference.status === "conflict" && <div className="project-reference-pending-actions">
            <button type="button" className="button primary compact-button" disabled={referenceConflictReloadDisabled} onClick={reloadAfterReferenceConflict}>Reload Project</button>
            <button type="button" className="button compact-button" onClick={() => cancelReferencePlacement(false)}>Cancel</button>
          </div>}
          {pendingReference.status === "conflict" && referenceConflictReloadDisabled && <small className="muted">Resolve existing placement changes before reloading the Project.</small>}
        </div>}
        <ReferenceSearchSurface
          mode="place"
          value={referenceSearch}
          onChange={setReferenceSearch}
          placementDisabled={referencePlacementDisabled}
          onPlaceAtCenter={placeReferenceAtCenter}
        />
      </aside>}
      <section className="project-map-panel" aria-label="Project Map">
        <Suspense fallback={<div className="project-map-loading"><p className="muted">Loading Map editor…</p></div>}>
          <DesktopProjectMap
            ref={mapSurfaceRef}
            nodes={descriptors}
            edges={snapshot.edges}
            pendingEdge={edgeController.pendingEdge}
            pendingReference={pendingReference}
            pendingAttachment={pendingAttachment}
            markdownEditor={markdownEditor}
            selectedItemId={selectedItemId}
            selectedItemIds={selectedItemIds}
            focusedItemId={navigationFocusItemId}
            selectedEdgeId={edgeController.selectedEdgeId}
            geometryInteractionDisabled={geometryInteractionDisabled}
            edgeInteractionDisabled={edgeController.interactionDisabled}
            contextCommands={contextCommands}
            onSelect={selectProjectItem}
            onSelectionChange={selectProjectItems}
            onEdgeSelect={selectProjectEdge}
            onEdgeConnect={edgeController.connect}
            onGeometryCommit={commitGeometry}
            onGeometryBatchCommit={commitGeometryBatch}
            onReferenceDrop={startReferencePlacement}
            onMarkdownCreateRequest={startMarkdownCreate}
            onMarkdownEditRequest={startMarkdownEdit}
            onMarkdownChange={changeMarkdown}
            onMarkdownSave={() => void saveMarkdown()}
            onMarkdownCancel={() => cancelMarkdown(false)}
            onAttachmentRequest={requestAttachmentAt}
          />
        </Suspense>
      </section>
      {inspectorPanelOpen && <aside
        ref={inspectorPanelRef}
        id="project-inspector-panel"
        className="project-inspector"
        aria-label="Project Inspector"
        tabIndex={-1}
        data-panel-presentation="floating"
      >
        <div className="project-workspace-panel-toolbar">
          <p className="card-label">Inspector</p>
          <div className="project-workspace-panel-actions">
            <button
              type="button"
              className="button compact-button"
              aria-pressed={inspectorPinned}
              disabled={viewSwitchDisabled}
              onClick={() => {
                const nextPinned = !inspectorPinned;
                setInspectorPinned(nextPinned);
                if (!nextPinned && selectedItemIds.length === 0 && !edgeController.selectedEdgeId) {
                  setInspectorPanelOpen(false);
                  window.requestAnimationFrame(() => inspectorPanelTriggerRef.current?.focus());
                }
              }}
            >{inspectorPinned ? "Unpin" : "Pin"}</button>
            <button
              type="button"
              className="button compact-button"
              aria-label="Close Inspector"
              aria-keyshortcuts="Escape"
              disabled={viewSwitchDisabled}
              onClick={() => {
                setInspectorPanelOpen(false);
                setInspectorPinned(false);
                window.requestAnimationFrame(() => inspectorPanelTriggerRef.current?.focus());
              }}
            >Close</button>
          </div>
        </div>
        {edgeController.selectedEdge ? <div className="project-inspector-content">
          <span className="meta-badge">edge</span>
          <h2>{edgeController.selectedEdge.label || "Relationship"}</h2>
          <dl>
            <dt>Source</dt><dd>{selectedEdgeSource?.title || edgeController.selectedEdge.sourceItemId}</dd>
            <dt>Target</dt><dd>{selectedEdgeTarget?.title || edgeController.selectedEdge.targetItemId}</dd>
            <dt>Handles</dt><dd>{edgeController.selectedEdge.sourceHandle} → {edgeController.selectedEdge.targetHandle}</dd>
            <dt>Direction</dt><dd>{projectEdgeDirection(edgeController.selectedEdge.markerStart, edgeController.selectedEdge.markerEnd)}</dd>
          </dl>
          {edgeController.editor?.edgeId === edgeController.selectedEdge.id ? <div className="project-attachment-meta-form">
            <label>Direction
              <select
                value={edgeController.editor.direction}
                disabled={edgeController.editor.status === "saving" || edgeController.editor.status === "uncertain" || edgeController.editor.status === "conflict"}
                onChange={(event) => edgeController.changeEdit("direction", event.currentTarget.value)}
              >
                <option value="undirected">Undirected</option>
                <option value="forward">Forward</option>
                <option value="reverse">Reverse</option>
                <option value="bidirectional">Bidirectional</option>
              </select>
            </label>
            <label>Label
              <input
                type="text"
                value={edgeController.editor.label}
                disabled={edgeController.editor.status === "saving" || edgeController.editor.status === "uncertain" || edgeController.editor.status === "conflict"}
                onChange={(event) => edgeController.changeEdit("label", event.currentTarget.value)}
              />
            </label>
            {edgeController.editor.message && <p className="error-banner">{edgeController.editor.message}</p>}
            <div className="project-owned-content-pending-actions">
              {edgeController.editor.status === "editing" && <button type="button" className="button primary compact-button" onClick={edgeController.saveEdit}>Save edge</button>}
              {edgeController.editor.status === "uncertain" && <button type="button" className="button primary compact-button" onClick={edgeController.retryExact}>Retry exact save</button>}
              {(edgeController.editor.status === "editing" || edgeController.editor.status === "error") && <button type="button" className="button compact-button" onClick={edgeController.cancelEdit}>Cancel</button>}
              {edgeController.editor.status === "conflict" && <button type="button" className="button compact-button" onClick={reloadAfterEdgeConflict}>Reload Project</button>}
            </div>
          </div> : <>
            <button type="button" className="button wide" disabled={workspaceOperationBusy || saveState !== "saved"} onClick={edgeController.startEdit}>Edit edge</button>
            <button type="button" className="button wide" disabled={workspaceOperationBusy || saveState !== "saved"} onClick={edgeController.deleteSelected}>Delete edge</button>
          </>}
        </div> : selectedDescriptors.length > 1 ? <div className="project-inspector-content project-multi-selection-inspector">
          <span className="meta-badge">multi-selection</span>
          <h2>{selectedDescriptors.length} items selected</h2>
          <p className="muted">Drag any selected node or use the arrow keys to move the selection as one local history command. Resize, edit, inspect, and remove remain single-item actions.</p>
          <dl>
            <dt>References</dt><dd>{selectedDescriptors.filter((descriptor) => descriptor.kind === "reference").length}</dd>
            <dt>Markdown</dt><dd>{selectedDescriptors.filter((descriptor) => descriptor.kind === "markdown").length}</dd>
            <dt>Attachments</dt><dd>{selectedDescriptors.filter((descriptor) => descriptor.kind === "attachment").length}</dd>
            <dt>Primary</dt><dd>{selectedDescriptors.find((descriptor) => descriptor.itemId === selectedItemId)?.title ?? "None"}</dd>
          </dl>
          {alignmentControls}
          {zOrderControls}
          <button type="button" className="button wide" onClick={() => selectProjectItems({ itemIds: [], primaryItemId: null })}>Clear selection</button>
        </div> : selected ? <div className="project-inspector-content">
          <ProjectInspectorDetails snapshot={snapshot} descriptor={selected} />
          {zOrderControls}
          {selectedReferenceTarget && <ProjectInspectorChildren
            key={`${selectedReferenceTarget.type}\u0000${selectedReferenceTarget.id}`}
            parent={selectedReferenceTarget}
            placementDisabled={referencePlacementDisabled || !desktop || desktopView !== "map"}
            onPlaceAtCenter={placeInspectorChildAtCenter}
          />}
          <button type="button" className="button wide" onClick={() => void copySelectedItemLink()}>
            {selectedStableLinkCopyStatus === "copied" ? "Stable link copied" : "Copy stable link"}
          </button>
          {selectedStableLinkCopyStatus === "error" && <small className="error">Clipboard access was unavailable; the link was not copied.</small>}
          {selected.kind === "markdown" && <button
            type="button"
            className="button wide"
            disabled={workspaceOperationBusy || Boolean(pendingReference) || Boolean(pendingReferenceRemoval)}
            onClick={() => startMarkdownEdit(selected.itemId)}
          >Edit Markdown</button>}
          {selected.kind === "markdown" && <button
            type="button"
            className="button wide"
            disabled={saveState !== "saved" || workspaceOperationBusy || Boolean(pendingReference) || Boolean(pendingReferenceRemoval)}
            onClick={() => removeMarkdownItem(selected.itemId)}
          >{pendingReferenceRemoval?.itemId === selected.itemId
            ? pendingReferenceRemoval.status === "removing"
              ? "Moving Markdown…"
              : pendingReferenceRemoval.status === "reconciling"
                ? "Reconciling removal…"
                : pendingReferenceRemoval.status === "uncertain"
                  ? "Removal needs exact retry"
                  : "Removal needs reconciliation"
            : "Move Markdown to trash"}</button>}
          {selected.kind === "attachment" && selected.attachmentSourceUrl && <a className="button wide" href={selected.attachmentSourceUrl} target="_blank" rel="noreferrer">Open source URL</a>}
          {selected.kind === "attachment" && attachmentEditor?.itemId !== selected.itemId && <button
            type="button"
            className="button wide"
            disabled={workspaceOperationBusy || Boolean(pendingReference) || Boolean(pendingReferenceRemoval)}
            onClick={() => startAttachmentEdit(selected.itemId)}
          >Edit attachment metadata</button>}
          {selected.kind === "attachment" && attachmentEditor?.itemId !== selected.itemId && <button
            type="button"
            className="button wide"
            disabled={saveState !== "saved" || workspaceOperationBusy || Boolean(pendingReference) || Boolean(pendingReferenceRemoval)}
            onClick={() => removeAttachmentItem(selected.itemId)}
          >{pendingReferenceRemoval?.itemId === selected.itemId
            ? pendingReferenceRemoval.status === "removing"
              ? "Moving attachment…"
              : pendingReferenceRemoval.status === "reconciling"
                ? "Reconciling removal…"
                : pendingReferenceRemoval.status === "uncertain"
                  ? "Removal needs exact retry"
                  : "Removal needs reconciliation"
            : "Move attachment to trash"}</button>}
          {selected.kind === "attachment" && attachmentEditor?.itemId === selected.itemId && <div className="project-attachment-meta-form">
            <label>Caption
              <textarea
                value={attachmentEditor.caption}
                disabled={attachmentEditor.status !== "editing"}
                onChange={(event) => updateAttachmentDraft("caption", event.currentTarget.value)}
              />
            </label>
            <label>Source URL
              <input
                type="url"
                placeholder="https://…"
                value={attachmentEditor.sourceUrl}
                disabled={attachmentEditor.status !== "editing"}
                onChange={(event) => updateAttachmentDraft("sourceUrl", event.currentTarget.value)}
              />
            </label>
            {attachmentEditor.message && <ProjectEditorFeedback
              status={attachmentEditor.status}
              message={attachmentEditor.message}
            />}
            <div className="project-owned-content-pending-actions">
              {(attachmentEditor.status === "editing" || attachmentEditor.status === "saving" || attachmentEditor.status === "uncertain") && <button type="button" className="button primary compact-button" disabled={attachmentEditor.status === "saving"} onClick={() => void saveAttachmentMetadata()}>
                {attachmentEditor.status === "saving" ? "Saving…" : attachmentEditor.status === "uncertain" ? "Retry exact save" : "Save metadata"}
              </button>}
              {attachmentEditor.status !== "saving" && attachmentEditor.status !== "uncertain" && <button type="button" className="button compact-button" onClick={() => cancelAttachmentEdit(false)}>Cancel</button>}
            </div>
          </div>}
          {selected.kind === "reference" && <button
            type="button"
            className="button wide"
            disabled={saveState !== "saved" || Boolean(pendingReference) || Boolean(pendingReferenceRemoval) || workspaceOperationBusy}
            onClick={removeSelectedReference}
          >{pendingReferenceRemoval?.itemId === selected.itemId
            ? pendingReferenceRemoval.status === "removing"
              ? "Removing…"
              : pendingReferenceRemoval.status === "reconciling"
                ? "Reconciling removal…"
                : pendingReferenceRemoval.status === "uncertain"
                  ? "Removal needs exact retry"
                  : "Removal needs reconciliation"
            : "Remove from Project"}</button>}
          {selected.kind === "reference" && saveState !== "saved" && <small className="muted">Save placement changes before removing this occurrence.</small>}
        </div> : <p className="muted">Select a Map item or edge to inspect it.</p>}
      </aside>}
      </> : <Suspense fallback={<div className="card"><p className="muted">Loading Reading…</p></div>}>
        <ProjectReadingSurface
          nodes={readingNodes}
        projectTitle={snapshot.project.title}
        focusedItemId={navigationFocusItemId}
        markdownEditor={markdownEditor}
        attachmentEditor={attachmentEditor}
        interactionDisabled={readingInteractionDisabled}
        onMarkdownEditRequest={startMarkdownEdit}
        onMarkdownDeleteRequest={removeMarkdownItem}
        onMarkdownChange={changeMarkdown}
        onMarkdownSave={() => void saveMarkdown()}
        onMarkdownCancel={() => cancelMarkdown(false)}
        onAttachmentEditRequest={startAttachmentEdit}
        onAttachmentDeleteRequest={removeAttachmentItem}
        onAttachmentChange={updateAttachmentDraft}
        onAttachmentSave={() => void saveAttachmentMetadata()}
        onAttachmentCancel={() => cancelAttachmentEdit(false)}
        />
      </Suspense>}
    </div> : <Suspense fallback={<div className="card"><p className="muted">Loading Reading…</p></div>}>
      <ProjectReadingSurface
        nodes={readingNodes}
      projectTitle={snapshot.project.title}
      focusedItemId={navigationFocusItemId}
      mobile
      markdownEditor={markdownEditor}
      attachmentEditor={attachmentEditor}
      interactionDisabled={readingInteractionDisabled}
      onMarkdownEditRequest={startMarkdownEdit}
      onMarkdownDeleteRequest={removeMarkdownItem}
      onMarkdownChange={changeMarkdown}
      onMarkdownSave={() => void saveMarkdown()}
      onMarkdownCancel={() => cancelMarkdown(false)}
      onAttachmentEditRequest={startAttachmentEdit}
      onAttachmentDeleteRequest={removeAttachmentItem}
      onAttachmentChange={updateAttachmentDraft}
      onAttachmentSave={() => void saveAttachmentMetadata()}
      onAttachmentCancel={() => cancelAttachmentEdit(false)}
      />
    </Suspense>}

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
