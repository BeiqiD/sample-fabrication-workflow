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
      inherited_state_hash: "state-parent-snapshot",
      pinned: 1,
      created_at: "2026-07-19T10:00:00.000Z",
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
      inheritedStateHash: "state-parent-snapshot",
      pinned: true,
      createdAt: "2026-07-19T10:00:00.000Z",
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
      inheritedStateHash: null,
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

  it("preserves native thumbnail identity without inventing a legacy storage key", () => {
    const row = { id: "sample-native", code: "NATIVE", title: "Native", status: "stored" as const,
      location: null, parent_id: null, pinned: 0, updated_at: "2026-10-05T12:00:00.000Z" };
    expect(sampleSummary({ ...row, current_state_thumbnail_json: JSON.stringify({ assetId: "native-image", fileId: "native-file", key: null }) }))
      .toMatchObject({ currentStateThumbnailKey: null, currentStateThumbnailUrl: "/api/file-assets/native-image" });
    expect(sampleSummary({ ...row, current_state_thumbnail_json: JSON.stringify({ assetId: "old-image", fileId: "old-file", key: "images/old.png" }) }))
      .toMatchObject({ currentStateThumbnailKey: "images/old.png" });
  });

  it("exposes native event URLs only with typed bindings and hides deleted attachments", () => {
    const row = { id: "native-event", sample_id: "sample-native", kind: "image" as const, body: null, asset_key: null,
      asset_file_id: "native-file", thumbnail_file_id: "native-preview", created_at: "2026-10-05T12:00:00.000Z" };
    const metadata = { action: "sample_record", assetId: "native-image", thumbnailAssetId: "preview-image" };
    expect(sampleEvent({ ...row, metadata_json: JSON.stringify(metadata) })).toMatchObject({ assetKey: null,
      assetUrl: "/api/file-assets/native-image", thumbnailUrl: "/api/file-assets/preview-image" });
    expect(sampleEvent({ ...row, asset_file_id: null, thumbnail_file_id: null, metadata_json: JSON.stringify(metadata) }).assetUrl).toBeUndefined();
    const hidden = sampleEvent({ ...row, metadata_json: JSON.stringify({ ...metadata, assetDeletedAt: "2026-10-05T12:01:00.000Z" }) });
    expect(hidden.assetUrl).toBeUndefined(); expect(hidden.thumbnailUrl).toBeUndefined();
  });
});
