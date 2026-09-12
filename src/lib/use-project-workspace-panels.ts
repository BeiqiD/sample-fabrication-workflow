import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { defaultReferenceSearchUiState, type ReferenceSearchUiState } from "./reference-search-ui";

export type ProjectWorkspacePanel = "reference" | "inspector";
interface PanelChoice {
  open: boolean;
  pinned: boolean;
  allowEmpty: boolean;
}
interface PanelSession {
  reference: PanelChoice;
  inspector: PanelChoice;
  lastOpened: ProjectWorkspacePanel | null;
  referenceSearch: ReferenceSearchUiState;
  referenceSearchDraft: ReferenceSearchUiState;
}
const closedPanel: PanelChoice = { open: false, pinned: false, allowEmpty: false };
const emptySession: PanelSession = {
  reference: closedPanel, inspector: closedPanel, lastOpened: null,
  referenceSearch: defaultReferenceSearchUiState(), referenceSearchDraft: defaultReferenceSearchUiState(),
};

export function useProjectWorkspacePanels(projectId: string, {
  hasSelection,
  reading,
  readingInspectorAvailable,
  ready,
  trashOpen,
  forcedPanel,
}: {
  hasSelection: boolean;
  reading: boolean;
  readingInspectorAvailable: boolean;
  ready: boolean;
  trashOpen: boolean;
  forcedPanel: ProjectWorkspacePanel | null;
}) {
  const [sessions, setSessions] = useState<Map<string, PanelSession>>(() => new Map());
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 1180px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1180px)");
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, []);
  const session = sessions.get(projectId) ?? emptySession;
  const updateSession = useCallback((update: (current: PanelSession) => PanelSession) => {
    setSessions((current) => {
      const previous = current.get(projectId) ?? emptySession;
      const next = update(previous);
      if (previous === next) return current;
      return new Map(current).set(projectId, next);
    });
  }, [projectId]);
  const open = useCallback((panel: ProjectWorkspacePanel) => {
    updateSession((current) => current[panel].open && current.lastOpened === panel
      && current[panel].allowEmpty === !hasSelection ? current : {
        ...current, lastOpened: panel, [panel]: { ...current[panel], open: true, allowEmpty: !hasSelection },
      });
  }, [hasSelection, updateSession]);
  const close = useCallback((panel: ProjectWorkspacePanel) => {
    updateSession((current) => !current[panel].open ? current : {
      ...current, lastOpened: current.lastOpened === panel ? null : current.lastOpened,
      [panel]: { ...current[panel], open: false },
    });
  }, [updateSession]);
  const hide = useCallback((panel: ProjectWorkspacePanel) => {
    // Temporary presentation changes never overwrite a user's open/Pin choice.
    updateSession((current) => current.lastOpened !== panel ? current : { ...current, lastOpened: null });
  }, [updateSession]);
  const setPinned = useCallback((panel: ProjectWorkspacePanel, pinned: boolean) => {
    updateSession((current) => ({
      ...current, [panel]: { ...current[panel], pinned, allowEmpty: pinned && current[panel].allowEmpty },
    }));
  }, [updateSession]);
  const setReferenceSearch = useCallback((referenceSearch: ReferenceSearchUiState) => {
    updateSession((current) => ({ ...current, referenceSearch }));
  }, [updateSession]);
  const setReferenceSearchDraft = useCallback((referenceSearchDraft: ReferenceSearchUiState) => {
    updateSession((current) => ({ ...current, referenceSearchDraft }));
  }, [updateSession]);

  useLayoutEffect(() => {
    if (!ready || !hasSelection) return;
    // A toolbar-opened empty panel stays usable, but after a real selection an
    // explicit selection clear temporarily hides either unpinned panel.
    updateSession((current) => !current.reference.allowEmpty && !current.inspector.allowEmpty ? current : {
      ...current,
      reference: { ...current.reference, allowEmpty: false },
      inspector: { ...current.inspector, allowEmpty: false },
    });
  }, [ready, hasSelection, updateSession]);
  useLayoutEffect(() => {
    if (ready && forcedPanel) open(forcedPanel);
  }, [ready, forcedPanel, open]);
  useLayoutEffect(() => {
    if (!ready || !reading || forcedPanel) return;
    // A Reading panel that loses its presentation must be explicitly summoned
    // again. Editing a card or following a focus link must not revive a modal.
    // Retain the open choice so the wide Map can still restore its panels.
    updateSession((current) => {
      const panel = current.lastOpened;
      if (!panel) return current;
      const choice = current[panel];
      const available = !trashOpen && choice.open && (hasSelection || choice.pinned || choice.allowEmpty)
        && (panel !== "inspector" || readingInspectorAvailable);
      return available ? current : { ...current, lastOpened: null };
    });
  }, [ready, reading, forcedPanel, hasSelection, readingInspectorAvailable, trashOpen,
    session.lastOpened, session.reference, session.inspector, updateSession]);

  const exclusive = reading || narrow;
  const active = forcedPanel ?? session.lastOpened;
  const visible = (panel: ProjectWorkspacePanel) => {
    if (!ready) return false;
    if (forcedPanel === panel) return true;
    if (reading && trashOpen) return false;
    if (exclusive && active !== panel) return false;
    if (reading && panel === "inspector" && !readingInspectorAvailable) return false;
    const choice = session[panel];
    return choice.open && (hasSelection || choice.pinned || choice.allowEmpty);
  };
  return {
    referenceOpen: visible("reference"), inspectorOpen: visible("inspector"),
    referencePinned: session.reference.pinned, inspectorPinned: session.inspector.pinned,
    referenceSearch: session.referenceSearch, referenceSearchDraft: session.referenceSearchDraft,
    setReferenceSearch, setReferenceSearchDraft,
    open, close, hide, setPinned,
  };
}
