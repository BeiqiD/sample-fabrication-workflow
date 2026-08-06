import type { SampleRun } from "../../shared/types";

function sameRunSelection(candidate: SampleRun, selectedRun: SampleRun) {
  return candidate.runKind === selectedRun.runKind
    && candidate.recipeFamilyId === selectedRun.recipeFamilyId
    && candidate.status === selectedRun.status;
}

function matchingMetrologySeries(runs: SampleRun[], selectedRun: SampleRun) {
  return runs
    .filter((run) => run.runKind === "metrology"
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
  if (selectedRun.runKind !== "metrology") {
    return candidateRuns.find((candidate) => sameRunSelection(candidate, selectedRun)) ?? null;
  }

  const primarySeries = matchingMetrologySeries(primaryRuns, selectedRun);
  const occurrence = primarySeries.findIndex((run) => run.id === selectedRun.id);
  if (occurrence < 0) return null;

  const candidate = matchingMetrologySeries(candidateRuns, selectedRun)[occurrence] ?? null;
  return candidate?.status === selectedRun.status ? candidate : null;
}
