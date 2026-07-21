import { describe, expect, it } from "vitest";
import { returnedEveryConfirmationTarget } from "./run-step-confirmation";

describe("run step confirmation results", () => {
  it("accepts the exact set of steps returned by the atomic update", () => {
    expect(returnedEveryConfirmationTarget([{ id: "step-b" }, { id: "step-a" }], ["step-a", "step-b"])).toBe(true);
  });

  it("rejects partial, duplicate, or malformed update results", () => {
    expect(returnedEveryConfirmationTarget([{ id: "step-a" }], ["step-a", "step-b"])).toBe(false);
    expect(returnedEveryConfirmationTarget([{ id: "step-a" }, { id: "step-a" }], ["step-a", "step-b"])).toBe(false);
    expect(returnedEveryConfirmationTarget([{ step_id: "step-a" }], ["step-a"])).toBe(false);
  });
});
