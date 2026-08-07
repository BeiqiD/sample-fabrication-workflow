import { type FormEvent, useRef, useState } from "react";
import { useModalDialog } from "../lib/use-modal-dialog";
import "../modal-form-controls.css";

export function StateMismatchDialog({
  sampleCode,
  stepTitle,
  busy,
  onCancel,
  onConfirm,
}: {
  sampleCode: string;
  stepTitle: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const blocked = busy || submitting;

  useModalDialog({ dialogRef, initialFocusRef: noteRef, onClose: onCancel, blocked });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked) return;
    setSubmitting(true);
    setError("");
    try {
      await onConfirm(note);
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !blocked) onCancel();
  }}>
    <section ref={dialogRef} className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="state-mismatch-title" aria-describedby="state-mismatch-description">
      <div>
        <p className="dialog-kicker">State verification</p>
        <h2 id="state-mismatch-title">Record state mismatch</h2>
      </div>
      <p id="state-mismatch-description">Describe how the observed state differs from the planned expectation for {sampleCode} · {stepTitle}.</p>
      <form onSubmit={submit}>
        <label className="confirm-dialog-confirmation">Mismatch note
          <textarea ref={noteRef} rows={4} value={note} disabled={blocked} placeholder="Observed structure, missing feature, unexpected residue…" onChange={(event) => setNote(event.target.value)} />
        </label>
        {error && <p className="error-banner">{error}</p>}
        <div className="form-actions">
          <button type="button" className="button" disabled={blocked} onClick={onCancel}>Cancel</button>
          <button type="submit" className="button primary" disabled={blocked}>{blocked ? "Saving…" : "Record mismatch"}</button>
        </div>
      </form>
    </section>
  </div>;
}
