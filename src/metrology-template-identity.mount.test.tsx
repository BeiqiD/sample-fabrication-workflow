import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type TemplateDetail } from "./lib/api";
import { MetrologyTemplatePage } from "./pages/MetrologyTemplatePage";

function template(id: string): TemplateDetail {
  return {
    id, recipeFamilyId: `${id}-family`, name: `Template ${id}`,
    templateType: "module", templateKind: "metrology", version: 1,
    manifestHash: `${id}-manifest`, sourceFilename: null, initialStateHash: null,
    initialStateImageKeys: [], initialSubstrateStep: null, locked: false,
    lockedAt: null, createdAt: "2026-09-12T00:00:00.000Z", archived: false,
    metrologyNotes: `Server notes ${id}`, referenceAttachments: [],
    steps: [{
      id: `${id}-step`, logicalStepKey: `${id}-step`, definitionHash: `${id}-definition`,
      expectedStateHash: null, position: 0, sourceRow: null, stepNumber: null,
      sectionName: null, name: `Step ${id}`, toolName: `Tool ${id}`,
      parametersText: `Parameters ${id}`, commentsText: `Comments ${id}`, imageKeys: [],
    }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const routers: ReturnType<typeof createMemoryRouter>[] = [];

function openTemplate(id = "A") {
  const router = createMemoryRouter([
    { path: "/templates/metrology/:templateId", element: <MetrologyTemplatePage /> },
    { path: "/templates/:templateId", element: <p>Process template destination</p> },
    { path: "/templates", element: <p>Template directory</p> },
  ], { initialEntries: [`/templates/metrology/${id}`] });
  routers.push(router);
  return { router, ...render(<RouterProvider router={router} />) };
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
});

afterEach(() => {
  cleanup();
  routers.splice(0).forEach((router) => router.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Metrology template source identity", () => {
  it("resets fields, pending files, and deletion confirmation when another template opens", async () => {
    vi.spyOn(api, "getTemplate").mockImplementation(async (id) => ({ template: template(id) }));
    const save = vi.spyOn(api, "updateMetrologyTemplate").mockResolvedValue({ ok: true });
    const { router, container } = openTemplate();
    const title = await screen.findByRole("textbox", { name: "Template title" });
    fireEvent.change(title, { target: { value: "A local draft" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Reference notes" }), { target: { value: "A local notes" } });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["manual"], "A-manual.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    await act(async () => { await router.navigate("/templates/metrology/B"); });
    await screen.findByRole("heading", { name: "Template B" });
    expect((screen.getByRole("textbox", { name: "Template title" }) as HTMLInputElement).value).toBe("Template B");
    expect((screen.getByRole("textbox", { name: "Reference notes" }) as HTMLTextAreaElement).value).toBe("Server notes B");
    expect(screen.queryByText("A-manual.pdf")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Template title" }), { target: { value: "New B name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("B", {
      name: "New B name", toolName: "Tool B", parametersText: "Parameters B", commentsText: "Comments B",
    }));
  });

  it("ignores an old load that would redirect after the new source is ready", async () => {
    const oldLoad = deferred<{ template: TemplateDetail }>();
    vi.spyOn(api, "getTemplate").mockImplementation((id) => id === "A"
      ? oldLoad.promise : Promise.resolve({ template: template(id) }));
    const { router } = openTemplate();
    await act(async () => { await router.navigate("/templates/metrology/B"); });
    await screen.findByRole("heading", { name: "Template B" });
    await act(async () => { oldLoad.resolve({ template: { ...template("A"), templateKind: "process" } }); });
    expect(router.state.location.pathname).toBe("/templates/metrology/B");
    expect(screen.getByRole("heading", { name: "Template B" })).toBeTruthy();
    expect(screen.queryByText("Process template destination")).toBeNull();
  });

  it("ignores an old load failure after navigating to another source", async () => {
    const oldLoad = deferred<{ template: TemplateDetail }>();
    vi.spyOn(api, "getTemplate").mockImplementation((id) => id === "A"
      ? oldLoad.promise : Promise.resolve({ template: template(id) }));
    const { router } = openTemplate();
    await act(async () => { await router.navigate("/templates/metrology/B"); });
    await screen.findByRole("heading", { name: "Template B" });
    await act(async () => { oldLoad.reject(new Error("A load failed")); });
    expect(screen.queryByText("A load failed")).toBeNull();
    expect(screen.getByRole("heading", { name: "Template B" })).toBeTruthy();
  });

  it("does not refresh or announce an old save in the new editing session", async () => {
    const oldSave = deferred<{ ok: true }>();
    const getTemplate = vi.spyOn(api, "getTemplate").mockImplementation(async (id) => ({ template: template(id) }));
    const save = vi.spyOn(api, "updateMetrologyTemplate").mockReturnValue(oldSave.promise);
    const { router } = openTemplate();
    await screen.findByRole("textbox", { name: "Template title" });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(save).toHaveBeenCalledWith("A", expect.anything());
    await act(async () => { await router.navigate("/templates/metrology/B"); });
    await screen.findByRole("heading", { name: "Template B" });
    fireEvent.change(screen.getByRole("textbox", { name: "Reference notes" }), { target: { value: "B local notes" } });
    await act(async () => { oldSave.resolve({ ok: true }); });
    expect(getTemplate.mock.calls.map(([id]) => id)).toEqual(["A", "B"]);
    expect(screen.queryByText("Template details saved.")).toBeNull();
    expect((screen.getByRole("textbox", { name: "Reference notes" }) as HTMLTextAreaElement).value).toBe("B local notes");
    expect(screen.getByRole("heading", { name: "Template B" })).toBeTruthy();
  });

  it("does not navigate away when deletion of the previous source finishes", async () => {
    const oldDelete = deferred<{ ok: true; disposition: "deleted" | "archived" }>();
    vi.spyOn(api, "getTemplate").mockImplementation(async (id) => ({ template: template(id) }));
    const remove = vi.spyOn(api, "removeTemplate").mockReturnValue(oldDelete.promise);
    const { router } = openTemplate();
    await screen.findByRole("heading", { name: "Template A" });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete template" }));
    expect(remove).toHaveBeenCalledWith("A");
    await act(async () => { await router.navigate("/templates/metrology/B"); });
    await screen.findByRole("heading", { name: "Template B" });
    await act(async () => { oldDelete.resolve({ ok: true, disposition: "deleted" }); });
    expect(router.state.location.pathname).toBe("/templates/metrology/B");
    expect(screen.queryByText("Template directory")).toBeNull();
  });

  it("keeps the latest refresh when two saves finish in a different response order", async () => {
    const olderRefresh = deferred<{ template: TemplateDetail }>();
    const getTemplate = vi.spyOn(api, "getTemplate")
      .mockResolvedValueOnce({ template: template("A") })
      .mockReturnValueOnce(olderRefresh.promise)
      .mockResolvedValueOnce({ template: { ...template("A"), name: "Latest A", metrologyNotes: "Latest notes" } });
    vi.spyOn(api, "updateMetrologyTemplate").mockResolvedValue({ ok: true });
    vi.spyOn(api, "updateMetrologyTemplateNotes").mockResolvedValue({ ok: true });
    const { router } = openTemplate();
    await screen.findByRole("heading", { name: "Template A" });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(getTemplate).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Save reference notes" }));
    await screen.findByRole("heading", { name: "Latest A" });
    await act(async () => { olderRefresh.resolve({ template: { ...template("A"), templateKind: "process" } }); });
    expect(router.state.location.pathname).toBe("/templates/metrology/A");
    expect(screen.getByRole("heading", { name: "Latest A" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Reference notes" }) as HTMLTextAreaElement).value).toBe("Latest notes");
  });

  it("preserves the same source's fields and pending file through focus history", async () => {
    const getTemplate = vi.spyOn(api, "getTemplate").mockResolvedValue({ template: template("A") });
    const { router, container } = openTemplate();
    const title = await screen.findByRole("textbox", { name: "Template title" });
    fireEvent.change(title, { target: { value: "A local draft" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Reference notes" }), { target: { value: "A local notes" } });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["manual"], "A-manual.pdf", { type: "application/pdf" })] },
    });
    await act(async () => { await router.navigate("/templates/metrology/A?focus=metrology_reference%3Ar1_AAAA"); });
    await act(async () => { await router.navigate(-1); });
    expect((screen.getByRole("textbox", { name: "Template title" }) as HTMLInputElement).value).toBe("A local draft");
    expect((screen.getByRole("textbox", { name: "Reference notes" }) as HTMLTextAreaElement).value).toBe("A local notes");
    expect(screen.getByText("A-manual.pdf")).toBeTruthy();
    expect(getTemplate).toHaveBeenCalledOnce();
  });
});
