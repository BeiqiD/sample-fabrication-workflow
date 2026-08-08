import { describe, expect, it } from "vitest";
import { REFERENCE_TARGET_TYPES } from "../../shared/reference-types";
import {
  activeReferenceSearchFilterCount,
  defaultReferenceSearchUiState,
  orderedReferenceSearchTypes,
  referenceSearchInputFromState,
  referenceSearchParamsFromState,
  referenceSearchStateFromParams,
  referenceSearchUiStateEquals,
  referenceTargetEquals,
  validateReferenceSearchUiState,
} from "./reference-search-ui";

describe("reference search UI state", () => {
  it("uses the all-type profile when URL filters are omitted", () => {
    expect(referenceSearchStateFromParams(new URLSearchParams())).toEqual({
      query: "",
      types: [...REFERENCE_TARGET_TYPES],
      sampleId: "",
      from: "",
      to: "",
    });
  });

  it("deduplicates valid URL types in closed registry order", () => {
    const state = referenceSearchStateFromParams(new URLSearchParams(
      "q=epitaxy&type=run&type=sample&type=run&type=unknown&sample=%20sample-a%20&from=2026-02-30&to=2026-08-09",
    ));
    expect(state).toEqual({
      query: "epitaxy",
      types: ["sample", "run"],
      sampleId: "sample-a",
      from: "",
      to: "2026-08-09",
    });
    expect(orderedReferenceSearchTypes(["recipe_revision", "sample", "recipe_revision"]))
      .toEqual(["sample", "recipe_revision"]);
  });

  it("falls back to all types when an external URL contains no valid type", () => {
    expect(referenceSearchStateFromParams(new URLSearchParams("type=unknown&type=other")).types)
      .toEqual([...REFERENCE_TARGET_TYPES]);
  });

  it("serializes one canonical URL and omits default filters", () => {
    const params = referenceSearchParamsFromState({
      query: "  focused step  ",
      types: ["run", "sample", "run"],
      sampleId: " sample-a ",
      from: "2026-08-01",
      to: "2026-08-09",
    });
    expect(Array.from(params.entries())).toEqual([
      ["q", "focused step"],
      ["type", "sample"],
      ["type", "run"],
      ["sample", "sample-a"],
      ["from", "2026-08-01"],
      ["to", "2026-08-09"],
    ]);

    const defaults = defaultReferenceSearchUiState();
    defaults.query = "sample";
    expect(Array.from(referenceSearchParamsFromState(defaults).entries()))
      .toEqual([["q", "sample"]]);
  });

  it("validates code-point length, type selection, Sample ID, and date order", () => {
    const valid = defaultReferenceSearchUiState();
    valid.query = "🧪".repeat(200);
    expect(validateReferenceSearchUiState(valid)).toBeNull();

    expect(validateReferenceSearchUiState({ ...valid, query: "🧪".repeat(201) }))
      .toMatch(/200 characters/);
    expect(validateReferenceSearchUiState({ ...valid, types: [] }))
      .toBe("Select at least one result type.");
    expect(validateReferenceSearchUiState({ ...valid, sampleId: "a".repeat(257) }))
      .toMatch(/256 characters/);
    expect(validateReferenceSearchUiState({ ...valid, from: "2026-08-10", to: "2026-08-09" }))
      .toBe("The start date must be on or before the end date.");
    expect(validateReferenceSearchUiState({ ...valid, from: "2026-02-30" }))
      .toBe("Use valid calendar dates in YYYY-MM-DD format.");
  });

  it("compares normalized committed state so an unchanged submit can become an explicit retry", () => {
    const left = {
      query: "  Case-ID ",
      types: ["run" as const, "sample" as const, "run" as const],
      sampleId: " sample-a ",
      from: "2026-08-01",
      to: "2026-08-09",
    };
    const right = {
      query: "Case-ID",
      types: ["sample" as const, "run" as const],
      sampleId: "sample-a",
      from: "2026-08-01",
      to: "2026-08-09",
    };
    expect(referenceSearchUiStateEquals(left, right)).toBe(true);
    expect(referenceSearchUiStateEquals(left, { ...right, to: "2026-08-10" })).toBe(false);
  });

  it("converts browser dates to complete UTC-day bounds in the Phase 2C1 input", () => {
    const allTypes = defaultReferenceSearchUiState();
    allTypes.query = "  exact-id  ";
    expect(referenceSearchInputFromState(allTypes)).toEqual({ query: "exact-id" });

    expect(referenceSearchInputFromState({
      query: "comment",
      types: ["comment", "comment_attachment"],
      sampleId: "sample-a",
      from: "2026-08-01",
      to: "2026-08-09",
    })).toEqual({
      query: "comment",
      types: ["comment", "comment_attachment"],
      sampleId: "sample-a",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-09T23:59:59.999Z",
    });
    expect(referenceSearchInputFromState(defaultReferenceSearchUiState())).toBeNull();
  });

  it("counts active filters and compares stable targets without object identity", () => {
    expect(activeReferenceSearchFilterCount({
      query: "sample",
      types: ["sample"],
      sampleId: "sample-a",
      from: "2026-08-01",
      to: "",
    })).toBe(3);
    expect(referenceTargetEquals(
      { type: "sample", id: "sample-a" },
      { type: "sample", id: "sample-a" },
    )).toBe(true);
    expect(referenceTargetEquals(
      { type: "sample", id: "sample-a" },
      { type: "run", id: "sample-a" },
    )).toBe(false);
  });
});
