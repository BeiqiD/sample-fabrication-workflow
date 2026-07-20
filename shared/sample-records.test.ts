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
});
