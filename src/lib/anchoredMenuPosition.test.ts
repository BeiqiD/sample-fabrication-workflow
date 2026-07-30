import { describe, expect, it } from "vitest";
import { anchoredMenuPosition } from "./anchoredMenuPosition";

describe("anchoredMenuPosition", () => {
  it("opens below the trigger when there is enough room", () => {
    expect(anchoredMenuPosition(
      { top: 120, right: 300, bottom: 152 },
      { width: 180, height: 90 },
      { width: 800, height: 600 },
    )).toEqual({ left: 120, top: 158, placement: "below" });
  });

  it("opens above a trigger near the bottom of the viewport", () => {
    expect(anchoredMenuPosition(
      { top: 520, right: 300, bottom: 552 },
      { width: 180, height: 90 },
      { width: 800, height: 600 },
    )).toEqual({ left: 120, top: 424, placement: "above" });
  });

  it("keeps the menu inside narrow viewport gutters", () => {
    expect(anchoredMenuPosition(
      { top: 120, right: 190, bottom: 152 },
      { width: 240, height: 90 },
      { width: 220, height: 600 },
    )).toEqual({ left: 8, top: 158, placement: "below" });
  });
});
