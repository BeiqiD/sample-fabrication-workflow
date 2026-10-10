// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessingSampleDetail, SampleRun } from "../shared/types";
import { api } from "./lib/api";
import { ProcessingWorkspacePage } from "./pages/ProcessingWorkspacePage";

type GridProps = {
  columns: { sample: ProcessingSampleDetail; run: SampleRun | null }[];
  onSaved: (affectedSampleIds?: readonly string[]) => Promise<void>;
  onAttachmentChanged: () => Promise<void>;
};
const grid = vi.hoisted(() => ({ current: null as GridProps | null }));
// Exercise the real route/read state and typed API, using a controlled grid
// boundary to independently settle overlapping refreshes without fabrication writes.
vi.mock("./components/MultiSampleRunGrid", () => ({
  MultiSampleRunGrid: (props: GridProps) => {
    grid.current = props;
    return <div data-testid="processing-columns">{props.columns.map(column =>
      <span key={column.sample.id}>{column.sample.title}</span>)}</div>;
  },
}));
vi.mock("./components/ReferenceSourceFocus", () => ({ ProcessingReferenceSourceFocus: () => null }));

const at = "2026-10-10T13:00:00.000Z";
const ids = Array.from({ length: 8 }, (_, index) => `sample-${index}`);
function detail(id: string, revision = 0): ProcessingSampleDetail {
  const run: SampleRun = {
    id: `run-${id}`, recipeFamilyId: "family-a", templateVersionId: "template-a",
    templateName: "Process family", templateType: "process", templateVersion: 1,
    runKind: "process", status: "active", currentPlanRevisionId: `plan-${id}`,
    planRevisionNumber: 1, predecessorRunId: null, anchorStepId: null, sequenceNo: 1,
    runGroupId: "group-a", initialStateHash: null, initialStateImageKeys: [],
    createdAt: at, completedAt: null, steps: [],
  };
  return { id, code: id.toUpperCase(), title: `${id} revision ${revision}`, status: "active",
    location: null, parentId: null, inheritedStateHash: null, pinned: false,
    createdAt: at, updatedAt: at, latestWorkflowName: "Process family", latestWorkflowVersion: 1,
    latestRunStatus: "active", currentStepTitle: null, currentStateStepTitle: null,
    currentStateThumbnailKey: null, runs: [run], stateVerifications: [] };
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
function workspace() {
  return render(<MemoryRouter initialEntries={[url]}><Navigation /><Routes>
    <Route path="/processing/:sampleId" element={<ProcessingWorkspacePage />} />
  </Routes></MemoryRouter>);
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
  vi.spyOn(api, "getProcessingSample").mockImplementation(id => queued.get(id)?.shift() ?? Promise.resolve(server.get(id)!));
});
afterEach(() => {
  try { expect(network).not.toHaveBeenCalled(); }
  finally { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});
function queue(id: string) {
  const result = deferred<ProcessingSampleDetail>();
  const existing = queued.get(id) ?? [];
  existing.push(result.promise); queued.set(id, existing);
  return result;
}
const columns = () => grid.current!.columns.map(column => column.sample);
const requests = () => vi.mocked(api.getProcessingSample).mock.calls.map(([id]) => id);
async function ready() {
  workspace(); await screen.findByTestId("processing-columns");
  await waitFor(() => expect(screen.queryByText("Loading processing workspace…")).toBeNull());
  expect(requests()).toEqual(ids);
}
async function begin(affected?: readonly string[]) {
  let result!: Promise<void>;
  await act(async () => {
    result = grid.current!.onSaved(affected);
    // Baseline interprets the proposed scope as its old strict-error boolean.
    // Observe that rejection without leaking it when an earlier assertion fails.
    void result.catch(() => {});
  });
  return { result };
}
async function finish(pending: ReturnType<typeof queue>, value: ProcessingSampleDetail) {
  await act(async () => pending.resolve(value));
}

describe("Processing owner refresh and source isolation", () => {
  it("reads only the declared owner and preserves every other sample reference and visible order", async () => {
    await ready(); const before = columns();
    const replacement = detail(ids[3], 1); server.set(ids[3], replacement);
    await act(async () => grid.current!.onSaved([ids[3], ids[3]]));
    expect(requests()).toEqual([...ids, ids[3]]);
    expect(columns().map(sample => sample.id)).toEqual(ids);
    expect(columns()[3]).toBe(replacement);
    for (const index of [0, 1, 2, 4, 5, 6, 7]) expect(columns()[index]).toBe(before[index]);
    // A successfully covered owner must not remain in later invalidations.
    const next = detail(ids[5], 2); server.set(ids[5], next);
    await act(async () => grid.current!.onSaved([ids[5]]));
    expect(requests()).toEqual([...ids, ids[3], ids[5]]);
    expect(columns()[3]).toBe(replacement); expect(columns()[5]).toBe(next);
  });

  it.each([undefined, [], ["not-visible"]] as const)("keeps default, empty and unknown scopes full: %j", async affected => {
    await ready();
    await act(async () => grid.current!.onSaved(affected));
    expect(requests()).toEqual([...ids, ...ids]);
  });

  it.each(["resolve", "reject"] as const)("unions overlapping A/B and ignores the earlier %s without releasing current loading", async outcome => {
    await ready(); const before = columns();
    const oldA = queue(ids[0]); const first = await begin([ids[0]]);
    const currentA = queue(ids[0]); const currentB = queue(ids[1]);
    const second = await begin([ids[1]]);
    expect(requests()).toEqual([...ids, ids[0], ids[0], ids[1]]);
    await act(async () => {
      if (outcome === "resolve") oldA.resolve(detail(ids[0], 91));
      else oldA.reject(new Error("Superseded read failure"));
      await first.result;
    });
    expect(screen.getByText("Loading processing workspace…")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Superseded read failure");
    const a = detail(ids[0], 2), b = detail(ids[1], 3);
    await finish(currentB, b);
    expect(columns()).toEqual(before); // Promise.all remains atomic.
    await finish(currentA, a); await second.result;
    expect(columns()[0]).toBe(a); expect(columns()[1]).toBe(b);
    for (let index = 2; index < 8; index += 1) expect(columns()[index]).toBe(before[index]);
    expect(screen.queryByText("Loading processing workspace…")).toBeNull();
  });

  it.each(["full-first", "full-second"] as const)("keeps mixed full/partial overlaps full: %s", async order => {
    await ready();
    const old = queue(ids[0]);
    const first = await begin(order === "full-first" ? undefined : [ids[0]]);
    const current = queue(ids[0]);
    const second = await begin(order === "full-first" ? [ids[1]] : undefined);
    const firstScope = order === "full-first" ? ids : [ids[0]];
    expect(requests()).toEqual([...ids, ...firstScope, ...ids]);
    await finish(old, detail(ids[0], 88)); await first.result;
    expect(screen.getByText("Loading processing workspace…")).toBeTruthy();
    await finish(current, detail(ids[0], 2)); await second.result;
    expect(columns()[0].title).toBe(`${ids[0]} revision 2`);
  });

  it("retains failed A/B invalidations for a later C refresh rather than silently leaving stale owners", async () => {
    await ready(); const before = columns();
    const oldA = queue(ids[0]); const first = await begin([ids[0]]);
    const failedA = queue(ids[0]), failedB = queue(ids[1]); const second = await begin([ids[1]]);
    await finish(oldA, detail(ids[0], 88)); await first.result;
    await act(async () => { failedA.reject(new Error("Current owner read failed")); await second.result; });
    await finish(failedB, detail(ids[1], 99));
    expect(screen.getByRole("alert").textContent).toContain("Current owner read failed");
    expect(columns()).toEqual(before);
    const replacements = [0, 1, 2].map(index => detail(ids[index], 5));
    replacements.forEach(sample => server.set(sample.id, sample));
    const count = requests().length;
    await act(async () => grid.current!.onSaved([ids[2]]));
    expect(requests().slice(count)).toEqual(ids.slice(0, 3));
    replacements.forEach((sample, index) => expect(columns()[index]).toBe(sample));
    for (let index = 3; index < 8; index += 1) expect(columns()[index]).toBe(before[index]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("preserves current data on owner read failure and Retry performs a full read without replaying a write", async () => {
    await ready(); const before = columns(); const failed = queue(ids[4]);
    const refresh = await begin([ids[4]]);
    await act(async () => { failed.reject(new Error("Owner unavailable")); await refresh.result; });
    expect(columns()).toEqual(before);
    expect(screen.getByRole("alert").textContent).toContain("Owner unavailable");
    const count = requests().length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(requests().slice(count)).toEqual(ids);
  });

  it("keeps attachment refresh full and rejects a current failure", async () => {
    await ready(); const before = columns(); const failed = queue(ids[5]);
    let failure: unknown;
    let refresh!: Promise<void>;
    await act(async () => { refresh = grid.current!.onAttachmentChanged().catch(error => { failure = error; }); });
    expect(requests()).toEqual([...ids, ...ids]);
    await act(async () => { failed.reject(new Error("Attachment refresh failed")); await refresh; });
    expect((failure as Error).message).toBe("Attachment refresh failed");
    expect(columns()).toEqual(before);
  });

  it("rejects a superseded strict full refresh while its newer owner refresh still covers all pending owners", async () => {
    await ready(); const old = queue(ids[0]);
    let failure: unknown;
    let strict!: Promise<void>;
    await act(async () => { strict = grid.current!.onAttachmentChanged().catch(error => { failure = error; }); });
    const current = queue(ids[0]); const latest = await begin([ids[2]]);
    expect(requests()).toEqual([...ids, ...ids, ...ids]);
    await act(async () => { old.resolve(detail(ids[0], 88)); await strict; });
    expect((failure as Error).message).toContain("processing view changed");
    expect(screen.getByText("Loading processing workspace…")).toBeTruthy();
    await finish(current, detail(ids[0], 2)); await latest.result;
    expect(columns()[0].title).toBe(`${ids[0]} revision 2`);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["resolve", "reject"] as const)("fences old source %s, loading and callbacks even after A/B/A reentry", async outcome => {
    await ready(); const oldCallback = grid.current!.onSaved;
    const oldA = queue(ids[0]); const first = await begin([ids[0]]);
    const z = queue("sample-z");
    fireEvent.click(screen.getByRole("button", { name: "Switch source" }));
    await waitFor(() => expect(requests().at(-1)).toBe("sample-z"));
    expect(screen.queryByTestId("processing-columns")).toBeNull();
    const returnedA = queue(ids[0]);
    fireEvent.click(screen.getByRole("button", { name: "Return source" }));
    await waitFor(() => expect(requests().slice(-8)).toEqual(ids));
    const count = requests().length;
    await act(async () => oldCallback([ids[0]]));
    expect(requests()).toHaveLength(count); // A captured source session is not the new A.
    await act(async () => {
      if (outcome === "resolve") oldA.resolve(detail(ids[0], 88));
      else oldA.reject(new Error("Old source failure"));
      z.resolve(detail("sample-z", 77)); await first.result;
    });
    expect(screen.getByText("Loading processing workspace…")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Old source failure");
    await finish(returnedA, detail(ids[0], 2));
    await waitFor(() => expect(screen.queryByText("Loading processing workspace…")).toBeNull());
    expect(columns()[0].title).toBe(`${ids[0]} revision 2`);
  });

  it("rejects an owner response mismatch atomically and retains invalidation until a correct refresh", async () => {
    await ready(); const before = columns(); const wrong = queue(ids[2]);
    const refresh = await begin([ids[2]]);
    await finish(wrong, detail(ids[7], 42)); await refresh.result;
    expect(columns()).toEqual(before);
    expect(screen.getByRole("alert").textContent).toMatch(/sample.*match/i);
    const count = requests().length;
    await act(async () => grid.current!.onSaved([ids[3]]));
    expect(requests().slice(count)).toEqual([ids[2], ids[3]]);
  });

  it("does not dispatch reads from a callback retained after unmount", async () => {
    const view = workspace(); await screen.findByTestId("processing-columns");
    const saved = grid.current!.onSaved, strict = grid.current!.onAttachmentChanged;
    const count = requests().length; view.unmount();
    await act(async () => saved([ids[0]]));
    await expect(strict()).rejects.toThrow("processing view changed");
    expect(requests()).toHaveLength(count);
  });
});
