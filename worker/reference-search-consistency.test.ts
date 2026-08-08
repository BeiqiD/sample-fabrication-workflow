import { describe, expect, it } from "vitest";
import { REFERENCE_SEARCH_MATCH_TIERS } from "../shared/reference-search";
import { REFERENCE_TARGET_TYPES } from "../shared/reference-types";
import { REFERENCE_SEARCH_ADAPTERS } from "./references/search";

describe("reference search contract coverage", () => {
  it("covers exactly the closed v1 reference target set", () => {
    expect(Object.keys(REFERENCE_SEARCH_ADAPTERS)).toEqual([...REFERENCE_TARGET_TYPES]);
  });

  it("keeps the explainable ranking tiers in their public order", () => {
    expect(REFERENCE_SEARCH_MATCH_TIERS).toEqual([
      "exact_id",
      "exact_primary",
      "prefix_primary",
      "content",
      "metadata",
    ]);
  });
});
