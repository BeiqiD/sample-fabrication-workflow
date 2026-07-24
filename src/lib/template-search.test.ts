import { describe, expect, it } from "vitest";
import type { TemplateRecord } from "./api";
import type { TemplateFamilyGroup } from "./template-groups";
import { matchesTemplateFamilySearch, matchesTemplateSearch } from "./template-search";

function template(overrides: Partial<TemplateRecord> = {}): TemplateRecord {
  return {
    id: "template-1",
    recipeFamilyId: "family-1",
    name: "AFM",
    templateType: "process",
    templateKind: "metrology",
    version: 1,
    manifestHash: "manifest-1",
    sourceFilename: null,
    stepCount: 0,
    toolName: "Dimension 3100",
    parametersText: "Tapping mode",
    commentsText: "Use the soft cantilever",
    initialStateHash: null,
    initialStateImageKeys: [],
    initialSubstrateStep: null,
    locked: false,
    lockedAt: null,
    createdAt: "2026-07-24T08:00:00.000Z",
    ...overrides,
  };
}

describe("template search", () => {
  it("matches metrology title, tool, parameters, and comments without case sensitivity", () => {
    const record = template();
    expect(matchesTemplateSearch(record, "afm")).toBe(true);
    expect(matchesTemplateSearch(record, "DIMENSION tapping")).toBe(true);
    expect(matchesTemplateSearch(record, "soft cantilever")).toBe(true);
    expect(matchesTemplateSearch(record, "process")).toBe(false);
  });

  it("matches process version and workbook details", () => {
    const record = template({
      name: "Dry etch",
      templateKind: "process",
      version: 3,
      sourceFilename: "etch-plan.xlsx",
      stepCount: 7,
      locked: true,
    });
    expect(matchesTemplateSearch(record, "v3 locked")).toBe(true);
    expect(matchesTemplateSearch(record, "etch-plan")).toBe(true);
    expect(matchesTemplateSearch(record, "7 steps")).toBe(true);
    expect(matchesTemplateSearch(record, "editable")).toBe(false);
  });

  it("can match a process family independently of its individual versions", () => {
    const versions = [template({ templateKind: "process", name: "Oxide deposition" })];
    const family: TemplateFamilyGroup = {
      recipeFamilyId: "family-1",
      name: "Oxide deposition",
      templateType: "process",
      latestVersion: 1,
      versions,
    };
    expect(matchesTemplateFamilySearch(family, "fabrication oxide")).toBe(true);
    expect(matchesTemplateFamilySearch(family, "metrology")).toBe(false);
  });
});
