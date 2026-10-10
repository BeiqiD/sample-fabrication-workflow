// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanUpdatePreview, ProcessingSampleDetail, RunStartPreview, SampleRun } from "../shared/types";
import { api, type ProcessTemplateFamilySummary, type ProcessTemplateVersionSummary } from "./lib/api";
import { ProcessingWorkspacePage } from "./pages/ProcessingWorkspacePage";

// Confirm only through mocked API receipts. Keep the real page, route and modal
// hooks; the refreshed grid boundary exposes the returned execution identity.
vi.mock("./components/MultiSampleRunGrid", () => ({
  MultiSampleRunGrid: ({ primaryRun }: { primaryRun: SampleRun }) =>
    <output aria-label="Processing snapshot">{primaryRun.id}|{primaryRun.currentPlanRevisionId}|{primaryRun.templateVersionId}</output>,
}));
vi.mock("./components/ReferenceSourceFocus", () => ({ ProcessingReferenceSourceFocus: () => null }));

type Mode = "start" | "update" | "reopen";
const at = "2026-10-09T12:00:00.000Z", later = "2026-10-09T12:01:00.000Z";
const incoming: ProcessTemplateVersionSummary = {
  id: "template-2", recipeFamilyId: "family-a", name: "Process family", templateType: "process", version: 2,
  sourceFilename: null, stepCount: 2, initialStateHash: "state-incoming", hasInitialSubstrateStep: true,
  initialStateImageCount: 0, locked: true, createdAt: at,
};
const family: ProcessTemplateFamilySummary = {
  recipeFamilyId: "family-a", name: "Process family", templateType: "process", latestVersion: 2,
  versionCount: 2, latest: incoming,
};
function snapshot(mode: Mode, refreshed = false): ProcessingSampleDetail {
  const original: SampleRun = {
    id: "run-a", recipeFamilyId: "family-a", templateVersionId: "template-1", templateName: "Process family",
    templateType: "process", templateVersion: 1, runKind: "process", status: mode === "update" ? "active" : "complete",
    currentPlanRevisionId: "plan-1", planRevisionNumber: 1, predecessorRunId: null, anchorStepId: null,
    sequenceNo: 1, runGroupId: "group-a", initialStateHash: "state-before", initialStateImageKeys: [],
    createdAt: at, completedAt: mode === "update" ? null : at, steps: [],
  };
  const current: SampleRun = refreshed ? {
    ...original, id: mode === "start" ? "run-new" : "run-a", status: "active", completedAt: null,
    templateVersionId: "template-2", templateVersion: 2, currentPlanRevisionId: "plan-new", planRevisionNumber: 2,
    sequenceNo: mode === "start" ? 2 : 1, predecessorRunId: mode === "start" ? "run-a" : null,
  } : original;
  return {
    id: "sample-a", code: "SAMPLE-A", title: "Confirmation sample", status: "active", location: null,
    parentId: null, inheritedStateHash: null, pinned: false, createdAt: at, updatedAt: refreshed ? later : at,
    latestWorkflowName: "Process family", latestWorkflowVersion: current.templateVersion, latestRunStatus: current.status,
    currentStepTitle: null, currentStateStepTitle: null, currentStateThumbnailKey: null,
    runs: refreshed && mode === "start" ? [current, original] : [current], stateVerifications: [],
  };
}
function structure(mode: Mode, canConfirm = true): RunStartPreview {
  return {
    successor: mode === "start", sampleUpdatedAt: at, expectedLatestRunId: "run-a", comparison: "different",
    canConfirm, blockingReason: canConfirm ? null : "Current structure cannot be compared.",
    comparisonTarget: {
      kind: mode === "start" ? "initial_substrate" : "matched_step", key: "incoming-structure",
      stateHash: "state-incoming", imageKeys: [], stepId: mode === "start" ? null : "execution-step-1",
      stepTitle: mode === "start" ? "Substrate Stack" : "Matched completed step",
    },
    template: { id: "template-2", name: "Process family", version: 2, initialSubstrateStep: {
      localId: "substrate-0", sourceRow: 1, position: 0, stepNumber: "0", sectionName: null,
      name: "Substrate Stack", toolName: null, parametersText: null, commentsText: null, imageIds: [], rawCells: {},
    } },
    sampleCurrentState: { hash: "state-before", stepTitle: "Completed fabrication step", imageKeys: [] },
  };
}
function plan(mode: Mode, compatible = true): PlanUpdatePreview {
  return {
    compatible, blockingReason: compatible ? null : "This version cannot continue the current execution plan.",
    currentTemplateVersionId: "template-1", nextTemplateVersionId: "template-2", canReopen: mode === "reopen",
    substrateTransition: structure(mode), preservedCount: 1, additionCount: 1, skippedAdditionCount: 0,
    supersededCount: 0, historicalDifferences: [],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function Location() {
  const location = useLocation();
  return <output aria-label="Processing route">{location.pathname}{location.search}</output>;
}
function workspace() {
  return render(<MemoryRouter initialEntries={["/processing/sample-a?run=run-a"]}><Location /><Routes>
    <Route path="/processing/:sampleId" element={<ProcessingWorkspacePage />} />
  </Routes></MemoryRouter>);
}
const picker = () => screen.getByRole("dialog", { name: "Choose the incoming process template" });
const triggerName = (mode: Mode) => mode === "start" ? "Start run" : "Run actions";
async function chooseTransition(mode: Mode) {
  const trigger = await screen.findByRole("button", { name: triggerName(mode) });
  trigger.focus(); fireEvent.click(trigger);
  const item = screen.getByRole("menuitem", { name: mode === "start" ? "Start new process"
    : mode === "update" ? "Update future plan" : "Reopen with updated template" });
  item.focus(); fireEvent.click(item);
  if (mode === "start") {
    fireEvent.click(await within(picker()).findByRole("button", { name: /^Process family/ }));
  }
  await within(picker()).findByRole("button", { name: /^Version 2/ });
}
async function compareTransition(mode: Mode) {
  await chooseTransition(mode);
  const compare = within(picker()).getByRole("button", { name: "Compare structures" });
  await waitFor(() => expect(compare.matches(":disabled")).toBe(false));
  compare.focus(); fireEvent.click(compare);
  return screen.findByRole("dialog", { name: "Does this structure handoff match what you expect?" });
}
const confirmationLabel = (mode: Mode) => mode === "start" ? "Confirm and start run"
  : mode === "update" ? "Confirm and update process" : "Confirm and reopen run";

const network = vi.fn<typeof fetch>();
beforeEach(() => {
  network.mockReset().mockRejectedValue(new Error("Unexpected real network request"));
  vi.stubGlobal("fetch", network);
  vi.spyOn(api, "getProcessingSample").mockResolvedValue(snapshot("update"));
  vi.spyOn(api, "listTemplateFamilies").mockResolvedValue({ families: [family],
    pagination: { page: 1, pageSize: 50, total: 1, totalPages: 1 } });
  vi.spyOn(api, "listTemplateFamilyVersions").mockResolvedValue({ versions: [incoming] });
  vi.spyOn(api, "previewRunStart").mockResolvedValue(structure("start"));
  vi.spyOn(api, "previewPlanUpdate").mockResolvedValue(plan("update"));
  vi.spyOn(api, "startProcessRun").mockRejectedValue(new Error("Unexpected mocked start"));
  vi.spyOn(api, "applyPlanUpdate").mockRejectedValue(new Error("Unexpected mocked plan update"));
  vi.spyOn(api, "finishProcessRun").mockRejectedValue(new Error("Unexpected finish"));
  vi.spyOn(api, "deleteRun").mockRejectedValue(new Error("Unexpected delete"));
});
afterEach(() => {
  try {
    expect(network).not.toHaveBeenCalled();
    expect(api.finishProcessRun).not.toHaveBeenCalled(); expect(api.deleteRun).not.toHaveBeenCalled();
  } finally { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

describe("Phase 5F mocked Processing confirmation contracts", () => {
  it.each(["start", "update", "reopen"] as const)("confirms %s once with the exact owner payload, refresh and returned focus", async mode => {
    const refresh = deferred<ProcessingSampleDetail>();
    const startReceipt = deferred<Awaited<ReturnType<typeof api.startProcessRun>>>();
    const updateReceipt = deferred<Awaited<ReturnType<typeof api.applyPlanUpdate>>>();
    vi.mocked(api.getProcessingSample).mockResolvedValueOnce(snapshot(mode)).mockReturnValueOnce(refresh.promise);
    vi.mocked(api.previewPlanUpdate).mockResolvedValue(plan(mode));
    vi.mocked(api.startProcessRun).mockReturnValueOnce(startReceipt.promise);
    vi.mocked(api.applyPlanUpdate).mockReturnValueOnce(updateReceipt.promise);
    workspace();
    const dialog = await compareTransition(mode);
    const confirm = within(dialog).getByRole("button", { name: confirmationLabel(mode) });
    expect(confirm.matches(":disabled")).toBe(false); fireEvent.click(confirm);
    const substrateConfirmation = {
      confirmed: true,
      expectedSampleUpdatedAt: at,
      expectedPreviousStateHash: "state-before",
      expectedTemplateStructureKey: "incoming-structure",
      expectedTemplateStateHash: "state-incoming",
      expectedLatestRunId: "run-a",
      ...(mode === "start" ? {} : { expectedCurrentPlanRevisionId: "plan-1" }),
    };
    if (mode === "start") {
      expect(vi.mocked(api.startProcessRun).mock.calls).toEqual([
        ["sample-a", { templateVersionId: "template-2", substrateConfirmation }],
      ]);
      expect(api.applyPlanUpdate).not.toHaveBeenCalled();
    } else {
      expect(vi.mocked(api.applyPlanUpdate).mock.calls).toEqual([
        ["sample-a", "run-a", { templateVersionId: "template-2", substrateConfirmation }],
      ]);
      expect(api.startProcessRun).not.toHaveBeenCalled();
    }
    const saving = within(dialog).getByRole("button", { name: "Saving…" });
    expect(saving.matches(":disabled")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Cancel" }).matches(":disabled")).toBe(true);
    fireEvent.click(saving); fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(api.getProcessingSample).toHaveBeenCalledTimes(1);
    expect(mode === "start" ? api.startProcessRun : api.applyPlanUpdate).toHaveBeenCalledTimes(1);

    await act(async () => {
      if (mode === "start") startReceipt.resolve({ id: "run-new" });
      else updateReceipt.resolve({ ok: true, planRevisionId: "plan-new", revisionNumber: 2 });
    });
    await waitFor(() => expect(api.getProcessingSample).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: triggerName(mode) }).matches(":disabled")).toBe(true);
    expect(vi.mocked(api.getProcessingSample).mock.calls).toEqual([["sample-a"], ["sample-a"]]);
    await act(async () => refresh.resolve(snapshot(mode, true)));
    const runId = mode === "start" ? "run-new" : "run-a";
    await waitFor(() => expect(screen.getByLabelText("Processing snapshot").textContent).toBe(`${runId}|plan-new|template-2`));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: triggerName(mode) })));
    expect(screen.getByLabelText("Processing route").textContent).toBe(`/processing/sample-a?run=${runId}`);
    expect(screen.queryByRole("dialog")).toBeNull(); expect(document.body.style.overflow).toBe("");
    expect(mode === "start" ? api.startProcessRun : api.applyPlanUpdate).toHaveBeenCalledTimes(1);
    expect(api.getProcessingSample).toHaveBeenCalledTimes(2);
  });

  it("keeps an unconfirmable start preview read-only", async () => {
    vi.mocked(api.getProcessingSample).mockResolvedValue(snapshot("start"));
    vi.mocked(api.previewRunStart).mockResolvedValue(structure("start", false));
    workspace(); const dialog = await compareTransition("start");
    const confirm = within(dialog).getByRole("button", { name: "Confirm and start run" });
    expect(confirm.matches(":disabled")).toBe(true); fireEvent.click(confirm);
    expect(api.startProcessRun).not.toHaveBeenCalled(); expect(api.applyPlanUpdate).not.toHaveBeenCalled();
    expect(api.getProcessingSample).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it.each(["update", "reopen"] as const)("does not compare or submit an incompatible %s plan", async mode => {
    vi.mocked(api.getProcessingSample).mockResolvedValue(snapshot(mode));
    vi.mocked(api.previewPlanUpdate).mockResolvedValue(plan(mode, false));
    workspace(); await chooseTransition(mode);
    await screen.findByText("This version cannot be applied");
    const compare = within(picker()).getByRole("button", { name: "Compare structures" });
    expect(compare.matches(":disabled")).toBe(true); fireEvent.click(compare);
    expect(screen.queryByRole("dialog", { name: "Does this structure handoff match what you expect?" })).toBeNull();
    expect(api.startProcessRun).not.toHaveBeenCalled(); expect(api.applyPlanUpdate).not.toHaveBeenCalled();
    expect(api.getProcessingSample).toHaveBeenCalledTimes(1);
  });
});
