import { describe, expect, it } from "vitest";
import type { TemplateRecord } from "./api";
import { groupTemplateVersions } from "./template-groups";

function template(overrides: Partial<TemplateRecord> & Pick<TemplateRecord, "id" | "recipeFamilyId" | "name" | "version">): TemplateRecord {
  return {
    templateType: "process",
    manifestHash: `${overrides.id}-manifest`,
    sourceFilename: null,
    stepCount: 3,
    initialStateHash: "state-1",
    initialStateImageKeys: [],
    initialSubstrateStep: null,
    locked: false,
    lockedAt: null,
    createdAt: `2026-07-${String(overrides.version).padStart(2, "0")}T10:00:00.000Z`,
    ...overrides,
  };
}

describe("template version grouping", () => {
  it("keeps versions from one process family together and newest first", () => {
    const groups = groupTemplateVersions([
      template({ id: "a-1", recipeFamilyId: "family-a", name: "Etch", version: 1 }),
      template({ id: "b-1", recipeFamilyId: "family-b", name: "Clean", version: 1 }),
      template({ id: "a-3", recipeFamilyId: "family-a", name: "Etch updated", version: 3 }),
      template({ id: "a-2", recipeFamilyId: "family-a", name: "Etch", version: 2 }),
    ]);

    expect(groups.map((group) => group.recipeFamilyId)).toEqual(["family-b", "family-a"]);
    expect(groups[1]).toMatchObject({
      name: "Etch updated",
      latestVersion: 3,
    });
    expect(groups[1].versions.map((version) => version.version)).toEqual([3, 2, 1]);
  });

  it("does not merge unrelated families that happen to share a name", () => {
    const groups = groupTemplateVersions([
      template({ id: "a-1", recipeFamilyId: "family-a", name: "Shared name", version: 1 }),
      template({ id: "b-1", recipeFamilyId: "family-b", name: "Shared name", version: 1 }),
    ]);

    expect(groups).toHaveLength(2);
  });
});
