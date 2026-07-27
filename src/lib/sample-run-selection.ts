import type { SampleRun } from "../../shared/types";

type SelectableRun = Pick<SampleRun, "id" | "runKind" | "status">;

export function selectSamplePageRuns(runs: readonly SelectableRun[]) {
  return {
    activeProcessRun: runs.find((run) => run.runKind === "process" && run.status === "active") ?? null,
    activeMetrologyRun: runs.find((run) => run.runKind === "metrology" && run.status === "active") ?? null,
    latestProcessRun: runs.find((run) => run.runKind === "process") ?? null,
    processRunCount: runs.filter((run) => run.runKind === "process").length,
  };
}
