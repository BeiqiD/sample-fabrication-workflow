import type { SampleRun } from "../../shared/types";

function matchingSeries(runs: SampleRun[], selectedRun: SampleRun) {
  return runs
    .filter((run) => run.runKind === selectedRun.runKind
      && run.recipeFamilyId === selectedRun.recipeFamilyId)
    .sort((left, right) => left.sequenceNo - right.sequenceNo
      || left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id));
}

export function correspondingRunForSelectedRun(
  selectedRun: SampleRun,
  primaryRuns: SampleRun[],
  candidateRuns: SampleRun[],
) {
  const primarySeries = matchingSeries(primaryRuns, selectedRun);
  const occurrence = primarySeries.findIndex((run) => run.id === selectedRun.id);
  if (occurrence < 0) return null;

  const candidate = matchingSeries(candidateRuns, selectedRun)[occurrence] ?? null;
  return candidate?.status === selectedRun.status ? candidate : null;
}
