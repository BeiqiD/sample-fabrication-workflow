import type { SampleRun } from "../../shared/types";

type SelectableRun = Pick<SampleRun, "id" | "runKind" | "status">;

export type RunControlActionId = "update_plan" | "finish_run" | "reopen_process" | "view_active_process" | "delete_run";
export type StartRunActionId = "start_process" | "start_metrology";

export function selectSamplePageRuns(runs: readonly SelectableRun[]) {
  return {
    activeProcessRun: runs.find((run) => run.runKind === "process" && run.status === "active") ?? null,
    activeMetrologyRun: runs.find((run) => run.runKind === "metrology" && run.status === "active") ?? null,
    latestProcessRun: runs.find((run) => run.runKind === "process") ?? null,
    processRunCount: runs.filter((run) => run.runKind === "process").length,
  };
}

export function sampleRunControlTitle(runKind: SelectableRun["runKind"] | null | undefined) {
  if (runKind === "process") return "Process run";
  if (runKind === "metrology") return "Metrology run";
  return "Run";
}

export function sampleRunControlActionIds({
  selectedRun,
  activeProcessRun,
  latestProcessRun,
}: {
  selectedRun: SelectableRun | null;
  activeProcessRun: SelectableRun | null;
  latestProcessRun: SelectableRun | null;
}) {
  const runActions: RunControlActionId[] = [];
  if (selectedRun?.runKind === "process" && selectedRun.status === "active") {
    runActions.push("update_plan", "finish_run");
  } else if (!activeProcessRun && selectedRun?.runKind === "process"
    && selectedRun.status === "complete" && selectedRun.id === latestProcessRun?.id) {
    runActions.push("reopen_process");
  } else if (activeProcessRun && selectedRun?.id !== activeProcessRun.id) {
    runActions.push("view_active_process");
  }
  if (selectedRun) runActions.push("delete_run");

  const startActions: StartRunActionId[] = [];
  if (!activeProcessRun) startActions.push("start_process");
  startActions.push("start_metrology");

  return { runActions, startActions };
}
