import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { exportAll } from "./lib/exportAll";
import { api } from "./lib/api";

vi.mock("./lib/exportAll", () => ({ exportAll: vi.fn() }));
vi.mock("./pages/ResearchPackagesPage", () => ({ ResearchPackagesPage: function DataFixture() {
  const [draft, setDraft] = useState("");
  return <><h1>Research data fixture</h1><label>Research draft<input value={draft} onChange={event => setDraft(event.target.value)} /></label>
    <Link to="?rootType=project&rootId=project%3A2&kind=report#export">Choose another research root</Link></>;
} }));
vi.mock("./pages/StorageSettingsPage", () => ({ StorageSettingsPage: () => <h1>Storage fixture</h1> }));
vi.mock("./pages/StorageConfigurationPage", () => ({ StorageConfigurationPage: () => <h1>Connections fixture</h1> }));
vi.mock("./pages/FileMigrationsPage", () => ({ FileMigrationsPage: () => <h1>Migrations fixture</h1> }));
vi.mock("./pages/SystemRecoveryPage", () => ({ SystemRecoveryPage: () => <h1>Recovery fixture</h1> }));
vi.mock("./pages/FileShadowPilotPage", () => ({ FileShadowPilotPage: () => <h1>Shadow fixture</h1> }));
vi.mock("./pages/FileEvidencePage", () => ({ FileEvidencePage: () => <h1>Evidence fixture</h1> }));
vi.mock("./pages/FileAuthorityPage", () => ({ FileAuthorityPage: () => <h1>Authority fixture</h1> }));
vi.mock("./pages/SamplesPage", () => ({ SamplesPage: () => <h1>Samples fixture</h1> }));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search + location.hash}</output>;
}
function mount(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><LocationProbe /><App /></MemoryRouter>);
}
function settingsNavigation() { return screen.getByRole("navigation", { name: "Settings navigation" }); }
function expectCurrent(path: string) {
  const primary = screen.getByRole("navigation", { name: "Primary navigation" });
  expect(primary.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  expect(within(primary).getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
  const current = settingsNavigation().querySelectorAll('[aria-current="page"]');
  expect(current).toHaveLength(1);
  expect(current[0].getAttribute("href")).toBe(path);
}
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.spyOn(api, "listTemplateFamilyOptions").mockResolvedValue({ families: [] });
  vi.mocked(exportAll).mockReset();
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn();
    static revokeObjectURL = vi.fn();
  });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL) => {
    if (String(path) === "/api/identity") return new Response(JSON.stringify({ schema: "application-identity/1", subject: "a".repeat(64) }),
      { headers: { "content-type": "application/json" } });
    throw new Error("Unexpected settings overview request");
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Settings organization in the actual App router", () => {
  it("offers a real overview without probing administrator APIs or starting work", async () => {
    mount("/settings");
    await screen.findByRole("heading", { name: "Settings" });
    expectCurrent("/settings");
    const primary = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(within(primary).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings");
    expect(within(primary).getByRole("link", { name: "Templates" })).toBeTruthy();
    expect(within(primary).queryByRole("link", { name: /export|archive/i })).toBeNull();
    expect(within(settingsNavigation()).getByRole("link", { name: "Workbook import" }).getAttribute("href")).toBe("/settings/import-workbook");
    expect(screen.getByRole("heading", { name: "Workbook import" }).querySelector("a")?.getAttribute("href")).toBe("/settings/import-workbook");
    expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual(["/api/identity"]);
    expect(exportAll).not.toHaveBeenCalled();
  });

  it.each([
    ["/export", "Export content"],
    ["/settings/data", "Research data fixture"],
    ["/settings/import-workbook", "Workbook import"],
    ["/settings/data/system", "Recovery fixture"],
    ["/settings/storage", "Storage fixture"],
    ["/settings/storage/configuration", "Connections fixture"],
    ["/settings/storage/migrations", "Migrations fixture"],
    ["/maintenance/file-shadow", "Shadow fixture"],
    ["/maintenance/file-evidence", "Evidence fixture"],
    ["/maintenance/file-authority", "Authority fixture"],
  ])("keeps legacy URL %s in Settings with one precise current destination", async (path, heading) => {
    mount(path);
    await screen.findByRole("heading", { name: heading });
    expectCurrent(path);
    expect(screen.getByTestId("location").textContent).toBe(path);
    expect(exportAll).not.toHaveBeenCalled();
  });

  it("retains object-export parameters and the same research draft on query/hash navigation", async () => {
    const url = "/settings/data?rootType=sample&rootId=sample%3A1&kind=report";
    mount(url);
    const draft = await screen.findByRole("textbox", { name: "Research draft" });
    expect(screen.getByTestId("location").textContent).toBe(url);
    fireEvent.change(draft, { target: { value: "Unsubmitted research work" } });
    fireEvent.click(screen.getByRole("link", { name: "Choose another research root" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent)
      .toBe("/settings/data?rootType=project&rootId=project%3A2&kind=report#export"));
    expect(screen.getByRole("textbox", { name: "Research draft" })).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe("Unsubmitted research work");
    expectCurrent("/settings/data");
  });

  it("preserves the connection form deep-link hash", async () => {
    mount("/settings/storage/configuration#storage-add-title");
    await screen.findByRole("heading", { name: "Connections fixture" });
    expect(screen.getByTestId("location").textContent).toBe("/settings/storage/configuration#storage-add-title");
    expectCurrent("/settings/storage/configuration");
  });

  it.each(["/export/", "/settings/data/", "/Settings/Data/System/"])("keeps supported URL spelling %s current without rewriting it", async url => {
    mount(url);
    await screen.findByRole("heading", { level: 1 });
    expectCurrent(url.replace(/\/+$/, "").toLowerCase());
    expect(screen.getByTestId("location").textContent).toBe(url);
  });

  it("cancels an actual browser export when the shared navigation leaves its page", async () => {
    let finish!: (value: Awaited<ReturnType<typeof exportAll>>) => void;
    vi.mocked(exportAll).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const createUrl = vi.fn();
    vi.spyOn(URL, "createObjectURL").mockImplementation(createUrl);
    mount("/export");
    fireEvent.click(await screen.findByRole("button", { name: "Download full ZIP" }));
    const signal = vi.mocked(exportAll).mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    fireEvent.click(within(settingsNavigation()).getByRole("link", { name: "Overview" }));
    await screen.findByRole("heading", { name: "Settings" });
    expect(signal?.aborted).toBe(true);
    await act(async () => { finish({ archive: new Blob(["late"]), filename: "late.zip", results: [], warnings: [] }); });
    expect(createUrl).not.toHaveBeenCalled();
    expectCurrent("/settings");
    fireEvent.click(within(settingsNavigation()).getByRole("link", { name: "Content archive" }));
    await screen.findByRole("button", { name: "Download full ZIP" });
    expect(screen.queryByRole("link", { name: "Download prepared ZIP" })).toBeNull();
  });

  it("releases a prepared browser download when navigating to core work", async () => {
    vi.mocked(exportAll).mockResolvedValue({ archive: new Blob(["zip"]), filename: "content.zip", results: [], warnings: [] });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:settings-archive");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    mount("/export");
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Download full ZIP" })); });
    await screen.findByRole("link", { name: "Download prepared ZIP" });
    fireEvent.click(within(screen.getByRole("navigation", { name: "Primary navigation" })).getByRole("link", { name: "Samples" }));
    await screen.findByRole("heading", { name: "Samples fixture" });
    expect(revoke).toHaveBeenCalledWith("blob:settings-archive");
    expect(screen.queryByRole("navigation", { name: "Settings navigation" })).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Primary navigation" })).getByRole("link", { name: "Settings" })
      .getAttribute("aria-current")).toBeNull();
  });
});
