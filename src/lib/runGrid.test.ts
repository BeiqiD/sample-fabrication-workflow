import { describe, expect, it } from "vitest";
import type { RunStep, SampleDetail, SampleRun } from "../../shared/types";
import { buildRunGrid, findCurrentRunGridRow, runGridSectionProgress, visibleRunGridSections } from "./runGrid";

function step(id: string, position: number, overrides: Partial<RunStep> = {}): RunStep {
  return {
    id,
    templateStepId: id,
    logicalStepKey: id,
    sectionName: null,
    definitionHash: `hash:${id}`,
    expectedStateHash: null,
    position,
    planPosition: null,
    origin: "template",
    entryKind: "fabrication",
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
    runKind: "process",
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
    inheritedStateHash: null,
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
  it("finds the first row with a non-terminal step across all matching samples", () => {
    const rows = buildRunGrid([
      {
        sample: sample("a"),
        run: run("a-run", [
          step("clean", 1000, { status: "done" }),
          step("coat", 2000, { status: "blocked" }),
          step("develop", 3000, { status: "done" }),
        ]),
      },
      {
        sample: sample("b"),
        run: run("b-run", [
          step("clean-b", 1000, { logicalStepKey: "clean", status: "skipped" }),
          step("coat-b", 2000, { logicalStepKey: "coat", status: "in_progress" }),
          step("develop-b", 3000, { logicalStepKey: "develop", status: "pending" }),
        ]),
      },
      {
        sample: sample("c"),
        run: run("c-run", [
          step("clean-c", 1000, { logicalStepKey: "clean", status: "done" }),
          step("coat-c", 2000, { logicalStepKey: "coat", status: "pending" }),
          step("develop-c", 3000, { logicalStepKey: "develop", status: "pending" }),
        ]),
      },
      { sample: sample("d"), run: null },
    ]);

    expect(findCurrentRunGridRow(rows)).toEqual({
      row: rows[1],
      rowIndex: 1,
      unfinishedColumnIndexes: [0, 1, 2],
    });
  });

  it("has no current row when every existing step is done or skipped", () => {
    const rows = buildRunGrid([
      { sample: sample("a"), run: run("a-run", [step("one", 1000, { status: "done" })]) },
      { sample: sample("b"), run: run("b-run", [step("one-b", 1000, { logicalStepKey: "one", status: "skipped" })]) },
    ]);

    expect(findCurrentRunGridRow(rows)).toBeNull();
  });

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

  it("renders the active template order without rewriting execution positions", () => {
    const rows = buildRunGrid([
      {
        sample: sample("a"),
        run: run("a-run", [
          step("clean", 1000, {
            status: "done",
            actualizedAt: "2026-01-01T01:00:00.000Z",
            planPosition: 1,
          }),
          step("pre-clean", 2000, {
            status: "skipped",
            actualizedAt: "2026-01-01T02:00:00.000Z",
            planPosition: 0,
          }),
          step("coat", 3000, { planPosition: 2 }),
        ]),
      },
    ]);
    expect(rows.map((row) => row.recipeStep?.id)).toEqual(["pre-clean", "clean", "coat"]);
  });

  it("hides a removed actualized step from the current process plan", () => {
    const rows = buildRunGrid([
      {
        sample: sample("a"),
        run: run("a-run", [
          step("clean", 1000, { planPosition: 0 }),
          step("obsolete", 2000, {
            planStatus: "superseded",
            status: "done",
            actualizedAt: "2026-01-01T01:00:00.000Z",
          }),
          step("coat", 3000, { planPosition: 1 }),
        ]),
      },
    ]);
    expect(rows.map((row) => row.recipeStep?.id)).toEqual(["clean", "coat"]);
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

  it("keeps metrology between fabrication steps without counting it as a process step", () => {
    const metrology = step("sem", 1500, {
      origin: "ad_hoc",
      entryKind: "metrology",
      templateStepId: "sem-template",
      logicalStepKey: "metrology:sem",
    });
    const rows = buildRunGrid([
      { sample: sample("a"), run: run("a-run", [step("one", 1000), metrology, step("two", 2000)]) },
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["template", "metrology", "template"]);
    expect(rows.filter((row) => row.kind === "template")).toHaveLength(2);
    expect(rows[1].steps[0]).toBe(metrology);
  });

  it("renders a standalone metrology run as one metrology row", () => {
    const metrology = step("xrd", 1000, {
      entryKind: "metrology",
      logicalStepKey: "metrology:xrd",
    });
    const rows = buildRunGrid([
      { sample: sample("a"), run: run("xrd-run", [metrology]) },
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["metrology"]);
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

  it("creates compact section boundaries only when the plan has multiple groups", () => {
    const rows = buildRunGrid([
      {
        sample: sample("a"),
        run: run("a-run", [
          step("clean", 1000, { sectionName: "Preparation" }),
          step("coat", 2000, { sectionName: "Lithography" }),
          step("develop", 3000, { sectionName: "Lithography" }),
        ]),
      },
    ]);

    expect(visibleRunGridSections(rows).map((section) => ({
      label: section.label,
      startIndex: section.startIndex,
      endIndex: section.endIndex,
    }))).toEqual([
      { label: "Preparation", startIndex: 0, endIndex: 0 },
      { label: "Lithography", startIndex: 1, endIndex: 2 },
    ]);
  });

  it("derives per-sample section progress and gives blocked state precedence", () => {
    const rows = buildRunGrid([
      {
        sample: sample("a"),
        run: run("a-run", [
          step("clean", 1000, { sectionName: "Preparation", status: "done" }),
          step("coat", 2000, { sectionName: "Lithography", status: "skipped" }),
          step("develop", 3000, { sectionName: "Lithography", status: "blocked" }),
        ]),
      },
      {
        sample: sample("b"),
        run: run("b-run", [
          step("clean-b", 1000, { logicalStepKey: "clean", sectionName: "Preparation" }),
          step("coat-b", 2000, { logicalStepKey: "coat", sectionName: "Lithography", status: "done" }),
          step("develop-b", 3000, { logicalStepKey: "develop", sectionName: "Lithography", status: "done" }),
        ]),
      },
    ]);
    const lithography = visibleRunGridSections(rows)[1];

    expect(runGridSectionProgress(rows, lithography, 0)).toEqual({
      completed: 1,
      total: 2,
      blocked: true,
      percent: 50,
    });
    expect(runGridSectionProgress(rows, lithography, 1)).toEqual({
      completed: 2,
      total: 2,
      blocked: false,
      percent: 100,
    });
  });
});
