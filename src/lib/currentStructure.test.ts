import { describe, expect, it } from "vitest";
import { currentStructurePresentation, hasRecordedStructure } from "./currentStructure";

const baseSample = {
  currentStateStepTitle: null,
  currentStateThumbnailKey: null,
  latestWorkflowName: null,
  latestWorkflowVersion: null,
  inheritedStateHash: null,
  parent: null,
};

describe("current structure presentation", () => {
  it("describes a completed process step as the current structure", () => {
    expect(currentStructurePresentation({
      ...baseSample,
      currentStateStepTitle: "Mesa etch",
      latestWorkflowName: "Device process",
      latestWorkflowVersion: 2,
    })).toEqual({
      source: "process-step",
      title: "After Mesa etch",
      detail: "Device process · v2",
    });
  });

  it("describes the initial substrate of an existing process run", () => {
    expect(currentStructurePresentation({
      ...baseSample,
      latestWorkflowName: "Device process",
      latestWorkflowVersion: 1,
    })).toEqual({
      source: "process-run",
      title: "Latest recorded substrate",
      detail: "Device process · v1",
    });
  });

  it("treats a child snapshot as a valid inherited current structure", () => {
    const inherited = {
      ...baseSample,
      inheritedStateHash: "state-hash",
      parent: { id: "parent-1", code: "SOD-014", title: "Parent sample" },
    };
    expect(currentStructurePresentation(inherited)).toEqual({
      source: "inherited",
      title: "Inherited structure",
      detail: "Snapshot inherited from SOD-014 when this sample was split.",
    });
    expect(hasRecordedStructure(inherited)).toBe(true);
  });

  it("uses the empty state only when no process or inherited structure exists", () => {
    expect(currentStructurePresentation(baseSample)).toEqual({
      source: "empty",
      title: "No process structure yet",
      detail: "Start a process run to establish the first substrate snapshot.",
    });
    expect(hasRecordedStructure(baseSample)).toBe(false);
  });
});
