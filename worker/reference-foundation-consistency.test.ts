import { describe, expect, it } from "vitest";
import {
  REFERENCE_TARGET_TO_PERMANENT_DELETE_SOURCE,
  REFERENCE_TARGET_TYPES,
} from "../shared/reference-types";
import { PERMANENT_DELETE_BLOCKER_SOURCE_TYPES } from "./blob-lifecycle/permanent-delete";
import { REFERENCE_ADAPTERS } from "./references/adapters";

describe("reference foundation target coverage", () => {
  it("keeps the public type registry and resolver adapters exact", () => {
    expect(Object.keys(REFERENCE_ADAPTERS).sort()).toEqual([...REFERENCE_TARGET_TYPES].sort());
  });

  it("maps every public target exactly once onto a permanent-delete blocker type", () => {
    const mapped = Object.values(REFERENCE_TARGET_TO_PERMANENT_DELETE_SOURCE);
    expect(Object.keys(REFERENCE_TARGET_TO_PERMANENT_DELETE_SOURCE).sort())
      .toEqual([...REFERENCE_TARGET_TYPES].sort());
    expect(new Set(mapped).size).toBe(REFERENCE_TARGET_TYPES.length);
    expect([...mapped].sort()).toEqual([...PERMANENT_DELETE_BLOCKER_SOURCE_TYPES].sort());
  });
});
