import { describe, expect, it } from "vitest";
import { SAMPLE_HISTORY_PREVIEW_COUNT, visibleSampleHistory } from "./sampleHistory";

describe("visibleSampleHistory", () => {
  const events = Array.from({ length: 8 }, (_, index) => `event-${index + 1}`);

  it("shows only the newest entries by default", () => {
    expect(visibleSampleHistory(events, false)).toEqual(events.slice(0, SAMPLE_HISTORY_PREVIEW_COUNT));
  });

  it("shows the complete history when expanded without mutating the input", () => {
    const visible = visibleSampleHistory(events, true);
    expect(visible).toEqual(events);
    expect(visible).not.toBe(events);
    expect(events).toHaveLength(8);
  });
});
