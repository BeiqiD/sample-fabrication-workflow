import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { api } from "./lib/api";

vi.mock("./components/FabubloxImporter", () => ({ FabubloxImporter: ({ onImported }: {
  onImported: (result: { templateVersionId: string; version: number; name: string }) => Promise<void>;
}) => <section aria-label="Workbook import fixture"><button onClick={() => void onImported({
  templateVersionId: "process:one/retained", version: 2, name: "Existing process",
})}>Open accepted process template</button></section> }));
vi.mock("./pages/TemplatePage", () => ({ TemplatePage: () => <h1>Saved process template</h1> }));
vi.mock("./pages/SamplesPage", () => ({ SamplesPage: () => <h1>Samples workspace</h1> }));

function LocationProbe() {
  const location = useLocation(), navigate = useNavigate();
  return <><output aria-label="Current route">{location.pathname}{location.search}</output>
    <button onClick={() => navigate(-1)}>Previous page</button></>;
}
function mount(path: string) {
  return render(<MemoryRouter initialEntries={["/samples", path]} initialIndex={1}><LocationProbe /><App /></MemoryRouter>);
}

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL) => {
    if (String(path) === "/api/identity") return Response.json({ schema: "application-identity/1", subject: "a".repeat(64) });
    throw new Error("Unexpected workbook route request");
  }));
  const pagination = { page: 1, pageSize: 20, total: 0, totalPages: 1 };
  vi.spyOn(api, "listTemplateFamilies").mockResolvedValue({ families: [], pagination });
  vi.spyOn(api, "listMetrologyTemplates").mockResolvedValue({ templates: [], pagination });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Workbook import belongs to Settings", () => {
  it("keeps the Template directory focused on existing plans and web metrology creation", async () => {
    mount("/templates");
    await screen.findByRole("heading", { name: "Templates" });
    await screen.findByText("No active process templates yet.");
    expect(screen.getByRole("button", { name: "New metrology template" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /import workbook/i })).toBeNull();
    expect(screen.queryByRole("region", { name: "Workbook import fixture" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Settings navigation" })).toBeNull();
  });

  it.each(["/templates?import=1", "/imports/fabublox?"])("replaces legacy entry %s with the Settings importer and retains only directory filters", async prefix => {
    mount(`${prefix}${prefix.endsWith("?") ? "" : "&"}q=gate&processPage=2&metrologyPage=3&returnTo=https%3A%2F%2Foutside.invalid`);
    await screen.findByRole("heading", { name: "Workbook import" });
    expect(screen.getByLabelText("Current route").textContent).toBe("/settings/import-workbook?q=gate&processPage=2&metrologyPage=3");
    expect(screen.getByRole("link", { name: "Template library" }).getAttribute("href")).toBe("/templates?q=gate&processPage=2&metrologyPage=3");
    expect(within(screen.getByRole("navigation", { name: "Primary navigation" })).getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
    expect(api.listTemplateFamilies).not.toHaveBeenCalled();
    expect(api.listMetrologyTemplates).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    await screen.findByRole("heading", { name: "Samples workspace" });
    expect(screen.getByLabelText("Current route").textContent).toBe("/samples");
  });

  it("opens the accepted process in the web workspace without starting another import", async () => {
    mount("/settings/import-workbook");
    const open = await screen.findByRole("button", { name: "Open accepted process template" });
    expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual(["/api/identity"]);
    fireEvent.click(open);
    await screen.findByRole("heading", { name: "Saved process template" });
    await waitFor(() => expect(screen.getByLabelText("Current route").textContent).toBe("/templates/process%3Aone%2Fretained"));
    expect(screen.queryByRole("navigation", { name: "Settings navigation" })).toBeNull();
    expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual(["/api/identity"]);
  });
});
