import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  CreateProjectEdgeInput,
  ProjectEdgeLifecycleInput,
  ProjectEdgeRecord,
  ProjectSnapshot,
  UpdateProjectEdgeInput,
} from "../../shared/project-api";
import type { ProjectEdgeHandle } from "../../shared/project-types";
import { ProjectApiError, createProjectApiId, projectApi } from "./project-client";
import type { ProjectEdgeHistoryCommand } from "./project-edge-history";
import {
  projectEdgeDirection,
  projectEdgeMarkers,
  projectEdgeMetadata,
  projectEdgeMetadataEquals,
  projectEdgeWouldDuplicate,
  projectItemRevisionIndex,
  type ProjectEdgeDirection,
  type ProjectEdgeMetadataShape,
  type ProjectEdgeMutationStatus,
  type ProjectPendingEdgePreview,
} from "./project-edges";

type EdgeEditorStatus = "editing" | "saving" | "uncertain" | "error" | "conflict";

export interface ProjectEdgeEditorState {
  edgeId: string;
  direction: ProjectEdgeDirection;
  label: string;
  status: EdgeEditorStatus;
  message: string | null;
}

type PendingCreate = {
  kind: "create";
  input: CreateProjectEdgeInput;
  status: ProjectEdgeMutationStatus;
  message: string | null;
  recordHistory: boolean;
};

type PendingUpdate = {
  kind: "update";
  edgeId: string;
  input: UpdateProjectEdgeInput;
  before: ProjectEdgeMetadataShape;
  after: ProjectEdgeMetadataShape;
  sourceItemId: string;
  targetItemId: string;
  status: ProjectEdgeMutationStatus;
  message: string | null;
  recordHistory: boolean;
};

type PendingLifecycle = {
  kind: "delete" | "restore";
  edgeId: string;
  input: ProjectEdgeLifecycleInput;
  sourceItemId: string;
  targetItemId: string;
  status: ProjectEdgeMutationStatus;
  message: string | null;
  recordHistory: boolean;
};

export type ProjectPendingEdgeMutation = PendingCreate | PendingUpdate | PendingLifecycle;

type UseProjectEdgeControllerOptions = {
  projectId: string;
  snapshot: ProjectSnapshot | null;
  setSnapshot: Dispatch<SetStateAction<ProjectSnapshot | null>>;
  externalBusy: boolean;
  onHistory: (command: ProjectEdgeHistoryCommand) => void;
};

function edgeFailureStatus(caught: unknown): Exclude<ProjectEdgeMutationStatus, "saving"> {
  if (caught instanceof ProjectApiError) {
    if (caught.status === 409) return "conflict";
    if (caught.status >= 400 && caught.status < 500 && caught.status !== 408 && caught.status !== 429) {
      return "error";
    }
  }
  return "uncertain";
}

function mergeActiveEdge(
  setSnapshot: Dispatch<SetStateAction<ProjectSnapshot | null>>,
  edge: ProjectEdgeRecord,
) {
  setSnapshot((current) => current ? {
    ...current,
    edges: [...current.edges.filter((candidate) => candidate.id !== edge.id), edge],
  } : current);
}

function removeActiveEdge(
  setSnapshot: Dispatch<SetStateAction<ProjectSnapshot | null>>,
  edgeId: string,
) {
  setSnapshot((current) => current ? {
    ...current,
    edges: current.edges.filter((candidate) => candidate.id !== edgeId),
  } : current);
}

export function useProjectEdgeController({
  projectId,
  snapshot,
  setSnapshot,
  externalBusy,
  onHistory,
}: UseProjectEdgeControllerOptions) {
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [editor, setEditorState] = useState<ProjectEdgeEditorState | null>(null);
  const [pending, setPendingState] = useState<ProjectPendingEdgeMutation | null>(null);
  const [actionError, setActionError] = useState("");
  const snapshotRef = useRef(snapshot);
  const editorRef = useRef<ProjectEdgeEditorState | null>(null);
  const pendingRef = useRef<ProjectPendingEdgeMutation | null>(null);
  const deletedEdgesRef = useRef<Record<string, ProjectEdgeRecord>>({});
  const transitionRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(true);
  const externalBusyRef = useRef(externalBusy);
  const unsafeRef = useRef(false);

  snapshotRef.current = snapshot;
  externalBusyRef.current = externalBusy;
  unsafeRef.current = editor !== null || pending !== null;

  useEffect(() => () => {
    activeRef.current = false;
    transitionRef.current = null;
  }, []);

  useEffect(() => {
    if (!selectedEdgeId || snapshot?.edges.some((edge) => edge.id === selectedEdgeId)) return;
    setSelectedEdgeId(null);
    editorRef.current = null;
    setEditorState(null);
  }, [selectedEdgeId, snapshot]);

  const updateEditor = useCallback((next: ProjectEdgeEditorState | null) => {
    editorRef.current = next;
    setEditorState(next);
  }, []);

  const updatePending = useCallback((next: ProjectPendingEdgeMutation | null) => {
    pendingRef.current = next;
    setPendingState(next);
  }, []);

  const finishTransition = useCallback(() => {
    const continuation = transitionRef.current;
    transitionRef.current = null;
    continuation?.();
  }, []);

  const runMutation = useCallback(async (mutation: ProjectPendingEdgeMutation) => {
    if (!projectId || !activeRef.current) return;
    const saving = { ...mutation, status: "saving" as const, message: null } as ProjectPendingEdgeMutation;
    updatePending(saving);
    setActionError("");
    if (saving.kind === "update" && editorRef.current?.edgeId === saving.edgeId) {
      updateEditor({ ...editorRef.current, status: "saving", message: null });
    }

    try {
      if (saving.kind === "create") {
        const result = await projectApi.createEdge(projectId, saving.input);
        if (!activeRef.current) return;
        mergeActiveEdge(setSnapshot, result.value);
        setSelectedEdgeId(result.value.id);
        if (saving.recordHistory) onHistory({
          kind: "edge-create",
          edgeId: result.value.id,
          sourceItemId: result.value.sourceItemId,
          targetItemId: result.value.targetItemId,
        });
      } else if (saving.kind === "update") {
        const result = await projectApi.updateEdge(projectId, saving.edgeId, saving.input);
        if (!activeRef.current) return;
        mergeActiveEdge(setSnapshot, result.value);
        if (saving.recordHistory) onHistory({
          kind: "edge-update",
          edgeId: result.value.id,
          sourceItemId: result.value.sourceItemId,
          targetItemId: result.value.targetItemId,
          before: saving.before,
          after: saving.after,
        });
        if (editorRef.current?.edgeId === saving.edgeId) updateEditor(null);
      } else if (saving.kind === "delete") {
        const result = await projectApi.deleteEdge(projectId, saving.edgeId, saving.input);
        if (!activeRef.current) return;
        deletedEdgesRef.current[saving.edgeId] = result.value;
        removeActiveEdge(setSnapshot, saving.edgeId);
        setSelectedEdgeId((current) => current === saving.edgeId ? null : current);
        if (saving.recordHistory) onHistory({
          kind: "edge-delete",
          edgeId: saving.edgeId,
          sourceItemId: saving.sourceItemId,
          targetItemId: saving.targetItemId,
        });
      } else {
        const result = await projectApi.restoreEdge(projectId, saving.edgeId, saving.input);
        if (!activeRef.current) return;
        delete deletedEdgesRef.current[saving.edgeId];
        mergeActiveEdge(setSnapshot, result.value);
        setSelectedEdgeId(result.value.id);
      }
      updatePending(null);
      finishTransition();
    } catch (caught) {
      if (!activeRef.current) return;
      const status = edgeFailureStatus(caught);
      const message = caught instanceof Error ? caught.message : "The Project edge operation failed";
      const failed = { ...saving, status, message } as ProjectPendingEdgeMutation;
      updatePending(failed);
      setActionError(message);
      if (failed.kind === "update" && editorRef.current?.edgeId === failed.edgeId) {
        updateEditor({ ...editorRef.current, status, message });
      }
      if (status !== "uncertain") transitionRef.current = null;
    }
  }, [finishTransition, onHistory, projectId, setSnapshot, updateEditor, updatePending]);

  const connect = useCallback((connection: {
    sourceItemId: string;
    targetItemId: string;
    sourceHandle: ProjectEdgeHandle;
    targetHandle: ProjectEdgeHandle;
  }) => {
    const current = snapshotRef.current;
    if (!current || externalBusyRef.current || pendingRef.current || editorRef.current) return;
    if (connection.sourceItemId === connection.targetItemId) {
      setActionError("Project edges cannot connect an item occurrence to itself");
      return;
    }
    const candidate = {
      ...connection,
      markerStart: "none" as const,
      markerEnd: "none" as const,
    };
    if (projectEdgeWouldDuplicate(current.edges, candidate)) {
      setActionError("This exact Project edge already exists");
      return;
    }
    const revisions = projectItemRevisionIndex(current);
    const sourceRevision = revisions[connection.sourceItemId];
    const targetRevision = revisions[connection.targetItemId];
    if (!Number.isInteger(sourceRevision) || !Number.isInteger(targetRevision)) {
      setActionError("The Project edge endpoints are no longer available");
      return;
    }
    const input: CreateProjectEdgeInput = {
      edgeId: createProjectApiId("edge"),
      ...connection,
      markerStart: "none",
      markerEnd: "none",
      label: null,
      expectedSourceItemRevision: sourceRevision,
      expectedTargetItemRevision: targetRevision,
      operationId: createProjectApiId("operation"),
    };
    void runMutation({ kind: "create", input, status: "saving", message: null, recordHistory: true });
  }, [runMutation]);

  const selectEdge = useCallback((edgeId: string | null) => {
    if (pendingRef.current || editorRef.current) return;
    setSelectedEdgeId(edgeId);
    setActionError("");
  }, []);

  const startEdit = useCallback(() => {
    const current = snapshotRef.current;
    if (!current || pendingRef.current || editorRef.current || externalBusyRef.current || !selectedEdgeId) return;
    const edge = current.edges.find((candidate) => candidate.id === selectedEdgeId);
    if (!edge) return;
    updateEditor({
      edgeId: edge.id,
      direction: projectEdgeDirection(edge.markerStart, edge.markerEnd),
      label: edge.label ?? "",
      status: "editing",
      message: null,
    });
  }, [selectedEdgeId, updateEditor]);

  const changeEdit = useCallback((field: "direction" | "label", value: string) => {
    const current = editorRef.current;
    if (!current || current.status === "saving" || current.status === "uncertain" || current.status === "conflict") return;
    updateEditor({
      ...current,
      [field]: value,
      status: "editing",
      message: null,
    } as ProjectEdgeEditorState);
  }, [updateEditor]);

  const cancelEdit = useCallback(() => {
    const current = editorRef.current;
    if (!current || current.status === "saving" || current.status === "uncertain" || current.status === "conflict") return;
    const pendingUpdate = pendingRef.current;
    if (pendingUpdate?.kind === "update" && pendingUpdate.edgeId === current.edgeId && pendingUpdate.status === "error") {
      updatePending(null);
    }
    updateEditor(null);
    setActionError("");
  }, [updateEditor, updatePending]);

  const saveEdit = useCallback(() => {
    const currentSnapshot = snapshotRef.current;
    const currentEditor = editorRef.current;
    if (!currentSnapshot || !currentEditor || currentEditor.status !== "editing" || pendingRef.current) return;
    const edge = currentSnapshot.edges.find((candidate) => candidate.id === currentEditor.edgeId);
    if (!edge) return;
    const label = currentEditor.label.trim() === "" ? null : currentEditor.label;
    if (label !== null && Array.from(label).length > 200) {
      const message = "Project edge labels must be at most 200 Unicode code points";
      updateEditor({ ...currentEditor, status: "error", message });
      setActionError(message);
      return;
    }
    const markers = projectEdgeMarkers(currentEditor.direction);
    const after = { ...markers, label };
    const before = projectEdgeMetadata(edge);
    if (projectEdgeMetadataEquals(before, after)) {
      updateEditor(null);
      return;
    }
    if (projectEdgeWouldDuplicate(currentSnapshot.edges, {
      sourceItemId: edge.sourceItemId,
      targetItemId: edge.targetItemId,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      markerStart: after.markerStart,
      markerEnd: after.markerEnd,
    }, edge.id)) {
      const message = "The edited direction would duplicate an existing Project edge";
      updateEditor({ ...currentEditor, status: "error", message });
      setActionError(message);
      return;
    }
    const input: UpdateProjectEdgeInput = {
      ...after,
      expectedRevision: edge.revision,
      operationId: createProjectApiId("operation"),
    };
    void runMutation({
      kind: "update",
      edgeId: edge.id,
      input,
      before,
      after,
      sourceItemId: edge.sourceItemId,
      targetItemId: edge.targetItemId,
      status: "saving",
      message: null,
      recordHistory: true,
    });
  }, [runMutation, updateEditor]);

  const deleteSelected = useCallback(() => {
    const current = snapshotRef.current;
    if (!current || externalBusyRef.current || pendingRef.current || editorRef.current || !selectedEdgeId) return;
    const edge = current.edges.find((candidate) => candidate.id === selectedEdgeId);
    if (!edge) return;
    const input: ProjectEdgeLifecycleInput = {
      expectedRevision: edge.revision,
      operationId: createProjectApiId("operation"),
    };
    void runMutation({
      kind: "delete",
      edgeId: edge.id,
      input,
      sourceItemId: edge.sourceItemId,
      targetItemId: edge.targetItemId,
      status: "saving",
      message: null,
      recordHistory: true,
    });
  }, [runMutation, selectedEdgeId]);

  const retryExact = useCallback(() => {
    const current = pendingRef.current;
    if (!current || current.status !== "uncertain") return;
    void runMutation(current);
  }, [runMutation]);

  const dismissDeterministic = useCallback(() => {
    const current = pendingRef.current;
    if (!current || current.status !== "error") return;
    updatePending(null);
    setActionError("");
  }, [updatePending]);

  const resetForAuthoritativeReload = useCallback(() => {
    transitionRef.current = null;
    deletedEdgesRef.current = {};
    updatePending(null);
    updateEditor(null);
    setSelectedEdgeId(null);
    setActionError("");
  }, [updateEditor, updatePending]);

  const applyHistory = useCallback((
    command: ProjectEdgeHistoryCommand,
    direction: "undo" | "redo",
    onSuccess: () => void,
  ) => {
    const current = snapshotRef.current;
    if (!current || externalBusyRef.current || pendingRef.current || editorRef.current) return false;
    let mutation: ProjectPendingEdgeMutation | null = null;
    if (command.kind === "edge-update") {
      const edge = current.edges.find((candidate) => candidate.id === command.edgeId);
      if (!edge) return false;
      const target = direction === "undo" ? command.before : command.after;
      mutation = {
        kind: "update",
        edgeId: edge.id,
        input: {
          ...target,
          expectedRevision: edge.revision,
          operationId: createProjectApiId("operation"),
        },
        before: projectEdgeMetadata(edge),
        after: target,
        sourceItemId: edge.sourceItemId,
        targetItemId: edge.targetItemId,
        status: "saving",
        message: null,
        recordHistory: false,
      };
    } else {
      const shouldDelete = (command.kind === "edge-create" && direction === "undo")
        || (command.kind === "edge-delete" && direction === "redo");
      if (shouldDelete) {
        const edge = current.edges.find((candidate) => candidate.id === command.edgeId);
        if (!edge) return false;
        mutation = {
          kind: "delete",
          edgeId: edge.id,
          input: { expectedRevision: edge.revision, operationId: createProjectApiId("operation") },
          sourceItemId: command.sourceItemId,
          targetItemId: command.targetItemId,
          status: "saving",
          message: null,
          recordHistory: false,
        };
      } else {
        const edge = deletedEdgesRef.current[command.edgeId];
        if (!edge) return false;
        mutation = {
          kind: "restore",
          edgeId: edge.id,
          input: { expectedRevision: edge.revision, operationId: createProjectApiId("operation") },
          sourceItemId: command.sourceItemId,
          targetItemId: command.targetItemId,
          status: "saving",
          message: null,
          recordHistory: false,
        };
      }
    }
    transitionRef.current = onSuccess;
    void runMutation(mutation);
    return true;
  }, [runMutation]);

  const selectedEdge = useMemo(
    () => snapshot?.edges.find((edge) => edge.id === selectedEdgeId) ?? null,
    [selectedEdgeId, snapshot],
  );

  const pendingEdge = useMemo<ProjectPendingEdgePreview | null>(() => {
    if (pending?.kind !== "create" || (pending.status !== "saving" && pending.status !== "uncertain")) return null;
    return {
      edgeId: pending.input.edgeId,
      sourceItemId: pending.input.sourceItemId,
      targetItemId: pending.input.targetItemId,
      sourceHandle: pending.input.sourceHandle,
      targetHandle: pending.input.targetHandle,
      markerStart: pending.input.markerStart,
      markerEnd: pending.input.markerEnd,
      label: pending.input.label,
      status: pending.status,
    };
  }, [pending]);

  return {
    selectedEdgeId,
    selectedEdge,
    editor,
    pending,
    pendingEdge,
    actionError,
    unsafeRef,
    unsafe: editor !== null || pending !== null,
    interactionDisabled: externalBusy || editor !== null || pending !== null,
    connect,
    selectEdge,
    startEdit,
    changeEdit,
    cancelEdit,
    saveEdit,
    deleteSelected,
    retryExact,
    dismissDeterministic,
    resetForAuthoritativeReload,
    applyHistory,
  };
}
