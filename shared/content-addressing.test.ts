import { describe, expect, it } from "vitest";
import { hashRecipeManifest, hashStateRepresentation, hashStepDefinition, logicalStepKey } from "./content-addressing";

describe("content-addressed recipe definitions", () => {
  it("normalizes line endings and trailing whitespace", async () => {
    const left = await hashStepDefinition({ name: "Develop", parametersText: "Time: 60 s\r\nTemp: 21 C  " });
    const right = await hashStepDefinition({ name: "Develop", parametersText: "Time: 60 s\nTemp: 21 C" });
    expect(left.hash).toBe(right.hash);
  });

  it("does not include recipe position in a step hash", async () => {
    const definition = await hashStepDefinition({ name: "Rinse", toolName: "DI" });
    expect(definition.canonical).not.toHaveProperty("position");
  });

  it("hashes the ordered state assets and recipe manifest independently", async () => {
    const first = await hashStateRepresentation(["asset-a", "asset-b"]);
    const reordered = await hashStateRepresentation(["asset-b", "asset-a"]);
    expect(first.hash).not.toBe(reordered.hash);
    await expect(hashRecipeManifest([{ logicalStepKey: "number:1", definitionHash: "action", expectedStateHash: first.hash }])).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it("prefers an imported step number over a generated name occurrence", () => {
    expect(logicalStepKey({ stepNumber: "2.1", name: "Bake" }, 3)).toBe("number:2.1");
    expect(logicalStepKey({ stepNumber: "2.1", name: "Bake" }, 3, true)).toBe("number:2.1:3");
    expect(logicalStepKey({ name: "Bake" }, 3)).toBe("name:bake:3");
  });
});
