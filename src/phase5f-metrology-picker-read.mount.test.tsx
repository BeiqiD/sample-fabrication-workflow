// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SampleDetail, SampleRun } from "../shared/types";
import { MultiSampleRunGrid } from "./components/MultiSampleRunGrid";
import { api, type MetrologyTemplateSummary } from "./lib/api";

type TemplatesResponse = Awaited<ReturnType<typeof api.listMetrologyTemplates>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function domainFixture(): { sample: SampleDetail; run: SampleRun } {
  const date = "2026-10-10T12:30:00Z";
  const run: SampleRun = { id: "run-a", recipeFamilyId: "family-a", templateVersionId: "template-a", templateName: "Etch process", templateType: "process", templateVersion: 1, runKind: "process", status: "active",
    currentPlanRevisionId: "revision-a", planRevisionNumber: 1, predecessorRunId: null, anchorStepId: null, sequenceNo: 1, runGroupId: "group-a", initialStateHash: null, initialStateImageKeys: [], createdAt: date, completedAt: null,
    steps: [{ id: "step-a", templateStepId: "template-step-a", logicalStepKey: "step-key-a", sectionName: null, definitionHash: null, expectedStateHash: null, position: 0, planPosition: 0, origin: "template", entryKind: "fabrication", planStatus: "current", title: "Etch", status: "done",
      notes: null, toolName: null, parametersText: null, commentsText: null, deviationNote: null, plannedTitle: "Etch", plannedToolName: null, plannedParametersText: null, plannedCommentsText: null, plannedImageKeys: [], executionImageKeys: [], comments: [], actualizedAt: date, verificationIds: [], stateVerification: null, createdAt: date, updatedAt: date }] };
  const sample: SampleDetail = { id: "sample-a", code: "S-001", title: "Metrology sample", status: "active", location: null, parentId: null, inheritedStateHash: null, pinned: false, createdAt: date, updatedAt: date,
    latestWorkflowName: null, latestWorkflowVersion: null, latestRunStatus: null, currentStepTitle: null, currentStateStepTitle: null, currentStateThumbnailKey: null, description: null, parent: null, children: [], events: [], stateVerifications: [], runs: [run], comments: [] };
  return { sample, run };
}

const sem: MetrologyTemplateSummary = { id: "sem-template", name: "SEM", toolName: "SEM instrument", hasDefaultContent: true, createdAt: "2026-10-10T12:30:00Z" };
const afm: MetrologyTemplateSummary = { id: "afm-template", name: "AFM", toolName: "AFM instrument", hasDefaultContent: false, createdAt: "2026-10-10T12:30:00Z" };
function response(templates: MetrologyTemplateSummary[]): TemplatesResponse {
  return { templates, pagination: { page: 1, pageSize: 50, total: templates.length, totalPages: templates.length ? 1 : 0 } };
}
let unexpectedFetch: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  unexpectedFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected network request in Metrology picker read test"));
  vi.stubGlobal("fetch", unexpectedFetch);
  vi.spyOn(api, "getManagedStorageStatus").mockResolvedValue({ provider: null, available: false, authentication: "not_configured", message: "Not configured in this test." });
  vi.spyOn(api, "listMetrologyTemplates").mockResolvedValue(response([sem]));
  vi.spyOn(api, "createMetrologyTemplate").mockResolvedValue({ id: "created-template", version: 1 });
  vi.spyOn(api, "createMetrologyRunEntry").mockResolvedValue({ id: "created-entry" });
});

afterEach(() => {
  cleanup();
  try { expect(unexpectedFetch).not.toHaveBeenCalled(); }
  finally { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.style.overflow = ""; }
});

function renderGrid(onSaved = vi.fn(async () => {})) {
  const { sample, run } = domainFixture();
  return { ...render(<MultiSampleRunGrid primaryRun={run} columns={[{ sample, run }]} onSaved={onSaved} />), onSaved };
}

function openPicker() {
  fireEvent.click(screen.getByRole("button", { name: "Add after this entry" }));
  fireEvent.click(screen.getByRole("button", { name: "Metrology" }));
  return screen.getByRole("dialog", { name: "Add metrology" });
}

async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

function search(dialog: HTMLElement, query: string) {
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Search templates" }), { target: { value: query } });
}

describe("Metrology picker query-owned reads and read-only recovery", () => {
  it.each(["resolve", "reject"] as const)("ignores an old query %s after newer matching rows are accepted", async outcome => {
    const oldRead = deferred<TemplatesResponse>(), newRead = deferred<TemplatesResponse>();
    vi.mocked(api.listMetrologyTemplates).mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    renderGrid(); const dialog = openPicker(); await advance(0);
    search(dialog, "AFM"); await advance(160);
    expect(api.listMetrologyTemplates).toHaveBeenCalledTimes(2);
    await act(async () => newRead.resolve(response([afm])));
    expect(within(dialog).getByRole("button", { name: /AFM.*Add/ })).toBeTruthy();
    await act(async () => {
      if (outcome === "resolve") oldRead.resolve(response([sem]));
      else oldRead.reject(new Error("Abandoned query unavailable"));
    });
    expect(within(dialog).getByRole("button", { name: /AFM.*Add/ })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /SEM.*Add/ })).toBeNull();
    expect(document.body.textContent).not.toContain("Abandoned query unavailable");
    expect(api.createMetrologyTemplate).not.toHaveBeenCalled(); expect(api.createMetrologyRunEntry).not.toHaveBeenCalled();
  });

  it("removes old actionable rows immediately during the existing 160 ms query debounce", async () => {
    const nextRead = deferred<TemplatesResponse>();
    vi.mocked(api.listMetrologyTemplates).mockResolvedValueOnce(response([sem])).mockReturnValueOnce(nextRead.promise);
    renderGrid(); const dialog = openPicker(); await advance(0);
    expect(within(dialog).getByRole("button", { name: /SEM.*Add/ })).toBeTruthy();
    search(dialog, "AFM");
    expect(within(dialog).queryByRole("button", { name: /SEM.*Add/ })).toBeNull();
    expect(within(dialog).getByText("Loading metrology templates…")).toBeTruthy();
    expect(api.listMetrologyTemplates).toHaveBeenCalledTimes(1);
    await advance(159); expect(api.listMetrologyTemplates).toHaveBeenCalledTimes(1);
    await advance(1); expect(api.listMetrologyTemplates).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.listMetrologyTemplates).mock.calls[1][0]).toMatchObject({ query: "AFM", pageSize: 50 });
    expect(api.createMetrologyTemplate).not.toHaveBeenCalled(); expect(api.createMetrologyRunEntry).not.toHaveBeenCalled();
    await act(async () => nextRead.resolve(response([afm])));
    expect(within(dialog).getByRole("button", { name: /AFM.*Add/ })).toBeTruthy();
  });

  it("keeps an insertion failure visible when an unrelated current list read succeeds", async () => {
    const read = deferred<TemplatesResponse>();
    vi.mocked(api.listMetrologyTemplates).mockReturnValueOnce(read.promise);
    vi.mocked(api.createMetrologyRunEntry).mockRejectedValueOnce(new Error("Entry insertion unavailable"));
    const owner = renderGrid(); const dialog = openPicker(); await advance(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create new metrology template" }));
    fireEvent.change(within(dialog).getByLabelText("Template title"), { target: { value: "Raman draft" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Save and add" })); });
    expect(within(dialog).getByText("Entry insertion unavailable")).toBeTruthy();
    await act(async () => read.resolve(response([sem])));
    expect(within(dialog).getByText("Entry insertion unavailable")).toBeTruthy();
    expect(api.createMetrologyTemplate).toHaveBeenCalledTimes(1); expect(api.createMetrologyRunEntry).toHaveBeenCalledTimes(1);
    expect(owner.onSaved).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("keeps a newer query loading when an old query settles with %s", async outcome => {
    const oldRead = deferred<TemplatesResponse>(), newRead = deferred<TemplatesResponse>();
    vi.mocked(api.listMetrologyTemplates).mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    renderGrid(); const dialog = openPicker(); await advance(0);
    search(dialog, "AFM"); await advance(160);
    await act(async () => {
      if (outcome === "resolve") oldRead.resolve(response([sem]));
      else oldRead.reject(new Error("Abandoned query unavailable"));
    });
    expect(within(dialog).getByText("Loading metrology templates…")).toBeTruthy();
    expect(within(dialog).queryByText("No matching metrology templates.")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /SEM.*Add/ })).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain("Abandoned query unavailable");
    await act(async () => newRead.resolve(response([afm])));
    expect(within(dialog).queryByText("Loading metrology templates…")).toBeNull();
    expect(within(dialog).getByRole("button", { name: /AFM.*Add/ })).toBeTruthy();
    expect(api.createMetrologyTemplate).not.toHaveBeenCalled(); expect(api.createMetrologyRunEntry).not.toHaveBeenCalled();
  });

  it("announces a current query read failure and retries only that same read without showing a false empty result", async () => {
    const retry = deferred<TemplatesResponse>();
    vi.mocked(api.listMetrologyTemplates).mockResolvedValueOnce(response([sem]))
      .mockRejectedValueOnce(new Error("AFM listing unavailable")).mockReturnValueOnce(retry.promise);
    const owner = renderGrid(); const dialog = openPicker(); await advance(0);
    search(dialog, "AFM"); await advance(160);
    expect(within(dialog).getByRole("alert").textContent).toContain("AFM listing unavailable");
    expect(within(dialog).queryByText("No matching metrology templates.")).toBeNull();
    expect(within(dialog).queryByText("Loading metrology templates…")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /SEM.*Add/ })).toBeNull();
    const retryButton = within(dialog).getByRole("button", { name: "Retry templates" });
    fireEvent.click(retryButton); await advance(160);
    expect(api.listMetrologyTemplates).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.listMetrologyTemplates).mock.calls.map(([options]) => options?.query)).toEqual(["", "AFM", "AFM"]);
    expect(within(dialog).getByText("Loading metrology templates…")).toBeTruthy();
    expect(within(dialog).queryByText("No matching metrology templates.")).toBeNull();
    const pendingRetry = within(dialog).queryByRole("button", { name: "Retry templates" }) as HTMLButtonElement | null;
    if (pendingRetry) { expect(pendingRetry.disabled).toBe(true); fireEvent.click(pendingRetry); }
    await advance(160); expect(api.listMetrologyTemplates).toHaveBeenCalledTimes(3);
    await act(async () => retry.resolve(response([afm])));
    expect(within(dialog).getByRole("button", { name: /AFM.*Add/ })).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(api.createMetrologyTemplate).not.toHaveBeenCalled(); expect(api.createMetrologyRunEntry).not.toHaveBeenCalled();
    expect(owner.onSaved).not.toHaveBeenCalled();
  });

  it("leaves repeated retry failures explicit and shows empty only after a successful empty read", async () => {
    vi.mocked(api.listMetrologyTemplates).mockRejectedValueOnce(new Error("Initial list unavailable"))
      .mockRejectedValueOnce(new Error("Retry list unavailable")).mockResolvedValueOnce(response([]));
    renderGrid(); const dialog = openPicker(); await advance(0);
    expect(within(dialog).getByRole("alert").textContent).toContain("Initial list unavailable");
    expect(within(dialog).queryByText("No matching metrology templates.")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry templates" })); await advance(0);
    expect(within(dialog).getByRole("alert").textContent).toContain("Retry list unavailable");
    expect(within(dialog).queryByText("No matching metrology templates.")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry templates" })); await advance(0);
    expect(within(dialog).getByText("No matching metrology templates.")).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(vi.mocked(api.listMetrologyTemplates).mock.calls.map(([options]) => options?.query)).toEqual(["", "", ""]);
    expect(api.createMetrologyTemplate).not.toHaveBeenCalled(); expect(api.createMetrologyRunEntry).not.toHaveBeenCalled();
  });

  it("shows an empty successful matching query without exposing rows from its previous query", async () => {
    vi.mocked(api.listMetrologyTemplates).mockResolvedValueOnce(response([sem])).mockResolvedValueOnce(response([]));
    renderGrid(); const dialog = openPicker(); await advance(0);
    search(dialog, "missing"); await advance(160);
    expect(within(dialog).getByText("No matching metrology templates.")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /SEM.*Add/ })).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(api.createMetrologyTemplate).not.toHaveBeenCalled(); expect(api.createMetrologyRunEntry).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("ignores a superseded retry %s when the user searches another query", async outcome => {
    const retry = deferred<TemplatesResponse>(), newRead = deferred<TemplatesResponse>();
    vi.mocked(api.listMetrologyTemplates).mockRejectedValueOnce(new Error("Initial list unavailable"))
      .mockReturnValueOnce(retry.promise).mockReturnValueOnce(newRead.promise);
    renderGrid(); const dialog = openPicker(); await advance(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry templates" })); await advance(0);
    search(dialog, "AFM"); await advance(160);
    await act(async () => newRead.resolve(response([afm])));
    await act(async () => {
      if (outcome === "resolve") retry.resolve(response([sem]));
      else retry.reject(new Error("Abandoned retry unavailable"));
    });
    expect(within(dialog).getByRole("button", { name: /AFM.*Add/ })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /SEM.*Add/ })).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain("Abandoned retry unavailable");
    expect(vi.mocked(api.listMetrologyTemplates).mock.calls.map(([options]) => options?.query)).toEqual(["", "", "AFM"]);
    expect(api.createMetrologyTemplate).not.toHaveBeenCalled(); expect(api.createMetrologyRunEntry).not.toHaveBeenCalled();
  });

  it("keeps an accepted-template insertion failure visible through separate list failure and a GET-only retry", async () => {
    const read = deferred<TemplatesResponse>();
    vi.mocked(api.listMetrologyTemplates).mockReturnValueOnce(read.promise).mockResolvedValueOnce(response([sem]));
    vi.mocked(api.createMetrologyRunEntry).mockRejectedValueOnce(new Error("Entry insertion unavailable"));
    const owner = renderGrid(); const dialog = openPicker(); await advance(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create new metrology template" }));
    fireEvent.change(within(dialog).getByLabelText("Template title"), { target: { value: "Raman draft" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Save and add" })); });
    await act(async () => read.reject(new Error("Template listing unavailable")));
    expect(within(dialog).getByText("Entry insertion unavailable")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(within(dialog).getByRole("alert").textContent).toContain("Template listing unavailable");
    expect(within(dialog).getByText("Entry insertion unavailable")).toBeTruthy();
    expect(within(dialog).queryByText("No matching metrology templates.")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry templates" })); await advance(0);
    expect(within(dialog).getByRole("button", { name: /SEM.*Add/ })).toBeTruthy();
    expect(within(dialog).getByText("Entry insertion unavailable")).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(api.listMetrologyTemplates).toHaveBeenCalledTimes(2);
    expect(api.createMetrologyTemplate).toHaveBeenCalledTimes(1); expect(api.createMetrologyRunEntry).toHaveBeenCalledTimes(1);
    expect(owner.onSaved).not.toHaveBeenCalled();
  });
});
