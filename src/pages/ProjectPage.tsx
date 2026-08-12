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
  CreateReferenceProjectItemInput,
  ProjectItemMutationResponse,
  ProjectPlacementRecord,
  ProjectSnapshot,
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
import {
  defaultReferenceSearchUiState,
  type ReferenceSearchUiState,
} from "../lib/reference-search-ui";
import "../project.css";

const DesktopProjectMap = lazy(() => import("../components/project/ProjectMapSurface")
  .then((module) => ({ default: module.ProjectMapSurface })));

type SaveState = "saved" | "unsaved" | "saving" | "error" | "conflict";

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
  const [referenceActionError, setReferenceActionError] = useState("");
  const [removingReference, setRemovingReference] = useState(false);

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
  const mapSurfaceRef = useRef<ProjectMapSurfaceHandle | null>(null);

  const updatePendingReference = useCallback((next: ProjectPendingReferencePlacement | null) => {
    pendingReferenceRef.current = next;
    setPendingReferenceState(next);
  }, []);

  const saveSessionIsActive = useCallback((generation: number) => (
    pageActiveRef.current && saveSessionGenerationRef.current === generation
  ), []);

  const referenceInsertionIsActive = useCallback((generation: number) => (
    pageActiveRef.current && referenceInsertionGenerationRef.current === generation
  ), []);

  const updateSaveState = useCallback((next: SaveState) => {
    if (!pageActiveRef.current) return;
    saveStateRef.current = next;
    setSaveState(next);
  }, []);

  const shouldBlockNavigation = useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => (
    (saveState !== "saved" || pendingReference !== null)
    && (
      currentLocation.pathname !== nextLocation.pathname
      || currentLocation.search !== nextLocation.search
      || currentLocation.hash !== nextLocation.hash
    )
  ), [pendingReference, saveState]);
  const blocker = useBlocker(shouldBlockNavigation);

  useBeforeUnload(useCallback((event) => {
    if (saveStateRef.current === "saved" && pendingReferenceRef.current === null) return;
    event.preventDefault();
    event.returnValue = "";
  }, []), { capture: true });

  const clearReferenceInsertion = useCallback(() => {
    referenceInsertionGenerationRef.current += 1;
    pendingReferenceInputRef.current = null;
    pendingReferencePayloadRef.current = null;
    updatePendingReference(null);
  }, [updatePendingReference]);

  const installSnapshot = useCallback((next: ProjectSnapshot) => {
    const baseline = projectPlacementIndex(next);
    const nextGeometry = geometryIndex(next);
    baselineRef.current = baseline;
    geometryRef.current = nextGeometry;
    pendingMutationRef.current = {};
    clearReferenceInsertion();
    setSnapshot(next);
    setGeometry(nextGeometry);
    setSelectedItemId(null);
    setUndoStack([]);
    setRedoStack([]);
    setSaveError("");
    setReferenceActionError("");
    updateSaveState("saved");
  }, [clearReferenceInsertion, updateSaveState]);

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
      navigationSaveRequestedRef.current = false;
      referenceNavigationRequestedRef.current = false;
      saveAgainRef.current = false;
      savingRef.current = false;
      pendingReferenceInputRef.current = null;
      pendingReferencePayloadRef.current = null;
      pendingReferenceRef.current = null;
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
    if (pendingReferenceRef.current) referenceNavigationRequestedRef.current = true;
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
    if (blocker.state !== "blocked" || pendingReference !== null) return;
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
  }, [blocker, pendingReference, saveState]);

  const commitGeometry = useCallback((command: ProjectGeometryCommand) => {
    if (projectGeometryEquals(command.before, command.after)) return;
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
      const conflict = caught instanceof ProjectApiError && caught.status === 409;
      const message = caught instanceof Error ? caught.message : "The reference could not be placed";
      updatePendingReference({
        localId: `pending-${input.itemId}`,
        target: payload.target,
        preview: payload.preview,
        geometry: input.geometry,
        status: conflict ? "conflict" : "error",
        message,
      });
      setReferenceActionError(message);
    }
  }, [mergeReferenceInsertion, projectId, referenceInsertionIsActive, updatePendingReference]);

  const startReferencePlacement = useCallback((
    payload: ProjectReferenceDragPayload,
    point: { x: number; y: number },
  ) => {
    if (!snapshot || pendingReferenceRef.current || removingReference) return;
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
  }, [performReferenceInsertion, removingReference, snapshot]);

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
    if (!input || !payload || pendingReferenceRef.current?.status !== "error") return;
    void performReferenceInsertion(referenceInsertionGenerationRef.current, input, payload);
  }, [performReferenceInsertion]);

  const cancelReferencePlacement = useCallback((leave = false) => {
    clearReferenceInsertion();
    setReferenceActionError("");
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
  }, [blocker, clearReferenceInsertion]);

  const reloadAfterReferenceConflict = useCallback(() => {
    if (saveStateRef.current !== "saved") return;
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
    if (blocker.state !== "blocked" || pendingReferenceRef.current) return;
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

  const removeSelectedReference = useCallback(async () => {
    if (!snapshot || !selectedItem || selectedItem.itemType !== "reference"
      || saveStateRef.current !== "saved" || pendingReferenceRef.current || removingReference) return;
    setRemovingReference(true);
    setReferenceActionError("");
    try {
      const result = await projectApi.removeItem(projectId, selectedItem.id, {
        expectedItemRevision: selectedItem.revision,
        operationId: createProjectApiId("operation"),
      });
      if (!pageActiveRef.current) return;
      const removedPlacementIds = snapshot.placements
        .filter((placement) => placement.projectItemId === selectedItem.id)
        .map((placement) => placement.id);
      const removed = new Set(removedPlacementIds);
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
        items: current.items.filter((item) => item.id !== selectedItem.id),
        placements: current.placements.filter((placement) => placement.projectItemId !== selectedItem.id),
      } : current);
      setSelectedItemId(null);
    } catch (caught) {
      setReferenceActionError(caught instanceof Error ? caught.message : "The Project occurrence could not be removed");
    } finally {
      if (pageActiveRef.current) setRemovingReference(false);
    }
  }, [projectId, removingReference, selectedItem, snapshot]);

  if (loading) return <div className="page project-page"><p className="muted">Loading Project…</p></div>;
  if (loadError || !snapshot) return <div className="page project-page">
    <Link className="back-link" to="/projects">← Projects</Link>
    <p className="error-banner">{loadError || "Project not found"}</p>
  </div>;

  const referencePlacementDisabled = Boolean(pendingReference || removingReference || saveState === "conflict");
  const referenceConflictReloadDisabled = saveState !== "saved";

  return <div className={`project-page${desktop ? " desktop" : " mobile"}`}>
    <header className="project-workspace-header">
      <div>
        <Link className="back-link" to="/projects">← Projects</Link>
        <p className="eyebrow">Project workspace</p>
        <h1>{snapshot.project.title}</h1>
      </div>
      {desktop && <div className="project-save-toolbar">
        <span className={`project-save-state ${saveState}`}>{saveLabel(saveState)}</span>
        <button type="button" className="button compact-button" disabled={!undoStack.length || saveState === "saving"} onClick={undo}>Undo</button>
        <button type="button" className="button compact-button" disabled={!redoStack.length || saveState === "saving"} onClick={redo}>Redo</button>
        <button
          type="button"
          className="button primary compact-button"
          disabled={saveState === "saved" || saveState === "saving" || saveState === "conflict"}
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
      {saveState === "conflict" && <button type="button" className="button compact-button" onClick={() => void loadProject()}>
        Reload authoritative Project
      </button>}
      {saveState === "error" && <button type="button" className="button compact-button" onClick={() => void flushSave()}>
        Retry save
      </button>}
    </div>}

    {referenceActionError && !pendingReference && <div className="project-save-banner error">
      <p>{referenceActionError}</p>
    </div>}

    {blocker.state === "blocked" && <div className="project-save-banner warning" role="alertdialog" aria-label="Unsaved Project changes">
      <p>{pendingReference
        ? pendingReference.status === "placing"
          ? "Finishing the reference placement before leaving this Project…"
          : pendingReference.status === "conflict" && referenceConflictReloadDisabled
            ? "The reference placement conflicted while this Project also has placement changes to resolve. Save or resolve those geometry changes before reloading, or cancel only the reference placement."
            : "The pending reference placement must be retried, reloaded, or explicitly cancelled before leaving."
        : saveState === "conflict"
          ? "This Project has a save conflict. Resolve it or explicitly leave without the local placement changes."
          : saveState === "error"
            ? "The placement changes could not be saved. Retry before leaving, stay on the Project, or explicitly discard them."
            : "Saving placement changes before leaving this Project…"}</p>
      <div className="project-navigation-actions">
        <button type="button" className="button compact-button" onClick={stayOnProject}>Stay on Project</button>
        {pendingReference?.status === "error" && <button type="button" className="button primary compact-button" onClick={retryReferencePlacement}>Retry placement</button>}
        {pendingReference?.status === "conflict" && <button type="button" className="button primary compact-button" disabled={referenceConflictReloadDisabled} onClick={reloadAfterReferenceConflict}>Reload Project</button>}
        {(pendingReference?.status === "error" || pendingReference?.status === "conflict") && <button type="button" className="button compact-button" onClick={() => cancelReferencePlacement(true)}>Cancel placement and leave</button>}
        {!pendingReference && saveState === "error" && <button type="button" className="button primary compact-button" onClick={retrySaveAndLeave}>Retry save and leave</button>}
        {!pendingReference && (saveState === "error" || saveState === "conflict") && <button type="button" className="button compact-button" onClick={leaveWithoutSaving}>Leave without saving</button>}
      </div>
    </div>}

    {desktop ? <div className="project-desktop-workspace with-reference-sidebar">
      <aside className="project-reference-sidebar" aria-label="Reference search and placement">
        <div className="project-reference-sidebar-heading">
          <p className="card-label">Add references</p>
          <p className="card-meta">Search the research record, then drag a result onto the Map or place it at the visible Map center.</p>
        </div>
        {pendingReference && <div className={`project-reference-pending ${pendingReference.status}`}>
          <strong>{pendingReference.preview.title}</strong>
          <span>{pendingReference.status === "placing" ? "Placing reference…" : pendingReference.message}</span>
          {pendingReference.status === "error" && <div className="project-reference-pending-actions">
            <button type="button" className="button primary compact-button" onClick={retryReferencePlacement}>Retry</button>
            <button type="button" className="button compact-button" onClick={() => cancelReferencePlacement(false)}>Cancel</button>
          </div>}
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
            selectedItemId={selectedItemId}
            onSelect={setSelectedItemId}
            onGeometryCommit={commitGeometry}
            onReferenceDrop={startReferencePlacement}
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
          {selected.kind === "reference" && <button
            type="button"
            className="button wide"
            disabled={saveState !== "saved" || Boolean(pendingReference) || removingReference}
            onClick={() => void removeSelectedReference()}
          >{removingReference ? "Removing…" : "Remove from Project"}</button>}
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
        {node.excerpt && <p className="project-reading-excerpt">{node.excerpt}</p>}
        {node.openReferenceUrl && <Link className="button wide" to={node.openReferenceUrl}>Open reference</Link>}
        {node.fileUrl && <a className="button wide" href={node.fileUrl}>Open attachment</a>}
      </article>) : <EmptyState title="This Project is empty">
        Add references from the desktop Project workspace.
      </EmptyState>}
    </section>}
  </div>;
}
