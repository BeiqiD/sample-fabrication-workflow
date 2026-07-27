import { describe, expect, it } from "vitest";
import { selectSamplePageRuns } from "./sample-run-selection";

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
