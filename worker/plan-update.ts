import type { PlanAlignment } from "../shared/plan-alignment";

type NextTemplateStep = {
  id: string;
  name: string;
  expectedStateHash: string | null;
};

type InitialSubstrateTarget = {
  templateVersionId: string;
  stateHash: string | null;
  valid: boolean;
};

export type PlanUpdateStructureTarget = {
  kind: "initial_substrate" | "matched_step";
  key: string;
  stateHash: string | null;
  stepId: string | null;
  stepTitle: string;
};

export function resolvePlanUpdateStructureTarget(
  alignment: PlanAlignment,
  currentStructureStepId: string | null,
  nextSteps: NextTemplateStep[],
  initialSubstrate: InitialSubstrateTarget,
): PlanUpdateStructureTarget | null {
  if (!currentStructureStepId) {
    if (!initialSubstrate.valid || !initialSubstrate.stateHash) return null;
    return {
      kind: "initial_substrate",
      key: `initial-substrate:${initialSubstrate.templateVersionId}`,
      stateHash: initialSubstrate.stateHash,
      stepId: null,
      stepTitle: "Substrate Stack",
    };
  }

  const matchedStepId = alignment.matches.find(
    (match) => match.existingStepId === currentStructureStepId,
  )?.templateStepId;
  const historicalTemplateStepIds = new Set(alignment.matches
    .filter((match) => match.relation === "historical")
    .map((match) => match.templateStepId));
  const step = matchedStepId
    ? nextSteps.find((candidate) => candidate.id === matchedStepId)
    : [...nextSteps].reverse().find((candidate) => historicalTemplateStepIds.has(candidate.id));
  if (!step) {
    if (!initialSubstrate.valid || !initialSubstrate.stateHash) return null;
    return {
      kind: "initial_substrate",
      key: `initial-substrate:${initialSubstrate.templateVersionId}`,
      stateHash: initialSubstrate.stateHash,
      stepId: null,
      stepTitle: "Substrate Stack",
    };
  }
  return {
    kind: "matched_step",
    key: `template-step:${step.id}`,
    stateHash: step.expectedStateHash,
    stepId: step.id,
    stepTitle: step.name,
  };
}
