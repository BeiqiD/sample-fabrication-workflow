import type { SubstrateTransitionConfirmation } from "../shared/types";

export type SubstrateTransitionFacts = {
  sampleUpdatedAt: string;
  previousStateHash: string | null;
  templateStructureKey: string | null;
  templateStateHash: string | null;
  templateStateRequired: boolean;
  latestRunId: string | null;
  currentPlanRevisionId?: string;
};

export function validateSubstrateTransition(
  confirmation: SubstrateTransitionConfirmation | undefined,
  facts: SubstrateTransitionFacts,
): {
  ok: true;
  confirmedTemplateStateHash: string | null;
} | {
  ok: false;
  reason: "confirmation_required" | "template_structure_missing" | "stale_confirmation";
} {
  if (!facts.templateStructureKey || (facts.templateStateRequired && !facts.templateStateHash)) {
    return { ok: false, reason: "template_structure_missing" };
  }
  if (!confirmation || confirmation.confirmed !== true) return { ok: false, reason: "confirmation_required" };
  if (confirmation.expectedSampleUpdatedAt !== facts.sampleUpdatedAt
    || confirmation.expectedPreviousStateHash !== facts.previousStateHash
    || confirmation.expectedTemplateStructureKey !== facts.templateStructureKey
    || confirmation.expectedTemplateStateHash !== facts.templateStateHash
    || confirmation.expectedLatestRunId !== facts.latestRunId
    || (facts.currentPlanRevisionId !== undefined
      && confirmation.expectedCurrentPlanRevisionId !== facts.currentPlanRevisionId)) {
    return { ok: false, reason: "stale_confirmation" };
  }
  return { ok: true, confirmedTemplateStateHash: facts.templateStateHash };
}
