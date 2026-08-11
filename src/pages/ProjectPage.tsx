import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useParams } from "react-router-dom";
import type {
  ProjectMapGeometry,
} from "../../shared/project-types";
import type {
  ProjectPlacementRecord,
  ProjectSnapshot,
  UpdateProjectPlacementInput,
} from "../../shared/project-api";
import { EmptyState } from "../components/EmptyState";
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
  const baselineRef = useRef<Record<string, ProjectPlacementRecord>>({});
  const geometryRef = useRef<Record<string, ProjectMapGeometry>>({});
  const pendingMutationRef = useRef<Record<string, UpdateProjectPlacementInput>>({});
  const saveStateRef = useRef<SaveState>("saved");
  const autosaveTimerRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const saveAgainRef = useRef(false);
  const flushSaveRef = useRef<() => Promise<void>>(async () => undefined);

  const updateSaveState = useCallback((next: SaveState) => {
    saveStateRef.current = next;
    setSaveState(next);
  }, []);

  const installSnapshot = useCallback((next: ProjectSnapshot) => {
    const baseline = projectPlacementIndex(next);
    const nextGeometry = geometryIndex(next);
    baselineRef.current = baseline;
    geometryRef.current = nextGeometry;
    pendingMutationRef.current = {};
    setSnapshot(next);
    setGeometry(nextGeometry);
    setSelectedItemId(null);
    setUndoStack([]);
    setRedoStack([]);
    setSaveError("");
    updateSaveState("saved");
  }, [updateSaveState]);

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

  useEffect(() => () => {
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
  }, []);

  const scheduleAutosave = useCallback(() => {
    if (saveStateRef.current === "conflict") return;
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void flushSaveRef.current();
    }, 1_600);
  }, []);

  const flushSave = useCallback(async () => {
    if (!projectId || saveStateRef.current === "conflict") return;
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
        baselineRef.current = { ...baselineRef.current, [placementId]: result.value };
        delete pendingMutationRef.current[placementId];
      }
      succeeded = true;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Project placements could not be saved";
      setSaveError(message);
      updateSaveState(caught instanceof ProjectApiError && caught.status === 409 ? "conflict" : "error");
    } finally {
      savingRef.current = false;
    }

    if (!succeeded) return;
    const remainsDirty = Object.keys(pendingMutationRef.current).length > 0
      || projectDirtyPlacements(baselineRef.current, geometryRef.current).length > 0;
    if (remainsDirty) {
      updateSaveState("unsaved");
      if (saveAgainRef.current) void flushSaveRef.current();
      else scheduleAutosave();
    } else {
      updateSaveState("saved");
    }
  }, [projectId, scheduleAutosave, updateSaveState]);

  useEffect(() => {
    flushSaveRef.current = flushSave;
  }, [flushSave]);

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

  const descriptors = useMemo(() => snapshot ? projectMapNodes(snapshot).map((node) => ({
    ...node,
    geometry: geometry[node.placementId] ?? node.geometry,
  })) : [], [geometry, snapshot]);
  const readingNodes = useMemo(() => snapshot ? projectReadingNodes(snapshot).map((node) => ({
    ...node,
    geometry: geometry[node.placementId] ?? node.geometry,
  })) : [], [geometry, snapshot]);
  const selected = descriptors.find((node) => node.itemId === selectedItemId) ?? null;

  if (loading) return <div className="page project-page"><p className="muted">Loading Project…</p></div>;
  if (loadError || !snapshot) return <div className="page project-page">
    <Link className="back-link" to="/projects">← Projects</Link>
    <p className="error-banner">{loadError || "Project not found"}</p>
  </div>;

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

    {desktop ? <div className="project-desktop-workspace">
      <section className="project-map-panel" aria-label="Project Map">
        <Suspense fallback={<div className="project-map-loading"><p className="muted">Loading Map editor…</p></div>}>
          <DesktopProjectMap
            nodes={descriptors}
            selectedItemId={selectedItemId}
            onSelect={setSelectedItemId}
            onGeometryCommit={commitGeometry}
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
        </div> : <p className="muted">Select a Map item to inspect its Project occurrence.</p>}
      </aside>
    </div> : <section className="project-mobile-reading" aria-label="Project occurrences">
      <div className="project-mobile-reading-heading">
        <p className="card-label">Read-only occurrence view</p>
        <p className="card-meta">Map editing is available on a larger screen. Items remain ordered by creation sequence.</p>
      </div>
      {readingNodes.length ? readingNodes.map((node) => <article className="card project-reading-item" key={node.itemId}>
        <header><span className="meta-badge">{node.kind}</span><small>#{node.createdSequence}</small></header>
        <h2>{node.title}</h2>
        {node.subtitle && <p className="card-meta">{node.subtitle}</p>}
        {node.excerpt && <p className="project-reading-excerpt">{node.excerpt}</p>}
        {node.openReferenceUrl && <Link className="button wide" to={node.openReferenceUrl}>Open reference</Link>}
        {node.fileUrl && <a className="button wide" href={node.fileUrl}>Open attachment</a>}
      </article>) : <EmptyState title="This Project is empty">
        Add Project items from the desktop Map in a later creation phase.
      </EmptyState>}
    </section>}
  </div>;
}
