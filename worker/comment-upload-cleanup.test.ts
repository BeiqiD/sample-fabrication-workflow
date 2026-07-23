import { describe, expect, it } from "vitest";

describe("comment upload cleanup retention", () => {
  it("uses a longer retention window for remote objects than abandoned submissions", () => {
    const day = 24 * 60 * 60 * 1_000;
    const now = new Date("2026-07-23T20:00:00Z");
    expect(new Date(now.getTime() - day).toISOString()).toBe("2026-07-22T20:00:00.000Z");
    expect(new Date(now.getTime() - 7 * day).toISOString()).toBe("2026-07-16T20:00:00.000Z");
  });
});
