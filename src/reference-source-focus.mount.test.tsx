// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeReferenceSourceFocus } from "../shared/reference-destinations";
import type { ProcessingSampleDetail, RunStep, SampleRun } from "../shared/types";
import { ProcessingReferenceSourceFocus } from "./components/ReferenceSourceFocus";
import type { RunGridColumn } from "./lib/runGrid";

const timestamp = "2026-08-08T12:00:00.000Z";

function focusColumns(): RunGridColumn[] {
const step: RunStep = {
  id: "step-a",
  templateStepId: "template-step-a",
  logicalStepKey: "logical-step-a",
  sectionName: null,
  definitionHash: null,
  expectedStateHash: null,
  position: 0,
  planPosition: 0,
  origin: "template",
  entryKind: "fabrication",
  planStatus: "current",
  title: "Focused step",
  status: "pending",
  notes: null,
  toolName: null,
  parametersText: null,
  commentsText: null,
  deviationNote: null,
  plannedTitle: "Focused step",
  plannedToolName: null,
  plannedParametersText: null,
  plannedCommentsText: null,
  plannedImageKeys: [],
  executionImageKeys: [],
  comments: [],
  actualizedAt: null,
  verificationIds: [],
  stateVerification: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const run: SampleRun = {
  id: "run-a",
  recipeFamilyId: "family-a",
  templateVersionId: "template-a",
  templateName: "Process A",
  templateType: "process",
  templateVersion: 1,
  runKind: "process",
  status: "active",
  currentPlanRevisionId: "plan-a",
  planRevisionNumber: 1,
  predecessorRunId: null,
  anchorStepId: null,
  sequenceNo: 1,
  runGroupId: "group-a",
  initialStateHash: null,
  initialStateImageKeys: [],
  createdAt: timestamp,
  completedAt: null,
  steps: [step],
};
const sample: ProcessingSampleDetail = {
  id: "sample-a",
  code: "A",
  title: "Sample A",
  status: "active",
  location: null,
  parentId: null,
  inheritedStateHash: null,
  pinned: false,
  createdAt: timestamp,
  updatedAt: timestamp,
  latestWorkflowName: "Process A",
  latestWorkflowVersion: 1,
  latestRunStatus: "active",
  currentStepTitle: "Focused step",
  currentStateStepTitle: null,
  currentStateThumbnailKey: null,
  runs: [run],
  stateVerifications: [],
};
return [{ sample, run }];
}

describe("mounted Processing reference focus", () => {
const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollIntoView.mockReset();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, "scrollBy", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => cleanup());

it("does not reopen a closed preview or recenter after an unrelated parent rerender", async () => {
  const sourceColumns = focusColumns();
  const focusValue = encodeReferenceSourceFocus({
    type: "execution_image",
    id: "execution-occurrence-a",
  });

  function Harness() {
    const [, setRevision] = useState(0);
    const freshColumns = sourceColumns.map((column) => ({ ...column }));
    return <div>
      <button type="button" onClick={() => setRevision((value) => value + 1)}>
        Unrelated rerender
      </button>
      <div>
        <div className="run-grid-card">
          <div className="run-grid-row">
            <div className="recipe-cell" />
            <div className="sample-step-cell" />
          </div>
        </div>
        <ProcessingReferenceSourceFocus
          focusValue={focusValue}
          sampleId="sample-a"
          stepId="step-a"
          columns={freshColumns}
        />
      </div>
    </div>;
  }

  render(<Harness />);
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Close reference preview" }));
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Unrelated rerender" }));
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
});
});
