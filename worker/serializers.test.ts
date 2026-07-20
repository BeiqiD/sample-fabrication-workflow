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
    })).toEqual({
      id: "sample-1",
      code: "SOD-001",
      title: "Stage one",
      status: "active",
      location: "Box A",
      parentId: null,
      pinned: true,
      updatedAt: "2026-07-20T10:00:00.000Z",
    });
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
