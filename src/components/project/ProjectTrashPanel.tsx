import { useEffect, useRef, useState } from "react";
import type { ProjectItemTrashController } from "../../lib/use-project-item-trash";
import { ProjectPanelSurface } from "./ProjectPanelSurface";
import { DialogCloseIcon } from "../DialogCloseIcon";
import "./project-trash-panel.css";

export function ProjectTrashPanel({
  controller,
  disabled = false,
  modal = false,
  returnFocusRef,
}: {
  controller: ProjectItemTrashController;
  disabled?: boolean;
  modal?: boolean;
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!controller.isOpen || modal) return;
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      if (origin?.isConnected && origin !== document.body) origin.focus();
      else document.querySelector<HTMLElement>('[aria-label="Project actions"]')?.focus();
    };
  }, [controller.isOpen, modal]);
  if (!controller.isOpen) return null;
  const busy = disabled || controller.pending !== null;
  const currentIds = new Set(controller.entries.map((entry) => entry.itemId));
  const selection = selectedIds.filter((id) => currentIds.has(id));
  return <ProjectPanelSurface modal={modal} label="Project trash" onClose={controller.close}
    blocked={controller.pending !== null} returnFocusRef={returnFocusRef} initialFocusRef={panelRef}>
  <section ref={panelRef} tabIndex={-1} className="project-trash-panel" aria-labelledby="project-trash-heading" onKeyDown={(event) => {
    if (event.key === "Escape" && !controller.pending) {
      event.preventDefault();
      event.stopPropagation();
      controller.close();
    }
  }}>
    <header className="project-trash-panel__header">
      <h2 id="project-trash-heading">Project trash</h2>
      <button className="button compact-button" type="button" onClick={controller.close} disabled={controller.pending !== null} aria-label="Close Project trash"><DialogCloseIcon /></button>
    </header>
    <p>Restore cards and their connections. Removed references leave the original records unchanged.</p>
    <div className="project-trash-panel__actions">
      <button className="button compact-button" type="button" onClick={() => void controller.refresh()} disabled={busy || controller.loading}>Refresh</button>
      <button className="button compact-button" type="button" disabled={busy || selection.length === 0} onClick={() => controller.restoreItems(selection)}>
        Restore selected{selection.length ? ` (${selection.length})` : ""}
      </button>
      {controller.recoverableConnectionCount > 0 ? <button className="button compact-button" type="button" disabled={busy} onClick={controller.restoreConnections}>
        Restore connections ({controller.recoverableConnectionCount})
      </button> : null}
    </div>
    {controller.loading ? <p role="status">Loading trash…</p> : null}
    {controller.error ? <p role="alert">{controller.error}</p> : null}
    {controller.pending ? <div role="status">
      <p>{controller.pending.total === 0 ? "Restoring connections…"
        : `${controller.pending.kind === "remove" ? "Removing" : "Restoring"} cards: ${controller.pending.completed}/${controller.pending.total}`}</p>
      {controller.pending.status !== "working" ? <button className="button compact-button" type="button" onClick={() => void controller.retry()}>
        {controller.pending.status === "uncertain" ? "Retry safely" : "Reload Project state"}
      </button> : null}
    </div> : null}
    {!controller.loading && !controller.pending && !controller.error && controller.entries.length === 0
      ? <p>{controller.recoverableConnectionCount > 0 ? "No deleted cards. Their connections can still be restored." : "Trash is empty."}</p> : null}
    <ul className="project-trash-panel__list">
      {controller.entries.map((entry) => <li key={entry.itemId}>
        <label>
          <input type="checkbox" checked={selection.includes(entry.itemId)} disabled={busy} onChange={(event) => {
            setSelectedIds(event.currentTarget.checked ? [...selection, entry.itemId] : selection.filter((id) => id !== entry.itemId));
          }} />
          <span><strong>{entry.title}</strong><small>{entry.kind}</small></span>
        </label>
        <button className="button compact-button" type="button" disabled={busy} onClick={() => controller.restoreItems([entry.itemId])} aria-label={`Restore ${entry.title}`}>Restore</button>
      </li>)}
    </ul>
  </section>
  </ProjectPanelSurface>;
}

/** Keep visible outside the drawer so a failed removal always has a recovery action. */
export function ProjectTrashStatus({ controller, disabled = false }: {
  controller: ProjectItemTrashController;
  disabled?: boolean;
}) {
  if (!controller.message && !controller.error && !controller.pending) return null;
  return <div className="project-trash-status" aria-live="polite">
    {controller.error ? <span role="alert">{controller.error}</span> : <span>{controller.message || "Updating Project cards…"}</span>}
    {controller.pending?.status === "uncertain" || controller.pending?.status === "reload"
      ? <button className="button compact-button" type="button" onClick={() => void controller.retry()}>
        {controller.pending.status === "uncertain" ? "Retry safely" : "Reload Project state"}
      </button>
      : controller.canUndo ? <button className="button compact-button" type="button" disabled={disabled} onClick={controller.undoRemoval}>Undo removal</button> : null}
    {!controller.pending ? <button className="button compact-button" type="button" onClick={controller.open}>View trash</button> : null}
    {!controller.pending && !controller.error ? <button className="button compact-button" type="button" aria-label="Dismiss trash notification" onClick={controller.dismissMessage}>×</button> : null}
  </div>;
}
