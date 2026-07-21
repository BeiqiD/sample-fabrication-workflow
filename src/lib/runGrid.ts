import type { RunStep, SampleDetail, SampleRun } from "../../shared/types";

export interface RunGridColumn {
  sample: SampleDetail;
  run: SampleRun | null;
}

export interface RunGridRow {
  key: string;
  recipeStep: RunStep | null;
  steps: Array<RunStep | null>;
  adHocBefore: Array<RunStep[]>;
  adHocAfter: Array<RunStep[]>;
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
    recipeStep,
    steps: templateStepsByColumn.map((steps) => recipeStep.logicalStepKey
      ? steps.find((step) => step.logicalStepKey === recipeStep.logicalStepKey) ?? null
      : steps[recipeIndex] ?? null),
    adHocBefore: Array.from({ length: columns.length }, (): RunStep[] => []),
    adHocAfter: Array.from({ length: columns.length }, (): RunStep[] => []),
  }));

  const leadingAdHoc = Array.from({ length: columns.length }, (): RunStep[] => []);
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
      if (anchorIndex < 0) leadingAdHoc[columnIndex].push(step);
      else templateRows[anchorIndex]?.adHocAfter[columnIndex].push(step);
    }
  });

  if (templateRows[0]) templateRows[0].adHocBefore = leadingAdHoc;
  return templateRows;
}
