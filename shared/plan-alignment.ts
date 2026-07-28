import { normalizedStepName } from "./content-addressing";

export interface ExistingPlanSlot {
  id: string;
  name: string;
  logicalStepKey: string | null;
  definitionHash: string | null;
  position: number;
  alignmentPosition?: number;
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

export type HistoricalPlanDifference = {
  kind: "modified_executed_step" | "removed_executed_step";
  existingStepId: string;
  templateStepId?: string;
};

export type PlanAddition = NextPlanStep & {
  initialStatus: "pending" | "skipped";
};

export interface PlanAlignment {
  matches: Array<{ existingStepId: string; templateStepId: string; relation: "planned" | "historical" }>;
  additions: PlanAddition[];
  supersededStepIds: string[];
  historicalDifferences: HistoricalPlanDifference[];
}

function nameMatches(existing: ExistingPlanSlot[], next: NextPlanStep[]) {
  const matches = new Map<number, ExistingPlanSlot>();
  const names = new Set([
    ...existing.map((step) => normalizedStepName(step.name)),
    ...next.map((step) => normalizedStepName(step.name)),
  ]);
  for (const name of names) {
    const remainingExisting = existing.filter((step) => normalizedStepName(step.name) === name);
    const remainingNext = next
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => normalizedStepName(step.name) === name);
    const claim = (predicate: (existingStep: ExistingPlanSlot, nextStep: NextPlanStep) => boolean) => {
      for (let nextIndex = 0; nextIndex < remainingNext.length;) {
        const candidate = remainingNext[nextIndex];
        const existingIndex = remainingExisting.findIndex((step) => predicate(step, candidate.step));
        if (existingIndex < 0) {
          nextIndex += 1;
          continue;
        }
        matches.set(candidate.index, remainingExisting[existingIndex]);
        remainingExisting.splice(existingIndex, 1);
        remainingNext.splice(nextIndex, 1);
      }
    };
    claim((left, right) => left.definitionHash === right.definitionHash
      && left.logicalStepKey === right.logicalStepKey);
    claim((left, right) => left.definitionHash === right.definitionHash);
    claim((left, right) => Boolean(left.logicalStepKey) && left.logicalStepKey === right.logicalStepKey);
    while (remainingExisting.length && remainingNext.length) {
      const candidate = remainingNext.shift()!;
      matches.set(candidate.index, remainingExisting.shift()!);
    }
  }
  return matches;
}

export function alignFuturePlan(existing: ExistingPlanSlot[], next: NextPlanStep[]): PlanAlignment {
  const templateSlots = existing
    .filter((step) => step.origin === "template")
    .sort((left, right) => (left.alignmentPosition ?? left.position) - (right.alignmentPosition ?? right.position));
  const matchedByNextPosition = nameMatches(templateSlots, next);
  const matched = next.map((_, index) => matchedByNextPosition.get(index) ?? null);
  const claimed = new Set([...matchedByNextPosition.values()].map((step) => step.id));

  const historicalDifferences: HistoricalPlanDifference[] = [];
  const matches: PlanAlignment["matches"] = [];
  const additions: PlanAddition[] = [];
  for (const [index, step] of next.entries()) {
    const existingStep = matched[index];
    if (!existingStep) {
      const laterExecutedAnchor = matched.slice(index + 1).some((candidate) => candidate?.actualized);
      additions.push({ ...step, initialStatus: laterExecutedAnchor ? "skipped" : "pending" });
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
    supersededStepIds.push(step.id);
  }
  return { matches, additions, supersededStepIds, historicalDifferences };
}
