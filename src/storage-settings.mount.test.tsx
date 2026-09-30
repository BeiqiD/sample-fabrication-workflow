import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageSettingsStatus } from "../shared/contracts/storage-settings";
import { App } from "./App";
import { StorageSettingsPage } from "./pages/StorageSettingsPage";

const snapshot = (id = "registered-r2"): StorageSettingsStatus => ({
  version: 2, kind: "storage-settings-status", readOnly: true, configurationSource: "deployment", health: "not_checked",
  authority: { mode: "overlap", shadowConversions: "paused" },
  roleDefaults: { state: "legacy" },
  bindings: { r2: { configuration: "configured" }, managed: { provider: "switchdrive", configuration: "configured" } },
  uploadDestinations: { ordinaryUploads: "r2", commentOriginals: "switchdrive" },
  profiles: { items: [{ id, adapterType: "r2", configurationRevision: 1, runtimeAccess: "read_write", bindingMatch: "matched" }], hasMore: false, limit: 100 },
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function pending() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((accept) => { resolve = accept; });
  return { promise, resolve };
}
const network = vi.fn<typeof fetch>();
beforeEach(() => {
  network.mockReset(); network.mockImplementation(async () => json(snapshot()));
  vi.stubGlobal("fetch", network);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
const refresh = () => screen.getByRole("button", { name: "Refresh" });
async function clickRefresh() { await act(async () => { fireEvent.click(refresh()); }); }

describe("read-only storage Settings", () => {
  it("opens through the primary Settings destination and describes real upload routes without claiming connection health", async () => {
    render(<MemoryRouter initialEntries={["/settings/storage"]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Storage", level: 1 })).toBeTruthy();
    const nav = within(screen.getByRole("navigation", { name: "Primary navigation" }));
    expect(nav.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings/storage");
    expect(nav.getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
    await screen.findByText("Connection not checked");
    const uploads = within(screen.getByRole("region", { name: "Current uploads" }));
    expect(uploads.getByRole("heading", { name: "Images and Project attachments" })).toBeTruthy();
    expect(uploads.getByText("Cloudflare R2")).toBeTruthy();
    expect(uploads.getByRole("heading", { name: "Original comment files" })).toBeTruthy();
    expect(uploads.getByText("SWITCHdrive")).toBeTruthy();
    expect(screen.getByText("Read and write")).toBeTruthy();
    expect(screen.getByText("Matches current configuration")).toBeTruthy();
    expect(screen.getByRole("link", { name: "File authority maintenance" }).getAttribute("href")).toBe("/maintenance/file-authority");
    expect(document.body.textContent).not.toMatch(/healthy|connected|default storage|S3|FP1/);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(network).toHaveBeenCalledExactlyOnceWith("/api/settings/storage", expect.objectContaining({ method: "GET", cache: "no-store", credentials: "same-origin", redirect: "error" }));
    const buttons = screen.getAllByRole("button").map((button) => button.textContent);
    expect(buttons).toEqual(["Night", "Refresh"]);
  });

  it("clears previous status on failed refresh, hides raw errors, and allows a fresh retry", async () => {
    render(<StorageSettingsPage />); await screen.findByText("registered-r2");
    network.mockResolvedValueOnce(json({ error: "PRIVATE_BUCKET_AND_SECRET" }, 503));
    await clickRefresh();
    expect(screen.getByRole("alert").textContent).toBe("Storage information is unavailable. Refresh to try again.");
    expect(screen.queryByText("registered-r2")).toBeNull(); expect(screen.queryByText("Connection not checked")).toBeNull();
    expect(document.body.textContent).not.toContain("PRIVATE_BUCKET_AND_SECRET");
    network.mockResolvedValueOnce(json(snapshot("updated-profile")));
    await clickRefresh(); expect(screen.getByText("updated-profile")).toBeTruthy(); expect(screen.queryByRole("alert")).toBeNull();
    expect(network.mock.calls.every(([path, options]) => path === "/api/settings/storage" && options?.method === "GET")).toBe(true);
  });

  it("aborts StrictMode stale requests, ignores late responses, and aborts on unmount", async () => {
    const old = pending(), current = pending();
    network.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const view = render(<StrictMode><StorageSettingsPage /></StrictMode>);
    expect(screen.getByRole("status").textContent).toBe("Reading storage configuration…");
    expect((screen.getByRole("button", { name: "Refreshing…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(network).toHaveBeenCalledTimes(2);
    expect(network.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => current.resolve(json(snapshot("current-profile"))));
    expect(screen.getByText("current-profile")).toBeTruthy();
    await act(async () => old.resolve(json(snapshot("stale-profile"))));
    expect(screen.queryByText("stale-profile")).toBeNull(); expect(screen.getByText("current-profile")).toBeTruthy();
    const leaving = pending(); network.mockReturnValueOnce(leaving.promise);
    fireEvent.click(refresh()); const signal = network.mock.calls.at(-1)![1]?.signal;
    view.unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => leaving.resolve(json(snapshot("unmounted-profile"))));
    expect(screen.queryByText("unmounted-profile")).toBeNull(); expect(network).toHaveBeenCalledTimes(3);
  });

  it("reports missing managed storage without presenting R2 as a fallback and supports an empty profile list", async () => {
    const value = snapshot(); value.bindings.managed = { provider: "none", configuration: "missing" };
    value.uploadDestinations.commentOriginals = "unconfigured"; value.profiles.items = [];
    network.mockResolvedValueOnce(json(value));
    render(<StorageSettingsPage />); await screen.findByText("No storage profiles have been registered.");
    const originals = screen.getByRole("heading", { name: "Original comment files" }).closest("article")!;
    expect(within(originals).getByText("Not configured")).toBeTruthy();
    expect(within(originals).getByText("Configuration missing")).toBeTruthy();
    expect(within(originals).queryByText("Cloudflare R2")).toBeNull();
    expect(screen.queryByRole("button", { name: /connect|test|save|enable/i })).toBeNull();
  });

  it("shows retired and unmatched registered profiles separately from current upload configuration", async () => {
    const value = snapshot("retired-profile");
    value.profiles.items[0].runtimeAccess = "retired"; value.profiles.items[0].bindingMatch = "mismatch";
    network.mockResolvedValueOnce(json(value)); render(<StorageSettingsPage />);
    await screen.findByText("Retired");
    expect(screen.getByText("Different from current configuration")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Current uploads" })).getByText("Cloudflare R2")).toBeTruthy();
    expect(screen.getByText("Connection not checked")).toBeTruthy();
  });

  it.each(["pending_bootstrap", "configured"] as const)("shows R2 originals with %s defaults even when historical managed configuration is absent", async state => {
    const value = snapshot(); value.authority.mode = "active"; value.roleDefaults.state = state;
    value.uploadDestinations.commentOriginals = "r2"; value.bindings.managed = { provider: "none", configuration: "missing" };
    network.mockResolvedValueOnce(json(value)); render(<StorageSettingsPage />);
    const originals = (await screen.findByRole("heading", { name: "Original comment files" })).closest("article")!;
    expect(within(originals).getByText("Cloudflare R2")).toBeTruthy();
    expect(within(originals).getByText("Configuration present")).toBeTruthy();
    expect(screen.getByText(/Existing files keep their recorded storage location/)).toBeTruthy();
    expect(Boolean(screen.queryByText(/This choice will be saved with the first file upload/))).toBe(state === "pending_bootstrap");
    expect(screen.queryByRole("button", { name: /connect|test|save|enable/i })).toBeNull();
  });

  it("rejects unsafe response fields and misleading health assertions before rendering status", async () => {
    network.mockResolvedValueOnce(json({ ...snapshot(), namespace: "PRIVATE_NAMESPACE" }));
    render(<StorageSettingsPage />); await screen.findByRole("alert");
    expect(document.body.textContent).not.toContain("PRIVATE_NAMESPACE"); expect(screen.queryByText("registered-r2")).toBeNull();
    network.mockResolvedValueOnce(json({ ...snapshot(), health: "healthy" })); await clickRefresh();
    expect(screen.getByRole("alert")).toBeTruthy(); expect(document.body.textContent).not.toContain("healthy");
  });
});
