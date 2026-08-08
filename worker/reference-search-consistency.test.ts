import { describe, expect, it } from "vitest";
import { REFERENCE_TARGET_TYPES } from "../shared/reference-types";
import { REFERENCE_SEARCH_ADAPTERS } from "./references/search";

describe("reference search target coverage", () => {
  it("covers exactly the closed v1 reference target set", () => {
    expect(Object.keys(REFERENCE_SEARCH_ADAPTERS)).toEqual([...REFERENCE_TARGET_TYPES]);
  });
});
