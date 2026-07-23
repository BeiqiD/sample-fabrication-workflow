import { normalizedStepName } from "./content-addressing";

export interface ExistingPlanSlot {
  id: string;
  name: string;
  logicalStepKey: string | null;
  definitionHash: string | null;
  position: number;
  actualized: boolean;
  origin: "template" | "ad_hoc";
}

export interface NextPlanStep {
  id: string;
  name: string;
  logicalStepKey: string;
  definitionHash: string;
  position: number;
}

type PlanConflict = {
  kind: "inserted_before_execution_head";
  existingStepId?: string;
  templateStepId?: string;
};

export type HistoricalPlanDifference = {
  kind: "modified_executed_step" | "removed_executed_step";
  existingStepId: string;
  templateStepId?: string;
};

export interface PlanAlignment {
  matches: Array<{ existingStepId: string; templateStepId: string; relation: "planned" | "historical" }>;
  additions: NextPlanStep[];
  supersededStepIds: string[];
  conflicts: PlanConflict[];
  historicalDifferences: HistoricalPlanDifference[];
}

function orderedNameMatches(existing: ExistingPlanSlot[], next: NextPlanStep[]) {
  const left = existing.map((step) => normalizedStepName(step.name));
  const right = next.map((step) => normalizedStepName(step.name));
  const lengths = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      lengths[leftIndex][rightIndex] = left[leftIndex] === right[rightIndex]
        ? lengths[leftIndex + 1][rightIndex + 1] + 1
        : Math.max(lengths[leftIndex + 1][rightIndex], lengths[leftIndex][rightIndex + 1]);
    }
  }
  const matches = new Map<number, ExistingPlanSlot>();
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      matches.set(rightIndex, existing[leftIndex]);
      leftIndex += 1;
      rightIndex += 1;
    } else if (lengths[leftIndex + 1][rightIndex] > lengths[leftIndex][rightIndex + 1]) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return matches;
}

export function alignFuturePlan(existing: ExistingPlanSlot[], next: NextPlanStep[]): PlanAlignment {
  const templateSlots = existing.filter((step) => step.origin === "template").sort((left, right) => left.position - right.position);
  const orderedMatches = orderedNameMatches(templateSlots, next);
  const matched = next.map((_, index) => orderedMatches.get(index) ?? null);
  const claimed = new Set([...orderedMatches.values()].map((step) => step.id));

  const conflicts: PlanConflict[] = [];
  const historicalDifferences: HistoricalPlanDifference[] = [];
  const matches: PlanAlignment["matches"] = [];
  const additions: NextPlanStep[] = [];
  for (const [index, step] of next.entries()) {
    const existingStep = matched[index];
    if (!existingStep) {
      const laterExecutedAnchor = matched.slice(index + 1).some((candidate) => candidate?.actualized);
      if (laterExecutedAnchor) conflicts.push({ kind: "inserted_before_execution_head", templateStepId: step.id });
      else additions.push(step);
      continue;
    }
    if (existingStep.actualized && existingStep.definitionHash !== step.definitionHash) {
      historicalDifferences.push({ kind: "modified_executed_step", existingStepId: existingStep.id, templateStepId: step.id });
    }
    matches.push({
      existingStepId: existingStep.id,
      templateStepId: step.id,
      relation: existingStep.actualized ? "historical" : "planned",
    });
  }

  const supersededStepIds: string[] = [];
  for (const step of templateSlots) {
    if (claimed.has(step.id)) continue;
    if (step.actualized) historicalDifferences.push({ kind: "removed_executed_step", existingStepId: step.id });
    else supersededStepIds.push(step.id);
  }
  return { matches, additions, supersededStepIds, conflicts, historicalDifferences };
}
