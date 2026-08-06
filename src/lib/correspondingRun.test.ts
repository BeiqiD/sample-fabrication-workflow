import { describe, expect, it } from "vitest";
import type { SampleRun } from "../../shared/types";
import { correspondingRunForSelectedRun } from "./correspondingRun";

function run(id: string, sequenceNo: number, overrides: Partial<SampleRun> = {}): SampleRun {
  return {
    id,
    recipeFamilyId: "sem-family",
    templateVersionId: "sem-template",
    templateName: "SEM",
    templateType: "module",
    templateVersion: 1,
    runKind: "metrology",
    status: "complete",
    currentPlanRevisionId: null,
    planRevisionNumber: 1,
    predecessorRunId: null,
    anchorStepId: null,
    sequenceNo,
    runGroupId: `group:${id}`,
    initialStateHash: null,
    initialStateImageKeys: [],
    createdAt: `2026-08-${String(sequenceNo).padStart(2, "0")}T00:00:00.000Z`,
    completedAt: `2026-08-${String(sequenceNo).padStart(2, "0")}T01:00:00.000Z`,
    steps: [],
    ...overrides,
  };
}

describe("corresponding run selection", () => {
  it("maps the second SEM run to the second SEM run instead of the first", () => {
    const primarySem1 = run("primary-sem-1", 2);
    const primarySem2 = run("primary-sem-2", 5);
    const candidateSem1 = run("candidate-sem-1", 1);
    const candidateSem2 = run("candidate-sem-2", 7);

    expect(correspondingRunForSelectedRun(
      primarySem2,
      [run("primary-process", 1, { runKind: "process", recipeFamilyId: "process-family" }), primarySem2, primarySem1],
      [candidateSem2, run("candidate-afm", 4, { recipeFamilyId: "afm-family" }), candidateSem1],
    )?.id).toBe("candidate-sem-2");
  });

  it("returns no match when the other sample does not have the same occurrence", () => {
    const primarySem1 = run("primary-sem-1", 1);
    const primarySem2 = run("primary-sem-2", 2);

    expect(correspondingRunForSelectedRun(
      primarySem2,
      [primarySem1, primarySem2],
      [run("candidate-sem-1", 1)],
    )).toBeNull();
  });

  it("does not mix active and completed occurrences", () => {
    const selected = run("primary-sem-2", 2);
    const candidate = run("candidate-sem-2", 2, { status: "active", completedAt: null });

    expect(correspondingRunForSelectedRun(
      selected,
      [run("primary-sem-1", 1), selected],
      [run("candidate-sem-1", 1), candidate],
    )).toBeNull();
  });
});
