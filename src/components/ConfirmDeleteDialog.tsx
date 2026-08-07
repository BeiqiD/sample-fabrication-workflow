import { useRef } from "react";
import { useModalDialog } from "../lib/use-modal-dialog";

export function ConfirmDeleteDialog({ title, description, summary, deleting, error, eyebrow = "Confirm deletion", confirmLabel = "Delete", busyLabel = "Deleting…", confirmation, onCancel, onConfirm }: {
  title: string;
  description: string;
  summary: string;
  deleting: boolean;
  error: string;
  eyebrow?: string;
  confirmLabel?: string;
  busyLabel?: string;
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
  useModalDialog({
    dialogRef,
    initialFocusRef: confirmation ? confirmationRef : cancelRef,
    onClose: onCancel,
    blocked: deleting,
  });

  return <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) onCancel(); }}>
    <section ref={dialogRef} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-delete-title" aria-describedby="confirm-delete-description">
      <p className="eyebrow">{eyebrow}</p>
      <h2 id="confirm-delete-title">{title}</h2>
      <p id="confirm-delete-description">{description} This cannot be undone.</p>
      <blockquote>{summary.length > 180 ? `${summary.slice(0, 180)}…` : summary}</blockquote>
      {confirmation && <label className="confirm-dialog-confirmation">{confirmation.label}
        <input ref={confirmationRef} value={confirmation.value} autoComplete="off" spellCheck={false} disabled={deleting} onChange={(event) => confirmation.onChange(event.target.value)} />
      </label>}
      {error && <p className="error-banner">{error}</p>}
      <div className="form-actions">
        <button ref={cancelRef} type="button" className="button" disabled={deleting} onClick={onCancel}>Cancel</button>
        <button type="button" className="button danger" disabled={deleting || Boolean(confirmation && confirmation.value !== confirmation.target)} onClick={onConfirm}>{deleting ? busyLabel : confirmLabel}</button>
      </div>
    </section>
  </div>;
}
