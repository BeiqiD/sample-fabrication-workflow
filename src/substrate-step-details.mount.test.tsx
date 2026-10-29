import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { InitialSubstrateStep } from "../shared/types";
import { SubstrateStepDetails } from "./components/SubstrateStepDetails";

afterEach(cleanup);

function substrate(rawCells: Record<string, unknown>, parametersText = "Layer 1: oxide\n\nTool parameters:\nTemperature: 300 K"): InitialSubstrateStep {
  return { localId: "initial", sourceRow: 2, position: 0, stepNumber: "0", sectionName: null,
    name: "Substrate Stack", toolName: null, parametersText, commentsText: "Keep surface clean",
    imageIds: [], rawCells };
}

describe("substrate source fields", () => {
  it("shows new-layout values once while retaining the actual substrate name and layer metadata", () => {
    render(<SubstrateStepDetails step={substrate({
      "Process Parameters": "Layer 1: oxide", "Tool Parameters": "Temperature: 300 K", Notes: "Keep surface clean",
      "Source substrate name": "Research stack", "Substrate layers": "Layer 1 | oxide | 25 nm",
    })} />);
    expect(screen.getAllByText("Keep surface clean")).toHaveLength(1);
    expect(screen.getAllByText(/Temperature: 300 K/)).toHaveLength(1);
    expect(screen.queryByText("Process Parameters")).toBeNull();
    expect(screen.queryByText("Tool Parameters")).toBeNull();
    expect(screen.queryByText("Notes")).toBeNull();
    expect(screen.getByText("Research stack")).toBeTruthy();
    expect(screen.getByText("Layer 1 | oxide | 25 nm")).toBeTruthy();
  });

  it("keeps older templates' independent extension values when they differ from the canonical fields", () => {
    render(<SubstrateStepDetails step={substrate({
      "Process Parameters": "Independent layer specification", "Tool Parameters": "Independent tool limits",
      Notes: "Independent source note", "Custom source field": "Retain this value",
    }, "Original canonical parameters")} />);
    for (const value of ["Independent layer specification", "Independent tool limits", "Independent source note", "Retain this value"]) {
      expect(screen.getByText(value)).toBeTruthy();
    }
    expect(screen.getByText("Original canonical parameters")).toBeTruthy();
    expect(screen.getByText("Keep surface clean")).toBeTruthy();
  });
});
