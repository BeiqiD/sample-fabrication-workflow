import { describe, expect, it } from "vitest";
import { isSampleRecordEvent } from "./sample-records";

describe("isSampleRecordEvent", () => {
  it("accepts sample-level text and photo records", () => {
    expect(isSampleRecordEvent("comment", {})).toBe(true);
    expect(isSampleRecordEvent("image", { action: "sample_record", thumbnailKey: "thumb" })).toBe(true);
  });

  it("protects execution images and system history", () => {
    expect(isSampleRecordEvent("image", { runId: "run-1", stepId: "step-1" })).toBe(false);
    expect(isSampleRecordEvent("step", { action: "updated" })).toBe(false);
    expect(isSampleRecordEvent("verification", {})).toBe(false);
  });

  it("does not offer audit or already-deleted events for deletion", () => {
    expect(isSampleRecordEvent("comment", { action: "sample_record_deleted" })).toBe(false);
    expect(isSampleRecordEvent("comment", { action: "sample_details_updated" })).toBe(false);
    expect(isSampleRecordEvent("comment", { action: "image_attachment_deleted" })).toBe(false);
    expect(isSampleRecordEvent("comment", { action: "sample_record", deletedAt: "2026-07-21T12:00:00Z" })).toBe(false);
  });
});
