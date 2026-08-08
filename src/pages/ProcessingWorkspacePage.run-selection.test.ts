import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspace = readFileSync(new URL("./ProcessingWorkspacePage.tsx", import.meta.url), "utf8");

describe("Processing workspace run isolation", () => {
  it("uses occurrence-safe matching for additional sample runs", () => {
    expect(workspace).toContain('import { correspondingRunForSelectedRun } from "../lib/correspondingRun";');
    expect(workspace).toMatch(/item\.id === sample\.id\s*\? selectedRun\s*:\s*correspondingRunForSelectedRun\(selectedRun, sample\.runs, item\.runs\)/);
    expect(workspace).not.toMatch(/item\.runs\.find\(\(candidate\) => candidate\.runKind === selectedRun\.runKind/);
  });
});
