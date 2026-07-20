import { useEffect, useRef } from "react";

export function ConfirmDeleteDialog({ title, description, summary, deleting, error, onCancel, onConfirm }: {
  title: string;
  description: string;
  summary: string;
  deleting: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cancelRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancelRef.current();
    }
    if (!deleting) window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [deleting]);

  return <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) onCancel(); }}>
    <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-delete-title" aria-describedby="confirm-delete-description">
      <p className="eyebrow">Delete comment</p>
      <h2 id="confirm-delete-title">{title}</h2>
      <p id="confirm-delete-description">{description} This cannot be undone.</p>
      <blockquote>{summary.length > 180 ? `${summary.slice(0, 180)}…` : summary}</blockquote>
      {error && <p className="error-banner">{error}</p>}
      <div className="form-actions">
        <button ref={cancelRef} type="button" className="button" disabled={deleting} onClick={onCancel}>Cancel</button>
        <button type="button" className="button danger" disabled={deleting} onClick={onConfirm}>{deleting ? "Deleting…" : "Delete comment"}</button>
      </div>
    </section>
  </div>;
}
