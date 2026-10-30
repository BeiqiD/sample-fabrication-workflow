import type { InitialSubstrateStep } from "../../shared/types";
import { FABUBLOX_HEADER_ALIASES } from "../lib/fabublox-formats";

const PARAMETER_FIELDS = new Set<string>(["process parameters", ...FABUBLOX_HEADER_ALIASES.toolParameters]);
const STANDARD_FIELDS = new Set<string>([
  ...FABUBLOX_HEADER_ALIASES.stepNumber,
  ...FABUBLOX_HEADER_ALIASES.stepName,
  ...FABUBLOX_HEADER_ALIASES.toolName,
  ...FABUBLOX_HEADER_ALIASES.parameters,
  ...FABUBLOX_HEADER_ALIASES.comments,
  ...FABUBLOX_HEADER_ALIASES.layerStacks,
].filter(label => !PARAMETER_FIELDS.has(label) && label !== "notes"));

function normalizedField(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function SubstrateStepDetails({ step, className = "initial-substrate-details" }: {
  step: InitialSubstrateStep;
  className?: string;
}) {
  const additional = Object.entries(step.rawCells).filter(([label, value]) => {
    const normalized = normalizedField(label);
    if (STANDARD_FIELDS.has(normalized) || value === null || value === undefined || !String(value).trim()) return false;
    // New aliases need no duplicate row when already visible in the canonical
    // value, but an older template's independent extension must stay visible.
    if (PARAMETER_FIELDS.has(normalized) && step.parametersText?.includes(String(value).trim())) return false;
    if (normalized === "notes" && step.commentsText?.trim() === String(value).trim()) return false;
    return true;
  });
  return <><dl className={className}>
    <dt>Tool</dt><dd>{step.toolName || "—"}</dd>
    <dt>Parameters</dt><dd>{step.parametersText || "—"}</dd>
    <dt>Comments</dt><dd>{step.commentsText || "—"}</dd>
  </dl>
    {additional.length > 0 && <details className="substrate-source-details">
      <summary>Source details</summary>
      <dl className={className}>{additional.flatMap(([label, value]) => [
      <dt key={`${label}:label`}>{label}</dt>,
      <dd key={`${label}:value`}>{String(value)}</dd>,
      ])}</dl>
    </details>}
  </>;
}
