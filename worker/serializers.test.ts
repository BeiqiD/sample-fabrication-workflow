import { describe, expect, it } from "vitest";
import { sampleEvent, sampleSummary } from "./serializers";

describe("D1 serializers", () => {
  it("maps sample flags and snake-case columns", () => {
    expect(sampleSummary({
      id: "sample-1",
      code: "SOD-001",
      title: "Stage one",
      status: "active",
      location: "Box A",
      parent_id: null,
      pinned: 1,
      updated_at: "2026-07-20T10:00:00.000Z",
      latest_workflow_name: "Mesa etch",
      latest_workflow_version: 3,
      latest_run_status: "active",
      current_step_title: "Strip resist",
      current_state_step_title: "Develop resist",
      current_state_thumbnail_key: "imports/recipe/images/state.png",
    })).toEqual({
      id: "sample-1",
      code: "SOD-001",
      title: "Stage one",
      status: "active",
      location: "Box A",
      parentId: null,
      pinned: true,
      updatedAt: "2026-07-20T10:00:00.000Z",
      latestWorkflowName: "Mesa etch",
      latestWorkflowVersion: 3,
      latestRunStatus: "active",
      currentStepTitle: "Strip resist",
      currentStateStepTitle: "Develop resist",
      currentStateThumbnailKey: "imports/recipe/images/state.png",
    });
  });

  it("uses empty workflow metadata for a sample without an assigned recipe", () => {
    expect(sampleSummary({
      id: "sample-2",
      code: "SOD-002",
      title: "Unassigned sample",
      status: "stored",
      location: null,
      parent_id: null,
      pinned: 0,
      updated_at: "2026-07-20T10:00:00.000Z",
    })).toEqual(expect.objectContaining({
      latestWorkflowName: null,
      latestWorkflowVersion: null,
      latestRunStatus: null,
      currentStepTitle: null,
      currentStateStepTitle: null,
      currentStateThumbnailKey: null,
    }));
  });

  it("parses event metadata", () => {
    expect(sampleEvent({
      id: "event-1",
      sample_id: "sample-1",
      kind: "step",
      body: "Spin coat complete",
      asset_key: null,
      metadata_json: "{\"stepStatus\":\"done\"}",
      created_at: "2026-07-20T10:05:00.000Z",
    }).metadata).toEqual({ stepStatus: "done" });
  });
});
