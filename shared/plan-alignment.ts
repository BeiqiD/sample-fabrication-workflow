export interface ExistingPlanSlot {
  id: string;
  logicalStepKey: string | null;
  definitionHash: string | null;
  position: number;
  actualized: boolean;
  origin: "template" | "ad_hoc";
}

export interface NextPlanStep {
  id: string;
  logicalStepKey: string;
  definitionHash: string;
  position: number;
}

type PlanConflict = {
  kind: "inserted_before_execution_head" | "modified_executed_step" | "removed_executed_step";
  existingStepId?: string;
  templateStepId?: string;
};

export interface PlanAlignment {
  matches: Array<{ existingStepId: string; templateStepId: string; relation: "planned" | "historical" }>;
  additions: NextPlanStep[];
  supersededStepIds: string[];
  conflicts: PlanConflict[];
}

export function alignFuturePlan(existing: ExistingPlanSlot[], next: NextPlanStep[]): PlanAlignment {
  const templateSlots = existing.filter((step) => step.origin === "template").sort((left, right) => left.position - right.position);
  const claimed = new Set<string>();
  const byLogical = new Map(templateSlots.filter((step) => step.logicalStepKey).map((step) => [step.logicalStepKey!, step]));
  const byHash = new Map<string, ExistingPlanSlot[]>();
  for (const step of templateSlots) if (step.definitionHash) byHash.set(step.definitionHash, [...(byHash.get(step.definitionHash) ?? []), step]);

  const matched = next.map((step) => {
    const logical = byLogical.get(step.logicalStepKey);
    if (logical && !claimed.has(logical.id)) { claimed.add(logical.id); return logical; }
    const sameHash = (byHash.get(step.definitionHash) ?? []).find((candidate) => !claimed.has(candidate.id));
    if (sameHash) claimed.add(sameHash.id);
    return sameHash ?? null;
  });

  const conflicts: PlanConflict[] = [];
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
      conflicts.push({ kind: "modified_executed_step", existingStepId: existingStep.id, templateStepId: step.id });
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
    if (step.actualized) conflicts.push({ kind: "removed_executed_step", existingStepId: step.id });
    else supersededStepIds.push(step.id);
  }
  return { matches, additions, supersededStepIds, conflicts };
}
