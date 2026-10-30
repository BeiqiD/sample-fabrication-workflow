import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type ProcessTemplateFamilySummary, type ProcessTemplateVersionSummary } from "./lib/api";
import { TemplatesPage } from "./pages/TemplatesPage";

const latest: ProcessTemplateVersionSummary = {
  id: "etch-v2", recipeFamilyId: "etch", name: "Etch plan", templateType: "process", version: 2,
  sourceFilename: "etch-latest.xlsx", stepCount: 7, initialStateHash: null,
  hasInitialSubstrateStep: true, initialStateImageCount: 1, locked: false, createdAt: "2026-10-29T10:00:00Z",
};
const older: ProcessTemplateVersionSummary = {
  ...latest, id: "etch-v1", version: 1, sourceFilename: "etch-original.xlsx", stepCount: 4,
  hasInitialSubstrateStep: false, initialStateHash: "legacy-substrate", locked: true,
};
const family: ProcessTemplateFamilySummary = {
  recipeFamilyId: "etch", name: "Etch plan", templateType: "process", latestVersion: 2,
  versionCount: 2, latest,
};
const emptyPagination = { page: 1, pageSize: 20, total: 0, totalPages: 1 };
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
const routers: ReturnType<typeof createMemoryRouter>[] = [];
function mount(path = "/templates") {
  const router = createMemoryRouter([
    { path: "/templates", element: <TemplatesPage /> },
    { path: "/settings/import-workbook", element: <h1>Workbook import destination</h1> },
  ], { initialEntries: [path] });
  routers.push(router);
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  vi.spyOn(api, "listTemplateFamilies").mockResolvedValue({ families: [], pagination: emptyPagination });
  vi.spyOn(api, "listMetrologyTemplates").mockResolvedValue({ templates: [], pagination: emptyPagination });
  vi.spyOn(api, "listTemplateFamilyVersions").mockResolvedValue({ versions: [latest, older] });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, writable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  routers.splice(0).forEach(router => router.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

describe("Template directory navigation and progressive versions", () => {
  it("keeps latest metadata and actions together while older versions stay available on demand", async () => {
    vi.mocked(api.listTemplateFamilies).mockResolvedValue({ families: [family], pagination: { ...emptyPagination, total: 1 } });
    mount();
    const heading = await screen.findByRole("heading", { name: "Etch plan" });
    const familySection = within(heading.closest("section")!);
    const latestLink = familySection.getByRole("link", { name: "Open Etch plan version 2" });
    expect(latestLink.textContent).toContain("process · Latest version v2");
    for (const text of ["etch-latest.xlsx", "Step 0 defined", "Editable", "7"]) {
      expect(within(latestLink).getByText(text)).toBeTruthy();
    }
    expect(familySection.getByRole("link", { name: "Edit →" }).getAttribute("href")).toBe("/templates/etch-v2");
    expect(familySection.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(familySection.queryByRole("link", { name: "Open Etch plan version 1" })).toBeNull();
    expect(api.listTemplateFamilyVersions).not.toHaveBeenCalled();

    fireEvent.click(familySection.getByRole("button", { name: "Show all versions" }));
    const olderLink = await screen.findByRole("link", { name: "Open Etch plan version 1" });
    for (const text of ["etch-original.xlsx", "Legacy definition", "Locked", "4"]) {
      expect(within(olderLink).getByText(text)).toBeTruthy();
    }
    expect(familySection.getByRole("link", { name: "View →" }).getAttribute("href")).toBe("/templates/etch-v1");
    expect(familySection.getAllByRole("heading", { name: "Etch plan" })).toHaveLength(1);
    fireEvent.click(familySection.getByRole("button", { name: "Show latest only" }));
    expect(familySection.queryByRole("link", { name: "Open Etch plan version 1" })).toBeNull();
    expect(api.listTemplateFamilyVersions).toHaveBeenCalledTimes(1);
  });

  it("offers both in-page destinations and retains independent page and search parameters", async () => {
    vi.mocked(api.listTemplateFamilies).mockImplementation(async options => ({
      families: [family], pagination: { page: options?.page ?? 1, pageSize: 20, total: 80, totalPages: 4 },
    }));
    vi.mocked(api.listMetrologyTemplates).mockResolvedValue({ templates: [], pagination: { page: 3, pageSize: 25, total: 75, totalPages: 3 } });
    const router = mount("/templates?q=etch&processPage=2&metrologyPage=3");
    await screen.findByRole("heading", { name: "Etch plan" });
    const navigation = within(screen.getByRole("navigation", { name: "Template sections" }));
    expect(navigation.getByRole("link", { name: "Process" }).getAttribute("href")).toBe("#process-templates");
    expect(navigation.getByRole("link", { name: "Metrology" }).getAttribute("href")).toBe("#metrology-templates");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Process template pages" })).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(router.state.location.search).toBe("?q=etch&processPage=3&metrologyPage=3"));
    for (const [options] of vi.mocked(api.listMetrologyTemplates).mock.calls) expect(options).toMatchObject({ query: "etch", page: 3 });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("takes an empty process library to the canonical Settings importer and keeps search emptiness focused", async () => {
    const router = mount();
    await screen.findByText("No active process templates yet.");
    const importer = screen.getByRole("link", { name: "Settings → Workbook import" });
    expect(importer.getAttribute("href")).toBe("/settings/import-workbook");
    fireEvent.click(importer);
    await screen.findByRole("heading", { name: "Workbook import destination" });
    await act(async () => { await router.navigate("/templates?q=missing"); });
    await screen.findByText("No matching process templates.");
    expect(screen.queryByRole("link", { name: "Settings → Workbook import" })).toBeNull();
  });
});
