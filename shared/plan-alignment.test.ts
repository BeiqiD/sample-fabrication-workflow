import { describe, expect, it } from "vitest";
import { alignFuturePlan, type ExistingPlanSlot, type NextPlanStep } from "./plan-alignment";

const slot = (id: string, definitionHash: string, position: number, actualized = false): ExistingPlanSlot => ({
  id, name: id, logicalStepKey: id, definitionHash, position, actualized, origin: "template",
});
const next = (id: string, definitionHash: string, position: number): NextPlanStep => ({ id: `v2-${id}`, name: id, logicalStepKey: id, definitionHash, position });
const namedSlot = (id: string, name: string, occurrence: number, definitionHash: string, position: number, actualized = false): ExistingPlanSlot => ({
  id,
  name,
  logicalStepKey: `name:${name}:${occurrence}`,
  definitionHash,
  position,
  actualized,
  origin: "template",
});
const namedNext = (id: string, name: string, occurrence: number, definitionHash: string, position: number): NextPlanStep => ({
  id,
  name,
  logicalStepKey: `name:${name}:${occurrence}`,
  definitionHash,
  position,
});

describe("future plan alignment", () => {
  it("preserves executed and ad-hoc history while appending a longer recipe tail", () => {
    const result = alignFuturePlan([
      slot("a", "ha", 1000, true),
      { id: "extra", name: "extra", logicalStepKey: null, definitionHash: null, position: 1500, actualized: true, origin: "ad_hoc" },
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

  it("retains modified or removed executed definitions as historical differences", () => {
    const changed = alignFuturePlan([slot("a", "ha", 1000, true)], [next("a", "changed", 0)]);
    expect(changed.conflicts).toEqual([]);
    expect(changed.historicalDifferences[0]?.kind).toBe("modified_executed_step");
    const removed = alignFuturePlan([slot("a", "ha", 1000, true)], []);
    expect(removed.conflicts).toEqual([]);
    expect(removed.historicalDifferences[0]?.kind).toBe("removed_executed_step");
  });

  it("matches by normalized name sequence when numbering and content change", () => {
    const result = alignFuturePlan([
      namedSlot("clean-old", "clean", 1, "old-clean", 1000, true),
      namedSlot("coat-old", "coat", 1, "old-coat", 2000),
      namedSlot("etch-old", "etch", 1, "old-etch", 3000),
    ], [
      namedNext("clean-new", "clean", 1, "changed-clean", 0),
      namedNext("descum-new", "descum", 1, "descum", 1),
      namedNext("coat-new", "coat", 1, "changed-coat", 2),
      namedNext("etch-new", "etch", 1, "changed-etch", 3),
    ]);
    expect(result.matches.map((match) => [match.existingStepId, match.templateStepId])).toEqual([
      ["clean-old", "clean-new"],
      ["coat-old", "coat-new"],
      ["etch-old", "etch-new"],
    ]);
    expect(result.additions.map((step) => step.id)).toEqual(["descum-new"]);
    expect(result.historicalDifferences).toEqual([{
      kind: "modified_executed_step",
      existingStepId: "clean-old",
      templateStepId: "clean-new",
    }]);
  });

  it("does not use identical content to match differently named steps", () => {
    const result = alignFuturePlan([
      namedSlot("old", "clean", 1, "same-content", 1000),
    ], [
      namedNext("new", "rinse", 1, "same-content", 0),
    ]);
    expect(result.matches).toEqual([]);
    expect(result.additions.map((step) => step.id)).toEqual(["new"]);
    expect(result.supersededStepIds).toEqual(["old"]);
  });

  it("uses actual names when legacy logical keys were generated from step numbers", () => {
    const result = alignFuturePlan([
      { ...slot("number:1", "old-clean", 1000), name: " Clean " },
      { ...slot("number:2", "old-coat", 2000), name: "COAT" },
    ], [
      { ...next("name:clean:1", "new-clean", 0), name: "clean" },
      { ...next("name:coat:1", "new-coat", 1), name: "coat" },
    ]);
    expect(result.matches.map((match) => match.existingStepId)).toEqual(["number:1", "number:2"]);
    expect(result.additions).toEqual([]);
    expect(result.supersededStepIds).toEqual([]);
  });
});
