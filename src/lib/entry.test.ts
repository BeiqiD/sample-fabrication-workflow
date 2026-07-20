import { describe, expect, it } from "vitest";
import { normalizeLocation, sampleDetailsChanged } from "./entry";

describe("entry helpers", () => {
  it("normalizes blank and padded locations", () => {
    expect(normalizeLocation("   ")).toBeNull();
    expect(normalizeLocation(" Box A ")).toBe("Box A");
  });

  it("does not submit unchanged details", () => {
    expect(sampleDetailsChanged(
      { status: "active", location: "Box A", pinned: false },
      { status: "active", location: " Box A ", pinned: false },
    )).toBe(false);
  });

  it("detects each mutable sample field", () => {
    const current = { status: "active" as const, location: null, pinned: false };
    expect(sampleDetailsChanged(current, { status: "stored", location: "", pinned: false })).toBe(true);
    expect(sampleDetailsChanged(current, { status: "active", location: "Lab", pinned: false })).toBe(true);
    expect(sampleDetailsChanged(current, { status: "active", location: "", pinned: true })).toBe(true);
  });
});
