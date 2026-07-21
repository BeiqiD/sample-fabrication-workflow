import type { RunStep, SampleDetail, SampleRun } from "../../shared/types";

export interface RunGridColumn {
  sample: SampleDetail;
  run: SampleRun | null;
}

export interface RunGridRow {
  key: string;
  kind: "template" | "ad_hoc";
  recipeStep: RunStep | null;
  steps: Array<RunStep | null>;
}

function orderedSteps(run: SampleRun | null) {
  return run ? [...run.steps].filter((step) => step.planStatus !== "superseded" || step.actualizedAt)
    .sort((left, right) => left.position - right.position) : [];
}

export function buildRunGrid(columns: RunGridColumn[]): RunGridRow[] {
  const primaryRun = columns[0]?.run ?? null;
  if (!primaryRun) return [];
  const primaryTemplateSteps = orderedSteps(primaryRun).filter((step) => step.origin === "template");
  const templateStepsByColumn = columns.map(({ run }) => orderedSteps(run).filter((step) => step.origin === "template"));
  const primaryIndexByLogicalKey = new Map(
    primaryTemplateSteps.flatMap((step, index) => step.logicalStepKey ? [[step.logicalStepKey, index] as const] : []),
  );

  const templateRows = primaryTemplateSteps.map<RunGridRow>((recipeStep, recipeIndex) => ({
    key: `template:${recipeStep.logicalStepKey ?? recipeStep.templateStepId ?? recipeIndex}`,
    kind: "template",
    recipeStep,
    steps: templateStepsByColumn.map((steps) => recipeStep.logicalStepKey
      ? steps.find((step) => step.logicalStepKey === recipeStep.logicalStepKey) ?? null
      : steps[recipeIndex] ?? null),
  }));

  const adHocByAnchor = Array.from(
    { length: primaryTemplateSteps.length + 1 },
    () => Array.from({ length: columns.length }, (): RunStep[] => []),
  );
  columns.forEach(({ run }, columnIndex) => {
    const steps = orderedSteps(run);
    let templateOrdinal = -1;
    let anchorIndex = -1;
    for (const step of steps) {
      if (step.origin === "template") {
        templateOrdinal += 1;
        anchorIndex = step.logicalStepKey
          ? primaryIndexByLogicalKey.get(step.logicalStepKey) ?? templateOrdinal
          : templateOrdinal;
        continue;
      }
      const bucketIndex = Math.max(0, Math.min(primaryTemplateSteps.length, anchorIndex + 1));
      adHocByAnchor[bucketIndex][columnIndex].push(step);
    }
  });

  const rows: RunGridRow[] = [];
  for (let bucketIndex = 0; bucketIndex < adHocByAnchor.length; bucketIndex += 1) {
    if (bucketIndex > 0) rows.push(templateRows[bucketIndex - 1]);
    const bucket = adHocByAnchor[bucketIndex];
    const rowCount = Math.max(0, ...bucket.map((steps) => steps.length));
    for (let adHocIndex = 0; adHocIndex < rowCount; adHocIndex += 1) {
      rows.push({
        key: `ad-hoc:${bucketIndex}:${adHocIndex}`,
        kind: "ad_hoc",
        recipeStep: null,
        steps: bucket.map((steps) => steps[adHocIndex] ?? null),
      });
    }
  }
  return rows;
}
