import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SampleDetail } from "../shared/types";
import { api, type ProcessTemplateFamilySummary, type ProcessTemplateVersionSummary, type TemplateDetail } from "./lib/api";
import { NewSamplePage } from "./pages/NewSamplePage";
import { SamplePage } from "./pages/SamplePage";
import { SamplesPage } from "./pages/SamplesPage";
import { TemplatePage } from "./pages/TemplatePage";
import { TemplatesPage } from "./pages/TemplatesPage";

const timestamp = "2026-10-08T10:00:00.000Z";
const pagination = { page: 1, pageSize: 50, total: 0, totalPages: 1 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function sample(id = "A"): SampleDetail {
  return {
    id, code: `SAMPLE-${id}`, title: `Sample ${id}`, status: "stored", location: "Lab",
    description: "First line\nSecond line", parentId: null, inheritedStateHash: null, pinned: false,
    createdAt: timestamp, updatedAt: timestamp, latestWorkflowName: null, latestWorkflowVersion: null,
    latestRunStatus: null, currentStepTitle: null, currentStateStepTitle: null, currentStateThumbnailKey: null,
    parent: null, children: [], runs: [], events: [], stateVerifications: [], comments: [],
  };
}
function template(id = "A"): TemplateDetail {
  return {
    id, recipeFamilyId: `family-${id}`, name: `Template ${id}`, templateKind: "process", templateType: "process",
    version: 2, manifestHash: `manifest-${id}`, sourceFilename: "workbook.xlsx", initialStateHash: null,
    initialStateImageKeys: [], initialSubstrateStep: null, locked: false, lockedAt: null,
    createdAt: timestamp, archived: false, metrologyNotes: null, referenceAttachments: [],
    steps: [{ id: `step-${id}`, logicalStepKey: `step-${id}`, definitionHash: "definition", expectedStateHash: null,
      position: 0, sourceRow: null, stepNumber: null, sectionName: null, name: `Step ${id}`, toolName: "Tool",
      parametersText: "Parameters", commentsText: "Comments", imageKeys: [] }],
  };
}
function version(id: string, number = 2): ProcessTemplateVersionSummary {
  return { id: `${id}-${number}`, recipeFamilyId: `family-${id}`, name: `Family ${id}`, templateType: "process",
    version: number, sourceFilename: "workbook.xlsx", stepCount: 1, initialStateHash: null,
    hasInitialSubstrateStep: false, initialStateImageCount: 0, locked: false, createdAt: timestamp };
}
function family(id: string): ProcessTemplateFamilySummary {
  return { recipeFamilyId: `family-${id}`, name: `Family ${id}`, templateType: "process", latestVersion: 2,
    versionCount: 2, latest: version(id) };
}
const routers: ReturnType<typeof createMemoryRouter>[] = [];
function mount(path: string) {
  const router = createMemoryRouter([
    { path: "/samples", element: <SamplesPage /> },
    { path: "/samples/new", element: <NewSamplePage /> },
    { path: "/samples/:sampleId", element: <SamplePage /> },
    { path: "/templates", element: <TemplatesPage /> },
    { path: "/templates/:templateId", element: <TemplatePage /> },
    { path: "/templates/metrology/:templateId", element: <p>Metrology destination</p> },
  ], { initialEntries: [path] });
  routers.push(router);
  return { router, ...render(<RouterProvider router={router} />) };
}
function familyCard(name: string) {
  return screen.getByRole("heading", { name }).closest("section")!;
}
beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.spyOn(api, "listSampleDirectoryOptions").mockResolvedValue({ locations: [], parents: [], workflows: [] });
  vi.spyOn(api, "listTemplateFamilies").mockResolvedValue({ families: [], pagination });
  vi.spyOn(api, "listMetrologyTemplates").mockResolvedValue({ templates: [], pagination });
  vi.stubGlobal("fetch", vi.fn(async (path) => {
    if (String(path) === "/api/storage/status") return Response.json({ provider: null, available: false, authentication: "not_configured", message: "File storage is not configured." });
    throw new Error(`Unexpected request ${path}`);
  }));
});
afterEach(() => {
  cleanup(); routers.splice(0).forEach((router) => router.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("Phase 5E authoritative reads", () => {
  it("does not claim the sample directory is empty after a failed read and retries the same filters", async () => {
    const reads = vi.spyOn(api, "listSamples").mockRejectedValueOnce(new Error("Sample read failed"))
      .mockResolvedValueOnce({ samples: [], pagination });
    mount("/samples?q=wafer&status=stored&location=Lab&sort=code-asc");
    await screen.findByRole("alert");
    expect(screen.queryByRole("heading", { name: "No matching samples" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "No samples yet" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry samples" }));
    await screen.findByRole("heading", { name: "No matching samples" });
    expect(reads).toHaveBeenCalledTimes(2);
    for (const [options] of reads.mock.calls) expect(options).toMatchObject({ query: "wafer", sampleStatus: "stored", location: "Lab", sort: "code-asc", page: 1 });
  });

  it("keeps sample-filter suggestion retry independent of the authoritative directory", async () => {
    const options = vi.mocked(api.listSampleDirectoryOptions).mockRejectedValueOnce(new Error("Suggestions failed"))
      .mockResolvedValueOnce({ locations: ["Lab B"], parents: [], workflows: [] });
    const reads = vi.spyOn(api, "listSamples").mockResolvedValue({ samples: [], pagination });
    mount("/samples");
    await screen.findByRole("heading", { name: "No samples yet" });
    fireEvent.click(screen.getByRole("button", { name: "Filter & sort" }));
    await screen.findByText("Suggestions are unavailable, but typed filters still work.");
    fireEvent.click(screen.getByRole("button", { name: "Retry suggestions" }));
    await waitFor(() => expect(document.querySelector('#sample-location-options option[value="Lab B"]')).toBeTruthy());
    expect(reads).toHaveBeenCalledTimes(1); expect(options).toHaveBeenCalledTimes(2);
  });

  it("ignores an old sample-directory response after the query changes", async () => {
    const old = deferred<Awaited<ReturnType<typeof api.listSamples>>>();
    vi.spyOn(api, "listSamples").mockImplementation((options) => typeof options !== "string" && options?.query === "old"
      ? old.promise : Promise.resolve({ samples: [sample("B")], pagination: { ...pagination, total: 1 } }));
    const { router } = mount("/samples?q=old");
    await act(async () => { await router.navigate("/samples?q=new"); });
    await screen.findByText("Sample B");
    await act(async () => { old.resolve({ samples: [sample("A")], pagination: { ...pagination, total: 1 } }); });
    expect(screen.getByText("Sample B")).toBeTruthy(); expect(screen.queryByText("Sample A")).toBeNull();
  });

  it("retries a failed process-template directory without reloading metrology or showing a false empty state", async () => {
    const process = vi.mocked(api.listTemplateFamilies).mockRejectedValueOnce(new Error("Process read failed"))
      .mockResolvedValueOnce({ families: [], pagination });
    mount("/templates?q=etch&processPage=1");
    await screen.findByRole("alert");
    expect(screen.queryByText("No matching process templates.")).toBeNull();
    await screen.findByText("No matching metrology templates.");
    fireEvent.click(screen.getByRole("button", { name: "Retry process templates" }));
    await screen.findByText("No matching process templates.");
    expect(process).toHaveBeenCalledTimes(2); expect(api.listMetrologyTemplates).toHaveBeenCalledTimes(1);
    expect(process.mock.calls[1][0]).toMatchObject({ query: "etch", page: 1 });
  });

  it("retries metrology alone and retains a successfully read process family", async () => {
    vi.mocked(api.listTemplateFamilies).mockResolvedValue({ families: [family("A")], pagination: { ...pagination, total: 1 } });
    const metrology = vi.mocked(api.listMetrologyTemplates).mockRejectedValueOnce(new Error("Metrology read failed"))
      .mockResolvedValueOnce({ templates: [], pagination });
    mount("/templates");
    await screen.findByRole("heading", { name: "Family A" }); await screen.findByRole("alert");
    expect(screen.queryByText("No metrology templates yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry metrology templates" }));
    await screen.findByText("No metrology templates yet.");
    expect(api.listTemplateFamilies).toHaveBeenCalledTimes(1); expect(metrology).toHaveBeenCalledTimes(2);
  });

  it("loads families lazily, tracks concurrent pending reads independently, and supplies expanded relations", async () => {
    vi.mocked(api.listTemplateFamilies).mockResolvedValue({ families: [family("A"), family("B")], pagination: { ...pagination, total: 2 } });
    const a = deferred<{ versions: ProcessTemplateVersionSummary[] }>(); const b = deferred<{ versions: ProcessTemplateVersionSummary[] }>();
    const reads = vi.spyOn(api, "listTemplateFamilyVersions").mockImplementation((id) => id === "family-A" ? a.promise : b.promise);
    mount("/templates"); await screen.findByRole("heading", { name: "Family A" });
    expect(reads).not.toHaveBeenCalled();
    const aToggle = within(familyCard("Family A")).getByRole("button", { name: "Show all versions" });
    const bToggle = within(familyCard("Family B")).getByRole("button", { name: "Show all versions" });
    expect(aToggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(aToggle.getAttribute("aria-controls")!)).toBeTruthy();
    fireEvent.click(aToggle); fireEvent.click(bToggle);
    expect((aToggle as HTMLButtonElement).disabled).toBe(true); expect((bToggle as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { a.resolve({ versions: [version("A"), version("A", 1)] }); });
    expect((bToggle as HTMLButtonElement).disabled).toBe(true); expect(aToggle.getAttribute("aria-expanded")).toBe("true");
    await act(async () => { b.resolve({ versions: [version("B"), version("B", 1)] }); });
    fireEvent.click(aToggle); fireEvent.click(aToggle);
    expect(reads).toHaveBeenCalledTimes(2); expect(bToggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps a family failure local and retries only its read", async () => {
    vi.mocked(api.listTemplateFamilies).mockResolvedValue({ families: [family("A")], pagination: { ...pagination, total: 1 } });
    const reads = vi.spyOn(api, "listTemplateFamilyVersions").mockRejectedValueOnce(new Error("Older versions unavailable"))
      .mockResolvedValueOnce({ versions: [version("A"), version("A", 1)] });
    mount("/templates"); await screen.findByRole("heading", { name: "Family A" });
    fireEvent.click(within(familyCard("Family A")).getByRole("button", { name: "Show all versions" }));
    await screen.findByRole("alert"); expect(screen.getByRole("link", { name: "Open Family A version 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry versions" }));
    await screen.findByRole("link", { name: "Open Family A version 1" });
    expect(reads).toHaveBeenCalledTimes(2); expect(api.listTemplateFamilies).toHaveBeenCalledTimes(1); expect(api.listMetrologyTemplates).toHaveBeenCalledTimes(1);
  });

  it("offers safe sample-detail read recovery with the directory still reachable", async () => {
    const reads = vi.spyOn(api, "getSample").mockRejectedValueOnce(new Error("Sample detail failed")).mockResolvedValueOnce(sample());
    mount("/samples/A"); await screen.findByRole("alert");
    expect(screen.getByRole("link", { name: "← Samples" }).getAttribute("href")).toBe("/samples");
    fireEvent.click(screen.getByRole("button", { name: "Retry sample" }));
    await screen.findByRole("heading", { name: "Sample A" }); expect(reads).toHaveBeenCalledTimes(2);
  });

  it("offers template-detail read recovery and never accepts an old source redirect", async () => {
    const old = deferred<{ template: TemplateDetail }>();
    const reads = vi.spyOn(api, "getTemplate").mockImplementation((id) => id === "A" ? old.promise : Promise.resolve({ template: template("B") }));
    const { router } = mount("/templates/A");
    await act(async () => { await router.navigate("/templates/B?focus=recipe_revision%3Ar1_AAAA"); });
    await screen.findByRole("heading", { name: "Template B" });
    await act(async () => { old.resolve({ template: { ...template("A"), templateKind: "metrology" } }); });
    expect(router.state.location.pathname).toBe("/templates/B");
    expect(screen.getByRole("heading", { name: "Template B" })).toBeTruthy(); expect(reads).toHaveBeenCalledTimes(2);
  });

  it("retries only a template GET while focus-only history preserves the metadata draft", async () => {
    const reads = vi.spyOn(api, "getTemplate").mockRejectedValueOnce(new Error("Template unavailable"))
      .mockResolvedValueOnce({ template: template() });
    const { router } = mount("/templates/A"); await screen.findByRole("alert");
    expect(screen.getByRole("link", { name: "← Templates" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry template" }));
    await screen.findByRole("heading", { name: "Template A" });
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Unsaved name" } });
    await act(async () => { await router.navigate("/templates/A?focus=recipe_revision%3Ar1_AAAA"); await router.navigate(-1); });
    expect(reads).toHaveBeenCalledTimes(2); expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Unsaved name");
  });
});

describe("Phase 5E pending writes retain the local draft", () => {
  it("blocks template-step cancellation and deletion during save, then retains all draft fields after rejection", async () => {
    vi.spyOn(api, "getTemplate").mockResolvedValue({ template: template() });
    const pending = deferred<{ ok: true }>(); const save = vi.spyOn(api, "updateTemplateStep").mockReturnValue(pending.promise);
    const remove = vi.spyOn(api, "deleteTemplateStep");
    mount("/templates/A"); await screen.findByRole("heading", { name: "Step A" });
    const card = screen.getByRole("heading", { name: "Step A" }).closest("article")!;
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(card).getByRole("textbox", { name: "Step name" }), { target: { value: "Unsaved step" } });
    fireEvent.change(within(card).getByRole("textbox", { name: "Comments" }), { target: { value: "Unsaved comments" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save step" }));
    const cancel = within(card).getByRole("button", { name: "Cancel" }); const deletion = within(card).getByRole("button", { name: "Delete step" });
    expect((cancel as HTMLButtonElement).disabled).toBe(true); expect((deletion as HTMLButtonElement).disabled).toBe(true);
    expect((within(card).getByRole("textbox", { name: "Step name" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(cancel); fireEvent.click(deletion); expect(screen.queryByRole("alertdialog")).toBeNull(); expect(remove).not.toHaveBeenCalled();
    await act(async () => { pending.reject(new Error("Step update failed")); });
    await screen.findByRole("alert");
    expect((within(card).getByRole("textbox", { name: "Step name" }) as HTMLInputElement).value).toBe("Unsaved step");
    expect((within(card).getByRole("textbox", { name: "Comments" }) as HTMLTextAreaElement).value).toBe("Unsaved comments");
    expect(save).toHaveBeenCalledTimes(1); expect((cancel as HTMLButtonElement).disabled).toBe(false);
  });

  it("blocks new-step cancellation during creation without clearing its draft after rejection", async () => {
    vi.spyOn(api, "getTemplate").mockResolvedValue({ template: { ...template(), steps: [] } });
    const pending = deferred<{ id: string }>(); const writes = vi.spyOn(api, "createTemplateStep").mockReturnValue(pending.promise);
    mount("/templates/A"); fireEvent.click(await screen.findByRole("button", { name: "+ Add template step" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Step name" }), { target: { value: "Draft new step" } });
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    const cancel = screen.getByRole("button", { name: "Cancel" }); expect((cancel as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "Step name" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(cancel);
    await act(async () => { pending.reject(new Error("Create step failed")); });
    await screen.findByRole("alert"); expect((screen.getByRole("textbox", { name: "Step name" }) as HTMLInputElement).value).toBe("Draft new step");
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it("blocks New Sample cancellation while creating and retains identity values after rejection", async () => {
    const pending = deferred<{ id: string }>(); const writes = vi.spyOn(api, "createSample").mockReturnValue(pending.promise);
    const { router } = mount("/samples/new");
    fireEvent.change(screen.getByRole("textbox", { name: "Sample code" }), { target: { value: "DRAFT-1" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Sample name" }), { target: { value: "Draft sample" } });
    fireEvent.click(screen.getByRole("button", { name: "Create sample" }));
    expect((screen.getByRole("textbox", { name: "Sample name" }) as HTMLInputElement).disabled).toBe(true);
    const cancel = screen.getByRole("link", { name: "Cancel" }); expect(cancel.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(cancel); expect(router.state.location.pathname).toBe("/samples/new");
    await act(async () => { pending.reject(new Error("Creation failed")); });
    await screen.findByRole("alert"); expect((screen.getByRole("textbox", { name: "Sample code" }) as HTMLInputElement).value).toBe("DRAFT-1");
    expect((screen.getByRole("textbox", { name: "Sample name" }) as HTMLInputElement).value).toBe("Draft sample"); expect(writes).toHaveBeenCalledTimes(1);
  });
});
