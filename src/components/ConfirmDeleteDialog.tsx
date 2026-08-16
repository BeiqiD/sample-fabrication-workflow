import { useEffect, useRef, useState } from "react";
import { useModalDialog } from "../lib/use-modal-dialog";
import "../modal-form-controls.css";

export function ConfirmDeleteDialog({ title, description, summary, deleting, error, eyebrow = "Confirm deletion", confirmLabel = "Delete", busyLabel = "Deleting…", appendIrreversibleWarning = true, cancelDisabled = false, confirmation, onCancel, onConfirm }: {
  title: string;
  description: string;
  summary: string;
  deleting: boolean;
  error: string;
  eyebrow?: string;
  confirmLabel?: string;
  busyLabel?: string;
  appendIrreversibleWarning?: boolean;
  cancelDisabled?: boolean;
  confirmation?: {
    label: string;
    target: string;
    value: string;
    onChange: (value: string) => void;
  };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const [settledError, setSettledError] = useState("");
  const visibleError = !deleting && error === settledError ? settledError : "";
  useModalDialog({
    dialogRef,
    initialFocusRef: confirmation ? confirmationRef : cancelRef,
    onClose: onCancel,
    blocked: deleting || cancelDisabled,
  });

  useEffect(() => {
    if (deleting || !error) {
      setSettledError("");
      return;
    }

    // The parent navigation blocker updates its predicate in a passive effect.
    // Announce a terminal mutation error only after that settled render has
    // completed, so immediate follow-up navigation cannot observe stale busy state.
    const timer = window.setTimeout(() => setSettledError(error), 0);
    return () => window.clearTimeout(timer);
  }, [deleting, error]);

  return <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting && !cancelDisabled) onCancel(); }}>
    <section ref={dialogRef} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-delete-title" aria-describedby="confirm-delete-description">
      <p className="eyebrow">{eyebrow}</p>
      <h2 id="confirm-delete-title">{title}</h2>
      <p id="confirm-delete-description">{description}{appendIrreversibleWarning ? " This cannot be undone." : ""}</p>
      <blockquote>{summary.length > 180 ? `${summary.slice(0, 180)}…` : summary}</blockquote>
      {confirmation && <label className="confirm-dialog-confirmation">{confirmation.label}
        <input ref={confirmationRef} value={confirmation.value} autoComplete="off" spellCheck={false} disabled={deleting} onChange={(event) => confirmation.onChange(event.target.value)} />
      </label>}
      {visibleError && <p className="error-banner">{visibleError}</p>}
      <div className="form-actions">
        <button ref={cancelRef} type="button" className="button" disabled={deleting || cancelDisabled} onClick={onCancel}>Cancel</button>
        <button type="button" className="button danger" disabled={deleting || Boolean(confirmation && confirmation.value !== confirmation.target)} onClick={onConfirm}>{deleting ? busyLabel : confirmLabel}</button>
      </div>
    </section>
  </div>;
}
