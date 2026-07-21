import { useEffect, useRef, useState } from "react";
import { MAX_SPLIT_PIECES, SAMPLE_CREATION_STATUSES, SAMPLE_STATUS_LABELS, type SampleDetail, type SampleStatus, type SplitSamplePieceInput } from "../../shared/types";
import { api } from "../lib/api";
import { createSplitPieceDrafts } from "../lib/splitSamples";

export function SplitSampleDialog({ sample, onCancel, onComplete }: {
  sample: SampleDetail;
  onCancel: () => void;
  onComplete: () => Promise<void> | void;
}) {
  const [stage, setStage] = useState<"setup" | "pieces">("setup");
  const [count, setCount] = useState(2);
  const [commonLocation, setCommonLocation] = useState("");
  const [parentStatusAfter, setParentStatusAfter] = useState<"active" | "consumed">("consumed");
  const [pieces, setPieces] = useState<SplitSamplePieceInput[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const firstInputRef = useRef<HTMLInputElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    firstInputRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) onCancelRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [saving]);

  function preparePieces() {
    const location = commonLocation.trim();
    if (!Number.isInteger(count) || count < 1 || count > MAX_SPLIT_PIECES) {
      setError(`Choose between 1 and ${MAX_SPLIT_PIECES} new pieces.`);
      return;
    }
    if (!location) {
      setError("Enter the initial location for the new pieces.");
      return;
    }
    setPieces(createSplitPieceDrafts(sample, count, location));
    setError("");
    setStage("pieces");
  }

  function updatePiece(index: number, field: keyof SplitSamplePieceInput, value: string) {
    setPieces((current) => current.map((piece, pieceIndex) => pieceIndex === index ? { ...piece, [field]: value } : piece));
  }

  async function confirmSplit() {
    const invalidIndex = pieces.findIndex((piece) => !piece.code.trim() || !piece.title.trim() || !piece.location.trim());
    if (invalidIndex >= 0) {
      setError(`Piece ${invalidIndex + 1} needs a code, short title, and location.`);
      return;
    }
    const normalizedCodes = pieces.map((piece) => piece.code.trim().toLocaleLowerCase());
    if (new Set(normalizedCodes).size !== normalizedCodes.length) {
      setError("Every new piece must have a unique sample code.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api.splitSample(sample.id, {
        expectedUpdatedAt: sample.updatedAt,
        parentStatusAfter,
        pieces: pieces.map((piece) => ({
          ...piece,
          code: piece.code.trim(),
          title: piece.title.trim(),
          description: piece.description?.trim() || "",
          location: piece.location.trim(),
        })),
      });
      await onComplete();
    } catch (error) {
      setError((error as Error).message);
      setSaving(false);
    }
  }

  return <div className="split-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onCancel(); }}>
    <section className="split-dialog" role="dialog" aria-modal="true" aria-labelledby="split-dialog-title">
      <div className="split-dialog-heading">
        <div><p className="eyebrow">Split sample</p><h2 id="split-dialog-title">{sample.code} · {sample.title}</h2></div>
        <button type="button" className="drawer-close" aria-label="Close split dialog" disabled={saving} onClick={onCancel}>×</button>
      </div>

      {stage === "setup" ? <>
        <p className="muted">Define the new pieces first. Their location is entered explicitly and is not inherited from the parent.</p>
        <div className="split-setup-grid">
          <label>Split into<input ref={firstInputRef} type="number" min="1" max={MAX_SPLIT_PIECES} step="1" value={count} onChange={(event) => setCount(Number(event.target.value))} /><small>Number of new physical pieces</small></label>
          <label>Parent after split<select value={parentStatusAfter} onChange={(event) => setParentStatusAfter(event.target.value as "active" | "consumed")}><option value="consumed">Consumed (default)</option><option value="active">Keep active</option></select><small>The original sample code remains in the archive.</small></label>
          <label className="split-common-location">Initial location for new pieces<input value={commonLocation} required placeholder="Box, lab, or tool" onChange={(event) => setCommonLocation(event.target.value)} /><small>This becomes the default for every piece and can be edited individually next.</small></label>
        </div>
        {error && <p className="error-banner">{error}</p>}
        <div className="form-actions"><button type="button" className="button" onClick={onCancel}>Cancel</button><button type="button" className="button primary" onClick={preparePieces}>Continue</button></div>
      </> : <>
        <div className="split-review-summary"><div><span>New pieces</span><strong>{pieces.length}</strong></div><div><span>Parent after split</span><strong>{parentStatusAfter === "consumed" ? "Consumed" : "Active"}</strong></div><div><span>Initial location</span><strong>{commonLocation.trim()}</strong></div></div>
        <p className="muted">Review each piece. Expand a row to override its generated details.</p>
        <div className="split-piece-list">
          {pieces.map((piece, index) => <details className="split-piece" key={index} open={index === 0}>
            <summary><span>Piece {index + 1}</span><strong>{piece.code || "Code required"}</strong><small>{piece.status} · {piece.location || "Location required"}</small></summary>
            <div className="split-piece-fields">
              <label>Sample code<input value={piece.code} required maxLength={100} onChange={(event) => updatePiece(index, "code", event.target.value)} /></label>
              <label>Short title<input value={piece.title} required maxLength={200} onChange={(event) => updatePiece(index, "title", event.target.value)} /></label>
              <label>Status<select value={piece.status} onChange={(event) => updatePiece(index, "status", event.target.value as SampleStatus)}>{SAMPLE_CREATION_STATUSES.map((status) => <option value={status} key={status}>{SAMPLE_STATUS_LABELS[status]}</option>)}</select></label>
              <label>Location<input value={piece.location} required maxLength={500} onChange={(event) => updatePiece(index, "location", event.target.value)} /></label>
              <label className="split-piece-description">Description<textarea rows={3} value={piece.description || ""} maxLength={10_000} onChange={(event) => updatePiece(index, "description", event.target.value)} /></label>
            </div>
          </details>)}
        </div>
        {error && <p className="error-banner">{error}</p>}
        <div className="form-actions"><button type="button" className="button" disabled={saving} onClick={() => { setError(""); setStage("setup"); }}>Back</button><button type="button" className="button primary" disabled={saving} onClick={() => void confirmSplit()}>{saving ? "Splitting…" : `Confirm split into ${pieces.length}`}</button></div>
      </>}
    </section>
  </div>;
}
