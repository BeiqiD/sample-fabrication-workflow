import { describe, expect, it } from "vitest";
import type { RunStep } from "../../shared/types";
import { runStepIsModified } from "./runSteps";

function step(overrides: Partial<RunStep> = {}): RunStep {
  return {
    id: "step", position: 1000, origin: "template", title: "Etch", status: "pending", notes: null,
    toolName: "RIE", parametersText: "10 s", commentsText: "Baseline", deviationNote: null,
    plannedTitle: "Etch", plannedToolName: "RIE", plannedParametersText: "10 s", plannedCommentsText: "Baseline",
    plannedImageKeys: [], executionImageKeys: [], createdAt: "2026-01-01", updatedAt: "2026-01-01",
    ...overrides,
  };
}

describe("sample run deviations", () => {
  it("keeps an unchanged snapshot unmarked", () => expect(runStepIsModified(step())).toBe(false));
  it("marks changed actual parameters", () => expect(runStepIsModified(step({ parametersText: "12 s" }))).toBe(true));
  it("always marks ad hoc steps", () => expect(runStepIsModified(step({ origin: "ad_hoc", plannedTitle: null }))).toBe(true));
});
