import { describe, expect, it } from "vitest";
import type { RunStep, SampleDetail, SampleRun } from "../../shared/types";
import { buildRunGrid } from "./runGrid";

function step(id: string, position: number, overrides: Partial<RunStep> = {}): RunStep {
  return {
    id,
    templateStepId: id,
    logicalStepKey: id,
    definitionHash: `hash:${id}`,
    expectedStateHash: null,
    position,
    origin: "template",
    planStatus: "current",
    title: id,
    status: "pending",
    notes: null,
    toolName: null,
    parametersText: null,
    commentsText: null,
    deviationNote: null,
    plannedTitle: id,
    plannedToolName: null,
    plannedParametersText: null,
    plannedCommentsText: null,
    plannedImageKeys: [],
    executionImageKeys: [],
    comments: [],
    actualizedAt: null,
    verificationIds: [],
    stateVerification: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function run(id: string, steps: RunStep[]): SampleRun {
  return {
    id,
    recipeFamilyId: "recipe-family",
    templateVersionId: "recipe-v1",
    templateName: "Recipe",
    templateType: "recipe",
    templateVersion: 1,
    status: "active",
    currentPlanRevisionId: "plan-1",
    planRevisionNumber: 1,
    predecessorRunId: null,
    anchorStepId: null,
    sequenceNo: 1,
    runGroupId: "group-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    steps,
  };
}

function sample(id: string): SampleDetail {
  return {
    id,
    code: id.toUpperCase(),
    title: id,
    status: "active",
    location: null,
    parentId: null,
    pinned: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestWorkflowName: null,
    latestWorkflowVersion: null,
    latestRunStatus: null,
    currentStepTitle: null,
    currentStateStepTitle: null,
    currentStateThumbnailKey: null,
    description: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    parent: null,
    children: [],
    events: [],
    runs: [],
    stateVerifications: [],
  };
}

describe("multi-sample run grid", () => {
  it("aligns template rows by logical key across recipe versions and different positions", () => {
    const rows = buildRunGrid([
      { sample: sample("a"), run: run("a-run", [step("one", 1000), step("two", 2000)]) },
      { sample: sample("b"), run: run("b-run", [step("v2-one", 500, { templateStepId: "v2-one", logicalStepKey: "one" }), step("v2-two", 9000, { templateStepId: "v2-two", logicalStepKey: "two" })]) },
    ]);
    expect(rows.map((row) => row.steps.map((item) => item?.id))).toEqual([
      ["one", "v2-one"],
      ["two", "v2-two"],
    ]);
  });

  it("adds an individual ad hoc step as its own row after the recipe anchor", () => {
    const extra = step("extra", 1500, { origin: "ad_hoc", templateStepId: null });
    const rows = buildRunGrid([
      { sample: sample("a"), run: run("a-run", [step("one", 1000), step("two", 2000)]) },
      { sample: sample("b"), run: run("b-run", [step("one", 1000), extra, step("two", 2000)]) },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.kind)).toEqual(["template", "ad_hoc", "template"]);
    expect(rows[1].steps).toEqual([null, extra]);
  });

  it("keeps leading ad hoc steps in aligned rows before the first recipe step", () => {
    const aLeading = step("a-leading", 500, { origin: "ad_hoc", templateStepId: null });
    const bLeading = step("b-leading", 700, { origin: "ad_hoc", templateStepId: null });
    const rows = buildRunGrid([
      { sample: sample("a"), run: run("a-run", [aLeading, step("one", 1000)]) },
      { sample: sample("b"), run: run("b-run", [bLeading, step("one", 1000)]) },
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["ad_hoc", "template"]);
    expect(rows[0].steps).toEqual([aLeading, bLeading]);
  });

  it("aligns the first ad hoc step from each sample in one shared additional row", () => {
    const aExtra = step("a-extra", 1400, { origin: "ad_hoc", templateStepId: null });
    const bExtra = step("b-extra", 1500, { origin: "ad_hoc", templateStepId: null });
    const rows = buildRunGrid([
      { sample: sample("a"), run: run("a-run", [step("one", 1000), aExtra, step("two", 2000)]) },
      { sample: sample("b"), run: run("b-run", [step("one", 1000), bExtra, step("two", 2000)]) },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[1].kind).toBe("ad_hoc");
    expect(rows[1].steps).toEqual([aExtra, bExtra]);
  });

  it("uses another shared row only when a sample has another ad hoc step at the same position", () => {
    const aFirst = step("a-first", 1300, { origin: "ad_hoc", templateStepId: null });
    const aSecond = step("a-second", 1400, { origin: "ad_hoc", templateStepId: null });
    const bFirst = step("b-first", 1500, { origin: "ad_hoc", templateStepId: null });
    const rows = buildRunGrid([
      { sample: sample("a"), run: run("a-run", [step("one", 1000), aFirst, aSecond, step("two", 2000)]) },
      { sample: sample("b"), run: run("b-run", [step("one", 1000), bFirst, step("two", 2000)]) },
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["template", "ad_hoc", "ad_hoc", "template"]);
    expect(rows[1].steps).toEqual([aFirst, bFirst]);
    expect(rows[2].steps).toEqual([aSecond, null]);
  });

  it("keeps a column present when a sample has no matching run", () => {
    const rows = buildRunGrid([
      { sample: sample("a"), run: run("a-run", [step("one", 1000)]) },
      { sample: sample("b"), run: null },
    ]);
    expect(rows[0].steps).toEqual([expect.objectContaining({ id: "one" }), null]);
  });
});
