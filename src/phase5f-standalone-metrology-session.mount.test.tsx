// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessingSampleDetail, SampleRun } from "../shared/types";
import { StandaloneMetrologyDialog } from "./components/StandaloneMetrologyDialog";
import { api, type MetrologyTemplateSummary } from "./lib/api";
import { ProcessingWorkspacePage } from "./pages/ProcessingWorkspacePage";

// Preserve the real page, router, standalone dialog and shared modal hook. The
// unrelated grid/focus boundary performs no fabrication or provider mutation.
vi.mock("./components/MultiSampleRunGrid", () => ({ MultiSampleRunGrid: () => null }));
vi.mock("./components/ReferenceSourceFocus", () => ({ ProcessingReferenceSourceFocus: () => null }));

const at = "2026-10-10T12:00:00.000Z";
function template(id: string, name = id): MetrologyTemplateSummary {
  return { id, name, toolName: "Instrument", createdAt: at, hasDefaultContent: false };
}
function directory(templates = [template("sem-template", "SEM")]) {
  return { templates, pagination: { page: 1, pageSize: 50, total: templates.length, totalPages: 1 } };
}
function processing(id: string): ProcessingSampleDetail {
  const run: SampleRun = {
    id: `run-${id}`, recipeFamilyId: "family-a", templateVersionId: "process-template-a", templateName: "Process family",
    templateType: "process", templateVersion: 1, runKind: "process", status: "active", currentPlanRevisionId: "plan-a",
    planRevisionNumber: 1, predecessorRunId: null, anchorStepId: null, sequenceNo: 1, runGroupId: "group-a",
    initialStateHash: null, initialStateImageKeys: [], createdAt: at, completedAt: null, steps: [],
  };
  return { id, code: id.toUpperCase(), title: `Title ${id}`, status: "active", location: null, parentId: null,
    inheritedStateHash: null, pinned: false, createdAt: at, updatedAt: at, latestWorkflowName: "Process family",
    latestWorkflowVersion: 1, latestRunStatus: "active", currentStepTitle: null, currentStateStepTitle: null,
    currentStateThumbnailKey: null, runs: [run], stateVerifications: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function Navigation() {
  const navigate = useNavigate(), location = useLocation();
  return <><button onClick={() => navigate("/processing/sample-b?run=run-sample-b")}>Switch processing source</button>
    <button onClick={() => navigate("/processing/sample-a?run=run-sample-a")}>Return to first source</button>
    <button onClick={() => navigate("/processing/sample-a?run=run-sample-a&with=sample-c")}>Change visible samples</button>
    <output aria-label="Processing route">{location.pathname}{location.search}</output></>;
}
function workspace() {
  return render(<MemoryRouter initialEntries={["/processing/sample-a?run=run-sample-a"]}><Navigation /><Routes>
    <Route path="/processing/:sampleId" element={<ProcessingWorkspacePage />} />
    <Route path="/templates" element={<p>Templates destination</p>} />
  </Routes></MemoryRouter>);
}
function dialog(onStarted = vi.fn<(runId: string) => void | Promise<void>>(), onClose = vi.fn()) {
  const view = render(<MemoryRouter><Navigation /><StandaloneMetrologyDialog sampleId="sample-a" onClose={onClose} onStarted={onStarted} /></MemoryRouter>);
  return { ...view, onStarted, onClose };
}
const picker = () => screen.getByRole("dialog", { name: "Choose a metrology template" });
async function choice(name = "SEM") { return within(picker()).findByRole("button", { name: new RegExp(`^${name}`) }); }
async function openStandalone() {
  const trigger = await screen.findByRole("button", { name: "Start run" });
  trigger.focus(); fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("menuitem", { name: "Start metrology" }));
  return choice();
}

const network = vi.fn<typeof fetch>();
beforeEach(() => {
  network.mockReset().mockRejectedValue(new Error("Unexpected real network request")); vi.stubGlobal("fetch", network);
  vi.spyOn(api, "listMetrologyTemplates").mockResolvedValue(directory());
  vi.spyOn(api, "startMetrologyRun").mockResolvedValue({ id: "metrology-run-a" });
  vi.spyOn(api, "getProcessingSample").mockImplementation(async id => processing(id));
});
afterEach(() => {
  try { expect(network).not.toHaveBeenCalled(); }
  finally { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

describe("Phase 5F standalone Metrology session ownership", () => {
  it("does not call the abandoned started callback after the dialog unmounts", async () => {
    const accepted = deferred<Awaited<ReturnType<typeof api.startMetrologyRun>>>();
    vi.mocked(api.startMetrologyRun).mockReturnValue(accepted.promise);
    const view = dialog(); fireEvent.click(await choice());
    expect(api.startMetrologyRun).toHaveBeenCalledExactlyOnceWith("sample-a", { templateVersionId: "sem-template" });
    view.unmount(); await act(async () => accepted.resolve({ id: "accepted-old-run" }));
    expect(view.onStarted).not.toHaveBeenCalled();
  });

  it("does not reopen the first source's idle picker after another processing sample loads", async () => {
    workspace(); await openStandalone();
    fireEvent.click(screen.getByRole("button", { name: "Switch processing source" }));
    await screen.findByRole("heading", { name: "Title sample-b" });
    expect(screen.queryByRole("dialog", { name: "Choose a metrology template" })).toBeNull();
    expect(api.startMetrologyRun).not.toHaveBeenCalled();
  });

  it("ignores an old successful directory response after the current query succeeds", async () => {
    const old = deferred<Awaited<ReturnType<typeof api.listMetrologyTemplates>>>();
    vi.mocked(api.listMetrologyTemplates).mockReturnValueOnce(old.promise).mockResolvedValueOnce(directory([template("raman-template", "Raman")]));
    dialog(); await waitFor(() => expect(api.listMetrologyTemplates).toHaveBeenCalledTimes(1));
    fireEvent.change(within(picker()).getByRole("textbox", { name: "Search templates" }), { target: { value: "Raman" } });
    await choice("Raman"); await act(async () => old.resolve(directory()));
    expect(within(picker()).queryByRole("button", { name: /^SEM/ })).toBeNull();
    expect(within(picker()).getByRole("button", { name: /^Raman/ })).toBeTruthy();
  });

  it("hides the prior query's selectable rows immediately while the new query loads", async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.listMetrologyTemplates>>>();
    vi.mocked(api.listMetrologyTemplates).mockResolvedValueOnce(directory()).mockReturnValueOnce(pending.promise);
    dialog(); await choice();
    fireEvent.change(within(picker()).getByRole("textbox", { name: "Search templates" }), { target: { value: "Raman" } });
    expect(within(picker()).queryByRole("button", { name: /^SEM/ })).toBeNull();
    expect(api.startMetrologyRun).not.toHaveBeenCalled();
  });

  it("does not resurrect cached selectable rows when a query returns to its earlier value", async () => {
    const intermediate = deferred<Awaited<ReturnType<typeof api.listMetrologyTemplates>>>(), current = deferred<Awaited<ReturnType<typeof api.listMetrologyTemplates>>>();
    vi.mocked(api.listMetrologyTemplates).mockResolvedValueOnce(directory()).mockReturnValueOnce(intermediate.promise).mockReturnValueOnce(current.promise);
    dialog(); await choice();
    const search = within(picker()).getByRole("textbox", { name: "Search templates" });
    fireEvent.change(search, { target: { value: "Raman" } });
    await waitFor(() => expect(api.listMetrologyTemplates).toHaveBeenCalledTimes(2));
    fireEvent.change(search, { target: { value: "" } });
    expect(within(picker()).queryByRole("button", { name: /^SEM/ })).toBeNull();
    await waitFor(() => expect(api.listMetrologyTemplates).toHaveBeenCalledTimes(3));
    await act(async () => current.resolve(directory([template("new-sem-template", "Current SEM")])));
    await choice("Current SEM"); await act(async () => intermediate.resolve(directory([template("raman-template", "Raman")])));
    expect(within(picker()).queryByRole("button", { name: /^Raman/ })).toBeNull();
    expect(api.startMetrologyRun).not.toHaveBeenCalled();
  });

  it("ignores an older directory error after the new query has succeeded", async () => {
    const old = deferred<Awaited<ReturnType<typeof api.listMetrologyTemplates>>>();
    vi.mocked(api.listMetrologyTemplates).mockReturnValueOnce(old.promise).mockResolvedValueOnce(directory([template("raman-template", "Raman")]));
    dialog(); await waitFor(() => expect(api.listMetrologyTemplates).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(api.listMetrologyTemplates).mock.calls[0]![0]!.signal!;
    fireEvent.change(within(picker()).getByRole("textbox", { name: "Search templates" }), { target: { value: "Raman" } });
    await choice("Raman"); expect(signal.aborted).toBe(true);
    await act(async () => old.reject(new Error("Obsolete SEM directory failed")));
    expect(screen.queryByText("Obsolete SEM directory failed")).toBeNull();
    expect(within(picker()).getByRole("button", { name: /^Raman/ })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retries only the failed current-query directory GET without a start mutation", async () => {
    const retried = deferred<Awaited<ReturnType<typeof api.listMetrologyTemplates>>>();
    vi.mocked(api.listMetrologyTemplates).mockResolvedValueOnce(directory())
      .mockRejectedValueOnce(new Error("Current Raman directory failed")).mockReturnValueOnce(retried.promise);
    dialog(); await choice();
    fireEvent.change(within(picker()).getByRole("textbox", { name: "Search templates" }), { target: { value: "Raman" } });
    await screen.findByText("Current Raman directory failed");
    expect(screen.getByRole("alert").textContent).toContain("Current Raman directory failed");
    expect(screen.queryByText("No matching metrology templates. Create one from Templates first.")).toBeNull();
    fireEvent.click(within(picker()).getByRole("button", { name: "Retry templates" }));
    await waitFor(() => expect(api.listMetrologyTemplates).toHaveBeenCalledTimes(3));
    expect(screen.queryByText("Current Raman directory failed")).toBeNull();
    expect(within(picker()).getByText("Loading metrology templates…")).toBeTruthy();
    await act(async () => retried.resolve(directory([template("raman-template", "Raman")])));
    await choice("Raman");
    expect(vi.mocked(api.listMetrologyTemplates).mock.calls.map(([input]) => ({ query: input!.query, pageSize: input!.pageSize }))).toEqual([
      { query: "", pageSize: 50 }, { query: "Raman", pageSize: 50 }, { query: "Raman", pageSize: 50 },
    ]);
    expect(api.startMetrologyRun).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not erase a controlled start failure when a later directory query succeeds", async () => {
    vi.mocked(api.startMetrologyRun).mockRejectedValueOnce(new Error("Start was not accepted"));
    vi.mocked(api.listMetrologyTemplates).mockResolvedValueOnce(directory()).mockResolvedValueOnce(directory([template("raman-template", "Raman")]));
    const view = dialog(); fireEvent.click(await choice());
    await screen.findByText("Start was not accepted");
    fireEvent.change(within(picker()).getByRole("textbox", { name: "Search templates" }), { target: { value: "Raman" } });
    await choice("Raman");
    expect(screen.getByText("Start was not accepted")).toBeTruthy();
    expect(api.startMetrologyRun).toHaveBeenCalledTimes(1); expect(view.onStarted).not.toHaveBeenCalled();
    expect(within(picker()).getByRole("button", { name: "Close" }).matches(":disabled")).toBe(false);
  });

  it("keeps the entire start and started-callback chain pending with its original payload", async () => {
    const accepted = deferred<Awaited<ReturnType<typeof api.startMetrologyRun>>>(), refreshed = deferred<void>();
    vi.mocked(api.startMetrologyRun).mockReturnValue(accepted.promise);
    const onStarted = vi.fn<(runId: string) => void | Promise<void>>().mockReturnValue(refreshed.promise);
    const view = dialog(onStarted), selected = await choice(); fireEvent.click(selected);
    const assertBlocked = () => {
      const current = picker();
      for (const name of ["Close", "Cancel"]) {
        const button = within(current).getByRole("button", { name });
        expect(button.matches(":disabled")).toBe(true); fireEvent.click(button);
      }
      expect(within(current).getByRole("textbox", { name: "Search templates" }).matches(":disabled")).toBe(true);
      fireEvent.keyDown(current, { key: "Escape" }); fireEvent.mouseDown(current.parentElement!);
      const manage = within(current).getByRole("link", { name: "Manage templates" });
      expect(manage.getAttribute("href")).toBe("/templates"); expect(manage.getAttribute("aria-disabled")).toBe("true");
      expect(manage.tabIndex).toBe(-1); expect(fireEvent.click(manage)).toBe(false);
      fireEvent.click(selected);
      expect(view.onClose).not.toHaveBeenCalled(); expect(screen.getByRole("dialog")).toBe(current);
      expect(screen.getByLabelText("Processing route").textContent).toBe("/");
      expect(api.startMetrologyRun).toHaveBeenCalledExactlyOnceWith("sample-a", { templateVersionId: "sem-template" });
    };
    assertBlocked(); expect(onStarted).not.toHaveBeenCalled();
    await act(async () => accepted.resolve({ id: "accepted-run-a" }));
    expect(onStarted).toHaveBeenCalledExactlyOnceWith("accepted-run-a"); assertBlocked();
    await act(async () => refreshed.resolve());
    expect(within(picker()).getByRole("button", { name: "Close" }).matches(":disabled")).toBe(false);
    expect(within(picker()).getByRole("link", { name: "Manage templates" }).getAttribute("aria-disabled")).toBeNull();
    expect(api.startMetrologyRun).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure"] as const)("keeps a remounted same-target session pending after the old start's %s", async outcome => {
    const old = deferred<Awaited<ReturnType<typeof api.startMetrologyRun>>>(), current = deferred<Awaited<ReturnType<typeof api.startMetrologyRun>>>();
    vi.mocked(api.startMetrologyRun).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const previous = dialog(); fireEvent.click(await choice()); previous.unmount();
    const next = dialog(); fireEvent.click(await choice());
    await act(async () => outcome === "success" ? old.resolve({ id: "old-accepted-run" }) : old.reject(new Error("Old start failed")));
    expect(previous.onStarted).not.toHaveBeenCalled(); expect(next.onStarted).not.toHaveBeenCalled();
    expect(within(picker()).getByRole("button", { name: "Close" }).matches(":disabled")).toBe(true);
    expect(screen.queryByText("Old start failed")).toBeNull();
    await act(async () => current.reject(new Error("Current start failed")));
    expect(screen.getByText("Current start failed")).toBeTruthy();
    expect(within(picker()).getByRole("button", { name: "Close" }).matches(":disabled")).toBe(false);
    expect(api.startMetrologyRun).toHaveBeenCalledTimes(2);
  });

  it("handles a current started-callback rejection without retrying the accepted start", async () => {
    const onStarted = vi.fn<(runId: string) => void | Promise<void>>().mockRejectedValue(new Error("View refresh failed"));
    dialog(onStarted); fireEvent.click(await choice()); await screen.findByText("View refresh failed");
    expect(onStarted).toHaveBeenCalledExactlyOnceWith("metrology-run-a");
    expect(api.startMetrologyRun).toHaveBeenCalledTimes(1);
    expect(within(picker()).getByRole("button", { name: "Close" }).matches(":disabled")).toBe(false);
  });

  it("starts a fresh session if the same mounted dialog receives another sample target", async () => {
    const old = deferred<Awaited<ReturnType<typeof api.startMetrologyRun>>>(), current = deferred<Awaited<ReturnType<typeof api.startMetrologyRun>>>();
    vi.mocked(api.startMetrologyRun).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const previous = dialog(); fireEvent.click(await choice());
    const onStarted = vi.fn<(runId: string) => void | Promise<void>>(), onClose = vi.fn();
    previous.rerender(<MemoryRouter><Navigation /><StandaloneMetrologyDialog sampleId="sample-b" onClose={onClose} onStarted={onStarted} /></MemoryRouter>);
    fireEvent.click(await choice()); await act(async () => old.resolve({ id: "old-source-run" }));
    expect(previous.onStarted).not.toHaveBeenCalled(); expect(onStarted).not.toHaveBeenCalled();
    expect(within(picker()).getByRole("button", { name: "Close" }).matches(":disabled")).toBe(true);
    await act(async () => current.resolve({ id: "current-source-run" }));
    expect(onStarted).toHaveBeenCalledExactlyOnceWith("current-source-run");
    expect(vi.mocked(api.startMetrologyRun).mock.calls).toEqual([
      ["sample-a", { templateVersionId: "sem-template" }], ["sample-b", { templateVersionId: "sem-template" }],
    ]);
  });

  it("does not let an accepted old-source start navigate or close a newer source's session", async () => {
    const old = deferred<Awaited<ReturnType<typeof api.startMetrologyRun>>>(), current = deferred<Awaited<ReturnType<typeof api.startMetrologyRun>>>();
    vi.mocked(api.startMetrologyRun).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    workspace(); fireEvent.click(await openStandalone());
    fireEvent.click(screen.getByRole("button", { name: "Switch processing source" }));
    await screen.findByRole("heading", { name: "Title sample-b" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(await openStandalone());
    await act(async () => old.resolve({ id: "old-accepted-run" }));
    expect(screen.getByLabelText("Processing route").textContent).toBe("/processing/sample-b?run=run-sample-b");
    expect(within(picker()).getByRole("button", { name: "Close" }).matches(":disabled")).toBe(true);
    expect(vi.mocked(api.getProcessingSample).mock.calls).toEqual([["sample-a"], ["sample-b"]]);
    await act(async () => current.reject(new Error("Current source start failed")));
    expect(screen.getByText("Current source start failed")).toBeTruthy();
    expect(vi.mocked(api.startMetrologyRun).mock.calls).toEqual([
      ["sample-a", { templateVersionId: "sem-template" }], ["sample-b", { templateVersionId: "sem-template" }],
    ]);
  });

  it("does not resurrect a prior opening when returning to the first source", async () => {
    workspace(); await openStandalone();
    fireEvent.click(screen.getByRole("button", { name: "Switch processing source" })); await screen.findByRole("heading", { name: "Title sample-b" });
    fireEvent.click(screen.getByRole("button", { name: "Return to first source" })); await screen.findByRole("heading", { name: "Title sample-a" });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(api.startMetrologyRun).not.toHaveBeenCalled();
  });

  it("closes the prior opening when the same sample's visible-source set changes", async () => {
    workspace(); await openStandalone();
    fireEvent.click(screen.getByRole("button", { name: "Change visible samples" }));
    await waitFor(() => expect(api.getProcessingSample).toHaveBeenCalledTimes(3));
    await screen.findByRole("heading", { name: "Title sample-a" });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(api.startMetrologyRun).not.toHaveBeenCalled();
  });

  it("keeps the ordinary host close-before-load flow and one accepted start after a GET failure", async () => {
    const accepted = deferred<Awaited<ReturnType<typeof api.startMetrologyRun>>>();
    vi.mocked(api.startMetrologyRun).mockReturnValue(accepted.promise);
    vi.mocked(api.getProcessingSample).mockResolvedValueOnce(processing("sample-a")).mockRejectedValueOnce(new Error("Post-start read failed"));
    workspace(); fireEvent.click(await openStandalone());
    await act(async () => accepted.resolve({ id: "accepted-run-a" }));
    await screen.findByText("Post-start read failed");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Processing route").textContent).toBe("/processing/sample-a?run=accepted-run-a");
    expect(vi.mocked(api.getProcessingSample).mock.calls).toEqual([["sample-a"], ["sample-a"]]);
    expect(api.startMetrologyRun).toHaveBeenCalledExactlyOnceWith("sample-a", { templateVersionId: "sem-template" });
  });

  it("keeps the existing opening's callback when its background Start metrology action repeats", async () => {
    const accepted = deferred<Awaited<ReturnType<typeof api.startMetrologyRun>>>();
    vi.mocked(api.startMetrologyRun).mockReturnValue(accepted.promise);
    workspace(); fireEvent.click(await openStandalone());
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Start metrology" }));
    expect(api.startMetrologyRun).toHaveBeenCalledTimes(1);
    await act(async () => accepted.resolve({ id: "accepted-run-a" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Processing route").textContent).toBe("/processing/sample-a?run=accepted-run-a");
    expect(vi.mocked(api.getProcessingSample).mock.calls).toEqual([["sample-a"], ["sample-a"]]);
    expect(api.startMetrologyRun).toHaveBeenCalledExactlyOnceWith("sample-a", { templateVersionId: "sem-template" });
  });

  it.each(["Close", "Cancel", "Escape", "backdrop"] as const)("preserves idle %s dismissal and initial focus", async path => {
    const view = dialog(); await choice();
    const current = picker(), search = within(current).getByRole("textbox", { name: "Search templates" });
    expect(document.activeElement).toBe(search); fireEvent.mouseDown(current); expect(view.onClose).not.toHaveBeenCalled();
    if (path === "Escape") fireEvent.keyDown(current, { key: "Escape" });
    else if (path === "backdrop") fireEvent.mouseDown(current.parentElement!);
    else fireEvent.click(within(current).getByRole("button", { name: path }));
    expect(view.onClose).toHaveBeenCalledTimes(1); expect(api.startMetrologyRun).not.toHaveBeenCalled();
  });

  it("preserves the idle Manage templates link and modal Tab trapping", async () => {
    dialog(); await choice();
    const current = picker(), close = within(current).getByRole("button", { name: "Close" }), cancel = within(current).getByRole("button", { name: "Cancel" });
    cancel.focus(); fireEvent.keyDown(cancel, { key: "Tab" }); expect(document.activeElement).toBe(close);
    close.focus(); fireEvent.keyDown(close, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(cancel);
    const manage = within(current).getByRole("link", { name: "Manage templates" });
    expect(manage.getAttribute("href")).toBe("/templates"); expect(manage.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(manage); expect(screen.getByLabelText("Processing route").textContent).toBe("/templates");
    expect(api.startMetrologyRun).not.toHaveBeenCalled();
  });
});
