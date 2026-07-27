import { describe, expect, it } from "vitest";
import type { ProcessTemplateVersionSummary } from "./api";
import {
  availableProcessTemplateVersions,
  selectedProcessTemplateVersionId,
} from "./process-template-picker";

function version(number: number): ProcessTemplateVersionSummary {
  return {
    id: `version-${number}`,
    recipeFamilyId: "family-1",
    name: "Etch",
    templateType: "process",
    version: number,
    sourceFilename: null,
    stepCount: 3,
    initialStateHash: null,
    hasInitialSubstrateStep: true,
    initialStateImageCount: 0,
    locked: false,
    createdAt: `2026-07-${number.toString().padStart(2, "0")}T10:00:00.000Z`,
  };
}

describe("process template picker", () => {
  const versions = [version(4), version(3), version(2), version(1)];

  it("keeps every version when starting a new process and defaults to the newest", () => {
    const available = availableProcessTemplateVersions(versions);
    expect(available.map((item) => item.version)).toEqual([4, 3, 2, 1]);
    expect(selectedProcessTemplateVersionId(available, "")).toBe("version-4");
  });

  it("keeps an explicitly selected older version", () => {
    expect(selectedProcessTemplateVersionId(versions, "version-2")).toBe("version-2");
  });

  it("offers only newer versions when updating or reopening a process", () => {
    const available = availableProcessTemplateVersions(versions, 2);
    expect(available.map((item) => item.version)).toEqual([4, 3]);
    expect(selectedProcessTemplateVersionId(available, "version-2")).toBe("version-4");
  });
});
