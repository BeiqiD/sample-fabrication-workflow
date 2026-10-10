// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SampleDetail, SampleRun } from "../shared/types";
import { MultiSampleRunGrid } from "./components/MultiSampleRunGrid";
import { api, type MetrologyTemplateSummary } from "./lib/api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function ownerFixture(owner: "a" | "b", adHoc = false): { sample: SampleDetail; run: SampleRun } {
  const date = "2026-10-10T12:30:00Z";
  const run: SampleRun = {
    id: `run-${owner}`, recipeFamilyId: "family-a", templateVersionId: "template-a", templateName: "Etch process", templateType: "process", templateVersion: 1, runKind: "process", status: "active",
    currentPlanRevisionId: `revision-${owner}`, planRevisionNumber: 1, predecessorRunId: null, anchorStepId: null, sequenceNo: 1, runGroupId: "group-a", initialStateHash: null, initialStateImageKeys: [], createdAt: date, completedAt: null,
    steps: [{ id: `step-${owner}`, templateStepId: adHoc ? null : "template-step-a", logicalStepKey: "step-key-a", sectionName: null, definitionHash: null, expectedStateHash: null, position: 0, planPosition: 0, origin: adHoc ? "ad_hoc" : "template", entryKind: "fabrication", planStatus: "current", title: "Etch", status: "pending",
      notes: "Original note", toolName: null, parametersText: null, commentsText: null, deviationNote: null, plannedTitle: adHoc ? null : "Etch", plannedToolName: null, plannedParametersText: null, plannedCommentsText: null, plannedImageKeys: [], executionImageKeys: [], comments: [], actualizedAt: null, verificationIds: [], stateVerification: null, createdAt: date, updatedAt: date }],
  };
  const sample: SampleDetail = {
    id: `sample-${owner}`, code: `S-00${owner === "a" ? 1 : 2}`, title: `Owner ${owner}`, status: "active", location: null, parentId: null, inheritedStateHash: null, pinned: false, createdAt: date, updatedAt: date,
    latestWorkflowName: null, latestWorkflowVersion: null, latestRunStatus: null, currentStepTitle: null, currentStateStepTitle: null, currentStateThumbnailKey: null, description: null, parent: null, children: [], events: [], stateVerifications: [], runs: [run], comments: [],
  };
  return { sample, run };
}

const savedTemplate: MetrologyTemplateSummary = { id: "saved-template-a", name: "SEM", toolName: "SEM instrument", hasDefaultContent: true, createdAt: "2026-10-10T12:30:00Z" };
type Saved = (affectedSampleIds?: readonly string[]) => Promise<void>;
let unexpectedFetch: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  unexpectedFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected network request in refresh owner test"));
  vi.stubGlobal("fetch", unexpectedFetch);
  vi.spyOn(api, "getManagedStorageStatus").mockResolvedValue({ provider: null, available: false, authentication: "not_configured", message: "Not configured in this test." });
  vi.spyOn(api, "updateRunStep").mockResolvedValue({ ok: true });
  vi.spyOn(api, "createRunStep").mockResolvedValue({ id: "accepted-new-step-b" });
  vi.spyOn(api, "confirmRunSteps").mockResolvedValue({ ok: true, confirmed: 2 });
  vi.spyOn(api, "listMetrologyTemplates").mockResolvedValue({ templates: [savedTemplate], pagination: { page: 1, pageSize: 50, total: 1, totalPages: 1 } });
  vi.spyOn(api, "createMetrologyTemplate").mockResolvedValue({ id: "created-template-a", version: 1 });
  vi.spyOn(api, "createMetrologyRunEntry").mockResolvedValue({ id: "accepted-metrology-b" });
});

afterEach(() => {
  cleanup();
  expect(unexpectedFetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.style.overflow = "";
});

function renderOwners(onSaved = vi.fn<Saved>(async () => {}), options: { adHoc?: boolean } = {}) {
  const a = ownerFixture("a"), b = ownerFixture("b", options.adHoc);
  const props = { primaryRun: a.run, columns: [a, b], onSaved };
  return { ...render(<MultiSampleRunGrid {...props} />), a, b, props, onSaved };
}

function ownerCell(container: HTMLElement, ownerIndex: number) {
  return container.querySelectorAll<HTMLElement>(".run-grid-row .sample-step-cell")[ownerIndex]!;
}

function openAddMenu(container: HTMLElement) {
  fireEvent.click(within(ownerCell(container, 1)).getByRole("button", { name: "Add after this entry" }));
}

function fillExecution(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "in_progress" } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: /^Actual tool/ }), { target: { value: "Owner B tool" } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: /^Actual parameters/ }), { target: { value: "30 seconds" } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: /^What happened/ }), { target: { value: "Corrected owner B only" } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: /^Reason for deviation/ }), { target: { value: "Observed result" } });
}

describe("Processing refresh scope from actual grid owner actions", () => {
  it.each([false, true])("refreshes exactly the edited fabrication owner after an accepted correction (adHoc=%s)", async adHoc => {
    const owner = renderOwners(undefined, { adHoc });
    fireEvent.click(within(ownerCell(owner.container, 1)).getByRole("button", { name: "Correct" }));
    const dialog = screen.getByRole("dialog", { name: "Correct execution" });
    fillExecution(dialog);
    if (adHoc) fireEvent.change(within(dialog).getByRole("textbox", { name: /^Step name/ }), { target: { value: "Owner B actual step" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(owner.onSaved).toHaveBeenCalledTimes(1));
    expect(api.updateRunStep).toHaveBeenCalledExactlyOnceWith("sample-b", "run-b", "step-b", {
      status: "in_progress", title: adHoc ? "Owner B actual step" : "Etch", toolName: "Owner B tool", parametersText: "30 seconds", commentsText: "Corrected owner B only", deviationNote: "Observed result", notes: "Original note", expectedUpdatedAt: owner.b.run.steps[0].updatedAt,
      assetKey: undefined, assetId: undefined, assetMetadata: undefined,
    });
    expect(owner.onSaved).toHaveBeenCalledExactlyOnceWith(["sample-b"]);
    expect(api.createRunStep).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Correct execution" })).toBeNull();
  });

  it("refreshes only the owner of an accepted added fabrication step without changing its write payload", async () => {
    const owner = renderOwners();
    openAddMenu(owner.container);
    fireEvent.click(screen.getByRole("button", { name: "Fabrication" }));
    const dialog = screen.getByRole("dialog", { name: "Add fabrication step" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Step name/ }), { target: { value: "Owner B clean" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Actual tool/ }), { target: { value: "Owner B tool" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Actual parameters/ }), { target: { value: "30 seconds" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^What happened/ }), { target: { value: "Owner B insertion" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Reason for deviation/ }), { target: { value: "Additional cleaning" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add step" }));
    await waitFor(() => expect(owner.onSaved).toHaveBeenCalledTimes(1));
    expect(api.createRunStep).toHaveBeenCalledExactlyOnceWith("sample-b", "run-b", {
      afterStepId: "step-b", title: "Owner B clean", toolName: "Owner B tool", parametersText: "30 seconds", commentsText: "Owner B insertion", deviationNote: "Additional cleaning", assetKey: undefined, assetId: undefined, assetMetadata: undefined,
    });
    expect(owner.onSaved).toHaveBeenCalledExactlyOnceWith(["sample-b"]);
    expect(api.updateRunStep).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Add fabrication step" })).toBeNull();
  });

  it("keeps the original Metrology owner and refresh callback across a held insertion and a run-object update", async () => {
    const add = deferred<{ id: string }>(), refresh = deferred<void>();
    vi.mocked(api.createMetrologyRunEntry).mockReturnValue(add.promise);
    const onSaved = vi.fn<Saved>(() => refresh.promise), replacementOnSaved = vi.fn<Saved>(async () => {});
    const owner = renderOwners(onSaved);
    openAddMenu(owner.container); fireEvent.click(screen.getByRole("button", { name: "Metrology" }));
    const dialog = screen.getByRole("dialog", { name: "Add metrology" });
    fireEvent.click(await within(dialog).findByRole("button", { name: /SEM.*Add/ }));
    expect(api.createMetrologyRunEntry).toHaveBeenCalledExactlyOnceWith("sample-b", "run-b", { templateVersionId: savedTemplate.id, afterStepId: "step-b" });
    expect(onSaved).not.toHaveBeenCalled();
    const freshRun: SampleRun = { ...owner.b.run, steps: owner.b.run.steps.map(step => ({ ...step, updatedAt: "2026-10-10T12:35:00Z" })) };
    const freshSample: SampleDetail = { ...owner.b.sample, updatedAt: "2026-10-10T12:35:00Z", runs: [freshRun] };
    owner.rerender(<MultiSampleRunGrid {...owner.props} columns={[owner.a, { sample: freshSample, run: freshRun }]} onSaved={replacementOnSaved} />);
    await act(async () => add.resolve({ id: "accepted-metrology-b" }));
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(["sample-b"]);
    expect(replacementOnSaved).not.toHaveBeenCalled();
    expect((within(dialog).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.createMetrologyTemplate).not.toHaveBeenCalled();
    expect(api.createMetrologyRunEntry).toHaveBeenCalledTimes(1);
    await act(async () => refresh.resolve());
    expect(screen.queryByRole("dialog", { name: "Add metrology" })).toBeNull();
  });

  it("keeps the default full refresh for a grouped action with two exact accepted targets", async () => {
    const owner = renderOwners();
    fireEvent.click(screen.getByRole("button", { name: "Confirm 2 selected sample steps as done" }));
    await waitFor(() => expect(owner.onSaved).toHaveBeenCalledTimes(1));
    expect(api.confirmRunSteps).toHaveBeenCalledExactlyOnceWith({ targets: [
      { sampleId: "sample-a", runId: "run-a", stepId: "step-a", expectedUpdatedAt: owner.a.run.steps[0].updatedAt },
      { sampleId: "sample-b", runId: "run-b", stepId: "step-b", expectedUpdatedAt: owner.b.run.steps[0].updatedAt },
    ] });
    expect(owner.onSaved).toHaveBeenCalledExactlyOnceWith();
    expect(api.updateRunStep).not.toHaveBeenCalled();
  });
});
