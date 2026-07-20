import type { RunStep } from "../../shared/types";

function normalized(value: string | null) {
  return value?.trim() || "";
}

export function runStepIsModified(step: RunStep) {
  if (step.origin === "ad_hoc") return true;
  return normalized(step.title) !== normalized(step.plannedTitle)
    || normalized(step.toolName) !== normalized(step.plannedToolName)
    || normalized(step.parametersText) !== normalized(step.plannedParametersText)
    || normalized(step.commentsText) !== normalized(step.plannedCommentsText)
    || Boolean(normalized(step.deviationNote));
}
