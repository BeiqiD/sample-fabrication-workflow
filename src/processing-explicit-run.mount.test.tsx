import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessingSampleDetail, SampleRun } from "../shared/types";
import { api } from "./lib/api";
import { ProcessingWorkspacePage } from "./pages/ProcessingWorkspacePage";

vi.mock("./components/MultiSampleRunGrid", () => ({
  MultiSampleRunGrid: ({ primaryRun, readOnly, onSaved }: {
    primaryRun: SampleRun; readOnly: boolean; onSaved: () => Promise<void>;
  }) => <div><output aria-label="Selected execution">{primaryRun.id}|{readOnly ? "read-only" : "editable"}</output>
    <button onClick={() => void onSaved()}>Refresh selected execution</button></div>,
}));
vi.mock("./components/ReferenceSourceFocus", () => ({ ProcessingReferenceSourceFocus: () => null }));

const at = "2026-10-27T12:00:00.000Z";
function run(id: string, status: SampleRun["status"] = "active", runKind: SampleRun["runKind"] = "process"): SampleRun {
  return {
    id, recipeFamilyId: "family-a", templateVersionId: "template-a", templateName: "Process family", templateType: "process",
    templateVersion: 1, runKind, status, currentPlanRevisionId: `plan-${id}`, planRevisionNumber: 1,
    predecessorRunId: null, anchorStepId: null, sequenceNo: 1, runGroupId: `group-${id}`,
    initialStateHash: null, initialStateImageKeys: [], createdAt: at, completedAt: status === "active" ? null : at, steps: [],
  };
}
function detail(id = "sample-a", runs: SampleRun[] = [run("active-run")]): ProcessingSampleDetail {
  return {
    id, code: id.toUpperCase(), title: `Sample ${id}`, status: "active", location: null, parentId: null,
    inheritedStateHash: null, pinned: false, createdAt: at, updatedAt: at, latestWorkflowName: "Process family",
    latestWorkflowVersion: 1, latestRunStatus: runs[0]?.status ?? null, currentStepTitle: null,
    currentStateStepTitle: null, currentStateThumbnailKey: null, runs, stateVerifications: [],
  };
}
function Location() {
  const location = useLocation();
  return <><output aria-label="Current execution URL">{location.pathname}{location.search}</output>
    <Link to="/processing/sample-a?run=missing&focus=step&step=old-step">Open unavailable run</Link></>;
}
function mount(query = "?run=missing") {
  return render(<MemoryRouter initialEntries={[`/processing/sample-a${query}`]}><Location /><Routes>
    <Route path="/processing/:sampleId" element={<ProcessingWorkspacePage />} />
  </Routes></MemoryRouter>);
}
const execution = () => screen.queryByLabelText("Selected execution");
let value: ProcessingSampleDetail;
const network = vi.fn<typeof fetch>();
beforeEach(() => {
  value = detail();
  network.mockReset().mockRejectedValue(new Error("Unexpected network request")); vi.stubGlobal("fetch", network);
  vi.spyOn(api, "getProcessingSample").mockImplementation(async id => id === "sample-a" ? value : detail(id, [run("secondary-run")]));
  vi.spyOn(api, "listTemplateFamilies").mockRejectedValue(new Error("Unexpected template lookup"));
  vi.spyOn(api, "previewRunStart").mockRejectedValue(new Error("Unexpected start preview"));
  vi.spyOn(api, "startProcessRun").mockRejectedValue(new Error("Unexpected start"));
  vi.spyOn(api, "applyPlanUpdate").mockRejectedValue(new Error("Unexpected plan update"));
  vi.spyOn(api, "finishProcessRun").mockRejectedValue(new Error("Unexpected finish"));
  vi.spyOn(api, "deleteRun").mockRejectedValue(new Error("Unexpected delete"));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function noWrites() {
  expect(network).not.toHaveBeenCalled();
  for (const mutation of [api.startProcessRun, api.applyPlanUpdate, api.finishProcessRun, api.deleteRun]) expect(mutation).not.toHaveBeenCalled();
}

describe("explicit Processing run ownership", () => {
  it.each([0, 1, 3])("keeps a missing explicit run unavailable with %i other runs instead of executing a fallback", async count => {
    value.runs = [run("active-run"), run("old-run", "complete"), run("metrology-run", "complete", "metrology")].slice(0, count);
    const query = "?run=missing&with=sample-b&step=old-step&focus=step&keep=retained";
    mount(query);
    await screen.findByRole("heading", { name: "Requested run unavailable" });
    expect(execution()).toBeNull();
    expect(screen.queryByRole("heading", { name: "No run yet" })).toBeNull();
    expect(screen.getByRole("button", { name: "Run actions" }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Start run" }).matches(":disabled")).toBe(true);
    expect(screen.queryByRole("link", { name: "Offline report" })).toBeNull();
    expect(screen.getByRole("button", { name: "+ Add sample" }).matches(":disabled")).toBe(true);
    expect(screen.getByLabelText("Current execution URL").textContent).toBe(`/processing/sample-a${query}`);
    if (count) {
      const chooser = screen.getByRole("combobox", { name: "Viewing run" }) as HTMLSelectElement;
      expect(chooser.value).toBe("");
      expect(chooser.selectedOptions[0].textContent).toBe("Choose an available run");
    } else expect(screen.queryByRole("combobox", { name: "Viewing run" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull(); noWrites();
  });

  it("treats an explicitly empty run as unavailable and requires deliberate selection", async () => {
    mount("?run=&with=sample-b");
    await screen.findByRole("heading", { name: "Requested run unavailable" });
    expect(execution()).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Viewing run" }), { target: { value: "active-run" } });
    await waitFor(() => expect(execution()?.textContent).toBe("active-run|editable"));
    expect(screen.queryByRole("heading", { name: "Requested run unavailable" })).toBeNull();
    expect(screen.getByLabelText("Current execution URL").textContent).toBe("/processing/sample-a?run=active-run&with=sample-b");
    noWrites();
  });

  it("does not auto-start from an invalid run link or after selecting its available history", async () => {
    value.runs = [run("historical-run", "complete")];
    mount("?run=missing&action=start&step=old-step&focus=step&keep=retained");
    await screen.findByRole("heading", { name: "Requested run unavailable" });
    expect(api.listTemplateFamilies).not.toHaveBeenCalled(); expect(api.previewRunStart).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Viewing run" }), { target: { value: "historical-run" } });
    await waitFor(() => expect(execution()?.textContent).toBe("historical-run|read-only"));
    expect(screen.getByLabelText("Current execution URL").textContent).toBe("/processing/sample-a?run=historical-run&keep=retained");
    expect(screen.queryByRole("dialog")).toBeNull(); expect(api.listTemplateFamilies).not.toHaveBeenCalled(); noWrites();
  });

  it("refreshes the requested identity without selecting another run or discarding its source focus", async () => {
    mount("?run=late-run&step=retained-step&focus=step");
    await screen.findByRole("heading", { name: "Requested run unavailable" });
    value = detail("sample-a", [run("active-run"), run("late-run", "complete")]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh available runs" }));
    await waitFor(() => expect(execution()?.textContent).toBe("late-run|read-only"));
    expect(api.getProcessingSample).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Current execution URL").textContent).toBe("/processing/sample-a?run=late-run&step=retained-step&focus=step");
    noWrites();
  });

  it("removes an execution surface if its exact selected run disappears during a current read", async () => {
    mount("?run=active-run");
    await screen.findByLabelText("Selected execution");
    value = detail("sample-a", [run("another-active-run")]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh selected execution" }));
    await screen.findByRole("heading", { name: "Requested run unavailable" });
    expect(execution()).toBeNull();
    expect(screen.getByRole("button", { name: "Run actions" }).matches(":disabled")).toBe(true);
    expect(screen.getByLabelText("Current execution URL").textContent).toBe("/processing/sample-a?run=active-run");
    noWrites();
  });

  it("keeps a failed read distinct from a confirmed missing run without opening a fallback", async () => {
    mount("?run=missing&step=retained-step&focus=step");
    await screen.findByRole("heading", { name: "Requested run unavailable" });
    vi.mocked(api.getProcessingSample).mockRejectedValueOnce(new Error("Read could not complete"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh available runs" }));
    await screen.findByRole("heading", { name: "Requested run could not be loaded" });
    expect(screen.queryByRole("heading", { name: "Requested run unavailable" })).toBeNull();
    expect(screen.getByText("Read could not complete")).toBeTruthy();
    expect(execution()).toBeNull();
    expect(screen.getByRole("button", { name: "Run actions" }).matches(":disabled")).toBe(true);
    expect(screen.getByLabelText("Current execution URL").textContent).toBe("/processing/sample-a?run=missing&step=retained-step&focus=step");
    noWrites();
  });

  it.each([
    ["", "process-run|editable"],
    ["?run=history-run", "history-run|read-only"],
    ["?run=measurement-run", "measurement-run|editable"],
  ])("retains ordinary selection and metrology editability for %s", async (query, expected) => {
    value.runs = [run("measurement-run", "complete", "metrology"), run("process-run"), run("history-run", "complete")];
    mount(query);
    await waitFor(() => expect(execution()?.textContent).toBe(expected));
    expect(screen.queryByRole("heading", { name: "Requested run unavailable" })).toBeNull(); noWrites();
  });

  it("keeps processing focused on the selected run and sample archive without transfer actions", async () => {
    mount("?run=active-run&with=sample-b&keep=retained");
    await screen.findByLabelText("Selected execution");
    expect(screen.getByRole("link", { name: "Open sample" }).getAttribute("href")).toBe("/samples/sample-a");
    expect(execution()?.textContent).toBe("active-run|editable");
    expect(screen.getByLabelText("Current execution URL").textContent).toBe("/processing/sample-a?run=active-run&with=sample-b&keep=retained");
    expect(screen.queryByRole("link", { name: /report|export|package/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /report|export|package/i })).toBeNull();
    noWrites();
  });

  it("keeps sample identity and status distinct from the viewed run while disclosing workspace help", async () => {
    value.status = "stored";
    const view = mount("?run=active-run");
    await screen.findByLabelText("Selected execution");
    const header = view.container.querySelector<HTMLElement>(".processing-workspace-header")!;
    expect(within(header).getByRole("heading", { name: "Sample sample-a", level: 1 })).toBeTruthy();
    expect(within(header).getByText("SAMPLE-A")).toBeTruthy();
    expect(within(header).getByText("Sample status").parentElement?.textContent).toBe("Sample statusstored");
    expect(view.container.querySelector(".run-controls-status")?.textContent).toBe("Active");
    const help = screen.getByText("Workspace guidance").closest("details")!;
    expect(help.open).toBe(false);
    fireEvent.click(within(help).getByText("Workspace guidance"));
    expect(help.open).toBe(true);
    expect(within(help).getByText("Execute the selected run; sample metadata and the permanent timeline stay in the sample archive.")).toBeTruthy();
    expect(within(help).getByText("Use checked columns for common confirmation and comments. Every correction remains sample-specific.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Add sample" }).getAttribute("aria-expanded")).toBe("false");
    noWrites();
  });

  it("links an empty process-template picker to workbook import in Settings", async () => {
    value.runs = [];
    vi.mocked(api.listTemplateFamilies).mockResolvedValue({ families: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 } });
    mount("");
    await screen.findByRole("heading", { name: "No run yet" });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Start first process" }));
    const picker = screen.getByRole("dialog", { name: "Choose the incoming process template" });
    const link = await within(picker).findByRole("link", { name: "Import a workbook in Settings" });
    expect(link.getAttribute("href")).toBe("/settings/import-workbook");
    expect(picker.textContent).toContain("No process templates are available.");
    expect(screen.queryByRole("link", { name: /export|report/i })).toBeNull();
    noWrites();
  });

  it("keeps an implicit no-run sample on its ordinary first-run path", async () => {
    value.runs = []; mount("");
    await screen.findByRole("heading", { name: "No run yet" });
    expect(screen.queryByRole("heading", { name: "Requested run unavailable" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start run" }).matches(":disabled")).toBe(false);
    noWrites();
  });

  it("still deliberately chooses the next available run after a confirmed deletion", async () => {
    value.runs = [run("history-run", "complete"), run("active-run")];
    vi.mocked(api.deleteRun).mockImplementation(async () => {
      value = detail("sample-a", [run("active-run")]); return { ok: true, updatedAt: at };
    });
    mount("?run=history-run&step=old-step&focus=step&keep=retained");
    await screen.findByLabelText("Selected execution");
    fireEvent.click(screen.getByRole("button", { name: "Run actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Delete run/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this process run?" });
    const button = within(dialog).getByRole("button", { name: "Delete run" });
    await act(async () => { fireEvent.click(button); });
    await waitFor(() => expect(execution()?.textContent).toBe("active-run|editable"));
    expect(api.deleteRun).toHaveBeenCalledExactlyOnceWith("sample-a", "history-run", { expectedSampleUpdatedAt: at });
    expect(screen.getByLabelText("Current execution URL").textContent).toBe("/processing/sample-a?run=active-run&keep=retained");
    expect(screen.queryByRole("heading", { name: "Requested run unavailable" })).toBeNull();
    expect(api.startProcessRun).not.toHaveBeenCalled(); expect(api.finishProcessRun).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
});
