import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import type { FileAuthorityStatus } from "./lib/file-authority-client";
import { FileAuthorityPage } from "./pages/FileAuthorityPage";

const shadowIncarnation = "9743cf72-834c-40ed-929e-ec0a6ce3a293";
const snapshot = (updates: Partial<FileAuthorityStatus> = {}): FileAuthorityStatus => ({
  mode: "overlap", updated_at: "2026-09-29T08:00:00.000Z", activated_at: "2026-09-29T08:00:00.000Z",
  epoch: 42, incarnation: null, enabled: 0, enabled_by: null, runtime_updated_at: "2026-09-29T08:00:00.000Z",
  shadow_enabled: 0, shadow_incarnation: shadowIncarnation, current_count: 4, resolved_count: 4,
  unfinished_attempts: 0, pending_receipts: 0, unfinished_failed_imports: 0,
  unattached_ready_uploads: 0, unpublished_candidates: 0, legacy_deleting: 0, file_deleting: 0,
  ...updates,
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const network = vi.fn<typeof fetch>();
let state: FileAuthorityStatus;
let operator: boolean;
let submit: (input: Record<string, unknown>) => Response | Promise<Response>;
let readStatus: () => Response | Promise<Response>;
const posts = () => network.mock.calls.filter(([, options]) => options?.method === "POST");
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };

beforeEach(() => {
  state = snapshot(); operator = true;
  readStatus = () => json(state);
  submit = input => {
    state = snapshot({ mode: "active", enabled: 1, incarnation: String(input.requestId), enabled_by: "operator@example.test" });
    return json(state);
  };
  network.mockReset();
  network.mockImplementation(async (path, init) => {
    if (path === "/api/files/shadow/evidence/capabilities") return json({ canAdjudicate: operator });
    if (path === "/api/files/authority/status" && init?.method === "GET") return readStatus();
    if (init?.method === "POST" && ["/api/files/authority/activate", "/api/files/authority/enable-recovered"].includes(String(path))) {
      return submit(JSON.parse(String(init.body)));
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch", network);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it("opens the maintenance route and activates once with the observed cutoff", async () => {
  render(<MemoryRouter initialEntries={["/maintenance/file-authority"]}><App /></MemoryRouter>);
  await screen.findByRole("button", { name: "Activate File authority" });
  expect(screen.getByText("4 / 4")).toBeTruthy();
  expect(posts()).toHaveLength(0);
  await click("Activate File authority");
  expect(posts()).toHaveLength(1);
  expect(posts()[0][0]).toBe("/api/files/authority/activate");
  expect(JSON.parse(String(posts()[0][1]?.body))).toEqual({
    requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    expectedEpoch: 42, expectedShadowIncarnation: shadowIncarnation,
  });
  expect(screen.getByText("File authority is active.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Activate File authority" })).toBeNull();
  await click("Refresh status");
  expect(posts()).toHaveLength(1);
});

it("shows actual unfinished work and disables activation", async () => {
  state = snapshot({ resolved_count: 2, shadow_enabled: 1, pending_receipts: 3, legacy_deleting: 1 });
  render(<FileAuthorityPage />);
  const activate = await screen.findByRole("button", { name: "Activate File authority" });
  expect((activate as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("2 of 4 current references are resolved.")).toBeTruthy();
  expect(screen.getByText("Pending uploads and imports: 3.")).toBeTruthy();
  expect(screen.getByText("Legacy deletions in progress: 1.")).toBeTruthy();
  expect(screen.getByText("Pause file conversions before activation.")).toBeTruthy();
  fireEvent.click(activate);
  expect(posts()).toHaveLength(0);
});

it("shows no commands or protected status request for a non-operator", async () => {
  operator = false;
  render(<FileAuthorityPage />);
  await screen.findByText("File operator access is required. This account cannot perform File authority maintenance.");
  expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["Refresh status"]);
  expect(network.mock.calls.map(([path]) => path)).toEqual(["/api/files/shadow/evidence/capabilities"]);
  await click("Refresh status");
  expect(posts()).toHaveLength(0);
});

it("requires the stopped-installation checkbox before enabling a recovered runtime", async () => {
  state = snapshot({ mode: "active", incarnation: shadowIncarnation, enabled: 0 });
  render(<FileAuthorityPage />);
  const enable = await screen.findByRole("button", { name: "Enable execution on this installation" });
  expect((enable as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(enable);
  expect(posts()).toHaveLength(0);
  fireEvent.click(screen.getByRole("checkbox", { name: "The previous installation has stopped executing writes and maintenance." }));
  await click("Enable execution on this installation");
  expect(posts()).toHaveLength(1);
  expect(posts()[0][0]).toBe("/api/files/authority/enable-recovered");
  expect(JSON.parse(String(posts()[0][1]?.body))).toEqual({
    requestId: expect.any(String), expectedIncarnation: shadowIncarnation, previousInstallationStopped: true,
  });
  expect(screen.getByText("File execution is enabled on this installation.")).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
});

it("reconciles a lost acknowledgement through status without sending a second command", async () => {
  submit = input => {
    state = snapshot({ mode: "active", enabled: 1, incarnation: String(input.requestId) });
    throw new Error("Lost acknowledgement");
  };
  render(<FileAuthorityPage />);
  await screen.findByRole("button", { name: "Activate File authority" });
  await click("Activate File authority");
  expect(screen.getByText("Command confirmed by current status. File execution is enabled.")).toBeTruthy();
  expect(posts()).toHaveLength(1);
  expect(network.mock.calls.filter(([path]) => path === "/api/files/authority/status")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Activate File authority" })).toBeNull();
  await click("Refresh status");
  expect(posts()).toHaveLength(1);
});

it("clears stale command controls when acknowledgement and status are unavailable, then retries the same cutoff explicitly", async () => {
  submit = () => { readStatus = () => { throw new Error("Offline"); }; throw new Error("Lost acknowledgement"); };
  render(<FileAuthorityPage />);
  await screen.findByRole("button", { name: "Activate File authority" });
  await click("Activate File authority");
  expect(screen.getByRole("alert").textContent).toBe("The command outcome is unknown. Refresh status before continuing.");
  expect(screen.queryByRole("button", { name: "Activate File authority" })).toBeNull();
  expect(posts()).toHaveLength(1);
  readStatus = () => json(state);
  await click("Refresh status");
  expect(posts()).toHaveLength(1);
  submit = () => json(state);
  await click("Activate File authority");
  expect(posts()).toHaveLength(2);
  expect(posts()[1][1]?.body).toBe(posts()[0][1]?.body);
});
