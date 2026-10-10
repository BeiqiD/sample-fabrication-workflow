// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessingSampleDetail, SampleRun } from "../shared/types";
import type { RunGridColumn } from "./lib/runGrid";
import { api } from "./lib/api";
import { ProcessingWorkspacePage } from "./pages/ProcessingWorkspacePage";

type GridProps = {
  columns: RunGridColumn[];
  primaryRun: SampleRun;
  onSaved: (affectedSampleIds?: readonly string[]) => Promise<void>;
};
const grid = vi.hoisted(() => ({ current: null as GridProps | null }));
// Keep the real grid and route mounted. The wrapper only observes the sample
// references supplied to the grid; all selection and confirmation use its UI.
vi.mock("./components/MultiSampleRunGrid", async importOriginal => {
  const original = await importOriginal<typeof import("./components/MultiSampleRunGrid")>();
  return {
    ...original,
    MultiSampleRunGrid: (props: GridProps) => {
      grid.current = props;
      return <original.MultiSampleRunGrid {...props} />;
    },
  };
});
vi.mock("./components/ReferenceSourceFocus", () => ({ ProcessingReferenceSourceFocus: () => null }));

const at = "2026-10-10T14:00:00.000Z";
const ids = Array.from({ length: 8 }, (_, index) => `sample-${index}`);
const originalTargets = ids.slice(0, 3).map(id => ({
  sampleId: id, runId: `run-${id}`, stepId: `step-${id}`, expectedUpdatedAt: at,
}));
function detail(id: string, revision = 0, status: "pending" | "in_progress" | "done" = "pending"): ProcessingSampleDetail {
  const run: SampleRun = {
    id: `run-${id}`, recipeFamilyId: "family-a", templateVersionId: "template-a",
    templateName: "Process family", templateType: "process", templateVersion: 1,
    runKind: "process", status: "active", currentPlanRevisionId: `plan-${id}`,
    planRevisionNumber: 1, predecessorRunId: null, anchorStepId: null, sequenceNo: 1,
    runGroupId: "group-a", initialStateHash: null, initialStateImageKeys: [],
    createdAt: at, completedAt: null,
    steps: [{
      id: `step-${id}`, templateStepId: "template-step-a", logicalStepKey: "step-key-a",
      sectionName: null, definitionHash: null, expectedStateHash: null, position: 0, planPosition: 0,
      origin: "template", entryKind: "fabrication", planStatus: "current", title: "Etch", status,
      notes: "Original note", toolName: null, parametersText: null, commentsText: null,
      deviationNote: null, plannedTitle: "Etch", plannedToolName: null, plannedParametersText: null,
      plannedCommentsText: null, plannedImageKeys: [], executionImageKeys: [], comments: [],
      actualizedAt: status === "done" ? at : null, verificationIds: [], stateVerification: null,
      createdAt: at, updatedAt: at,
    }],
  };
  return {
    id, code: id.toUpperCase(), title: `${id} revision ${revision}`, status: "active",
    location: null, parentId: null, inheritedStateHash: null, pinned: false,
    createdAt: at, updatedAt: at, latestWorkflowName: "Process family", latestWorkflowVersion: 1,
    latestRunStatus: "active", currentStepTitle: "Etch", currentStateStepTitle: null,
    currentStateThumbnailKey: null, runs: [run], stateVerifications: [],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
const url = `/processing/${ids[0]}?with=${ids.slice(1).join(",")}`;
function Navigation() {
  const navigate = useNavigate();
  return <>
    <button onClick={() => navigate("/processing/sample-z")}>Switch source</button>
    <button onClick={() => navigate(url)}>Return source</button>
  </>;
}
const network = vi.fn<typeof fetch>();
let server: Map<string, ProcessingSampleDetail>;
let queued: Map<string, Promise<ProcessingSampleDetail>[]>;
beforeEach(() => {
  grid.current = null;
  server = new Map([...ids, "sample-z"].map(id => [id, detail(id)]));
  queued = new Map();
  network.mockReset().mockRejectedValue(new Error("Unexpected network request"));
  vi.stubGlobal("fetch", network);
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(api, "getManagedStorageStatus").mockResolvedValue({ provider: null, available: false, authentication: "not_configured", message: "Not configured in this test." });
  vi.spyOn(api, "getProcessingSample").mockImplementation(id => queued.get(id)?.shift() ?? Promise.resolve(server.get(id)!));
  vi.spyOn(api, "confirmRunSteps").mockResolvedValue({ ok: true, confirmed: 3 });
});
afterEach(() => {
  try { expect(network).not.toHaveBeenCalled(); }
  finally { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});
const columns = () => grid.current!.columns.map(column => column.sample);
const requests = () => vi.mocked(api.getProcessingSample).mock.calls.map(([id]) => id);
function queue(id: string) {
  const result = deferred<ProcessingSampleDetail>();
  const existing = queued.get(id) ?? [];
  existing.push(result.promise); queued.set(id, existing);
  return result;
}
async function ready() {
  render(<MemoryRouter initialEntries={[url]}><Navigation /><Routes>
    <Route path="/processing/:sampleId" element={<ProcessingWorkspacePage />} />
  </Routes></MemoryRouter>);
  await screen.findByRole("button", { name: "Confirm 8 selected sample steps as done" });
  expect(requests()).toEqual(ids);
  return columns();
}
function chooseFirstThree() {
  for (const id of ids.slice(3)) {
    fireEvent.click(screen.getByRole("checkbox", { name: `${id} revision 0 ${id.toUpperCase()}` }));
  }
}
function confirmThree() {
  fireEvent.click(screen.getByRole("button", { name: "Confirm 3 selected sample steps as done" }));
}
function markFirstThreeDone() {
  for (const id of ids.slice(0, 3)) server.set(id, detail(id, 1, "done"));
}

describe("Processing grouped confirmation through the actual grid and page", () => {
  it("reads exactly the three accepted original owners and retains all five other sample references", async () => {
    const before = await ready();
    chooseFirstThree();
    expect(requests()).toEqual(ids); // Selection never reads or writes.
    markFirstThreeDone(); confirmThree();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Saving confirmed steps" })).toBeNull());
    expect(api.confirmRunSteps).toHaveBeenCalledExactlyOnceWith({ targets: originalTargets });
    expect(requests()).toEqual([...ids, ...ids.slice(0, 3)]);
    expect(columns().map(sample => sample.id)).toEqual(ids);
    for (const index of [0, 1, 2]) expect(columns()[index]).toBe(server.get(ids[index]));
    for (const index of [3, 4, 5, 6, 7]) expect(columns()[index]).toBe(before[index]);
    expect(screen.getByRole("button", { name: "Confirm 0 selected sample steps as done" }).hasAttribute("disabled")).toBe(true);
  });

  it("excludes an already done selected owner and an unchecked pending owner from writes and reads", async () => {
    server.set(ids[1], detail(ids[1], 0, "done"));
    render(<MemoryRouter initialEntries={[url]}><Routes>
      <Route path="/processing/:sampleId" element={<ProcessingWorkspacePage />} />
    </Routes></MemoryRouter>);
    await screen.findByRole("button", { name: "Confirm 7 selected sample steps as done" });
    const before = columns(); chooseFirstThree();
    server.set(ids[0], detail(ids[0], 1, "done"));
    server.set(ids[2], detail(ids[2], 1, "done"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm 2 selected sample steps as done" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Saving confirmed steps" })).toBeNull());
    expect(api.confirmRunSteps).toHaveBeenCalledExactlyOnceWith({ targets: [originalTargets[0], originalTargets[2]] });
    expect(requests()).toEqual([...ids, ids[0], ids[2]]);
    for (const index of [1, 3, 4, 5, 6, 7]) expect(columns()[index]).toBe(before[index]);
  });

  it("holds confirmation pending through the accepted write and all three owner reads without replaying it", async () => {
    await ready(); chooseFirstThree();
    const accepted = deferred<{ ok: true; confirmed: number }>();
    vi.mocked(api.confirmRunSteps).mockReturnValue(accepted.promise);
    const reads = ids.slice(0, 3).map(queue); confirmThree();
    expect(screen.getByRole("button", { name: "Saving confirmed steps" }).hasAttribute("disabled")).toBe(true);
    expect(requests()).toEqual(ids);
    // Changes to current selection while the write is held cannot change the
    // already captured original three-target payload or owner refresh scope.
    fireEvent.click(screen.getByRole("checkbox", { name: `${ids[3]} revision 0 ${ids[3].toUpperCase()}` }));
    await act(async () => accepted.resolve({ ok: true, confirmed: 3 }));
    expect(requests()).toEqual([...ids, ...ids.slice(0, 3)]);
    expect(api.confirmRunSteps).toHaveBeenCalledExactlyOnceWith({ targets: originalTargets });
    await act(async () => reads[0].resolve(detail(ids[0], 1, "done")));
    await act(async () => reads[1].resolve(detail(ids[1], 1, "done")));
    expect(screen.getByRole("button", { name: "Saving confirmed steps" }).hasAttribute("disabled")).toBe(true);
    await act(async () => reads[2].resolve(detail(ids[2], 1, "done")));
    expect(screen.queryByRole("button", { name: "Saving confirmed steps" })).toBeNull();
    expect(api.confirmRunSteps).toHaveBeenCalledTimes(1);
  });

  it("does not refresh or alter the captured target payload when the confirmation is rejected", async () => {
    const before = await ready(); chooseFirstThree();
    vi.mocked(api.confirmRunSteps).mockRejectedValue(new Error("One or more steps changed elsewhere. Reload before confirming."));
    confirmThree();
    await screen.findByText("One or more steps changed elsewhere. Reload before confirming.");
    expect(api.confirmRunSteps).toHaveBeenCalledExactlyOnceWith({ targets: originalTargets });
    expect(requests()).toEqual(ids);
    expect(columns()).toEqual(before);
    expect(screen.getByRole("button", { name: "Confirm 3 selected sample steps as done" }).hasAttribute("disabled")).toBe(false);
  });

  it("publishes no partial owner results after a failed group refresh and retains all three invalidations", async () => {
    const before = await ready(); chooseFirstThree();
    const failed = queue(ids[1]); markFirstThreeDone(); confirmThree();
    await waitFor(() => expect(requests()).toHaveLength(11));
    await act(async () => failed.reject(new Error("Second confirmed owner unavailable")));
    expect(columns()).toEqual(before);
    expect(screen.getByRole("alert").textContent).toContain("Second confirmed owner unavailable");
    expect(api.confirmRunSteps).toHaveBeenCalledTimes(1);
    // A later unrelated invalidation must cover all three accepted owners,
    // rather than treating the successfully fetched siblings as published.
    const count = requests().length;
    server.set(ids[4], detail(ids[4], 2));
    await act(async () => grid.current!.onSaved([ids[4]]));
    expect(requests().slice(count)).toEqual([ids[0], ids[1], ids[2], ids[4]]);
    for (const index of [0, 1, 2, 4]) expect(columns()[index]).toBe(server.get(ids[index]));
    for (const index of [3, 5, 6, 7]) expect(columns()[index]).toBe(before[index]);
    expect(api.confirmRunSteps).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched owner response atomically and lets Retry read all owners without another confirmation", async () => {
    const before = await ready(); chooseFirstThree();
    const mismatch = queue(ids[2]); markFirstThreeDone(); confirmThree();
    await waitFor(() => expect(requests()).toHaveLength(11));
    await act(async () => mismatch.resolve(detail(ids[7], 99, "done")));
    expect(columns()).toEqual(before);
    expect(screen.getByRole("alert").textContent).toMatch(/sample.*match/i);
    const count = requests().length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(requests().slice(count)).toEqual(ids);
    expect(api.confirmRunSteps).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      for (const index of [0, 1, 2]) expect(columns()[index]).toBe(server.get(ids[index]));
    });
  });

  it("fences a held accepted original confirmation after switching the route source", async () => {
    await ready(); chooseFirstThree();
    const accepted = deferred<{ ok: true; confirmed: number }>();
    vi.mocked(api.confirmRunSteps).mockReturnValue(accepted.promise);
    confirmThree();
    fireEvent.click(screen.getByRole("button", { name: "Switch source" }));
    await screen.findByRole("heading", { name: "sample-z revision 0" });
    const before = columns(); const count = requests().length;
    await act(async () => accepted.resolve({ ok: true, confirmed: 3 }));
    expect(api.confirmRunSteps).toHaveBeenCalledExactlyOnceWith({ targets: originalTargets });
    expect(requests()).toHaveLength(count);
    expect(columns()).toEqual(before);
    expect(columns().map(sample => sample.id)).toEqual(["sample-z"]);
  });
});
