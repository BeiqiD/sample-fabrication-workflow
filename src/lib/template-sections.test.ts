import { describe, expect, it } from "vitest";
import { normalizeSectionName, sectionNameAtGroupStart } from "./template-sections";

describe("template section display", () => {
  it("hides empty and imported placeholder section names", () => {
    expect(normalizeSectionName(null)).toBeNull();
    expect(normalizeSectionName("   ")).toBeNull();
    expect(normalizeSectionName("Unnamed Section")).toBeNull();
    expect(normalizeSectionName("  unnamed   section  ")).toBeNull();
  });

  it("normalizes meaningful section names", () => {
    expect(normalizeSectionName("  Surface   preparation ")).toBe("Surface preparation");
  });

  it("shows a section only at the start of each consecutive group", () => {
    const steps = [
      { sectionName: "Preparation" },
      { sectionName: "Preparation" },
      { sectionName: "Unnamed Section" },
      { sectionName: "Deposition" },
      { sectionName: "Deposition" },
    ];

    expect(steps.map((_, index) => sectionNameAtGroupStart(steps, index))).toEqual([
      "Preparation",
      null,
      null,
      "Deposition",
      null,
    ]);
  });
});
