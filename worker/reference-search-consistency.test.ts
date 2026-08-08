import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REFERENCE_TARGET_TYPES } from "../shared/reference-types";
import { REFERENCE_SEARCH_ADAPTERS } from "./references/search";

describe("reference search target coverage", () => {
  it("covers exactly the closed v1 reference target set", () => {
    expect(Object.keys(REFERENCE_SEARCH_ADAPTERS)).toEqual([...REFERENCE_TARGET_TYPES]);
  });

  it("uses the portable literal matcher instead of LIKE-pattern encoding", () => {
    const source = readFileSync(new URL("./references/search.ts", import.meta.url), "utf8");
    expect(source).not.toContain("escapedLikePattern");
    expect(source).not.toContain("toLocaleLowerCase");
    expect(source).not.toMatch(/\bLIKE\b/);
    expect(source).toContain("INSTR(");
    expect(source).toContain('kind: "sqlite-source-scan"');
    expect(source).toContain("export type ReferenceSearchCandidate");
    expect(source).toContain("match_specificity");
    expect(source).toContain("left.specificity - right.specificity");
    expect(source).toContain("MATCH_TIER_BY_SPECIFICITY[candidate.specificity]");
  });
});
