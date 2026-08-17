import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type {
  ProjectEdgeRecord,
  ProjectItemMutationResponse,
  ProjectRowMutationResponse,
  ProjectSnapshot,
} from "../../shared/project-api";
import {
  buildProjectCanvasClipboard,
  createProjectCanvasPasteJournal,
  executeProjectCanvasPasteJournal,
  projectCanvasPasteDestinationItemIds,
  projectCanvasPasteHasAcknowledgedWrites,
  type ProjectCanvasClipboard,
  type ProjectCanvasPasteFailure,
  type ProjectCanvasPasteJournal,
} from "./project-canvas-copy-paste";
import { createProjectApiId, projectApi } from "./project-client";

export type ProjectCanvasPasteUiStatus =
  | "pasting"
  | "paused"
  | "reconciling"
  | "reconcile-error";

export interface ProjectCanvasPasteUiState {
  status: ProjectCanvasPasteUiStatus;
  journal: ProjectCanvasPasteJournal;
  failedStep: ProjectCanvasPasteFailure | null;
  message: string | null;
}

export type ProjectCanvasClipboardUiState =
  | {
    status: "ready";
    itemCount: number;
    edgeCount: number;
    message: string;
  }
  | {
    status: "error";
    itemCount: 0;
    edgeCount: 0;
    message: string;
  };

export interface UseProjectCanvasCopyPasteOptions {
  projectId: string;
  onItemAcknowledged: (result: ProjectItemMutationResponse) => void;
  onEdgeAcknowledged: (result: ProjectRowMutationResponse<ProjectEdgeRecord>) => void;
  onAuthoritativeSnapshot: (
    snapshot: ProjectSnapshot,
    destinationItemIds: readonly string[],
  ) => void;
}

export interface ProjectCanvasCopyPasteController {
  clipboard: ProjectCanvasClipboardUiState | null;
  paste: ProjectCanvasPasteUiState | null;
  notice: string | null;
  unsafe: boolean;
  unsafeRef: MutableRefObject<ProjectCanvasPasteUiState | null>;
  acknowledgedWrites: number;
  totalWrites: number;
  copySelection: (snapshot: ProjectSnapshot, selectedItemIds: readonly string[]) => boolean;
  pasteClipboard: (snapshot: ProjectSnapshot) => boolean;
  retryExact: () => void;
  reloadAndAbandon: () => void;
  retryAuthoritativeReload: () => void;
  clearNotice: () => void;
}

function pasteWriteCounts(journal: ProjectCanvasPasteJournal) {
  const steps = [...journal.itemSteps, ...journal.edgeSteps];
  return {
    acknowledged: steps.filter((step) => step.status === "acknowledged").length,
    total: steps.length,
  };
}

function pasteErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The Project paste could not continue";
}

export function useProjectCanvasCopyPaste({
  projectId,
  onItemAcknowledged,
  onEdgeAcknowledged,
  onAuthoritativeSnapshot,
}: UseProjectCanvasCopyPasteOptions): ProjectCanvasCopyPasteController {
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const clipboardRef = useRef<ProjectCanvasClipboard | null>(null);
  const pasteStateRef = useRef<ProjectCanvasPasteUiState | null>(null);
  const pasteOrdinalRef = useRef(0);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const [clipboard, setClipboard] = useState<ProjectCanvasClipboardUiState | null>(null);
  const [paste, setPasteState] = useState<ProjectCanvasPasteUiState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const updatePaste = useCallback((next: ProjectCanvasPasteUiState | null) => {
    pasteStateRef.current = next;
    setPasteState(next);
  }, []);

  const sessionIsActive = useCallback((
    generation: number,
    requestProjectId: string,
    journalId: string,
  ) => (
    mountedRef.current
    && generationRef.current === generation
    && projectIdRef.current === requestProjectId
    && pasteStateRef.current?.journal.journalId === journalId
  ), []);

  const installAuthoritative = useCallback(async (
    generation: number,
    requestProjectId: string,
    journal: ProjectCanvasPasteJournal,
    mode: "complete" | "abandon",
  ) => {
    if (!sessionIsActive(generation, requestProjectId, journal.journalId)) return;
    updatePaste({
      status: "reconciling",
      journal,
      failedStep: null,
      message: mode === "complete"
        ? "Confirming the completed paste against authoritative Project state…"
        : "Reloading authoritative Project state before abandoning the remaining paste steps…",
    });
    try {
      const authoritative = await projectApi.read(requestProjectId);
      if (!sessionIsActive(generation, requestProjectId, journal.journalId)) return;
      const destinationItemIds = projectCanvasPasteDestinationItemIds(journal);
      onAuthoritativeSnapshot(authoritative, destinationItemIds);
      const acknowledged = projectCanvasPasteHasAcknowledgedWrites(journal);
      updatePaste(null);
      setNotice(mode === "complete"
        ? `Pasted ${journal.itemSteps.length} Project item${journal.itemSteps.length === 1 ? "" : "s"}.`
        : acknowledged
          ? "Authoritative Project state was loaded. Already committed pasted items remain; the unacknowledged paste steps were abandoned."
          : "Authoritative Project state was loaded and the uncommitted paste was abandoned.");
    } catch (error) {
      if (!sessionIsActive(generation, requestProjectId, journal.journalId)) return;
      if (mode === "complete") {
        updatePaste({
          status: "reconcile-error",
          journal,
          failedStep: null,
          message: `The paste writes were acknowledged, but authoritative reload failed: ${pasteErrorMessage(error)}`,
        });
      } else {
        updatePaste({
          status: "paused",
          journal,
          failedStep: pasteStateRef.current?.failedStep ?? null,
          message: `Authoritative reload failed; the exact paste journal is still retained: ${pasteErrorMessage(error)}`,
        });
      }
    }
  }, [onAuthoritativeSnapshot, sessionIsActive, updatePaste]);

  const executeJournal = useCallback(async (
    generation: number,
    requestProjectId: string,
    journal: ProjectCanvasPasteJournal,
  ) => {
    if (!sessionIsActive(generation, requestProjectId, journal.journalId)) return;
    updatePaste({
      status: "pasting",
      journal,
      failedStep: null,
      message: null,
    });

    const requireActive = () => {
      if (!sessionIsActive(generation, requestProjectId, journal.journalId)) {
        throw new Error("The Project paste session is no longer active");
      }
    };

    const result = await executeProjectCanvasPasteJournal(journal, {
      createReferenceItem: async (targetProjectId, input) => {
        requireActive();
        const response = await projectApi.createReferenceItem(targetProjectId, input);
        if (sessionIsActive(generation, requestProjectId, journal.journalId)) {
          onItemAcknowledged(response);
        }
        return response;
      },
      createMarkdownItem: async (targetProjectId, input) => {
        requireActive();
        const response = await projectApi.createMarkdownItem(targetProjectId, input);
        if (sessionIsActive(generation, requestProjectId, journal.journalId)) {
          onItemAcknowledged(response);
        }
        return response;
      },
      copyAttachmentItem: async (targetProjectId, input) => {
        requireActive();
        const response = await projectApi.copyAttachmentItem(targetProjectId, input);
        if (sessionIsActive(generation, requestProjectId, journal.journalId)) {
          onItemAcknowledged(response);
        }
        return response;
      },
      createEdge: async (targetProjectId, input) => {
        requireActive();
        const response = await projectApi.createEdge(targetProjectId, input);
        if (sessionIsActive(generation, requestProjectId, journal.journalId)) {
          onEdgeAcknowledged(response);
        }
        return response;
      },
    });

    if (!sessionIsActive(generation, requestProjectId, journal.journalId)) return;
    if (result.status === "paused") {
      updatePaste({
        status: "paused",
        journal: result.journal,
        failedStep: result.failedStep,
        message: pasteErrorMessage(result.error),
      });
      return;
    }
    updatePaste({
      status: "reconciling",
      journal: result.journal,
      failedStep: null,
      message: "Confirming the completed paste against authoritative Project state…",
    });
    await installAuthoritative(generation, requestProjectId, result.journal, "complete");
  }, [installAuthoritative, onEdgeAcknowledged, onItemAcknowledged, sessionIsActive, updatePaste]);

  const copySelection = useCallback((
    snapshot: ProjectSnapshot,
    selectedItemIds: readonly string[],
  ) => {
    if (pasteStateRef.current || snapshot.project.id !== projectIdRef.current) return false;
    try {
      const next = buildProjectCanvasClipboard(snapshot, selectedItemIds);
      if (!next) return false;
      clipboardRef.current = next;
      pasteOrdinalRef.current = 0;
      setNotice(null);
      setClipboard({
        status: "ready",
        itemCount: next.items.length,
        edgeCount: next.edges.length,
        message: `Copied ${next.items.length} Project item${next.items.length === 1 ? "" : "s"}${next.edges.length ? ` and ${next.edges.length} internal edge${next.edges.length === 1 ? "" : "s"}` : ""}.`,
      });
      return true;
    } catch (error) {
      clipboardRef.current = null;
      pasteOrdinalRef.current = 0;
      setClipboard({
        status: "error",
        itemCount: 0,
        edgeCount: 0,
        message: pasteErrorMessage(error),
      });
      return false;
    }
  }, []);

  const pasteClipboard = useCallback((snapshot: ProjectSnapshot) => {
    const source = clipboardRef.current;
    if (!source || pasteStateRef.current || snapshot.project.id !== projectIdRef.current) return false;
    try {
      const pasteOrdinal = pasteOrdinalRef.current + 1;
      const journal = createProjectCanvasPasteJournal(snapshot, source, {
        pasteOrdinal,
        createIdentity: (kind) => createProjectApiId(kind),
      });
      pasteOrdinalRef.current = pasteOrdinal;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      setNotice(null);
      updatePaste({ status: "pasting", journal, failedStep: null, message: null });
      void executeJournal(generation, projectIdRef.current, journal);
      return true;
    } catch (error) {
      setNotice(pasteErrorMessage(error));
      return false;
    }
  }, [executeJournal, updatePaste]);

  const retryExact = useCallback(() => {
    const current = pasteStateRef.current;
    if (!current || current.status !== "paused") return;
    const generation = generationRef.current;
    void executeJournal(generation, projectIdRef.current, current.journal);
  }, [executeJournal]);

  const reloadAndAbandon = useCallback(() => {
    const current = pasteStateRef.current;
    if (!current || current.status !== "paused") return;
    void installAuthoritative(
      generationRef.current,
      projectIdRef.current,
      current.journal,
      "abandon",
    );
  }, [installAuthoritative]);

  const retryAuthoritativeReload = useCallback(() => {
    const current = pasteStateRef.current;
    if (!current || current.status !== "reconcile-error") return;
    void installAuthoritative(
      generationRef.current,
      projectIdRef.current,
      current.journal,
      "complete",
    );
  }, [installAuthoritative]);

  useEffect(() => {
    generationRef.current += 1;
    clipboardRef.current = null;
    pasteOrdinalRef.current = 0;
    pasteStateRef.current = null;
    setClipboard(null);
    setPasteState(null);
    setNotice(null);
  }, [projectId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      pasteStateRef.current = null;
    };
  }, []);

  const counts = useMemo(
    () => paste ? pasteWriteCounts(paste.journal) : { acknowledged: 0, total: 0 },
    [paste],
  );

  return {
    clipboard,
    paste,
    notice,
    unsafe: paste !== null,
    unsafeRef: pasteStateRef,
    acknowledgedWrites: counts.acknowledged,
    totalWrites: counts.total,
    copySelection,
    pasteClipboard,
    retryExact,
    reloadAndAbandon,
    retryAuthoritativeReload,
    clearNotice: () => setNotice(null),
  };
}
