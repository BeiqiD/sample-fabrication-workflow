// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessingSampleDetail, SampleDetail, SampleEvent, SampleListResponse, SampleRun, SampleSummary } from "../shared/types";
import { SampleTimeline } from "./components/SampleTimeline";
import { api } from "./lib/api";
import { ProcessingPage } from "./pages/ProcessingPage";
import { ProcessingWorkspacePage } from "./pages/ProcessingWorkspacePage";
import { SampleTimelinePage } from "./pages/SampleTimelinePage";

// Keep the actual route, read callbacks, matching logic and run controls. The
// Dense grid itself is qualified by its permanent gates; this small boundary
// exposes the two real refresh contracts without executing a fabrication write.
vi.mock("./components/MultiSampleRunGrid", async () => {
  const { useState } = await import("react");
  return {
    DiagramGallery: () => <div data-testid="diagram-gallery" />,
    MultiSampleRunGrid: ({ primaryRun, columns, onSaved, onAttachmentChanged }: {
      primaryRun: SampleRun;
      columns: Array<{ sample: ProcessingSampleDetail }>;
      onSaved: () => Promise<void>;
      onAttachmentChanged: () => Promise<void>;
    }) => {
      const [outcome, setOutcome] = useState("");
      const refresh = (callback: () => Promise<void>) => {
        setOutcome("pending");
        void callback().then(() => setOutcome("resolved"), () => setOutcome("rejected"));
      };
      return <div data-testid="run-grid" data-run={primaryRun.id}>
        {columns.map(({ sample }) => <span key={sample.id}>{sample.title}</span>)}
        <button type="button" onClick={() => refresh(onSaved)}>Refresh run snapshot</button>
        <button type="button" onClick={() => refresh(onAttachmentChanged)}>Refresh attachment owner</button>
        <output aria-label="Refresh outcome">{outcome}</output>
      </div>;
    },
  };
});
vi.mock("./components/ReferenceSourceFocus", () => ({ ProcessingReferenceSourceFocus: () => null }));

const timestamp = "2026-10-08T10:00:00.000Z";
const run: SampleRun = {
  id: "run-a", recipeFamilyId: "family-a", templateVersionId: "template-a",
  templateName: "Process A", templateType: "process", templateVersion: 1,
  runKind: "process", status: "active", currentPlanRevisionId: "plan-a",
  planRevisionNumber: 1, predecessorRunId: null, anchorStepId: null, sequenceNo: 1,
  runGroupId: "group-a", initialStateHash: null, initialStateImageKeys: [],
  createdAt: timestamp, completedAt: null, steps: [],
};

function summary(id = "sample-a"): SampleSummary {
  return {
    id, code: id.toUpperCase(), title: `Title ${id}`, status: "active", location: null,
    parentId: null, inheritedStateHash: null, pinned: false, createdAt: timestamp,
    updatedAt: timestamp, latestWorkflowName: "Process A", latestWorkflowVersion: 1,
    latestRunStatus: "active", currentStepTitle: null, currentStateStepTitle: null,
    currentStateThumbnailKey: null,
  };
}
function processing(id = "sample-a"): ProcessingSampleDetail {
  return { ...summary(id), runs: [{ ...run, id: id === "sample-a" ? run.id : `run-${id}` }], stateVerifications: [] };
}
function event(id = "created-a"): SampleEvent {
  return { id, sampleId: "sample-a", kind: "created", body: `Audit ${id}`, assetKey: null,
    metadata: {}, actorEmail: "MixedCase.Researcher@example.test", createdAt: timestamp };
}
function detail(id = "sample-a", events: SampleEvent[] = [event()]): SampleDetail {
  return { ...processing(id), description: null, parent: null, children: [], events };
}
function list(samples: SampleSummary[] = [], page = 1): SampleListResponse {
  return { samples, pagination: { page, pageSize: 50, total: samples.length ? 100 : 0, totalPages: 2 },
    facets: { active: samples.length, complete: 0, cancelled: 0, all: samples.length } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function openSamplePicker() {
  // The first grid render can precede the selected-run reset effect. Wait for
  // the visible control, settle React, then issue the one intended open click.
  await waitFor(() => {
    const button = screen.getByRole("button", { name: "+ Add sample" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.queryByText("Loading processing workspace…", { exact: true })).toBeNull();
  });
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "+ Add sample" }));
}
function Location() {
  const location = useLocation();
  return <output aria-label="Current route">{location.pathname}{location.search}</output>;
}
function readStatus(message: string) {
  // <output> has an implicit status role. Resolve the exact read message, then
  // retain the live-region assertion instead of assuming it is the only status.
  const status = screen.getByText(message, { exact: true }).closest('[role="status"]');
  expect(status).not.toBeNull();
  return status!;
}
function directory(url = "/processing") {
  return render(<MemoryRouter initialEntries={[url]}><Location /><Routes>
    <Route path="/processing" element={<ProcessingPage />} />
  </Routes></MemoryRouter>);
}
function timeline(url = "/samples/sample-a/timeline") {
  return render(<MemoryRouter initialEntries={[url]}>
    <Link to="/samples/sample-b/timeline">Other timeline</Link><Location /><Routes>
      <Route path="/samples/:sampleId/timeline" element={<SampleTimelinePage />} />
    </Routes>
  </MemoryRouter>);
}
function workspace(url = "/processing/sample-a?run=run-a") {
  return render(<MemoryRouter initialEntries={[url]}>
    <Link to="/processing/sample-b">Other workspace</Link>
    <Link to="/processing/sample-a?run=run-a&with=sample-b">Compare second sample</Link>
    <Location /><Routes><Route path="/processing/:sampleId" element={<ProcessingWorkspacePage />} /></Routes>
  </MemoryRouter>);
}

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset().mockRejectedValue(new Error("Unexpected network request"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  // These are read-state tests. Neither Retry nor a grid refresh may acquire
  // mutation authority, and all intended reads are spied through their API.
  expect(fetchMock).not.toHaveBeenCalled();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Phase 5E Processing directory read states", () => {
  it("shows a pending read without claiming an empty Processing directory", () => {
    vi.spyOn(api, "listSamples").mockReturnValue(deferred<SampleListResponse>().promise);
    directory();
    expect(readStatus("Loading processing…").textContent).toContain("Loading processing…");
    expect(screen.queryByText("No active processing")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Processing pages" })).toBeNull();
    expect(screen.getByRole("button", { name: /Active/ }).textContent).toContain("—");
  });

  it("retries only the same current filter, query and page after a failed read", async () => {
    const pending = deferred<SampleListResponse>();
    const read = vi.spyOn(api, "listSamples").mockRejectedValueOnce(new Error("Directory offline")).mockReturnValueOnce(pending.promise);
    directory("/processing?status=complete&q=film&page=2");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Directory offline");
    expect(screen.queryByText("No matching process runs")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({ query: "film", page: 2, pageSize: 50, view: "processing", status: "complete" }),
      expect.objectContaining({ query: "film", page: 2, pageSize: 50, view: "processing", status: "complete" }),
    ]);
    expect(readStatus("Loading processing…").textContent).toContain("Loading processing…");
    await act(async () => pending.resolve(list([summary()], 2)));
    expect(screen.getByRole("link", { name: /Title sample-a/ }).getAttribute("href")).toBe("/processing/sample-a");
    expect(screen.getByLabelText("Current route").textContent).toBe("/processing?status=complete&q=film&page=2");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not present the prior filter's rows or page after a new filter fails", async () => {
    const read = vi.spyOn(api, "listSamples").mockResolvedValueOnce(list([summary()])).mockRejectedValueOnce(new Error("Completed unavailable"));
    directory();
    await screen.findByRole("link", { name: /Title sample-a/ });
    fireEvent.click(screen.getByRole("button", { name: /Completed/ }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("link", { name: /Title sample-a/ })).toBeNull();
    expect(screen.queryByText("No completed process runs")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Processing pages" })).toBeNull();
    expect(read.mock.calls[1][0]).toMatchObject({ status: "complete", page: 1 });
  });

  it("ignores a superseded filter response even when its transport ignores abort", async () => {
    const old = deferred<SampleListResponse>();
    const read = vi.spyOn(api, "listSamples").mockReturnValueOnce(old.promise).mockResolvedValueOnce(list([summary("completed-b")]));
    directory();
    fireEvent.click(screen.getByRole("button", { name: /Completed/ }));
    await screen.findByRole("link", { name: /Title completed-b/ });
    await act(async () => old.resolve(list([summary("old-active")])));
    expect(screen.queryByText("Title old-active")).toBeNull();
    expect(screen.getByRole("link", { name: /Title completed-b/ })).toBeTruthy();
    const oldOptions = read.mock.calls[0][0];
    expect(typeof oldOptions === "object" && oldOptions.signal?.aborted).toBe(true);
  });

  it.each([
    ["/processing?status=complete", "No completed process runs"],
    ["/processing?status=all", "No process runs"],
  ])("uses truthful successful-empty copy for %s", async (url, title) => {
    vi.spyOn(api, "listSamples").mockResolvedValue(list());
    directory(url);
    expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("gives the updated date its authoritative machine-readable timestamp", async () => {
    vi.spyOn(api, "listSamples").mockResolvedValue(list([summary()]));
    const view = directory();
    await screen.findByRole("link", { name: /Title sample-a/ });
    expect(view.container.querySelector("time")?.getAttribute("datetime")).toBe(timestamp);
  });
});

describe("Phase 5E Timeline read and filtered-empty states", () => {
  it("retains Timeline context and a read-only Retry after an initial failure", async () => {
    const read = vi.spyOn(api, "getSample").mockRejectedValueOnce(new Error("History offline")).mockResolvedValueOnce(detail());
    timeline();
    expect(screen.getByRole("heading", { name: "Timeline" })).toBeTruthy();
    const alert = await screen.findByRole("alert");
    expect(screen.getByRole("link", { name: "← Sample" }).getAttribute("href")).toBe("/samples/sample-a");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByText("Audit created-a");
    expect(read.mock.calls).toEqual([["sample-a"], ["sample-a"]]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("distinguishes a filter with no matching events from an empty history", async () => {
    vi.spyOn(api, "getSample").mockResolvedValue(detail());
    timeline();
    await screen.findByText("Audit created-a");
    fireEvent.click(screen.getByRole("button", { name: /Notes/ }));
    expect(screen.getByText("No notes in this timeline. Choose All activity to see the complete history.")).toBeTruthy();
    expect(screen.queryByText("No timeline entries yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /All activity/ }));
    expect(screen.getByText("Audit created-a")).toBeTruthy();
  });

  it("keeps the generic Timeline empty state for a genuinely empty history", () => {
    render(<SampleTimeline events={[]} compact />);
    expect(screen.getByText("No timeline entries yet.")).toBeTruthy();
  });

  it("does not let a late read of the prior sample replace the current Timeline", async () => {
    const old = deferred<SampleDetail>();
    vi.spyOn(api, "getSample").mockReturnValueOnce(old.promise).mockResolvedValueOnce(detail("sample-b", [event("new-b")]));
    timeline();
    fireEvent.click(screen.getByRole("link", { name: "Other timeline" }));
    await screen.findByText("Audit new-b");
    await act(async () => old.resolve(detail("sample-a", [event("old-a")])));
    expect(screen.queryByText("Audit old-a")).toBeNull();
    expect(screen.getByRole("heading", { name: "Title sample-b" })).toBeTruthy();
  });

  it("does not let a late failure of the prior sample turn the current Timeline into an error", async () => {
    const old = deferred<SampleDetail>();
    vi.spyOn(api, "getSample").mockReturnValueOnce(old.promise).mockResolvedValueOnce(detail("sample-b", [event("new-b")]));
    timeline();
    fireEvent.click(screen.getByRole("link", { name: "Other timeline" }));
    await screen.findByText("Audit new-b");
    await act(async () => old.reject(new Error("Old source unavailable")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Audit new-b")).toBeTruthy();
  });

  it("preserves actor spelling and exposes the exact event timestamp", () => {
    const view = render(<SampleTimeline events={[event()]} />);
    expect(screen.getByText(/MixedCase\.Researcher@example\.test/).textContent).toContain("MixedCase.Researcher@example.test");
    expect(view.container.querySelector("time")?.getAttribute("datetime")).toBe(timestamp);
  });
});

describe("Phase 5E Processing workspace read and picker recovery", () => {
  it("retries the same source and additional columns after an initial GET failure", async () => {
    let fail = true;
    const read = vi.spyOn(api, "getProcessingSample").mockImplementation(async (id) => {
      if (id === "sample-b" && fail) throw new Error("Second column unavailable");
      return processing(id);
    });
    workspace("/processing/sample-a?run=run-a&with=sample-b");
    const alert = await screen.findByRole("alert");
    expect(screen.getByRole("heading", { name: "Processing workspace" })).toBeTruthy();
    expect(screen.queryByTestId("run-grid")).toBeNull();
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    const grid = await screen.findByTestId("run-grid");
    expect(grid.getAttribute("data-run")).toBe("run-a");
    expect(within(grid).getByText("Title sample-b")).toBeTruthy();
    expect(read.mock.calls).toEqual([["sample-a"], ["sample-b"], ["sample-a"], ["sample-b"]]);
    expect(screen.getByLabelText("Current route").textContent).toBe("/processing/sample-a?run=run-a&with=sample-b");
  });

  it("ignores prior-source GET success when a different workspace becomes current", async () => {
    const old = deferred<ProcessingSampleDetail>();
    vi.spyOn(api, "getProcessingSample").mockReturnValueOnce(old.promise).mockResolvedValueOnce(processing("sample-b"));
    workspace();
    fireEvent.click(screen.getByRole("link", { name: "Other workspace" }));
    const grid = await screen.findByTestId("run-grid");
    expect(grid.getAttribute("data-run")).toBe("run-sample-b");
    await act(async () => old.resolve(processing()));
    expect(screen.getByTestId("run-grid").getAttribute("data-run")).toBe("run-sample-b");
    expect(screen.queryByText("Title sample-a")).toBeNull();
  });

  it("hides the prior column set while a different with URL is loading or failed", async () => {
    const comparison = deferred<ProcessingSampleDetail>();
    vi.spyOn(api, "getProcessingSample").mockImplementation((id) => id === "sample-b" ? comparison.promise : Promise.resolve(processing()));
    workspace();
    await screen.findByTestId("run-grid");
    fireEvent.click(screen.getByRole("link", { name: "Compare second sample" }));
    expect(screen.queryByTestId("run-grid")).toBeNull();
    expect(readStatus("Loading processing workspace…").textContent).toContain("Loading processing workspace…");
    await act(async () => comparison.reject(new Error("Column unavailable")));
    await screen.findByRole("alert");
    expect(screen.queryByTestId("run-grid")).toBeNull();
  });

  it.each([
    ["Refresh run snapshot", "resolved"],
    ["Refresh attachment owner", "rejected"],
  ])("preserves the mounted grid and %s failure contract", async (button, outcome) => {
    const refresh = deferred<ProcessingSampleDetail>();
    const read = vi.spyOn(api, "getProcessingSample").mockResolvedValueOnce(processing()).mockReturnValueOnce(refresh.promise).mockResolvedValueOnce(processing());
    workspace();
    const grid = await screen.findByTestId("run-grid");
    fireEvent.click(within(grid).getByRole("button", { name: button }));
    expect(screen.getByTestId("run-grid")).toBe(grid);
    expect(readStatus("Loading processing workspace…").textContent).toContain("Loading processing workspace…");
    await act(async () => refresh.reject(new Error("Owner refresh unavailable")));
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByLabelText("Refresh outcome").textContent).toBe(outcome));
    expect(screen.getByTestId("run-grid")).toBe(grid);
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByTestId("run-grid")).toBe(grid);
  });

  it("rejects a strict refresh superseded by a newer read rather than claiming it applied", async () => {
    const strict = deferred<ProcessingSampleDetail>();
    const newer = deferred<ProcessingSampleDetail>();
    vi.spyOn(api, "getProcessingSample").mockResolvedValueOnce(processing()).mockReturnValueOnce(strict.promise).mockReturnValueOnce(newer.promise);
    workspace();
    const grid = await screen.findByTestId("run-grid");
    fireEvent.click(within(grid).getByRole("button", { name: "Refresh attachment owner" }));
    fireEvent.click(within(grid).getByRole("button", { name: "Refresh run snapshot" }));
    await act(async () => strict.resolve(processing()));
    await waitFor(() => expect(screen.getByLabelText("Refresh outcome").textContent).toBe("rejected"));
    expect(readStatus("Loading processing workspace…").textContent).toContain("Loading processing workspace…");
    await act(async () => newer.resolve(processing()));
    await waitFor(() => expect(screen.getByLabelText("Refresh outcome").textContent).toBe("resolved"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("run-grid")).toBe(grid);
  });

  it("shows picker-local loading and error before retrying exactly the matching GET", async () => {
    vi.spyOn(api, "getProcessingSample").mockResolvedValue(processing());
    const initial = deferred<SampleListResponse>();
    const retry = deferred<SampleListResponse>();
    const read = vi.spyOn(api, "listSamples").mockReturnValueOnce(initial.promise).mockReturnValueOnce(retry.promise);
    workspace();
    await screen.findByTestId("run-grid");
    await openSamplePicker();
    expect(readStatus("Loading matching samples…").textContent).toContain("Loading matching samples…");
    expect(screen.queryByText("No matching samples to add.")).toBeNull();
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    await act(async () => initial.reject(new Error("Matching search unavailable")));
    const alert = await screen.findByRole("alert");
    expect(alert.closest("#sample-picker-popover")).not.toBeNull();
    expect(screen.queryByText("No matching samples to add.")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({ query: "", pageSize: 20, matchingRun: { recipeFamilyId: "family-a", runKind: "process", status: "active" } }),
      expect.objectContaining({ query: "", pageSize: 20, matchingRun: { recipeFamilyId: "family-a", runKind: "process", status: "active" } }),
    ]);
    await act(async () => retry.resolve(list()));
    expect(screen.getByText("No matching samples to add.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("suppresses old picker rows and ignores a response after changing its query", async () => {
    vi.spyOn(api, "getProcessingSample").mockResolvedValue(processing());
    const old = deferred<SampleListResponse>();
    const current = deferred<SampleListResponse>();
    const read = vi.spyOn(api, "listSamples").mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    workspace();
    await screen.findByTestId("run-grid");
    await openSamplePicker();
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByRole("textbox", { name: "Find a sample assigned to this process" }), { target: { value: "new" } });
    await act(async () => old.resolve(list([summary("old-candidate")])));
    expect(screen.queryByText("Title old-candidate")).toBeNull();
    expect(screen.queryByText("No matching samples to add.")).toBeNull();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => current.resolve(list([summary("new-candidate")])));
    expect(screen.getByRole("button", { name: /Title new-candidate/ })).toBeTruthy();
    expect(screen.queryByText("Title old-candidate")).toBeNull();
  });

  it("ignores failed picker reads after closing instead of turning them into route errors", async () => {
    vi.spyOn(api, "getProcessingSample").mockResolvedValue(processing());
    const pending = deferred<SampleListResponse>();
    const read = vi.spyOn(api, "listSamples").mockReturnValue(pending.promise);
    workspace();
    await screen.findByTestId("run-grid");
    await openSamplePicker();
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "+ Add sample" }));
    await act(async () => pending.reject(new Error("Closed search unavailable")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("No matching samples to add.")).toBeNull();
    expect(screen.getByTestId("run-grid")).toBeTruthy();
  });
});
