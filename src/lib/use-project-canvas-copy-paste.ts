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
  type ProjectCanvasClipboard,
  type ProjectCanvasPasteClients,
  type ProjectCanvasPasteFailure,
  type ProjectCanvasPasteJournal,
} from "./project-canvas-copy-paste";
import {
  ProjectApiError,
  createProjectApiId,
  projectApi,
} from "./project-client";

export type ProjectCanvasPasteUiStatus =
  | "pasting"
  | "paused"
  | "reconciling"
  | "reconcile-error";

export type ProjectCanvasPasteFailureCertainty = "deterministic" | "uncertain";

export interface ProjectCanvasPasteUiState {
  status: ProjectCanvasPasteUiStatus;
  journal: ProjectCanvasPasteJournal;
  failedStep: ProjectCanvasPasteFailure | null;
  failureCertainty: ProjectCanvasPasteFailureCertainty | null;
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
  ) => number;
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

export function projectCanvasPasteFailureCertainty(
  error: unknown,
): ProjectCanvasPasteFailureCertainty {
  if (!(error instanceof ProjectApiError)) return "uncertain";
  return error.status === 408
    || error.status === 425
    || error.status === 429
    || error.status >= 500
    ? "uncertain"
    : "deterministic";
}

function acknowledgeFailedStep(
  journal: ProjectCanvasPasteJournal,
  failure: ProjectCanvasPasteFailure,
) {
  if (failure.kind === "item") {
    const index = journal.itemSteps.findIndex((step) => (
      step.destinationItemId === failure.destinationId
      && step.sourceItemId === failure.sourceId
    ));
    if (index < 0 || journal.itemSteps[index].status !== "pending") {
      throw new Error("The failed Project paste item is no longer the pending journal step");
    }
    return {
      ...journal,
      itemSteps: journal.itemSteps.map((step, candidateIndex) => (
        candidateIndex === index ? { ...step, status: "acknowledged" as const } : step
      )),
    };
  }

  const index = journal.edgeSteps.findIndex((step) => (
    step.destinationEdgeId === failure.destinationId
    && step.sourceEdgeId === failure.sourceId
  ));
  if (index < 0 || journal.edgeSteps[index].status !== "pending") {
    throw new Error("The failed Project paste edge is no longer the pending journal step");
  }
  return {
    ...journal,
    edgeSteps: journal.edgeSteps.map((step, candidateIndex) => (
      candidateIndex === index ? { ...step, status: "acknowledged" as const } : step
    )),
  };
}

async function replayFailedStep(
  journal: ProjectCanvasPasteJournal,
  failure: ProjectCanvasPasteFailure,
  clients: ProjectCanvasPasteClients,
) {
  if (failure.kind === "item") {
    const step = journal.itemSteps.find((candidate) => (
      candidate.destinationItemId === failure.destinationId
      && candidate.sourceItemId === failure.sourceId
      && candidate.status === "pending"
    ));
    if (!step) throw new Error("The failed Project paste item is unavailable for exact replay");
    if (step.kind === "reference") {
      await clients.createReferenceItem(journal.projectId, step.input);
    } else if (step.kind === "markdown") {
      await clients.createMarkdownItem(journal.projectId, step.input);
    } else {
      await clients.copyAttachmentItem(journal.projectId, step.input);
    }
  } else {
    const step = journal.edgeSteps.find((candidate) => (
      candidate.destinationEdgeId === failure.destinationId
      && candidate.sourceEdgeId === failure.sourceId
      && candidate.status === "pending"
    ));
    if (!step) throw new Error("The failed Project paste edge is unavailable for exact replay");
    await clients.createEdge(journal.projectId, step.input);
  }
  return acknowledgeFailedStep(journal, failure);
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

  const createSessionClients = useCallback((
    generation: number,
    requestProjectId: string,
    journal: ProjectCanvasPasteJournal,
  ): ProjectCanvasPasteClients => {
    const requireActive = () => {
      if (!sessionIsActive(generation, requestProjectId, journal.journalId)) {
        throw new Error("The Project paste session is no longer active");
      }
    };
    return {
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
    };
  }, [onEdgeAcknowledged, onItemAcknowledged, sessionIsActive]);

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
      failureCertainty: null,
      message: mode === "complete"
        ? "Confirming the completed paste against authoritative Project state…"
        : "Loading authoritative Project state after settling the last attempted paste write…",
    });
    try {
      const authoritative = await projectApi.read(requestProjectId);
      if (!sessionIsActive(generation, requestProjectId, journal.journalId)) return;
      const destinationItemIds = projectCanvasPasteDestinationItemIds(journal);
      const retainedItemCount = onAuthoritativeSnapshot(authoritative, destinationItemIds);
      updatePaste(null);
      setNotice(mode === "complete"
        ? `Pasted ${journal.itemSteps.length} Project item${journal.itemSteps.length === 1 ? "" : "s"}.`
        : retainedItemCount > 0
          ? `Authoritative Project state was loaded. ${retainedItemCount} pasted item${retainedItemCount === 1 ? "" : "s"} already committed to the Project ${retainedItemCount === 1 ? "remains" : "remain"}; the later unattempted paste steps were abandoned.`
          : "Authoritative Project state was loaded and the uncommitted paste was abandoned.");
    } catch (error) {
      if (!sessionIsActive(generation, requestProjectId, journal.journalId)) return;
      if (mode === "complete") {
        updatePaste({
          status: "reconcile-error",
          journal,
          failedStep: null,
          failureCertainty: null,
          message: `The paste writes were acknowledged, but authoritative reload failed: ${pasteErrorMessage(error)}`,
        });
      } else {
        updatePaste({
          status: "paused",
          journal,
          failedStep: null,
          failureCertainty: "deterministic",
          message: `The last attempted write is settled and later paste steps remain abandoned, but authoritative reload failed. Retry the reload before leaving: ${pasteErrorMessage(error)}`,
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
      failureCertainty: null,
      message: null,
    });

    const result = await executeProjectCanvasPasteJournal(
      journal,
      createSessionClients(generation, requestProjectId, journal),
    );

    if (!sessionIsActive(generation, requestProjectId, journal.journalId)) return;
    if (result.status === "paused") {
      const certainty = projectCanvasPasteFailureCertainty(result.error);
      updatePaste({
        status: "paused",
        journal: result.journal,
        failedStep: result.failedStep,
        failureCertainty: certainty,
        message: certainty === "uncertain"
          ? `The last write outcome is uncertain and must be replayed exactly before it can be abandoned: ${pasteErrorMessage(result.error)}`
          : `The last write was rejected without committing: ${pasteErrorMessage(result.error)}`,
      });
      return;
    }
    updatePaste({
      status: "reconciling",
      journal: result.journal,
      failedStep: null,
      failureCertainty: null,
      message: "Confirming the completed paste against authoritative Project state…",
    });
    await installAuthoritative(generation, requestProjectId, result.journal, "complete");
  }, [createSessionClients, installAuthoritative, sessionIsActive, updatePaste]);

  const settleUncertainAndAbandon = useCallback(async (
    generation: number,
    requestProjectId: string,
    current: ProjectCanvasPasteUiState,
  ) => {
    const failure = current.failedStep;
    if (!failure || current.failureCertainty !== "uncertain"
      || !sessionIsActive(generation, requestProjectId, current.journal.journalId)) return;
    updatePaste({
      status: "reconciling",
      journal: current.journal,
      failedStep: failure,
      failureCertainty: "uncertain",
      message: "Settling the uncertain failed write by replaying its exact frozen identity, payload, revision, and operation before abandoning later steps…",
    });
    try {
      const settledJournal = await replayFailedStep(
        current.journal,
        failure,
        createSessionClients(generation, requestProjectId, current.journal),
      );
      if (!sessionIsActive(generation, requestProjectId, current.journal.journalId)) return;
      await installAuthoritative(generation, requestProjectId, settledJournal, "abandon");
    } catch (error) {
      if (!sessionIsActive(generation, requestProjectId, current.journal.journalId)) return;
      const certainty = projectCanvasPasteFailureCertainty(error);
      if (certainty === "deterministic") {
        await installAuthoritative(generation, requestProjectId, current.journal, "abandon");
        return;
      }
      updatePaste({
        status: "paused",
        journal: current.journal,
        failedStep: failure,
        failureCertainty: "uncertain",
        message: `The exact replay is still outcome-uncertain. The journal and navigation protection remain active; retry before abandoning: ${pasteErrorMessage(error)}`,
      });
    }
  }, [createSessionClients, installAuthoritative, sessionIsActive, updatePaste]);

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
      updatePaste({
        status: "pasting",
        journal,
        failedStep: null,
        failureCertainty: null,
        message: null,
      });
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
    if (!current.failedStep) {
      void installAuthoritative(
        generationRef.current,
        projectIdRef.current,
        current.journal,
        "abandon",
      );
      return;
    }
    void executeJournal(generationRef.current, projectIdRef.current, current.journal);
  }, [executeJournal, installAuthoritative]);

  const reloadAndAbandon = useCallback(() => {
    const current = pasteStateRef.current;
    if (!current || current.status !== "paused") return;
    if (current.failureCertainty === "uncertain" && current.failedStep) {
      void settleUncertainAndAbandon(
        generationRef.current,
        projectIdRef.current,
        current,
      );
      return;
    }
    void installAuthoritative(
      generationRef.current,
      projectIdRef.current,
      current.journal,
      "abandon",
    );
  }, [installAuthoritative, settleUncertainAndAbandon]);

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

  const selectionLockActive = paste !== null;
  useEffect(() => {
    if (!selectionLockActive) return;
    const surfaces = Array.from(document.querySelectorAll<HTMLElement>(
      ".project-map-panel, .project-inspector",
    ));
    const previous = surfaces.map((surface) => ({
      surface,
      inert: surface.inert,
      ariaBusy: surface.getAttribute("aria-busy"),
    }));
    for (const { surface } of previous) {
      surface.inert = true;
      surface.setAttribute("aria-busy", "true");
    }
    const blockSelectionEvent = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)
        || !surfaces.some((surface) => surface.contains(target))) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const eventTypes = [
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "touchstart",
      "touchend",
      "click",
      "dblclick",
      "contextmenu",
      "keydown",
    ] as const;
    for (const eventType of eventTypes) {
      document.addEventListener(eventType, blockSelectionEvent, true);
    }
    return () => {
      for (const eventType of eventTypes) {
        document.removeEventListener(eventType, blockSelectionEvent, true);
      }
      for (const { surface, inert, ariaBusy } of previous) {
        surface.inert = inert;
        if (ariaBusy === null) surface.removeAttribute("aria-busy");
        else surface.setAttribute("aria-busy", ariaBusy);
      }
    };
  }, [selectionLockActive]);

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
