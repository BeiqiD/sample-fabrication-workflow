import { describe, expect, it } from "vitest";
import { sampleRunControlActionIds, sampleRunControlTitle, selectSamplePageRuns } from "./sample-run-selection";

describe("selectSamplePageRuns", () => {
  it("keeps active process and standalone metrology actions independent", () => {
    const result = selectSamplePageRuns([
      { id: "metrology-active", runKind: "metrology", status: "active" },
      { id: "process-complete", runKind: "process", status: "complete" },
    ]);

    expect(result.activeProcessRun).toBeNull();
    expect(result.activeMetrologyRun?.id).toBe("metrology-active");
    expect(result.latestProcessRun?.id).toBe("process-complete");
    expect(result.processRunCount).toBe(1);
  });

  it("selects the newest active run of each kind from the ordered run list", () => {
    const result = selectSamplePageRuns([
      { id: "metrology-new", runKind: "metrology", status: "active" },
      { id: "process-new", runKind: "process", status: "active" },
      { id: "metrology-old", runKind: "metrology", status: "active" },
      { id: "process-old", runKind: "process", status: "complete" },
    ]);

    expect(result.activeProcessRun?.id).toBe("process-new");
    expect(result.activeMetrologyRun?.id).toBe("metrology-new");
    expect(result.latestProcessRun?.id).toBe("process-new");
    expect(result.processRunCount).toBe(2);
  });
});

describe("sampleRunControlTitle", () => {
  it("matches the title to the selected run kind", () => {
    expect(sampleRunControlTitle("process")).toBe("Process run");
    expect(sampleRunControlTitle("metrology")).toBe("Metrology run");
    expect(sampleRunControlTitle(null)).toBe("Run");
  });
});

describe("sampleRunControlActionIds", () => {
  const activeProcess = { id: "process-active", runKind: "process" as const, status: "active" as const };
  const completeProcess = { id: "process-complete", runKind: "process" as const, status: "complete" as const };
  const oldProcess = { id: "process-old", runKind: "process" as const, status: "complete" as const };
  const metrology = { id: "metrology", runKind: "metrology" as const, status: "complete" as const };

  it("separates actions on the selected active process from new-run actions", () => {
    expect(sampleRunControlActionIds({
      selectedRun: activeProcess,
      activeProcessRun: activeProcess,
      latestProcessRun: activeProcess,
    })).toEqual({
      runActions: ["update_plan", "finish_run"],
      startActions: ["start_metrology"],
    });
  });

  it("offers reopen only for the latest completed process without an active successor", () => {
    expect(sampleRunControlActionIds({
      selectedRun: completeProcess,
      activeProcessRun: null,
      latestProcessRun: completeProcess,
    })).toEqual({
      runActions: ["reopen_process"],
      startActions: ["start_process", "start_metrology"],
    });
    expect(sampleRunControlActionIds({
      selectedRun: oldProcess,
      activeProcessRun: null,
      latestProcessRun: completeProcess,
    }).runActions).toEqual([]);
  });

  it("keeps navigation to the active process out of the start-run menu", () => {
    expect(sampleRunControlActionIds({
      selectedRun: metrology,
      activeProcessRun: activeProcess,
      latestProcessRun: activeProcess,
    })).toEqual({
      runActions: ["view_active_process"],
      startActions: ["start_metrology"],
    });
  });

  it("allows both kinds of new run when no process is active", () => {
    expect(sampleRunControlActionIds({
      selectedRun: metrology,
      activeProcessRun: null,
      latestProcessRun: completeProcess,
    })).toEqual({
      runActions: [],
      startActions: ["start_process", "start_metrology"],
    });
  });
});
