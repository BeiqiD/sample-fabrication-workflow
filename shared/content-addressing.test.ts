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

  it("uses the normalized step name and occurrence even when numbering changes", () => {
    expect(logicalStepKey({ stepNumber: "2.1", name: "Bake" }, 3)).toBe("name:bake:3");
    expect(logicalStepKey({ stepNumber: "9", name: "Bake" }, 3)).toBe("name:bake:3");
    expect(logicalStepKey({ name: "Bake" }, 3)).toBe("name:bake:3");
    expect(logicalStepKey({ name: " Clean  Wafer " }, 1)).toBe("name:clean%20wafer:1");
    expect(logicalStepKey({ name: "Clean-Wafer" }, 1)).toBe("name:clean-wafer:1");
  });
});
