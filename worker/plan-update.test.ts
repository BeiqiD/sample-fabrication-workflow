import { describe, expect, it } from "vitest";
import type { PlanAlignment } from "../shared/plan-alignment";
import { resolvePlanUpdateStructureTarget } from "./plan-update";

const alignment: PlanAlignment = {
  matches: [
    { existingStepId: "old-clean", templateStepId: "new-clean", relation: "historical" },
    { existingStepId: "old-coat", templateStepId: "new-coat", relation: "planned" },
  ],
  additions: [],
  supersededStepIds: [],
  historicalDifferences: [],
};

const nextSteps = [
  { id: "new-clean", name: "Clean", expectedStateHash: "state-after-clean" },
  { id: "new-coat", name: "Coat", expectedStateHash: "state-after-coat" },
];

describe("plan update structure comparison target", () => {
  it("uses the new-template step matched to the step that produced the current structure", () => {
    expect(resolvePlanUpdateStructureTarget(alignment, "old-clean", nextSteps, {
      templateVersionId: "template-v2",
      stateHash: "step-zero",
      valid: true,
    })).toEqual({
      kind: "matched_step",
      key: "template-step:new-clean",
      stateHash: "state-after-clean",
      stepId: "new-clean",
      stepTitle: "Clean",
    });
  });

  it("falls back to Step 0 only before any run step has produced the current structure", () => {
    expect(resolvePlanUpdateStructureTarget(alignment, null, nextSteps, {
      templateVersionId: "template-v2",
      stateHash: "step-zero",
      valid: true,
    })).toEqual({
      kind: "initial_substrate",
      key: "initial-substrate:template-v2",
      stateHash: "step-zero",
      stepId: null,
      stepTitle: "Substrate Stack",
    });
  });

  it("uses the latest matched executed step when the structure-producing step was removed", () => {
    expect(resolvePlanUpdateStructureTarget(alignment, "renamed-current-step", nextSteps, {
      templateVersionId: "template-v2",
      stateHash: "step-zero",
      valid: true,
    })).toEqual({
      kind: "matched_step",
      key: "template-step:new-clean",
      stateHash: "state-after-clean",
      stepId: "new-clean",
      stepTitle: "Clean",
    });
  });

  it("uses Step 0 when the updated plan retains no executed step", () => {
    expect(resolvePlanUpdateStructureTarget({
      ...alignment,
      matches: alignment.matches.map((match) => ({ ...match, relation: "planned" as const })),
    }, "removed-current-step", nextSteps, {
      templateVersionId: "template-v2",
      stateHash: "step-zero",
      valid: true,
    })).toEqual({
      kind: "initial_substrate",
      key: "initial-substrate:template-v2",
      stateHash: "step-zero",
      stepId: null,
      stepTitle: "Substrate Stack",
    });
  });

  it("blocks when no matched execution boundary or valid Step 0 remains", () => {
    expect(resolvePlanUpdateStructureTarget({
      ...alignment,
      matches: [],
    }, "removed-current-step", nextSteps, {
      templateVersionId: "template-v2",
      stateHash: null,
      valid: false,
    })).toBeNull();
  });

  it("allows a matched step to be confirmed even when it has no diagram", () => {
    expect(resolvePlanUpdateStructureTarget(alignment, "old-clean", [
      { ...nextSteps[0], expectedStateHash: null },
      nextSteps[1],
    ], {
      templateVersionId: "template-v2",
      stateHash: "step-zero",
      valid: true,
    })?.key).toBe("template-step:new-clean");
  });
});
