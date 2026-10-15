import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Component, useState, type ReactNode } from "react";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const failedImports = vi.hoisted(() => {
  function deferred() {
    let reject!: (error: Error) => void;
    const promise = new Promise<never>((_resolve, fail) => { reject = fail; });
    return { promise, reject };
  }
  return { pending: deferred(), reload: deferred(), navigation: deferred() };
});
vi.mock("./pages/ProjectsPage", async () => await failedImports.pending.promise);
vi.mock("./pages/ProjectPage", async () => await failedImports.reload.promise);
vi.mock("./pages/ExportPage", async () => await failedImports.navigation.promise);
vi.mock("./pages/SamplesPage", () => ({ SamplesPage: function HealthyPage() {
  const [draft, setDraft] = useState("");
  return <><h1>Healthy Samples</h1><label>Sample draft<input value={draft} onChange={event => setDraft(event.target.value)} /></label>
    <Link to="?focus=sample#record">Focus this sample</Link></>;
} }));
vi.mock("./pages/TemplatesPage", () => ({ TemplatesPage: function BrokenPage(): never {
  throw new Error("private render diagnostic: credentials and stack must stay hidden");
} }));

// Observe the old uncaught lazy rejection without letting the test host abort.
// After the repair, the real App-owned boundary must handle it first.
class UncaughtRouteObserver extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p>Unhandled route failure</p> : this.props.children; }
}
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search + location.hash}</output>;
}
function mount(url = "/projects?filter=retained#selected") {
  return render(<MemoryRouter initialEntries={[url]}><LocationProbe /><UncaughtRouteObserver><App /></UncaughtRouteObserver></MemoryRouter>);
}
type NavigationConsole = { on(event: string, listener: (error: Error) => void): void;
  removeListener(event: string, listener: (error: Error) => void): void };
const navigationDiagnostics: Error[] = [];
const observeNavigation = (error: Error) => {
  if (error.message.includes("Not implemented: navigation")) navigationDiagnostics.push(error);
};
const hostConsole = () => (globalThis as unknown as { jsdom: { virtualConsole: NavigationConsole } }).jsdom.virtualConsole;
const navigationErrors = () => navigationDiagnostics;

beforeEach(() => {
  window.localStorage.clear();
  navigationDiagnostics.length = 0;
  hostConsole().on("jsdomError", observeNavigation);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected HTTP request"); }));
});
afterEach(() => {
  cleanup(); hostConsole().removeListener("jsdomError", observeNavigation);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("explicit recovery of a rejected actual App lazy route", () => {
  it("keeps navigation and shows a focused safe recovery after the pending import rejects", async () => {
    mount();
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeTruthy();
    await act(async () => { failedImports.pending.reject(new Error("Failed to fetch dynamically imported module: private-old-chunk.js")); });
    const recovery = await screen.findByRole("alert");
    expect(recovery.textContent).toContain("This page could not be loaded");
    expect(recovery.textContent).not.toContain("private-old-chunk");
    expect(recovery.textContent).not.toContain("Error:");
    expect(document.activeElement).toBe(recovery);
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
    expect(navigationErrors()).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reloads only on explicit activation and retains the current full browser URL", async () => {
    const original = window.location.pathname + window.location.search + window.location.hash;
    const retained = "/projects/retained?filter=retained#selected";
    window.history.replaceState(null, "", retained);
    try {
      mount(retained);
      await act(async () => { failedImports.reload.reject(new Error("Failed to fetch dynamically imported module: private-reload-chunk.js")); });
      const reload = await screen.findByRole("button", { name: "Reload page" });
      expect(reload.tagName).toBe("BUTTON"); expect(reload.getAttribute("type")).toBe("button");
      reload.focus(); expect(document.activeElement).toBe(reload);
      expect(navigationErrors()).toHaveLength(0);
      fireEvent.click(reload);
      // jsdom intentionally does not implement reload; its single navigation
      // diagnostic observes this real window.location.reload invocation.
      expect(navigationErrors()).toHaveLength(1);
      expect(window.location.pathname + window.location.search + window.location.hash).toBe(retained);
      expect(screen.getByTestId("location").textContent).toBe(retained);
      expect(fetch).not.toHaveBeenCalled();
    } finally { window.history.replaceState(null, "", original); }
  });

  it("lets the retained topbar navigate to a healthy lazy route and switch theme", async () => {
    mount("/export");
    await act(async () => { failedImports.navigation.reject(new Error("Failed to fetch dynamically imported module: private-navigation-chunk.js")); });
    await screen.findByRole("button", { name: "Reload page" });
    fireEvent.click(screen.getByRole("button", { name: "Switch to night mode" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    fireEvent.click(screen.getByRole("link", { name: "Samples" }));
    expect(await screen.findByRole("heading", { name: "Healthy Samples" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("location").textContent).toBe("/samples");
    expect(navigationErrors()).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves an existing healthy route draft during query and hash focus navigation", async () => {
    mount("/samples");
    const draft = await screen.findByRole("textbox", { name: "Sample draft" });
    fireEvent.change(draft, { target: { value: "Retained local draft" } });
    fireEvent.click(screen.getByRole("link", { name: "Focus this sample" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/samples?focus=sample#record"));
    expect(screen.getByRole("textbox", { name: "Sample draft" })).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe("Retained local draft");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("handles page render failures through the same safe explicit recovery", async () => {
    mount("/templates");
    const recovery = await screen.findByRole("alert");
    expect(recovery.textContent).toContain("This page could not be loaded");
    expect(recovery.textContent).not.toContain("private render diagnostic");
    expect(recovery.textContent).not.toContain("credentials");
    expect(document.activeElement).toBe(recovery);
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeTruthy();
    expect(navigationErrors()).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
