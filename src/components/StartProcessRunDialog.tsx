import { useEffect, useMemo, useRef, useState } from "react";
import type { RunStartPreview } from "../../shared/types";

type StructureChoice = "sample" | "template" | "empty" | "";

function StructureImages({ keys, emptyLabel }: { keys: string[]; emptyLabel: string }) {
  if (!keys.length) return <div className="run-start-structure-empty">{emptyLabel}</div>;
  return <div className="run-start-structure-images">{keys.map((key, index) =>
    <a href={`/api/assets/${key}`} target="_blank" rel="noreferrer" key={key}>
      <img src={`/api/assets/${key}`} alt={`Substrate structure ${index + 1}`} />
    </a>)}</div>;
}

export function StartProcessRunDialog({ preview, starting, error, onCancel, onConfirm }: {
  preview: RunStartPreview;
  starting: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (initialStateHash: string | null) => void;
}) {
  const sameStructure = preview.template.initialStateHash === preview.sampleCurrentState.hash;
  const initialChoice = useMemo<StructureChoice>(() => {
    if (sameStructure) return preview.template.initialStateHash === null ? "empty" : "template";
    if (preview.sampleCurrentState.hash && !preview.template.initialStateHash) return "sample";
    if (preview.template.initialStateHash && !preview.sampleCurrentState.hash) return "template";
    if (!preview.template.initialStateHash && !preview.sampleCurrentState.hash) return "empty";
    return "";
  }, [preview, sameStructure]);
  const [choice, setChoice] = useState<StructureChoice>(initialChoice);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cancelRef.current?.focus();
    function keyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !starting) onCancel();
    }
    window.addEventListener("keydown", keyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", keyDown);
    };
  }, [onCancel, starting]);

  const selectedHash = choice === "sample"
    ? preview.sampleCurrentState.hash
    : choice === "template"
      ? preview.template.initialStateHash
      : null;

  return <div className="run-start-dialog-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !starting) onCancel();
  }}>
    <section className="run-start-dialog" role="dialog" aria-modal="true" aria-labelledby="run-start-title">
      <div className="run-start-dialog-heading">
        <div><p className="eyebrow">{preview.successor ? "Start new process run" : "Start process run"}</p><h2 id="run-start-title">Confirm the initial substrate structure</h2></div>
        <button type="button" className="drawer-close" disabled={starting} onClick={onCancel} aria-label="Close">×</button>
      </div>
      <p className="muted">The selected structure is saved as an immutable starting snapshot for this run. Later process-template updates will not change it.</p>

      {sameStructure ? <label className="run-start-structure-option selected">
        <input type="radio" name="initial-structure" checked readOnly />
        <div className="run-start-structure-copy"><strong>Current sample and process template agree</strong><small>{preview.template.name} · v{preview.template.version}</small></div>
        <StructureImages keys={preview.template.initialStateImageKeys.length ? preview.template.initialStateImageKeys : preview.sampleCurrentState.imageKeys} emptyLabel="Neither source includes a structure diagram." />
      </label> : <div className="run-start-structure-options">
        <label className={`run-start-structure-option${choice === "sample" ? " selected" : ""}${!preview.sampleCurrentState.hash ? " unavailable" : ""}`}>
          <input type="radio" name="initial-structure" value="sample" checked={choice === "sample"} disabled={!preview.sampleCurrentState.hash || starting} onChange={() => setChoice("sample")} />
          <div className="run-start-structure-copy"><strong>Continue from the sample’s current structure</strong><small>{preview.sampleCurrentState.stepTitle ? `Derived after ${preview.sampleCurrentState.stepTitle}` : preview.successor ? "Inherited from its completed processing history" : "Inherited when this sample was split"}</small></div>
          <StructureImages keys={preview.sampleCurrentState.imageKeys} emptyLabel="No current sample structure is available." />
        </label>
        <label className={`run-start-structure-option${choice === "template" ? " selected" : ""}${!preview.template.initialStateHash ? " unavailable" : ""}`}>
          <input type="radio" name="initial-structure" value="template" checked={choice === "template"} disabled={!preview.template.initialStateHash || starting} onChange={() => setChoice("template")} />
          <div className="run-start-structure-copy"><strong>Use the process template’s defined substrate</strong><small>{preview.template.name} · v{preview.template.version}</small></div>
          <StructureImages keys={preview.template.initialStateImageKeys} emptyLabel="This process-template version has no initial substrate diagram." />
        </label>
      </div>}

      {!sameStructure && preview.sampleCurrentState.hash && preview.template.initialStateHash && <p className="warning-card compact-warning">The two structures differ. Select the structure that physically matches the sample before beginning this independent run.</p>}
      {error && <p className="error-banner">{error}</p>}
      <div className="form-actions">
        <button ref={cancelRef} type="button" className="button" disabled={starting} onClick={onCancel}>Cancel</button>
        <button type="button" className="button primary" disabled={starting || !choice} onClick={() => onConfirm(selectedHash)}>{starting ? "Starting…" : "Confirm and start run"}</button>
      </div>
    </section>
  </div>;
}
