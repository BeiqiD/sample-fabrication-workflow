// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SampleDetail, SampleRun } from "../shared/types";
import { MultiSampleRunGrid } from "./components/MultiSampleRunGrid";
import { api, type MetrologyTemplateInput, type MetrologyTemplateSummary } from "./lib/api";

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

const savedTemplate: MetrologyTemplateSummary = { id: "saved-template-a", name: "SEM", toolName: "SEM instrument", hasDefaultContent: true, createdAt: "2026-10-10T12:30:00Z" };
const draft: MetrologyTemplateInput = { name: "Raman draft", toolName: "Raman instrument", parametersText: "532 nm", commentsText: "Surface observation" };
let unexpectedFetch: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  unexpectedFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected network request in Metrology pending test"));
  vi.stubGlobal("fetch", unexpectedFetch);
  vi.spyOn(api, "getManagedStorageStatus").mockResolvedValue({ provider: null, available: false, authentication: "not_configured", message: "Not configured in this test." });
  vi.spyOn(api, "listMetrologyTemplates").mockResolvedValue({ templates: [savedTemplate], pagination: { page: 1, pageSize: 50, total: 1, totalPages: 1 } });
  vi.spyOn(api, "createMetrologyTemplate").mockResolvedValue({ id: "created-template-a", version: 1 });
  vi.spyOn(api, "createMetrologyRunEntry").mockResolvedValue({ id: "metrology-entry-a" });
});

afterEach(() => {
  cleanup();
  expect(unexpectedFetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.style.overflow = "";
});

function renderGrid(onSaved = vi.fn(async () => {}), options: { readOnly?: boolean; completed?: boolean } = {}) {
  const { sample, run } = domainFixture();
  if (options.completed) { run.status = "complete"; run.completedAt = sample.updatedAt; }
  const props = { primaryRun: run, columns: [{ sample, run }], onSaved, readOnly: options.readOnly ?? false };
  return { ...render(<MultiSampleRunGrid {...props} />), sample, run, props, onSaved };
}

async function openPicker() {
  fireEvent.click(screen.getByRole("button", { name: "Add after this entry" }));
  fireEvent.click(screen.getByRole("button", { name: "Metrology" }));
  const dialog = screen.getByRole("dialog", { name: "Add metrology" });
  await within(dialog).findByRole("button", { name: /SEM.*Add/ });
  return dialog;
}

async function openCreate() {
  const dialog = await openPicker();
  fireEvent.click(within(dialog).getByRole("button", { name: "Create new metrology template" }));
  fireEvent.change(within(dialog).getByLabelText("Template title"), { target: { value: draft.name } });
  fireEvent.change(within(dialog).getByLabelText(/Tool/), { target: { value: draft.toolName } });
  fireEvent.change(within(dialog).getByLabelText(/Parameters/), { target: { value: draft.parametersText } });
  fireEvent.change(within(dialog).getByLabelText(/Comments/), { target: { value: draft.commentsText } });
  return dialog;
}

function dismiss(dialog: HTMLElement, path: "Escape" | "Close" | "backdrop") {
  if (path === "Escape") fireEvent.keyDown(dialog, { key: "Escape" });
  else if (path === "Close") fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  else fireEvent.mouseDown(dialog.parentElement!);
}

function assertCreatePending(dialog: HTMLElement) {
  expect(screen.getByRole("dialog", { name: "Add metrology" })).toBe(dialog);
  expect((within(dialog).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(dialog).getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(dialog).getByLabelText("Template title") as HTMLInputElement).value).toBe(draft.name);
  fireEvent.click(within(dialog).getByRole("button", { name: "Saving…" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
}

function assertPickerPending(dialog: HTMLElement) {
  expect(screen.getByRole("dialog", { name: "Add metrology" })).toBe(dialog);
  const close = within(dialog).getByRole("button", { name: "Close" }) as HTMLButtonElement;
  const add = within(dialog).getByRole("button", { name: /SEM.*Adding…/ }) as HTMLButtonElement;
  const create = within(dialog).getByRole("button", { name: "Create new metrology template" }) as HTMLButtonElement;
  expect(close.disabled).toBe(true); expect(add.disabled).toBe(true); expect(create.disabled).toBe(true);
  fireEvent.click(add); fireEvent.click(create);
}

describe("Metrology picker full-chain pending and original-session ownership", () => {
  it.each(["Escape", "Close", "backdrop"] as const)("blocks %s while template creation is pending", async path => {
    const create = deferred<{ id: string; version: number }>();
    vi.mocked(api.createMetrologyTemplate).mockReturnValue(create.promise);
    renderGrid(); const dialog = await openCreate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save and add" }));
    expect(api.createMetrologyTemplate).toHaveBeenCalledExactlyOnceWith(draft);
    dismiss(dialog, path);
    expect(screen.getByRole("dialog", { name: "Add metrology" })).toBe(dialog);
    expect((within(dialog).getByLabelText("Template title") as HTMLInputElement).value).toBe(draft.name);
    expect(api.createMetrologyTemplate).toHaveBeenCalledTimes(1);
    expect(api.createMetrologyRunEntry).not.toHaveBeenCalled();
  });

  it("does not insert or refresh after the original grid unmounts during template creation", async () => {
    const create = deferred<{ id: string; version: number }>();
    vi.mocked(api.createMetrologyTemplate).mockReturnValue(create.promise);
    const owner = renderGrid(); const dialog = await openCreate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save and add" }));
    owner.unmount();
    await act(async () => { create.resolve({ id: "accepted-template-a", version: 1 }); await create.promise; });
    expect(api.createMetrologyRunEntry).not.toHaveBeenCalled();
    expect(owner.onSaved).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Add metrology" })).toBeNull();
  });

  it.each([
    { phase: "create", outcome: "resolve" }, { phase: "create", outcome: "reject" },
    { phase: "add", outcome: "resolve" }, { phase: "add", outcome: "reject" },
  ] as const)("ignores an old $phase $outcome after the same target opens a new pending session", async ({ phase, outcome }) => {
    const oldCreate = deferred<{ id: string; version: number }>(), oldAdd = deferred<{ id: string }>();
    const newCreate = deferred<{ id: string; version: number }>();
    if (phase === "create") vi.mocked(api.createMetrologyTemplate).mockReturnValueOnce(oldCreate.promise).mockReturnValueOnce(newCreate.promise);
    else {
      vi.mocked(api.createMetrologyTemplate).mockResolvedValueOnce({ id: "old-accepted-template", version: 1 }).mockReturnValueOnce(newCreate.promise);
      vi.mocked(api.createMetrologyRunEntry).mockReturnValueOnce(oldAdd.promise);
    }
    const oldOwner = renderGrid(); const oldDialog = await openCreate();
    fireEvent.click(within(oldDialog).getByRole("button", { name: "Save and add" }));
    if (phase === "add") await waitFor(() => expect(api.createMetrologyRunEntry).toHaveBeenCalledTimes(1));
    oldOwner.unmount();
    const newOwner = renderGrid(); const newDialog = await openCreate();
    fireEvent.click(within(newDialog).getByRole("button", { name: "Save and add" }));
    await act(async () => {
      if (phase === "create") {
        if (outcome === "resolve") oldCreate.resolve({ id: "old-accepted-template", version: 1 });
        else oldCreate.reject(new Error("Abandoned create failed"));
      } else if (outcome === "resolve") oldAdd.resolve({ id: "old-accepted-entry" });
      else oldAdd.reject(new Error("Abandoned add failed"));
    });
    assertCreatePending(newDialog);
    for (const path of ["Escape", "Close", "backdrop"] as const) { dismiss(newDialog, path); assertCreatePending(newDialog); }
    expect(document.body.textContent).not.toContain("Abandoned");
    expect(oldOwner.onSaved).not.toHaveBeenCalled(); expect(newOwner.onSaved).not.toHaveBeenCalled();
    expect(api.createMetrologyTemplate).toHaveBeenCalledTimes(2);
    expect(api.createMetrologyRunEntry).toHaveBeenCalledTimes(phase === "add" ? 1 : 0);
    await act(async () => newCreate.reject(new Error("Current create unavailable")));
    expect((within(newDialog).getByRole("alert")).textContent).toBe("Current create unavailable");
    expect((within(newDialog).getByRole("button", { name: "Save and add" }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(newDialog).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(false);
    expect(api.createMetrologyRunEntry).toHaveBeenCalledTimes(phase === "add" ? 1 : 0);
  });

  it("preserves ordered original create/add payloads and waits for refresh across an ordinary run-object update", async () => {
    const create = deferred<{ id: string; version: number }>(), add = deferred<{ id: string }>(), refresh = deferred<void>();
    const order: string[] = [];
    vi.mocked(api.createMetrologyTemplate).mockImplementation(input => { expect(input).toEqual(draft); order.push("create"); return create.promise; });
    vi.mocked(api.createMetrologyRunEntry).mockImplementation(() => { order.push("add"); return add.promise; });
    const onSaved = vi.fn(() => { order.push("refresh"); return refresh.promise; });
    const owner = renderGrid(onSaved); const dialog = await openCreate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save and add" }));
    expect(order).toEqual(["create"]);
    await act(async () => create.resolve({ id: "accepted-template-a", version: 7 }));
    expect(api.createMetrologyRunEntry).toHaveBeenCalledExactlyOnceWith("sample-a", "run-a", { templateVersionId: "accepted-template-a", afterStepId: "step-a" });
    expect(order).toEqual(["create", "add"]); assertCreatePending(dialog);
    await act(async () => add.resolve({ id: "accepted-entry-a" }));
    expect(order).toEqual(["create", "add", "refresh"]); assertCreatePending(dialog);
    const refreshedRun: SampleRun = { ...owner.run, steps: owner.run.steps.map(step => ({ ...step, updatedAt: "2026-10-10T12:35:00Z" })) };
    const refreshedSample: SampleDetail = { ...owner.sample, updatedAt: "2026-10-10T12:35:00Z", runs: [refreshedRun] };
    owner.rerender(<MultiSampleRunGrid {...owner.props} primaryRun={refreshedRun} columns={[{ sample: refreshedSample, run: refreshedRun }]} />);
    assertCreatePending(dialog);
    await act(async () => refresh.resolve());
    expect(screen.queryByRole("dialog", { name: "Add metrology" })).toBeNull();
    expect(api.createMetrologyTemplate).toHaveBeenCalledExactlyOnceWith(draft);
    expect(api.createMetrologyRunEntry).toHaveBeenCalledTimes(1); expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it.each(["Escape", "Close", "backdrop"] as const)("blocks %s and competing form actions through entry insertion and refresh", async path => {
    const add = deferred<{ id: string }>(), refresh = deferred<void>();
    vi.mocked(api.createMetrologyRunEntry).mockReturnValue(add.promise);
    const onSaved = vi.fn(() => refresh.promise);
    renderGrid(onSaved); const dialog = await openCreate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save and add" }));
    await waitFor(() => expect(api.createMetrologyRunEntry).toHaveBeenCalledTimes(1));
    dismiss(dialog, path); assertCreatePending(dialog);
    expect(api.createMetrologyTemplate).toHaveBeenCalledTimes(1); expect(onSaved).not.toHaveBeenCalled();
    await act(async () => add.resolve({ id: "accepted-entry-a" }));
    expect(onSaved).toHaveBeenCalledTimes(1);
    dismiss(dialog, path); assertCreatePending(dialog);
    expect(api.createMetrologyTemplate).toHaveBeenCalledTimes(1); expect(api.createMetrologyRunEntry).toHaveBeenCalledTimes(1);
    await act(async () => refresh.resolve());
    expect(screen.queryByRole("dialog", { name: "Add metrology" })).toBeNull();
  });

  it("adds an existing template once, blocks competing picker actions through refresh, and never creates a template", async () => {
    const add = deferred<{ id: string }>(), refresh = deferred<void>();
    vi.mocked(api.createMetrologyRunEntry).mockReturnValue(add.promise);
    const onSaved = vi.fn(() => refresh.promise);
    renderGrid(onSaved); const dialog = await openPicker();
    fireEvent.click(within(dialog).getByRole("button", { name: /SEM.*Add/ }));
    expect(api.createMetrologyRunEntry).toHaveBeenCalledExactlyOnceWith("sample-a", "run-a", { templateVersionId: savedTemplate.id, afterStepId: "step-a" });
    for (const path of ["Escape", "Close", "backdrop"] as const) { dismiss(dialog, path); assertPickerPending(dialog); }
    expect(onSaved).not.toHaveBeenCalled();
    await act(async () => add.resolve({ id: "accepted-entry-a" }));
    expect(onSaved).toHaveBeenCalledTimes(1);
    for (const path of ["Escape", "Close", "backdrop"] as const) { dismiss(dialog, path); assertPickerPending(dialog); }
    expect(api.createMetrologyTemplate).not.toHaveBeenCalled(); expect(api.createMetrologyRunEntry).toHaveBeenCalledTimes(1);
    await act(async () => refresh.resolve());
    expect(screen.queryByRole("dialog", { name: "Add metrology" })).toBeNull();
  });

  it("does not refresh an abandoned direct Add session when its already-dispatched entry is accepted", async () => {
    const add = deferred<{ id: string }>();
    vi.mocked(api.createMetrologyRunEntry).mockReturnValue(add.promise);
    const owner = renderGrid(); const dialog = await openPicker();
    fireEvent.click(within(dialog).getByRole("button", { name: /SEM.*Add/ }));
    owner.unmount();
    await act(async () => add.resolve({ id: "accepted-entry-a" }));
    expect(api.createMetrologyRunEntry).toHaveBeenCalledTimes(1); expect(api.createMetrologyTemplate).not.toHaveBeenCalled();
    expect(owner.onSaved).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("ignores an old held refresh %s while the same target has a new pending drawer", async outcome => {
    const oldRefresh = deferred<void>(), newCreate = deferred<{ id: string; version: number }>();
    const oldOnSaved = vi.fn(() => oldRefresh.promise);
    const oldOwner = renderGrid(oldOnSaved); const oldDialog = await openPicker();
    fireEvent.click(within(oldDialog).getByRole("button", { name: /SEM.*Add/ }));
    await waitFor(() => expect(oldOnSaved).toHaveBeenCalledTimes(1));
    assertPickerPending(oldDialog);
    oldOwner.unmount();
    vi.mocked(api.createMetrologyTemplate).mockReturnValueOnce(newCreate.promise);
    const newOwner = renderGrid(); const newDialog = await openCreate();
    fireEvent.click(within(newDialog).getByRole("button", { name: "Save and add" }));
    await act(async () => {
      if (outcome === "resolve") oldRefresh.resolve();
      else oldRefresh.reject(new Error("Abandoned refresh failed"));
    });
    for (const path of ["Escape", "Close", "backdrop"] as const) { dismiss(newDialog, path); assertCreatePending(newDialog); }
    expect(document.body.textContent).not.toContain("Abandoned refresh failed");
    expect(api.createMetrologyTemplate).toHaveBeenCalledExactlyOnceWith(draft);
    expect(api.createMetrologyRunEntry).toHaveBeenCalledExactlyOnceWith("sample-a", "run-a", { templateVersionId: savedTemplate.id, afterStepId: "step-a" });
    expect(oldOnSaved).toHaveBeenCalledTimes(1); expect(newOwner.onSaved).not.toHaveBeenCalled();
    await act(async () => newCreate.reject(new Error("Current create unavailable")));
    expect(within(newDialog).getByRole("alert").textContent).toBe("Current create unavailable");
    expect((within(newDialog).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(false);
    expect(api.createMetrologyRunEntry).toHaveBeenCalledTimes(1);
  });

  it("retains the create draft and releases pending after a current create failure without insertion or replay", async () => {
    const create = deferred<{ id: string; version: number }>();
    vi.mocked(api.createMetrologyTemplate).mockReturnValue(create.promise);
    const owner = renderGrid(); const dialog = await openCreate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save and add" }));
    await act(async () => create.reject(new Error("Create unavailable")));
    expect(within(dialog).getByRole("alert").textContent).toBe("Create unavailable");
    expect((within(dialog).getByLabelText("Template title") as HTMLInputElement).value).toBe(draft.name);
    expect((within(dialog).getByLabelText(/Tool/) as HTMLInputElement).value).toBe(draft.toolName);
    expect((within(dialog).getByLabelText(/Parameters/) as HTMLTextAreaElement).value).toBe(draft.parametersText);
    expect((within(dialog).getByLabelText(/Comments/) as HTMLTextAreaElement).value).toBe(draft.commentsText);
    expect((within(dialog).getByRole("button", { name: "Save and add" }) as HTMLButtonElement).disabled).toBe(false);
    expect(api.createMetrologyTemplate).toHaveBeenCalledTimes(1); expect(api.createMetrologyRunEntry).not.toHaveBeenCalled();
    expect(owner.onSaved).not.toHaveBeenCalled();
    dismiss(dialog, "Close"); expect(screen.queryByRole("dialog", { name: "Add metrology" })).toBeNull();
  });

  it("retains the accepted-template draft and visible add failure without retrying either POST", async () => {
    const add = deferred<{ id: string }>();
    vi.mocked(api.createMetrologyRunEntry).mockReturnValue(add.promise);
    const owner = renderGrid(); const dialog = await openCreate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save and add" }));
    await waitFor(() => expect(api.createMetrologyRunEntry).toHaveBeenCalledTimes(1));
    await act(async () => add.reject(new Error("Entry insertion unavailable")));
    expect(within(dialog).getByText("Entry insertion unavailable")).toBeTruthy();
    expect((within(dialog).getByLabelText("Template title") as HTMLInputElement).value).toBe(draft.name);
    expect((within(dialog).getByRole("button", { name: "Save and add" }) as HTMLButtonElement).disabled).toBe(false);
    expect(api.createMetrologyTemplate).toHaveBeenCalledTimes(1); expect(api.createMetrologyRunEntry).toHaveBeenCalledTimes(1);
    expect(owner.onSaved).not.toHaveBeenCalled();
    dismiss(dialog, "Escape"); expect(screen.queryByRole("dialog", { name: "Add metrology" })).toBeNull();
  });

  it("controls a current direct Add rejection and releases picker actions without replay", async () => {
    const add = deferred<{ id: string }>();
    vi.mocked(api.createMetrologyRunEntry).mockReturnValue(add.promise);
    const owner = renderGrid(); const dialog = await openPicker();
    fireEvent.click(within(dialog).getByRole("button", { name: /SEM.*Add/ }));
    await act(async () => add.reject(new Error("Direct Add unavailable")));
    expect(within(dialog).getByText("Direct Add unavailable")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: /SEM.*Add/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(dialog).getByRole("button", { name: "Create new metrology template" }) as HTMLButtonElement).disabled).toBe(false);
    expect(api.createMetrologyTemplate).not.toHaveBeenCalled(); expect(api.createMetrologyRunEntry).toHaveBeenCalledTimes(1);
    expect(owner.onSaved).not.toHaveBeenCalled();
    dismiss(dialog, "backdrop"); expect(screen.queryByRole("dialog", { name: "Add metrology" })).toBeNull();
  });

  it("releases pending and shows a rejected refresh stub without replaying an accepted direct Add", async () => {
    const refresh = deferred<void>(), onSaved = vi.fn(() => refresh.promise);
    renderGrid(onSaved); const dialog = await openPicker();
    fireEvent.click(within(dialog).getByRole("button", { name: /SEM.*Add/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await act(async () => refresh.reject(new Error("Explicit refresh stub rejected")));
    expect(within(dialog).getByText("Explicit refresh stub rejected")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(false);
    expect(api.createMetrologyRunEntry).toHaveBeenCalledTimes(1); expect(api.createMetrologyTemplate).not.toHaveBeenCalled();
    // The ordinary Processing load callback resolves and presents its read error on the page instead.
    dismiss(dialog, "Close"); expect(screen.queryByRole("dialog", { name: "Add metrology" })).toBeNull();
  });

  it.each(["Escape", "Close", "backdrop"] as const)("still permits idle %s dismissal without any write", async path => {
    renderGrid(); const dialog = await openPicker(); dismiss(dialog, path);
    expect(screen.queryByRole("dialog", { name: "Add metrology" })).toBeNull();
    expect(api.createMetrologyTemplate).not.toHaveBeenCalled(); expect(api.createMetrologyRunEntry).not.toHaveBeenCalled();
  });

  it("keeps inside clicks, search/title focus and modal Tab wrapping within the real drawer", async () => {
    renderGrid(); const dialog = await openPicker();
    const search = within(dialog).getByRole("textbox", { name: "Search templates" });
    expect(document.activeElement).toBe(search);
    fireEvent.mouseDown(dialog); expect(screen.getByRole("dialog", { name: "Add metrology" })).toBe(dialog);
    const create = within(dialog).getByRole("button", { name: "Create new metrology template" });
    const close = within(dialog).getByRole("button", { name: "Close" });
    create.focus(); fireEvent.keyDown(create, { key: "Tab" }); expect(document.activeElement).toBe(close);
    close.focus(); fireEvent.keyDown(close, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(create);
    fireEvent.click(create);
    const title = within(dialog).getByLabelText("Template title"); expect(document.activeElement).toBe(title);
    fireEvent.change(title, { target: { value: "A title" } });
    const submit = within(dialog).getByRole("button", { name: "Save and add" });
    submit.focus(); fireEvent.keyDown(submit, { key: "Tab" }); expect(document.activeElement).toBe(close);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it.each(["read-only", "completed"] as const)("keeps Add unavailable for a %s run", mode => {
    renderGrid(undefined, { readOnly: mode === "read-only", completed: mode === "completed" });
    const add = screen.queryByRole("button", { name: "Add after this entry" }) as HTMLButtonElement | null;
    if (mode === "read-only") expect(add).toBeNull();
    else { expect(add?.disabled).toBe(true); fireEvent.click(add!); }
    expect(screen.queryByRole("dialog", { name: "Add metrology" })).toBeNull();
    expect(api.createMetrologyTemplate).not.toHaveBeenCalled(); expect(api.createMetrologyRunEntry).not.toHaveBeenCalled();
  });
});
