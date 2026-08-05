import { describe, expect, it } from "vitest";
import { pendingRunStepActionTargets } from "./runGridActions";

describe("pendingRunStepActionTargets", () => {
  it("scopes individual Done feedback to the clicked sample step", () => {
    expect(pendingRunStepActionTargets("done:step-a", "step-a")).toBe(true);
    expect(pendingRunStepActionTargets("done:step-a", "step-b")).toBe(false);
  });

  it("recognizes the other step-specific actions without assigning bulk work to every cell", () => {
    expect(pendingRunStepActionTargets("verify:step-a", "step-a")).toBe(true);
    expect(pendingRunStepActionTargets("delete-asset:step-a:image-key", "step-a")).toBe(true);
    expect(pendingRunStepActionTargets("confirm:metrology-row", "step-a")).toBe(false);
    expect(pendingRunStepActionTargets(null, "step-a")).toBe(false);
  });
});
