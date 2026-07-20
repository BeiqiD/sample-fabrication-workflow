import { describe, expect, it } from "vitest";
import { alignFuturePlan, type ExistingPlanSlot, type NextPlanStep } from "./plan-alignment";

const slot = (id: string, definitionHash: string, position: number, actualized = false): ExistingPlanSlot => ({
  id, logicalStepKey: id, definitionHash, position, actualized, origin: "template",
});
const next = (id: string, definitionHash: string, position: number): NextPlanStep => ({ id: `v2-${id}`, logicalStepKey: id, definitionHash, position });

describe("future plan alignment", () => {
  it("preserves executed and ad-hoc history while appending a longer recipe tail", () => {
    const result = alignFuturePlan([
      slot("a", "ha", 1000, true),
      { id: "extra", logicalStepKey: null, definitionHash: null, position: 1500, actualized: true, origin: "ad_hoc" },
      slot("b", "hb", 2000, true),
      slot("c", "hc", 3000),
    ], [next("a", "ha", 0), next("b", "hb", 1), next("x", "hx", 2), next("c", "hc", 3), next("d", "hd", 4)]);
    expect(result.conflicts).toEqual([]);
    expect(result.additions.map((step) => step.logicalStepKey)).toEqual(["x", "d"]);
    expect(result.matches.map((match) => match.existingStepId)).toEqual(["a", "b", "c"]);
  });

  it("rejects a new recipe step inserted before an executed anchor", () => {
    const result = alignFuturePlan([slot("a", "ha", 1000, true), slot("b", "hb", 2000, true)], [next("a", "ha", 0), next("x", "hx", 1), next("b", "hb", 2)]);
    expect(result.conflicts).toContainEqual({ kind: "inserted_before_execution_head", templateStepId: "v2-x" });
  });

  it("rejects modification or removal of executed definitions", () => {
    const changed = alignFuturePlan([slot("a", "ha", 1000, true)], [next("a", "changed", 0)]);
    expect(changed.conflicts[0]?.kind).toBe("modified_executed_step");
    const removed = alignFuturePlan([slot("a", "ha", 1000, true)], []);
    expect(removed.conflicts[0]?.kind).toBe("removed_executed_step");
  });
});
