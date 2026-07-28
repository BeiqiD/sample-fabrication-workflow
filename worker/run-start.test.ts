import { describe, expect, it } from "vitest";
import { validateSubstrateTransition } from "./run-start";

const facts = {
  sampleUpdatedAt: "2026-07-23T12:00:00.000Z",
  previousStateHash: "previous-state",
  templateStructureKey: "initial-substrate:template-2",
  templateStateHash: "template-step-zero",
  templateStateRequired: true,
  latestRunId: "run-1",
  currentPlanRevisionId: "revision-3",
};

const confirmation = {
  confirmed: true as const,
  expectedSampleUpdatedAt: facts.sampleUpdatedAt,
  expectedPreviousStateHash: facts.previousStateHash,
  expectedTemplateStructureKey: facts.templateStructureKey,
  expectedTemplateStateHash: facts.templateStateHash,
  expectedLatestRunId: facts.latestRunId,
  expectedCurrentPlanRevisionId: facts.currentPlanRevisionId,
};

describe("substrate transition confirmation", () => {
  it("requires explicit confirmation even when this is the first run", () => {
    expect(validateSubstrateTransition(undefined, {
      ...facts,
      previousStateHash: null,
      latestRunId: null,
      currentPlanRevisionId: undefined,
    })).toEqual({ ok: false, reason: "confirmation_required" });
  });

  it("accepts a reviewed first-run handoff with no previous structure", () => {
    expect(validateSubstrateTransition({
      ...confirmation,
      expectedPreviousStateHash: null,
      expectedLatestRunId: null,
      expectedCurrentPlanRevisionId: undefined,
    }, {
      ...facts,
      previousStateHash: null,
      latestRunId: null,
      currentPlanRevisionId: undefined,
    })).toEqual({ ok: true, confirmedTemplateStateHash: "template-step-zero" });
  });

  it("records Step 0 as the immutable run start instead of selecting either side", () => {
    expect(validateSubstrateTransition(confirmation, facts)).toEqual({
      ok: true,
      confirmedTemplateStateHash: "template-step-zero",
    });
  });

  it("rejects a transition when the template has no Step 0 snapshot", () => {
    expect(validateSubstrateTransition({
      ...confirmation,
      expectedTemplateStateHash: null,
    }, {
      ...facts,
      templateStateHash: null,
    })).toEqual({ ok: false, reason: "template_structure_missing" });
  });

  it("accepts a matched update step without a diagram", () => {
    expect(validateSubstrateTransition({
      ...confirmation,
      expectedTemplateStructureKey: "template-step:step-4",
      expectedTemplateStateHash: null,
    }, {
      ...facts,
      templateStructureKey: "template-step:step-4",
      templateStateHash: null,
      templateStateRequired: false,
    })).toEqual({ ok: true, confirmedTemplateStateHash: null });
  });

  it.each([
    ["sample revision", { expectedSampleUpdatedAt: "later" }],
    ["previous structure", { expectedPreviousStateHash: "changed" }],
    ["template structure", { expectedTemplateStateHash: "changed" }],
    ["template step", { expectedTemplateStructureKey: "template-step:changed" }],
    ["latest run", { expectedLatestRunId: "run-2" }],
    ["plan revision", { expectedCurrentPlanRevisionId: "revision-4" }],
  ])("rejects stale confirmation when the %s changed", (_label, change) => {
    expect(validateSubstrateTransition({ ...confirmation, ...change }, facts))
      .toEqual({ ok: false, reason: "stale_confirmation" });
  });
});
