import type { ProcessingSampleDetail, RunStep, SampleRun } from "../../shared/types";
import { visibleSectionGroups, type SectionGroup } from "./template-sections";

export interface RunGridColumn {
  sample: ProcessingSampleDetail;
  run: SampleRun | null;
}

export interface RunGridRow {
  key: string;
  kind: "template" | "ad_hoc" | "metrology";
  sectionName: string | null;
  recipeStep: RunStep | null;
  steps: Array<RunStep | null>;
}

export interface CurrentRunGridRow {
  row: RunGridRow;
  rowIndex: number;
  unfinishedColumnIndexes: number[];
}

function orderedSteps(run: SampleRun | null) {
  return run ? [...run.steps].filter((step) => step.planStatus === "current")
    .sort((left, right) => left.position - right.position) : [];
}

function orderedTemplateSteps(run: SampleRun | null) {
  return orderedSteps(run)
    .filter((step) => step.origin === "template" && step.entryKind === "fabrication")
    .sort((left, right) => {
      if (left.planPosition !== null && right.planPosition !== null) {
        return left.planPosition - right.planPosition;
      }
      if (left.planPosition !== null) return -1;
      if (right.planPosition !== null) return 1;
      return left.position - right.position;
    });
}

export function buildRunGrid(columns: RunGridColumn[]): RunGridRow[] {
  const primaryRun = columns[0]?.run ?? null;
  if (!primaryRun) return [];
  const primaryTemplateSteps = orderedTemplateSteps(primaryRun);
  const templateStepsByColumn = columns.map(({ run }) => orderedTemplateSteps(run));
  const primaryIndexByLogicalKey = new Map(
    primaryTemplateSteps.flatMap((step, index) => step.logicalStepKey ? [[step.logicalStepKey, index] as const] : []),
  );

  const templateRows = primaryTemplateSteps.map<RunGridRow>((recipeStep, recipeIndex) => ({
    key: `template:${recipeStep.logicalStepKey ?? recipeStep.templateStepId ?? recipeIndex}`,
    kind: "template",
    sectionName: recipeStep.sectionName,
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
      if (step.origin === "template" && step.entryKind === "fabrication") {
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
      const rowSteps = bucket.map((steps) => steps[adHocIndex] ?? null);
      rows.push({
        key: `ad-hoc:${bucketIndex}:${adHocIndex}`,
        kind: rowSteps.find(Boolean)?.entryKind === "metrology" ? "metrology" : "ad_hoc",
        sectionName: bucketIndex > 0
          ? primaryTemplateSteps[bucketIndex - 1]?.sectionName ?? null
          : primaryTemplateSteps[0]?.sectionName ?? null,
        recipeStep: null,
        steps: rowSteps,
      });
    }
  }
  return rows;
}

export function findCurrentRunGridRow(rows: RunGridRow[]): CurrentRunGridRow | null {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const unfinishedColumnIndexes = row.steps.flatMap((step, columnIndex) => (
      step && step.status !== "done" && step.status !== "skipped" ? [columnIndex] : []
    ));
    if (unfinishedColumnIndexes.length > 0) return { row, rowIndex, unfinishedColumnIndexes };
  }
  return null;
}

export interface RunGridSection extends SectionGroup {}

export function visibleRunGridSections(rows: RunGridRow[]): RunGridSection[] {
  return visibleSectionGroups(rows);
}

export function runGridSectionProgress(
  rows: RunGridRow[],
  section: RunGridSection,
  columnIndex: number,
) {
  const steps = rows
    .slice(section.startIndex, section.endIndex + 1)
    .flatMap((row) => {
      const step = row.steps[columnIndex];
      return step?.entryKind === "fabrication" ? [step] : [];
    });
  const completed = steps.filter((step) => step.status === "done" || step.status === "skipped").length;
  return {
    completed,
    total: steps.length,
    blocked: steps.some((step) => step.status === "blocked"),
    percent: steps.length ? Math.round((completed / steps.length) * 100) : 0,
  };
}
