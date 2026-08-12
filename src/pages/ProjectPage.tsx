import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  useBeforeUnload,
  useBlocker,
  useParams,
  type BlockerFunction,
} from "react-router-dom";
import type { ReferenceSearchResult } from "../../shared/reference-search";
import type {
  CreateAttachmentProjectItemInput,
  CreateMarkdownProjectItemInput,
  CreateReferenceProjectItemInput,
  ProjectItemLifecycleInput,
  ProjectItemMutationResponse,
  ProjectPlacementRecord,
  ProjectSnapshot,
  UpdateProjectAttachmentInput,
  UpdateProjectMarkdownInput,
  UpdateProjectPlacementInput,
} from "../../shared/project-api";
import type {
  ProjectMapGeometry,
} from "../../shared/project-types";
import { EmptyState } from "../components/EmptyState";
import { ReferenceSearchSurface } from "../components/ReferenceSearchSurface";
import type { ProjectMapSurfaceHandle } from "../components/project/ProjectMapSurface";
import {
  ProjectApiError,
  createProjectApiId,
  projectApi,
} from "../lib/project-client";
import {
  applyProjectGeometryCommand,
  projectDirtyPlacements,
  projectGeometryEquals,
  projectMapNodes,
  projectPlacementIndex,
  projectReadingNodes,
  type ProjectGeometryCommand,
} from "../lib/project-map-model";
import {
  projectReferenceDragPayloadFromResult,
  projectReferenceGeometryAtPoint,
  projectReferenceRecordFromPreview,
  type ProjectPendingReferencePlacement,
  type ProjectReferenceDragPayload,
} from "../lib/project-reference-placement";
import { projectReferenceRemovalNeedsReconciliation } from "../lib/project-reference-removal";
import {
  projectAttachmentGeometryAtPoint,
  projectAttachmentIsImage,
  projectMarkdownGeometryAtPoint,
  projectOwnedContentFailureStatus,
  type ProjectMapMarkdownEditorState,
  type ProjectPendingAttachmentPlacement,
} from "../lib/project-owned-content";
import {
  defaultReferenceSearchUiState,
  type ReferenceSearchUiState,
} from "../lib/reference-search-ui";
import "../project.css";

const DesktopProjectMap = lazy(() => import("../components/project/ProjectMapSurface")
  .then((module) => ({ default: module.ProjectMapSurface })));

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

function useDesktopProjectMap() {
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

function geometryIndex(snapshot: ProjectSnapshot) {
  return Object.fromEntries(snapshot.placements.map((placement) => [placement.id, {
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    zIndex: placement.zIndex,
  }]));
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

export function ProjectPage() {
  const { projectId = "" } = useParams();
  const desktop = useDesktopProjectMap();
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<Record<string, ProjectMapGeometry>>({});
  const [undoStack, setUndoStack] = useState<ProjectGeometryCommand[]>([]);
  const [redoStack, setRedoStack] = useState<ProjectGeometryCommand[]>([]);
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
  const mapSurfaceRef = useRef<ProjectMapSurfaceHandle | null>(null);

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

  const shouldBlockNavigation = useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => (
    (saveState !== "saved"
      || pendingReference !== null
      || pendingReferenceRemoval !== null
      || markdownEditor !== null
      || pendingAttachment !== null
      || attachmentEditor !== null)
    && (
      currentLocation.pathname !== nextLocation.pathname
      || currentLocation.search !== nextLocation.search
      || currentLocation.hash !== nextLocation.hash
    )
  ), [attachmentEditor, markdownEditor, pendingAttachment, pendingReference, pendingReferenceRemoval, saveState]);
  const blocker = useBlocker(shouldBlockNavigation);

  useBeforeUnload(useCallback((event) => {
    if (saveStateRef.current === "saved"
      && pendingReferenceRef.current === null
      && pendingReferenceRemovalRef.current === null
      && markdownEditorRef.current === null
      && pendingAttachmentRef.current === null
      && attachmentEditorRef.current === null) return;
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
    clearReferenceInsertion();
    clearReferenceRemoval();
    clearOwnedContentState();
    setSnapshot(next);
    setGeometry(nextGeometry);
    setSelectedItemId(null);
    setUndoStack([]);
    setRedoStack([]);
    setSaveError("");
    setReferenceActionError("");
    updateSaveState("saved");
  }, [clearOwnedContentState, clearReferenceInsertion, clearReferenceRemoval, updateSaveState]);

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
    const controller = new AbortController();
    void loadProject(controller.signal);
    return () => controller.abort();
  }, [loadProject]);

  useEffect(() => {
    pageActiveRef.current = true;
    return () => {
      pageActiveRef.current = false;
      saveSessionGenerationRef.current += 1;
      referenceInsertionGenerationRef.current += 1;
      referenceRemovalGenerationRef.current += 1;
      ownedContentGenerationRef.current += 1;
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
        delete pendingMutationRef.current[placementId];
      }
      succeeded = true;
    } catch (caught) {
      if (!saveSessionIsActive(generation)) return;
      const message = caught instanceof Error ? caught.message : "Project placements could not be saved";
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
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current) {
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
      || attachmentEditor !== null) return;
    if (saveState === "error" || saveState === "conflict") {
      navigationSaveRequestedRef.current = false;
      return;
    }
    if (saveState !== "saved") return;
    if (navigationSaveRequestedRef.current || referenceNavigationRequestedRef.current) {
      navigationSaveRequestedRef.current = false;
      referenceNavigationRequestedRef.current = false;
      blocker.proceed();
    } else {
      blocker.reset();
    }
  }, [attachmentEditor, blocker, markdownEditor, pendingAttachment, pendingReference, pendingReferenceRemoval, saveState]);

  const commitGeometry = useCallback((command: ProjectGeometryCommand) => {
    if (pendingReferenceRemovalRef.current
      || pendingReferenceRef.current?.status === "reconciling"
      || markdownEditorRef.current
      || pendingAttachmentRef.current
      || attachmentEditorRef.current
      || projectGeometryEquals(command.before, command.after)) return;
    const next = { ...geometryRef.current, [command.placementId]: command.after };
    geometryRef.current = next;
    setGeometry(next);
    setUndoStack((current) => [...current, command].slice(-100));
    setRedoStack([]);
    if (saveStateRef.current !== "conflict") {
      setSaveError("");
      updateSaveState("unsaved");
      scheduleAutosave();
    }
  }, [scheduleAutosave, updateSaveState]);

  const undo = useCallback(() => {
    if (pendingReferenceRemovalRef.current || pendingReferenceRef.current?.status === "reconciling"
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current) return;
    const command = undoStack.at(-1);
    if (!command) return;
    const next = applyProjectGeometryCommand(geometryRef.current, command, "undo");
    geometryRef.current = next;
    setGeometry(next);
    setUndoStack((current) => current.slice(0, -1));
    setRedoStack((current) => [...current, command].slice(-100));
    if (saveStateRef.current !== "conflict") {
      setSaveError("");
      updateSaveState("unsaved");
      scheduleAutosave();
    }
  }, [scheduleAutosave, undoStack, updateSaveState]);

  const redo = useCallback(() => {
    if (pendingReferenceRemovalRef.current || pendingReferenceRef.current?.status === "reconciling"
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current) return;
    const command = redoStack.at(-1);
    if (!command) return;
    const next = applyProjectGeometryCommand(geometryRef.current, command, "redo");
    geometryRef.current = next;
    setGeometry(next);
    setRedoStack((current) => current.slice(0, -1));
    setUndoStack((current) => [...current, command].slice(-100));
    if (saveStateRef.current !== "conflict") {
      setSaveError("");
      updateSaveState("unsaved");
      scheduleAutosave();
    }
  }, [redoStack, scheduleAutosave, updateSaveState]);

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
    setSelectedItemId(result.item.id);
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
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current) return;
    const maxZ = snapshot.placements.reduce((maximum, placement) => Math.max(maximum, placement.zIndex), 0);
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

  const placeReferenceAtCenter = useCallback((result: ReferenceSearchResult) => {
    const point = mapSurfaceRef.current?.getViewportCenter();
    if (!point) {
      setReferenceActionError("The Map viewport is not ready for placement yet");
      return;
    }
    startReferencePlacement(projectReferenceDragPayloadFromResult(result), point);
  }, [startReferencePlacement]);

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
    setUndoStack((current) => current.filter((command) => !removed.has(command.placementId)));
    setRedoStack((current) => current.filter((command) => !removed.has(command.placementId)));
    setSnapshot((current) => current ? {
      ...current,
      project: result.project,
      items: current.items.filter((item) => item.id !== itemId),
      placements: current.placements.filter((placement) => placement.projectItemId !== itemId),
      edges: current.edges.filter((edge) => edge.sourceItemId !== itemId && edge.targetItemId !== itemId),
    } : current);
    setSelectedItemId((current) => current === itemId ? null : current);
    setSaveError("");
    setReferenceActionError("");
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

  const startReferenceRemoval = useCallback((itemId: string, expectedItemRevision: number) => {
    if (pendingReferenceRemovalRef.current) return;
    const input: ProjectItemLifecycleInput = {
      expectedItemRevision,
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
    setSelectedItemId(result.item.id);
  }, []);

  const startMarkdownCreate = useCallback((point: { x: number; y: number }) => {
    if (!snapshot || !desktop || saveStateRef.current === "conflict"
      || pendingReferenceRef.current || pendingReferenceRemovalRef.current
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current) return;
    const maxZ = snapshot.placements.reduce((maximum, placement) => Math.max(maximum, placement.zIndex), 0);
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
    setSelectedItemId(itemId);
  }, [desktop, snapshot, updateMarkdownEditor]);

  const startMarkdownEdit = useCallback((itemId: string) => {
    if (!snapshot || saveStateRef.current === "conflict"
      || pendingReferenceRef.current || pendingReferenceRemovalRef.current
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current) return;
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
    setSelectedItemId(itemId);
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
    if (current.isNew) setSelectedItemId(null);
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
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current) return;
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
    const maxZ = snapshot.placements.reduce((maximum, placement) => Math.max(maximum, placement.zIndex), 0);
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
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current) return;
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
    setSelectedItemId(itemId);
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
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current) return;
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

  const selectProjectItem = useCallback((itemId: string | null) => {
    const lockedItemId = markdownEditorRef.current?.itemId ?? attachmentEditorRef.current?.itemId ?? null;
    if (lockedItemId && itemId !== lockedItemId) return;
    setSelectedItemId(itemId);
  }, []);

  const descriptors = useMemo(() => snapshot ? projectMapNodes(snapshot).map((node) => ({
    ...node,
    geometry: geometry[node.placementId] ?? node.geometry,
  })) : [], [geometry, snapshot]);
  const readingNodes = useMemo(() => snapshot ? projectReadingNodes(snapshot).map((node) => ({
    ...node,
    geometry: geometry[node.placementId] ?? node.geometry,
  })) : [], [geometry, snapshot]);
  const selected = descriptors.find((node) => node.itemId === selectedItemId) ?? null;
  const selectedItem = snapshot?.items.find((item) => item.id === selectedItemId) ?? null;

  const removeSelectedReference = useCallback(() => {
    if (!snapshot || !selectedItem || selectedItem.itemType !== "reference"
      || saveStateRef.current !== "saved" || pendingReferenceRef.current || pendingReferenceRemovalRef.current
      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current) return;
    startReferenceRemoval(selectedItem.id, selectedItem.revision);
  }, [selectedItem, snapshot, startReferenceRemoval]);

  if (loading) return <div className="page project-page"><p className="muted">Loading Project…</p></div>;
  if (loadError || !snapshot) return <div className="page project-page">
    <Link className="back-link" to="/projects">← Projects</Link>
    <p className="error-banner">{loadError || "Project not found"}</p>
  </div>;

  const ownedContentBusy = Boolean(markdownEditor || pendingAttachment || attachmentEditor);
  const referencePlacementDisabled = Boolean(pendingReference || pendingReferenceRemoval || ownedContentBusy || saveState === "conflict");
  const referenceConflictReloadDisabled = saveState !== "saved" || pendingReferenceRemoval !== null || ownedContentBusy;
  const geometryInteractionDisabled = pendingReferenceRemoval !== null
    || pendingReference?.status === "reconciling"
    || ownedContentBusy;

  const navigationBlockMessage = pendingReferenceRemoval
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
              : "The open Project Markdown editor must be saved or discarded before leaving."
          : attachmentEditor
            ? attachmentEditor.status === "saving"
              ? "Finishing the attachment metadata save before leaving…"
              : attachmentEditor.status === "uncertain"
                ? "The attachment metadata save outcome is uncertain. Retry the exact save before leaving."
                : "The attachment metadata editor must be saved or discarded before leaving."
            : saveState === "conflict"
              ? "This Project has a save conflict. Resolve it or explicitly leave without the local placement changes."
              : saveState === "error"
                ? "The placement changes could not be saved. Retry before leaving, stay on the Project, or explicitly discard them."
                : "Saving placement changes before leaving this Project…";

  return <div className={`project-page${desktop ? " desktop" : " mobile"}`}>
    <header className="project-workspace-header">
      <div>
        <Link className="back-link" to="/projects">← Projects</Link>
        <p className="eyebrow">Project workspace</p>
        <h1>{snapshot.project.title}</h1>
      </div>
      {desktop && <div className="project-save-toolbar">
        <span className={`project-save-state ${saveState}`}>{saveLabel(saveState)}</span>
        <button type="button" className="button compact-button" disabled={!undoStack.length || saveState === "saving" || geometryInteractionDisabled} onClick={undo}>Undo</button>
        <button type="button" className="button compact-button" disabled={!redoStack.length || saveState === "saving" || geometryInteractionDisabled} onClick={redo}>Redo</button>
        <button
          type="button"
          className="button primary compact-button"
          disabled={saveState === "saved" || saveState === "saving" || saveState === "conflict" || geometryInteractionDisabled}
          onClick={() => {
            if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
            autosaveTimerRef.current = null;
            void flushSave();
          }}
        >Save</button>
      </div>}
    </header>

    {saveError && <div className={`project-save-banner ${saveState}`}>
      <p>{saveError}</p>
      {saveState === "conflict" && <button
        type="button"
        className="button compact-button"
        disabled={pendingReferenceRemoval !== null || ownedContentBusy}
        onClick={() => void loadProject()}
      >
        Reload authoritative Project
      </button>}
      {saveState === "error" && <button
        type="button"
        className="button compact-button"
        disabled={pendingReferenceRemoval !== null || ownedContentBusy}
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

    {blocker.state === "blocked" && <div className="project-save-banner warning" role="alertdialog" aria-label="Unsaved Project changes">
      <p>{navigationBlockMessage}</p>
      <div className="project-navigation-actions">
        <button type="button" className="button compact-button" onClick={stayOnProject}>Stay on Project</button>
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
        {!pendingReference && !pendingReferenceRemoval && !ownedContentBusy && saveState === "error" && <button type="button" className="button primary compact-button" onClick={retrySaveAndLeave}>Retry save and leave</button>}
        {!pendingReference && !pendingReferenceRemoval && !ownedContentBusy && (saveState === "error" || saveState === "conflict") && <button type="button" className="button compact-button" onClick={leaveWithoutSaving}>Leave without saving</button>}
      </div>
    </div>}

    {desktop ? <div className="project-desktop-workspace with-reference-sidebar">
      <aside className="project-reference-sidebar" aria-label="Reference search and placement">
        <div className="project-reference-sidebar-heading">
          <p className="card-label">Add Project content</p>
          <p className="card-meta">Double-click empty Map space for Markdown, or add a generic file at the visible Map center.</p>
        </div>
        <div className="project-owned-content-actions">
          <button type="button" className="button wide" disabled={ownedContentBusy || Boolean(pendingReference) || Boolean(pendingReferenceRemoval) || saveState === "conflict"} onClick={requestAttachmentAtCenter}>Add attachment</button>
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
      </aside>
      <section className="project-map-panel" aria-label="Project Map">
        <Suspense fallback={<div className="project-map-loading"><p className="muted">Loading Map editor…</p></div>}>
          <DesktopProjectMap
            ref={mapSurfaceRef}
            nodes={descriptors}
            pendingReference={pendingReference}
            pendingAttachment={pendingAttachment}
            markdownEditor={markdownEditor}
            selectedItemId={selectedItemId}
            geometryInteractionDisabled={geometryInteractionDisabled}
            onSelect={selectProjectItem}
            onGeometryCommit={commitGeometry}
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
      <aside className="project-inspector" aria-label="Project Inspector">
        <p className="card-label">Inspector</p>
        {selected ? <div className="project-inspector-content">
          <span className="meta-badge">{selected.kind}</span>
          <h2>{selected.title}</h2>
          {selected.subtitle && <p className="card-meta">{selected.subtitle}</p>}
          {selected.excerpt && <p className="project-inspector-excerpt">{selected.excerpt}</p>}
          <dl>
            <dt>Occurrence</dt><dd>{selected.itemId}</dd>
            <dt>Position</dt><dd>{Math.round(selected.geometry.x)}, {Math.round(selected.geometry.y)}</dd>
            <dt>Size</dt><dd>{Math.round(selected.geometry.width)} × {Math.round(selected.geometry.height)}</dd>
          </dl>
          {selected.openReferenceUrl && <Link className="button wide" to={selected.openReferenceUrl}>Open reference</Link>}
          {selected.fileUrl && <a className="button wide" href={selected.fileUrl}>Open attachment</a>}
          {selected.kind === "markdown" && <button
            type="button"
            className="button wide"
            disabled={ownedContentBusy || Boolean(pendingReference) || Boolean(pendingReferenceRemoval)}
            onClick={() => startMarkdownEdit(selected.itemId)}
          >Edit Markdown</button>}
          {selected.kind === "attachment" && selected.attachmentSourceUrl && <a className="button wide" href={selected.attachmentSourceUrl} target="_blank" rel="noreferrer">Open source URL</a>}
          {selected.kind === "attachment" && attachmentEditor?.itemId !== selected.itemId && <button
            type="button"
            className="button wide"
            disabled={ownedContentBusy || Boolean(pendingReference) || Boolean(pendingReferenceRemoval)}
            onClick={() => startAttachmentEdit(selected.itemId)}
          >Edit attachment metadata</button>}
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
            {attachmentEditor.message && <p className="error-banner">{attachmentEditor.message}</p>}
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
            disabled={saveState !== "saved" || Boolean(pendingReference) || Boolean(pendingReferenceRemoval) || ownedContentBusy}
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
        </div> : <p className="muted">Select a Map item to inspect its Project occurrence.</p>}
      </aside>
    </div> : <section className="project-mobile-reading" aria-label="Project occurrences">
      <div className="project-mobile-reading-heading">
        <p className="card-label">Read-only occurrence view</p>
        <p className="card-meta">Reference placement and Map editing are available on a larger screen. Items remain ordered by creation sequence.</p>
      </div>
      {readingNodes.length ? readingNodes.map((node) => <article className="card project-reading-item" key={node.itemId}>
        <header><span className="meta-badge">{node.kind}</span><small>#{node.createdSequence}</small></header>
        <h2>{node.title}</h2>
        {node.subtitle && <p className="card-meta">{node.subtitle}</p>}
        {node.kind === "attachment" && node.fileUrl && projectAttachmentIsImage(node.mimeType) && <img className="project-reading-image" src={node.fileUrl} alt={node.attachmentCaption || node.title} />}
        {node.excerpt && <p className="project-reading-excerpt">{node.excerpt}</p>}
        {node.attachmentSourceUrl && <a className="button wide" href={node.attachmentSourceUrl} target="_blank" rel="noreferrer">Open source URL</a>}
        {node.openReferenceUrl && <Link className="button wide" to={node.openReferenceUrl}>Open reference</Link>}
        {node.fileUrl && <a className="button wide" href={node.fileUrl}>Open attachment</a>}
      </article>) : <EmptyState title="This Project is empty">
        Add references or Project-owned content from the desktop Project workspace.
      </EmptyState>}
    </section>}
  </div>;
}
