import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ProjectEdgeLifecycleInput,
  ProjectEdgeRecord,
  ProjectItemLifecycleInput,
  ProjectItemMutationResponse,
  ProjectSnapshot,
} from "../../shared/project-api";
import { createProjectApiId, ProjectApiError, projectApi } from "./project-client";
import {
  projectActiveTrashSnapshot,
  projectRecoverableEdges,
  projectRememberCascadeEdges,
  projectTrashEntries,
  type ProjectRecoverableEdge,
} from "./project-item-trash";

interface ItemTask {
  kind: "remove" | "restore";
  itemId: string;
  input: ProjectItemLifecycleInput;
}
interface EdgeTask {
  kind: "edge";
  edgeId: string;
  input: ProjectEdgeLifecycleInput;
}
interface TrashJournal {
  kind: "remove" | "restore";
  ids: string[];
  tasks: Array<ItemTask | EdgeTask>;
  cursor: number;
  acknowledged: number;
  phase: "prepare" | "items" | "prepare-edges" | "edges" | "finish" | "reconcile";
  rejection: string | null;
  expectedDeletions?: Record<string, string>;
}
export interface ProjectTrashPending {
  kind: "remove" | "restore";
  status: "working" | "uncertain" | "reload";
  completed: number;
  total: number;
}
interface LastRemoval {
  itemIds: string[];
  operations: string[];
}
export interface UseProjectItemTrashOptions {
  projectId: string;
  snapshot: ProjectSnapshot | null;
  externalBusy: boolean;
  onItemRemoved: (result: ProjectItemMutationResponse) => void;
  onItemRestored: (result: ProjectItemMutationResponse) => void;
  onEdgeRestored: (edge: ProjectEdgeRecord) => void;
  onAuthoritativeSnapshot: (snapshot: ProjectSnapshot) => void;
}

function definiteRejection(error: unknown) {
  return error instanceof ProjectApiError
    && error.status >= 400 && error.status < 500
    && error.status !== 408 && error.status !== 429;
}

function recoveryStorageKey(projectId: string) {
  return `project-trash-recovery:${projectId}`;
}

function readRememberedEdges(projectId: string): ProjectRecoverableEdge[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(recoveryStorageKey(projectId)) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is ProjectRecoverableEdge => entry !== null
      && typeof entry === "object" && typeof entry.edgeId === "string"
      && typeof entry.deletionOperationId === "string");
  } catch { return []; }
}

/** Keeps acknowledged work and the exact uncertain request until it is resolved. */
export function useProjectItemTrash(options: UseProjectItemTrashOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [isOpen, setIsOpen] = useState(false);
  const [trashSnapshot, setTrashSnapshot] = useState<ProjectSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<ProjectTrashPending | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [lastRemoval, setLastRemoval] = useState<LastRemoval | null>(null);
  const [undoPriority, setUndoPriority] = useState(false);
  const lastRemovalRef = useRef<LastRemoval | null>(null);
  const journalRef = useRef<TrashJournal | null>(null);
  const runningRef = useRef(false);
  const activeRef = useRef(true);
  const generationRef = useRef(0);
  const initialRemembered = useMemo(() => readRememberedEdges(options.projectId), [options.projectId]);
  const rememberedRef = useRef<ProjectRecoverableEdge[]>(initialRemembered);
  const unsafeRef = useRef(false);

  useLayoutEffect(() => {
    activeRef.current = true;
    rememberedRef.current = initialRemembered;
    journalRef.current = null;
    runningRef.current = false;
    unsafeRef.current = false;
    lastRemovalRef.current = null;
    setIsOpen(false);
    setTrashSnapshot(null);
    setLoading(false);
    setPending(null);
    setError("");
    setMessage("");
    setLastRemoval(null);
    setUndoPriority(false);
    return () => { activeRef.current = false; generationRef.current += 1; };
  }, [initialRemembered, options.projectId]);

  const remember = useCallback((edges: ProjectRecoverableEdge[]) => {
    rememberedRef.current = edges;
    try {
      sessionStorage.setItem(recoveryStorageKey(optionsRef.current.projectId), JSON.stringify(edges));
    } catch { /* Recovery still works in this session when storage is unavailable. */ }
  }, []);

  const onRemoved = useCallback((result: ProjectItemMutationResponse, operationId?: string) => {
    const token = operationId ?? result.item.deletionOperationId;
    if (!token || !result.item.deletedAt) return;
    const current = lastRemovalRef.current;
    if (current?.operations.includes(token)) return;
    const journal = journalRef.current;
    const belongsToBatch = journal?.kind === "remove"
      && journal.tasks.some((task) => task.kind === "remove" && task.input.operationId === token);
    const append = belongsToBatch && current?.operations.some((operation) => (
      journal.tasks.some((task) => task.kind === "remove" && task.input.operationId === operation)
    ));
    const next = {
      itemIds: [...(append && current ? current.itemIds : []), result.item.id],
      operations: [...(append && current ? current.operations : []), token],
    };
    lastRemovalRef.current = next;
    setLastRemoval(next);
    setUndoPriority(true);
    setError("");
    setMessage(`${next.itemIds.length === 1 ? "Card" : `${next.itemIds.length} cards`} moved to trash.`);
    setTrashSnapshot(null);
  }, []);

  const refresh = useCallback(async () => {
    if (journalRef.current || runningRef.current) return;
    const generation = ++generationRef.current;
    setLoading(true);
    setError("");
    try {
      const fresh = await projectApi.readTrash(optionsRef.current.projectId);
      if (!activeRef.current || generation !== generationRef.current) return;
      setTrashSnapshot(fresh);
    } catch (caught) {
      if (!activeRef.current || generation !== generationRef.current) return;
      setError(caught instanceof Error ? caught.message : "Trash could not be loaded.");
    } finally {
      if (activeRef.current && generation === generationRef.current) setLoading(false);
    }
  }, []);

  const open = useCallback(() => { setIsOpen(true); void refresh(); }, [refresh]);
  const close = useCallback(() => { if (!unsafeRef.current) setIsOpen(false); }, []);

  const run = useCallback(async () => {
    const journal = journalRef.current;
    if (!journal || runningRef.current || !activeRef.current) return;
    const projectId = optionsRef.current.projectId;
    runningRef.current = true;
    generationRef.current += 1;
    setLoading(false);
    setError("");
    while (activeRef.current && journalRef.current === journal) {
      setPending({ kind: journal.kind, status: "working", completed: journal.acknowledged, total: journal.ids.length });
      let mutationInFlight = false;
      try {
        if (journal.phase === "prepare") {
          const fresh = await projectApi.readTrash(projectId);
          if (!activeRef.current || journalRef.current !== journal) break;
          const ids = new Set(journal.ids);
          const candidates = fresh.items.filter((item) => ids.has(item.id) && item.deletedAt !== null);
          const items = candidates.filter((item) => !journal.expectedDeletions
            || journal.expectedDeletions[item.id] === item.deletionOperationId);
          if (items.length < candidates.length) {
            journal.rejection = "Some cards were changed after this removal and were left unchanged.";
          }
          remember(projectRememberCascadeEdges(fresh, items, rememberedRef.current));
          journal.tasks = items.map((item): ItemTask => {
            const content = fresh.contents.find((candidate) => candidate.id === item.projectContentId);
            return { kind: "restore", itemId: item.id, input: {
              expectedItemRevision: item.revision,
              ...(content ? { expectedContentRevision: content.revision } : {}),
              operationId: createProjectApiId("operation"),
            } };
          });
          journal.phase = "items";
          continue;
        }

        if (journal.phase === "items" || journal.phase === "edges") {
          const task = journal.tasks[journal.cursor];
          if (!task) {
            journal.phase = journal.phase === "items" && journal.kind === "restore" ? "prepare-edges" : "finish";
            continue;
          }
          mutationInFlight = true;
          if (task.kind === "edge") {
            const result = await projectApi.restoreEdge(projectId, task.edgeId, task.input);
            if (!activeRef.current || journalRef.current !== journal) break;
            journal.cursor += 1;
            remember(rememberedRef.current.filter((edge) => edge.edgeId !== task.edgeId));
            optionsRef.current.onEdgeRestored(result.value);
          } else {
            const result = task.kind === "remove"
              ? await projectApi.removeItem(projectId, task.itemId, task.input)
              : await projectApi.restoreItem(projectId, task.itemId, task.input);
            if (!activeRef.current || journalRef.current !== journal) break;
            journal.cursor += 1;
            journal.acknowledged += 1;
            if (task.kind === "remove") {
              onRemoved(result, task.input.operationId);
              optionsRef.current.onItemRemoved(result);
            } else optionsRef.current.onItemRestored(result);
          }
          continue;
        }

        if (journal.phase === "prepare-edges") {
          // Re-read after every item is acknowledged; both endpoints must now be active.
          const fresh = await projectApi.readTrash(projectId);
          if (!activeRef.current || journalRef.current !== journal) break;
          journal.tasks = projectRecoverableEdges(fresh, rememberedRef.current).map((edge): EdgeTask => ({
            kind: "edge", edgeId: edge.id,
            input: { expectedRevision: edge.revision, operationId: createProjectApiId("operation") },
          }));
          journal.cursor = 0;
          journal.phase = "edges";
          continue;
        }

        const fresh = await projectApi.readTrash(projectId);
        if (!activeRef.current || journalRef.current !== journal) break;
        setTrashSnapshot(fresh);
        if (fresh.project.deletedAt !== null) {
          setError("This Project has been moved to trash. Return to Projects to continue.");
          journalRef.current = null;
          unsafeRef.current = false;
          setPending(null);
          break;
        }
        optionsRef.current.onAuthoritativeSnapshot(projectActiveTrashSnapshot(fresh));
        const currentEdges = new Map(fresh.edges.map((edge) => [edge.id, edge]));
        remember(rememberedRef.current.filter((candidate) => {
          const edge = currentEdges.get(candidate.edgeId);
          return edge?.deletedAt != null && edge.deletionOperationId === candidate.deletionOperationId;
        }));
        const currentItems = new Map(fresh.items.map((item) => [item.id, item]));
        if (lastRemovalRef.current && !lastRemovalRef.current.itemIds.some((id, index) => {
          const item = currentItems.get(id);
          return item?.deletedAt != null && item.deletionOperationId === lastRemovalRef.current!.operations[index];
        })) {
          lastRemovalRef.current = null;
          setLastRemoval(null);
          setUndoPriority(false);
        }
        if (journal.rejection) {
          setError(`${journal.rejection} The latest Project state is loaded. Completed changes are preserved; review before trying again.`);
        } else if (journal.kind === "restore") {
          setMessage("Cards restored. Their connections are restored when both cards are available.");
        }
        journalRef.current = null;
        unsafeRef.current = false;
        setPending(null);
        break;
      } catch (caught) {
        if (!activeRef.current || journalRef.current !== journal) break;
        const detail = caught instanceof Error ? caught.message : "The operation could not be completed.";
        if (mutationInFlight && definiteRejection(caught)) {
          journal.rejection = detail;
          journal.phase = "reconcile";
          continue;
        }
        setError(mutationInFlight
          ? `${detail} The result is not confirmed. Retry to safely check the same request.`
          : `${detail} Reload to finish reconciling the Project.`);
        setPending({ kind: journal.kind, status: mutationInFlight ? "uncertain" : "reload", completed: journal.acknowledged, total: journal.ids.length });
        break;
      }
    }
    if (journalRef.current === journal || journalRef.current === null) runningRef.current = false;
  }, [onRemoved, remember]);

  const removeItems = useCallback((itemIds: readonly string[]) => {
    const current = optionsRef.current;
    if (journalRef.current || current.externalBusy || !current.snapshot) return false;
    const ids = new Set(itemIds);
    const items = current.snapshot.items.filter((item) => ids.has(item.id) && item.deletedAt === null);
    if (items.length === 0) return false;
    const tasks = items.map((item): ItemTask => {
      const content = current.snapshot!.contents.find((candidate) => candidate.id === item.projectContentId);
      return { kind: "remove", itemId: item.id, input: {
        expectedItemRevision: item.revision,
        ...(content ? { expectedContentRevision: content.revision } : {}),
        operationId: createProjectApiId("operation"),
      } };
    });
    journalRef.current = { kind: "remove", ids: items.map((item) => item.id), tasks, cursor: 0, acknowledged: 0, phase: "items", rejection: null };
    unsafeRef.current = true;
    void run();
    return true;
  }, [run]);

  const restoreItems = useCallback((itemIds: readonly string[], expectedDeletions?: Record<string, string>) => {
    if (journalRef.current || optionsRef.current.externalBusy || itemIds.length === 0) return false;
    journalRef.current = { kind: "restore", ids: [...new Set(itemIds)], tasks: [], cursor: 0, acknowledged: 0, phase: "prepare", rejection: null, expectedDeletions };
    unsafeRef.current = true;
    void run();
    return true;
  }, [run]);

  const undoRemoval = useCallback(() => (
    lastRemovalRef.current ? restoreItems(lastRemovalRef.current.itemIds, Object.fromEntries(
      lastRemovalRef.current.itemIds.map((id, index) => [id, lastRemovalRef.current!.operations[index]!]),
    )) : false
  ), [restoreItems]);

  const restoreConnections = useCallback(() => {
    if (journalRef.current || optionsRef.current.externalBusy) return false;
    journalRef.current = {
      kind: "restore", ids: [], tasks: [], cursor: 0, acknowledged: 0,
      phase: "prepare-edges", rejection: null,
    };
    unsafeRef.current = true;
    void run();
    return true;
  }, [run]);

  const entries = useMemo(() => projectTrashEntries(trashSnapshot), [trashSnapshot]);
  const recoverableConnectionCount = trashSnapshot
    ? projectRecoverableEdges(trashSnapshot, rememberedRef.current).length : 0;
  return {
    isOpen, open, close, refresh, entries, loading, pending, error, message,
    removeItems, restoreItems, onRemoved, undoRemoval, retry: run, unsafeRef,
    restoreConnections, recoverableConnectionCount,
    canUndo: lastRemoval !== null && pending === null,
    undoPriority,
    invalidateUndoPriority: useCallback(() => setUndoPriority(false), []),
    dismissMessage: useCallback(() => setMessage(""), []),
  };
}

export type ProjectItemTrashController = ReturnType<typeof useProjectItemTrash>;
