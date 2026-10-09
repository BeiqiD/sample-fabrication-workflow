// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanUpdatePreview, ProcessingSampleDetail, RunStartPreview, SampleRun } from "../shared/types";
import { api, type ProcessTemplateFamilySummary, type ProcessTemplateVersionSummary } from "./lib/api";
import { ProcessingWorkspacePage } from "./pages/ProcessingWorkspacePage";

// Keep the real route, preview APIs and both dialog presentations. The grid
// boundary permits a read refresh without performing a fabrication mutation.
vi.mock("./components/MultiSampleRunGrid", () => ({
  MultiSampleRunGrid: ({ onSaved }: { onSaved: () => Promise<void> }) =>
    <button type="button" onClick={() => void onSaved()}>Refresh processing data</button>,
}));
vi.mock("./components/ReferenceSourceFocus", () => ({ ProcessingReferenceSourceFocus: () => null }));

const at = "2026-10-09T10:00:00.000Z";
const later = "2026-10-09T10:01:00.000Z";
function processing(id = "sample-a", active = true): ProcessingSampleDetail {
  const run: SampleRun = {
    id: id === "sample-a" ? "run-a" : "run-b", recipeFamilyId: "family-a", templateVersionId: "template-1",
    templateName: "Process family", templateType: "process", templateVersion: 1, runKind: "process",
    status: active ? "active" : "complete", currentPlanRevisionId: "plan-1", planRevisionNumber: 1,
    predecessorRunId: null, anchorStepId: null, sequenceNo: 1, runGroupId: "group-a", initialStateHash: null,
    initialStateImageKeys: [], createdAt: at, completedAt: active ? null : at, steps: [],
  };
  return {
    id, code: id.toUpperCase(), title: `Title ${id}`, status: "active", location: null, parentId: null,
    inheritedStateHash: null, pinned: false, createdAt: at, updatedAt: at, latestWorkflowName: "Process family",
    latestWorkflowVersion: 1, latestRunStatus: run.status, currentStepTitle: null, currentStateStepTitle: null,
    currentStateThumbnailKey: null, runs: [run], stateVerifications: [],
  };
}
function version(number: number, recipeFamilyId = "family-a"): ProcessTemplateVersionSummary {
  return { id: `template-${number}`, recipeFamilyId, name: "Process family", templateType: "process", version: number,
    sourceFilename: null, stepCount: 2, initialStateHash: null, hasInitialSubstrateStep: false,
    initialStateImageCount: 0, locked: true, createdAt: at };
}
function family(name = "Process family", latest = version(3)): ProcessTemplateFamilySummary {
  return { recipeFamilyId: latest.recipeFamilyId, name, templateType: "process", latestVersion: latest.version,
    versionCount: 3, latest };
}
function families(items = [family()]) {
  return { families: items, pagination: { page: 1, pageSize: 50, total: items.length, totalPages: 1 } };
}
function structure(number = 2, label = "Current comparison", sampleUpdatedAt = at, expectedLatestRunId = "run-a"): RunStartPreview {
  return {
    successor: true, sampleUpdatedAt, expectedLatestRunId, comparison: "same", canConfirm: true,
    blockingReason: null, comparisonTarget: { kind: "initial_substrate", key: `structure-${number}`,
      stateHash: `state-${number}`, imageKeys: [], stepId: null, stepTitle: label },
    template: { id: `template-${number}`, name: "Process family", version: number, initialSubstrateStep: null },
    sampleCurrentState: { hash: `state-${number}`, stepTitle: null, imageKeys: [] },
  };
}
function plan(number = 2, linked = 2, sampleUpdatedAt = at): PlanUpdatePreview {
  return { compatible: true, blockingReason: null, currentTemplateVersionId: "template-1", nextTemplateVersionId: `template-${number}`,
    canReopen: true, substrateTransition: structure(number, `Current comparison ${number}`, sampleUpdatedAt),
    preservedCount: linked, additionCount: 0, skippedAdditionCount: 0, supersededCount: 0, historicalDifferences: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function Navigation() {
  const navigate = useNavigate();
  return <>
    <button onClick={() => navigate("/processing/sample-b?run=run-b")}>Switch processing source</button>
    <button onClick={() => navigate("/processing/sample-a?run=run-a")}>Return to first source</button>
    <button onClick={() => navigate("/processing/sample-a?run=run-old")}>View another run</button>
  </>;
}
function workspace(url = "/processing/sample-a?run=run-a") {
  return render(<MemoryRouter initialEntries={[url]}><Navigation /><Routes>
    <Route path="/processing/:sampleId" element={<ProcessingWorkspacePage />} />
  </Routes></MemoryRouter>);
}
const picker = () => screen.getByRole("dialog", { name: "Choose the incoming process template" });
const compare = () => within(picker()).getByRole("button", { name: "Compare structures" });
async function openUpdate() {
  const trigger = await screen.findByRole("button", { name: "Run actions" });
  trigger.focus(); fireEvent.click(trigger);
  const item = screen.getByRole("menuitem", { name: "Update future plan" });
  item.focus(); fireEvent.click(item);
  await within(picker()).findByRole("button", { name: /^Version 2/ });
}
async function openStart() {
  const trigger = await screen.findByRole("button", { name: "Start run" });
  trigger.focus(); fireEvent.click(trigger);
  const item = screen.getByRole("menuitem", { name: "Start new process" });
  item.focus(); fireEvent.click(item);
  await screen.findByRole("dialog", { name: "Choose the incoming process template" });
}
async function chooseStartVersion() {
  const choice = await within(picker()).findByRole("button", { name: /^Process family/ });
  fireEvent.click(choice);
  const incoming = await within(picker()).findByRole("button", { name: /^Version 2/ });
  fireEvent.click(incoming);
  await waitFor(() => expect(compare().matches(":disabled")).toBe(false));
}

const network = vi.fn<typeof fetch>();
beforeEach(() => {
  network.mockReset().mockRejectedValue(new Error("Unexpected network request"));
  vi.stubGlobal("fetch", network);
  vi.spyOn(api, "getProcessingSample").mockImplementation(async id => processing(id));
  vi.spyOn(api, "listTemplateFamilies").mockResolvedValue(families());
  vi.spyOn(api, "listTemplateFamilyVersions").mockResolvedValue({ versions: [version(2), version(3)] });
  vi.spyOn(api, "previewPlanUpdate").mockResolvedValue(plan());
  vi.spyOn(api, "previewRunStart").mockResolvedValue(structure());
  vi.spyOn(api, "startProcessRun").mockRejectedValue(new Error("Unexpected start mutation"));
  vi.spyOn(api, "applyPlanUpdate").mockRejectedValue(new Error("Unexpected plan mutation"));
  vi.spyOn(api, "finishProcessRun").mockRejectedValue(new Error("Unexpected finish mutation"));
  vi.spyOn(api, "deleteRun").mockRejectedValue(new Error("Unexpected delete mutation"));
});
afterEach(() => {
  try {
    expect(network).not.toHaveBeenCalled();
    for (const mutation of [api.startProcessRun, api.applyPlanUpdate, api.finishProcessRun, api.deleteRun]) {
      expect(mutation).not.toHaveBeenCalled();
    }
  } finally { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

describe("Phase 5F Processing plan preview ownership", () => {
  it("keeps the newer version's compatibility after reversed successful responses", async () => {
    const old = deferred<PlanUpdatePreview>(), current = deferred<PlanUpdatePreview>();
    vi.mocked(api.previewPlanUpdate).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    workspace(); await openUpdate();
    await waitFor(() => expect(api.previewPlanUpdate).toHaveBeenCalledTimes(1));
    fireEvent.click(within(picker()).getByRole("button", { name: /^Version 3/ }));
    await waitFor(() => expect(api.previewPlanUpdate).toHaveBeenCalledTimes(2));
    expect(compare().matches(":disabled")).toBe(true);
    await act(async () => current.resolve(plan(3, 33)));
    expect(screen.getByText("33 linked · 0 new · 0 replaced")).toBeTruthy();
    await act(async () => old.resolve(plan(2, 22)));
    expect(screen.queryByText("22 linked · 0 new · 0 replaced")).toBeNull();
    expect(compare().matches(":disabled")).toBe(false);
    expect(vi.mocked(api.previewPlanUpdate).mock.calls).toEqual([
      ["sample-a", "run-a", "template-2"], ["sample-a", "run-a", "template-3"],
    ]);
  });

  it("ignores an older failure after the selected version succeeds", async () => {
    const old = deferred<PlanUpdatePreview>();
    vi.mocked(api.previewPlanUpdate).mockReturnValueOnce(old.promise).mockResolvedValueOnce(plan(3, 33));
    workspace(); await openUpdate();
    await waitFor(() => expect(api.previewPlanUpdate).toHaveBeenCalledTimes(1));
    fireEvent.click(within(picker()).getByRole("button", { name: /^Version 3/ }));
    await screen.findByText("33 linked · 0 new · 0 replaced");
    await act(async () => old.reject(new Error("Old plan failure")));
    expect(screen.queryByText("Old plan failure")).toBeNull();
    expect(compare().matches(":disabled")).toBe(false);
  });

  it.each(["success", "failure"])("rejects an old %s after closing and reopening the same template", async outcome => {
    const old = deferred<PlanUpdatePreview>(), current = deferred<PlanUpdatePreview>();
    vi.mocked(api.previewPlanUpdate).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    workspace(); await openUpdate();
    await waitFor(() => expect(api.previewPlanUpdate).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(picker(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Run actions" }));
    await openUpdate();
    await waitFor(() => expect(api.previewPlanUpdate).toHaveBeenCalledTimes(2));
    await act(async () => outcome === "success" ? old.resolve(plan(2, 77)) : old.reject(new Error("Closed plan failure")));
    expect(screen.queryByText("77 linked · 0 new · 0 replaced")).toBeNull();
    expect(screen.queryByText("Closed plan failure")).toBeNull();
    expect(compare().matches(":disabled")).toBe(true);
    await act(async () => current.resolve(plan(2, 22)));
    expect(screen.getByText("22 linked · 0 new · 0 replaced")).toBeTruthy();
    expect(compare().matches(":disabled")).toBe(false);
  });

  it("closes a prior-source session and previews only the current sample's target", async () => {
    const old = deferred<PlanUpdatePreview>();
    vi.mocked(api.previewPlanUpdate).mockReturnValueOnce(old.promise).mockResolvedValueOnce(plan(2, 44));
    workspace(); await openUpdate();
    await waitFor(() => expect(api.previewPlanUpdate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Switch processing source" }));
    await screen.findByRole("heading", { name: "Title sample-b" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => old.resolve(plan(2, 77)));
    expect(screen.queryByRole("dialog")).toBeNull();
    await openUpdate();
    await screen.findByText("44 linked · 0 new · 0 replaced");
    expect(vi.mocked(api.previewPlanUpdate).mock.calls[1]).toEqual(["sample-b", "run-b", "template-2"]);
  });

  it("invalidates an accepted comparison when the selected run changes", async () => {
    const value = processing();
    value.runs.push({ ...value.runs[0]!, id: "run-old", status: "complete", completedAt: at, sequenceNo: 0 });
    vi.mocked(api.getProcessingSample).mockResolvedValue(value);
    const current = deferred<PlanUpdatePreview>();
    vi.mocked(api.previewPlanUpdate).mockResolvedValueOnce(plan(2, 66)).mockReturnValueOnce(current.promise);
    workspace(); await openUpdate(); await screen.findByText("66 linked · 0 new · 0 replaced");
    fireEvent.click(compare());
    await screen.findByRole("dialog", { name: "Does this structure handoff match what you expect?" });
    fireEvent.click(screen.getByRole("button", { name: "View another run" }));
    await waitFor(() => expect(api.previewPlanUpdate).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Confirm and update process" })).toBeNull();
    expect(screen.queryByText("66 linked · 0 new · 0 replaced")).toBeNull();
    expect(compare().matches(":disabled")).toBe(true);
    await act(async () => current.resolve(plan(2, 77)));
    expect(compare().matches(":disabled")).toBe(false);
  });

  it("invalidates accepted comparisons after a same-source state and plan-revision refresh", async () => {
    const updated = processing(); updated.updatedAt = later;
    updated.runs[0]!.currentPlanRevisionId = "plan-2";
    vi.mocked(api.getProcessingSample).mockResolvedValueOnce(processing()).mockResolvedValueOnce(updated);
    const current = deferred<PlanUpdatePreview>();
    vi.mocked(api.previewPlanUpdate).mockResolvedValueOnce(plan(2, 66)).mockReturnValueOnce(current.promise);
    workspace(); await openUpdate(); await screen.findByText("66 linked · 0 new · 0 replaced");
    fireEvent.click(compare());
    await screen.findByRole("dialog", { name: "Does this structure handoff match what you expect?" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh processing data" }));
    await waitFor(() => expect(api.previewPlanUpdate).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Confirm and update process" })).toBeNull();
    expect(compare().matches(":disabled")).toBe(true);
    await act(async () => current.resolve(plan(2, 77, later)));
    expect(compare().matches(":disabled")).toBe(false);
  });

  it("recovers a current failure through a fresh version preview", async () => {
    vi.mocked(api.previewPlanUpdate).mockRejectedValueOnce(new Error("Current plan unavailable")).mockResolvedValueOnce(plan(3));
    workspace(); await openUpdate(); await screen.findByText("Current plan unavailable");
    expect(compare().matches(":disabled")).toBe(true);
    fireEvent.click(within(picker()).getByRole("button", { name: /^Version 3/ }));
    await waitFor(() => expect(compare().matches(":disabled")).toBe(false));
    expect(screen.queryByText("Current plan unavailable")).toBeNull();
  });
});

describe("Phase 5F Processing start preview and picker boundaries", () => {
  it.each(["success", "failure"])("keeps a new source's busy state when an old preview settles with %s", async outcome => {
    vi.mocked(api.getProcessingSample).mockImplementation(async id => processing(id, false));
    const old = deferred<RunStartPreview>(), current = deferred<RunStartPreview>();
    vi.mocked(api.previewRunStart).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    workspace(); await openStart(); await chooseStartVersion(); fireEvent.click(compare());
    await waitFor(() => expect(api.previewRunStart).toHaveBeenCalledTimes(1));
    const first = picker(); fireEvent.keyDown(first, { key: "Escape" });
    expect(picker()).toBe(first);
    expect(within(first).getByRole("button", { name: "Loading…" }).matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Switch processing source" }));
    await screen.findByRole("heading", { name: "Title sample-b" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await openStart(); await chooseStartVersion(); fireEvent.click(compare());
    await waitFor(() => expect(api.previewRunStart).toHaveBeenCalledTimes(2));
    await act(async () => outcome === "success" ? old.resolve(structure(2, "Old comparison")) : old.reject(new Error("Old start failure")));
    expect(within(picker()).getByRole("button", { name: "Loading…" }).matches(":disabled")).toBe(true);
    expect(within(picker()).getByRole("button", { name: "Cancel" }).matches(":disabled")).toBe(true);
    expect(screen.queryByText(/Old comparison|Old start failure/)).toBeNull();
    await act(async () => current.resolve(structure(2, "New source comparison", at, "run-b")));
    const confirmation = screen.getByRole("dialog", { name: "Does this structure handoff match what you expect?" });
    expect(within(confirmation).getByText(/New source comparison/)).toBeTruthy();
    expect(within(confirmation).getByRole("button", { name: "Confirm and start run" }).matches(":disabled")).toBe(false);
    expect(document.activeElement).toBe(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(vi.mocked(api.previewRunStart).mock.calls).toEqual([["sample-a", "template-2"], ["sample-b", "template-2"]]);
  });

  it("allows a fresh preview after a current start failure without starting a run", async () => {
    vi.mocked(api.getProcessingSample).mockImplementation(async id => processing(id, false));
    vi.mocked(api.previewRunStart).mockRejectedValueOnce(new Error("Current start unavailable")).mockResolvedValueOnce(structure());
    workspace(); await openStart(); await chooseStartVersion(); fireEvent.click(compare());
    await screen.findByText("Current start unavailable");
    expect(compare().matches(":disabled")).toBe(false);
    fireEvent.click(compare());
    await screen.findByRole("dialog", { name: "Does this structure handoff match what you expect?" });
    expect(screen.queryByText("Current start unavailable")).toBeNull();
    expect(vi.mocked(api.previewRunStart).mock.calls).toEqual([["sample-a", "template-2"], ["sample-a", "template-2"]]);
  });

  it("does not revive an accepted start comparison after leaving and returning to its source", async () => {
    vi.mocked(api.getProcessingSample).mockImplementation(async id => processing(id, false));
    workspace(); await openStart(); await chooseStartVersion(); fireEvent.click(compare());
    await screen.findByRole("dialog", { name: "Does this structure handoff match what you expect?" });
    fireEvent.click(screen.getByRole("button", { name: "Switch processing source" }));
    await screen.findByRole("heading", { name: "Title sample-b" });
    fireEvent.click(screen.getByRole("button", { name: "Return to first source" }));
    await screen.findByRole("heading", { name: "Title sample-a" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await openStart();
    expect(compare().matches(":disabled")).toBe(true);
  });

  it.each(["pending", "accepted"])("does not revive a %s start comparison after a selected-run round trip", async outcome => {
    const value = processing("sample-a", false);
    value.runs.push({ ...value.runs[0]!, id: "run-old", sequenceNo: 0 });
    vi.mocked(api.getProcessingSample).mockResolvedValue(value);
    const old = deferred<RunStartPreview>();
    vi.mocked(api.previewRunStart).mockReturnValueOnce(old.promise).mockResolvedValueOnce(structure(2, "Fresh round-trip comparison"));
    workspace(); await openStart(); await chooseStartVersion(); fireEvent.click(compare());
    await waitFor(() => expect(api.previewRunStart).toHaveBeenCalledTimes(1));
    if (outcome === "accepted") {
      await act(async () => old.resolve(structure(2, "Old round-trip comparison")));
      await screen.findByRole("dialog", { name: "Does this structure handoff match what you expect?" });
    }
    fireEvent.click(screen.getByRole("button", { name: "View another run" }));
    await waitFor(() => expect(compare().matches(":disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Return to first source" }));
    await waitFor(() => expect(compare().matches(":disabled")).toBe(false));
    if (outcome === "pending") await act(async () => old.resolve(structure(2, "Old round-trip comparison")));
    expect(screen.queryByRole("button", { name: "Confirm and start run" })).toBeNull();
    expect(screen.queryByText(/Old round-trip comparison/)).toBeNull();
    fireEvent.click(compare());
    const confirmation = await screen.findByRole("dialog", { name: "Does this structure handoff match what you expect?" });
    expect(within(confirmation).getByText(/Fresh round-trip comparison/)).toBeTruthy();
    expect(api.previewRunStart).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"])("ignores an aborted family search's late %s", async outcome => {
    vi.mocked(api.getProcessingSample).mockImplementation(async id => processing(id, false));
    const old = deferred<Awaited<ReturnType<typeof api.listTemplateFamilies>>>();
    const current = deferred<Awaited<ReturnType<typeof api.listTemplateFamilies>>>();
    vi.mocked(api.listTemplateFamilies).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    workspace(); await openStart();
    await waitFor(() => expect(api.listTemplateFamilies).toHaveBeenCalledTimes(1));
    fireEvent.change(within(picker()).getByRole("textbox", { name: "Search process families" }), { target: { value: "new" } });
    await act(async () => outcome === "success" ? old.resolve(families([family("Old family")])) : old.reject(new Error("Old family failure")));
    expect(screen.queryByText(/Old family/)).toBeNull();
    expect(screen.getByText("Loading process families…")).toBeTruthy();
    expect(vi.mocked(api.listTemplateFamilies).mock.calls[0]![0]?.signal?.aborted).toBe(true);
    await waitFor(() => expect(api.listTemplateFamilies).toHaveBeenCalledTimes(2));
    await act(async () => current.resolve(families([family("New family")])));
    expect(within(picker()).getByRole("button", { name: /^New family/ })).toBeTruthy();
  });

  it.each(["success", "failure"])("keeps the new family's versions after the old request's late %s", async outcome => {
    vi.mocked(api.getProcessingSample).mockImplementation(async id => processing(id, false));
    vi.mocked(api.listTemplateFamilies).mockResolvedValue(families([family(), family("Other family", version(4, "family-b"))]));
    const old = deferred<Awaited<ReturnType<typeof api.listTemplateFamilyVersions>>>();
    vi.mocked(api.listTemplateFamilyVersions).mockReturnValueOnce(old.promise).mockResolvedValueOnce({ versions: [version(4, "family-b")] });
    workspace(); await openStart();
    fireEvent.click(await within(picker()).findByRole("button", { name: /^Process family/ }));
    await waitFor(() => expect(api.listTemplateFamilyVersions).toHaveBeenCalledTimes(1));
    fireEvent.click(within(picker()).getByRole("button", { name: /^Other family/ }));
    await waitFor(() => expect(api.listTemplateFamilyVersions).toHaveBeenCalledTimes(2));
    await act(async () => outcome === "success" ? old.resolve({ versions: [version(2)] }) : old.reject(new Error("Old versions failure")));
    expect(within(picker()).getByRole("button", { name: /^Version 4/ }).getAttribute("aria-pressed")).toBe("true");
    expect(within(picker()).queryByRole("button", { name: /^Version 2/ })).toBeNull();
    expect(screen.queryByText("Old versions failure")).toBeNull();
    expect(vi.mocked(api.listTemplateFamilyVersions).mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(compare().matches(":disabled")).toBe(false);
  });
});

describe("Phase 5F Processing transition dialog keyboard and focus", () => {
  it("contains keyboard focus and returns it to the persistent menu trigger after Escape", async () => {
    vi.mocked(api.getProcessingSample).mockImplementation(async id => processing(id, false));
    workspace(); await openStart();
    const dialog = picker(), first = within(dialog).getByRole("button", { name: "Close" });
    const last = within(dialog).getByRole("button", { name: "Cancel" });
    const search = within(dialog).getByRole("textbox", { name: "Search process families" });
    expect(document.activeElement).toBe(search);
    first.focus(); fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" }); expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Escape", isComposing: true }); expect(picker()).toBe(dialog);
    fireEvent.keyDown(first, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Start run" }));
    expect(document.body.style.overflow).toBe("");
  });

  it("hands focus to structure confirmation and back to template selection before closing", async () => {
    workspace(); await openUpdate();
    await waitFor(() => expect(compare().matches(":disabled")).toBe(false));
    compare().focus(); fireEvent.click(compare());
    const confirmation = screen.getByRole("dialog", { name: "Does this structure handoff match what you expect?" });
    expect(document.activeElement).toBe(within(confirmation).getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(confirmation, { key: "Escape" });
    expect(document.activeElement).toBe(within(picker()).getByRole("button", { name: "Cancel" }));
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(picker(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Run actions" }));
    expect(document.body.style.overflow).toBe("");
  });

  it("uses the same fresh session and focus behavior for a URL-requested start", async () => {
    vi.mocked(api.getProcessingSample).mockImplementation(async id => processing(id, false));
    workspace("/processing/sample-a?action=start");
    await screen.findByRole("dialog", { name: "Choose the incoming process template" });
    expect(document.activeElement).toBe(within(picker()).getByRole("textbox", { name: "Search process families" }));
    fireEvent.keyDown(picker(), { key: "Escape" });
    await openStart(); await chooseStartVersion();
    expect(compare().matches(":disabled")).toBe(false);
    expect(api.previewRunStart).not.toHaveBeenCalled();
  });
});
