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

  it("does not silently compare Step 0 when the current step failed to align", () => {
    expect(resolvePlanUpdateStructureTarget(alignment, "renamed-current-step", nextSteps, {
      templateVersionId: "template-v2",
      stateHash: "step-zero",
      valid: true,
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
