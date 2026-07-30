import { useEffect, useRef } from "react";
import type { RunStartPreview } from "../../shared/types";
import { DialogCloseIcon } from "./DialogCloseIcon";
import { SubstrateStepDetails } from "./SubstrateStepDetails";

function StructureImages({ keys, emptyLabel }: { keys: string[]; emptyLabel: string }) {
  if (!keys.length) return <div className="run-start-structure-empty">{emptyLabel}</div>;
  return <div className="run-start-structure-images">{keys.map((key, index) =>
    <a href={`/api/assets/${key}`} target="_blank" rel="noreferrer" key={key}>
      <img src={`/api/assets/${key}`} alt={`Substrate structure ${index + 1}`} />
    </a>)}</div>;
}

export function StartProcessRunDialog({ preview, action, starting, error, onCancel, onConfirm }: {
  preview: RunStartPreview;
  action: "start" | "update" | "reopen";
  starting: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
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

  const actionLabel = action === "start" ? "Start new process run" : action === "reopen" ? "Reopen process run" : "Update process";
  const updating = action !== "start";
  const target = preview.comparisonTarget;
  const targetIsInitial = target?.kind === "initial_substrate";

  return <div className="run-start-dialog-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !starting) onCancel();
  }}>
    <section className="run-start-dialog" role="dialog" aria-modal="true" aria-labelledby="run-start-title">
      <div className="run-start-dialog-heading">
        <div><p className="dialog-kicker">{actionLabel}</p><h2 id="run-start-title">Does this structure handoff match what you expect?</h2></div>
        <button type="button" className="drawer-close" disabled={starting} onClick={onCancel} aria-label="Close"><DialogCloseIcon /></button>
      </div>
      <p className="muted">{updating
        ? targetIsInitial
          ? "No process step has produced a newer structure yet, so compare the current recorded structure with Step 0 of the updated template."
          : "Compare the current recorded structure with the output of its matched step in the updated template. Step 0 is not used for an in-place update after execution has begun."
        : "Compare the last structure recorded on the sample with Step 0 of the incoming process template. Confirmation records that this transition is intentional; it does not choose between the two structures."}</p>

      <div className="run-start-structure-options">
        <section className="run-start-structure-option">
          <div className="run-start-structure-copy"><strong>{updating ? "Current recorded structure" : "Previous recorded structure"}</strong><small>{preview.sampleCurrentState.stepTitle ? `Last recorded after ${preview.sampleCurrentState.stepTitle}` : action !== "start" && preview.sampleCurrentState.hash ? "The latest structure recorded for this run" : preview.successor ? "From the latest completed process run" : preview.sampleCurrentState.hash ? "Inherited with this sample" : "No earlier substrate structure is recorded"}</small></div>
          <StructureImages keys={preview.sampleCurrentState.imageKeys} emptyLabel="No previous structure diagram is available." />
        </section>
        <section className={`run-start-structure-option${preview.canConfirm ? "" : " unavailable"}`}>
          <div className="run-start-structure-copy"><strong>{target?.kind === "matched_step" ? "Updated process · matched step" : "Incoming process · Step 0"}</strong><small>{preview.template.name} · v{preview.template.version} · {target?.stepTitle || preview.template.initialSubstrateStep?.name || "Comparison step not found"}</small></div>
          <StructureImages keys={target?.imageKeys ?? []} emptyLabel={target?.kind === "matched_step" ? "The matched step has no structure diagram." : preview.template.initialSubstrateStep ? "Step 0 was imported without a diagram." : "This version has no Step 0 substrate structure."} />
          {targetIsInitial && preview.template.initialSubstrateStep && <SubstrateStepDetails step={preview.template.initialSubstrateStep} className="run-start-substrate-details" />}
        </section>
      </div>

      {preview.comparison === "same" && <p className="transition-result transition-match">The recorded diagrams match. Confirm that this is the intended {updating ? "template update" : "process handoff"}.</p>}
      {preview.comparison === "different" && <p className="warning-card compact-warning">The recorded diagrams differ. Continue only if the difference is expected and the {target?.kind === "matched_step" ? "matched step correctly represents the current structure" : "incoming Step 0 correctly describes the substrate for the next work"}.</p>}
      {preview.comparison === "no_previous_structure" && <p className="warning-card compact-warning">There is no previous structure to compare. Confirm the template structure against the physical sample before continuing.</p>}
      {preview.comparison === "not_comparable" && <p className="warning-card compact-warning">At least one side has no comparable diagram. Review the available structure details and confirm against the physical sample.</p>}
      {preview.blockingReason && <p className="error-banner">{preview.blockingReason}</p>}
      {error && <p className="error-banner">{error}</p>}
      <div className="form-actions">
        <button ref={cancelRef} type="button" className="button" disabled={starting} onClick={onCancel}>Cancel</button>
        <button type="button" className="button primary" disabled={starting || !preview.canConfirm} onClick={onConfirm}>{starting ? "Saving…" : action === "start" ? "Confirm and start run" : action === "reopen" ? "Confirm and reopen run" : "Confirm and update process"}</button>
      </div>
    </section>
  </div>;
}
