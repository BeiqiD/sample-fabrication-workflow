import { describe, expect, it } from "vitest";
import {
  normalizeSectionName,
  sectionHeaderAtGroupStart,
  sectionNameAtGroupStart,
  visibleSectionGroups,
} from "./template-sections";

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

  it("omits the header when every step belongs to one section", () => {
    const steps = [
      { sectionName: "Lithography" },
      { sectionName: "Lithography" },
    ];

    expect(visibleSectionGroups(steps)).toEqual([]);
    expect(steps.map((_, index) => sectionHeaderAtGroupStart(steps, index))).toEqual([null, null]);
  });

  it("uses a quiet fallback label for an unsectioned group among named sections", () => {
    const steps = [
      { sectionName: "Preparation" },
      { sectionName: "Unnamed Section" },
      { sectionName: null },
      { sectionName: "Bonding" },
    ];

    expect(visibleSectionGroups(steps).map((group) => group.label)).toEqual([
      "Preparation",
      "Other steps",
      "Bonding",
    ]);
    expect(steps.map((_, index) => sectionHeaderAtGroupStart(steps, index))).toEqual([
      "Preparation",
      "Other steps",
      null,
      "Bonding",
    ]);
  });
});
