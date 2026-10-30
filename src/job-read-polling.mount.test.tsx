import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResearchPackagesPage } from "./pages/ResearchPackagesPage";
import { FileMigrationsPage } from "./pages/FileMigrationsPage";
import { SystemRecoveryPage } from "./pages/SystemRecoveryPage";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const at = "2026-10-20T09:00:00Z";
const packageExecutor = { supported: true, enabled: true, stale: false, canManage: false, lastHeartbeatAt: at, cadenceSeconds: 120, maxStepMs: 60000, reason: null };
const migrationExecutor = { enabled: true, stale: false, cadenceSeconds: 120, maxFilesPerStep: 1, maxStepMs: 60000, lastHeartbeatAt: at };
const maintenance = { state: "open", generation: 0, token: null, checkpoint: null, backupJobId: null, activeWriters: 0 };
const recoveryCapability = { supported: true, canManage: true, enabled: true, stale: false, lastHeartbeatAt: at, cadenceSeconds: 120, maxStepMs: 60000,
  reason: null, target: { configured: true, id: "isolated:1", mode: "fresh" }, maintenance: { state: "open", checkpoint: null },
  policy: { recoveryMapping: "explicit-profile", backupMaintenance: "planned-only", maintenanceWithoutTarget: false, recoveryCleanup: true, sourceResume: false } };
const settings = { version: 3, kind: "storage-settings-status", readOnly: true, health: "not_checked",
  authority: { mode: "active", shadowConversions: "paused", fileAccess: "enabled" },
  roleDefaults: { state: "configured", policyRevision: 3, internal: { profileId: "source", adapterType: "r2", availability: "available" }, originals: { profileId: "source", adapterType: "r2", availability: "available" } },
  bindings: { r2: { configuration: "configured" }, managed: { provider: "none", configuration: "missing" } },
  profiles: { items: [{ id: "source", adapterType: "r2", configurationRevision: 1, runtimeAccess: "read_write", bindingMatch: "matched", bindingRevision: null, availability: "available" }], hasMore: false, limit: 100 } };
const cases = [
  { name: "Package", Page: ResearchPackagesPage, list: "/api/packages/jobs", sibling: "/api/packages/executor", value: packageExecutor, button: "Refresh status" },
  { name: "Migration", Page: FileMigrationsPage, list: "/api/files/migrations", sibling: "/api/files/migrations/executor", value: migrationExecutor, button: "Refresh" },
  { name: "Recovery", Page: SystemRecoveryPage, list: "/api/system-recovery/jobs", sibling: "/api/system-recovery/maintenance", value: maintenance, button: "Refresh recovery status" },
];
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const network = vi.fn<typeof fetch>();
let hidden = false;
beforeEach(() => {
  vi.useFakeTimers(); sessionStorage.clear(); hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  network.mockReset(); vi.stubGlobal("fetch", network);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });
function setup(scenario: typeof cases[number], options: { failedList?: boolean; ignoresAbort?: boolean; hangs?: boolean } = {}) {
  const pending: { signal: AbortSignal; resolve: () => void }[] = []; let listCalls = 0, siblingCalls = 0;
  let hangs = options.hangs !== false;
  network.mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === scenario.list) { listCalls++; return json(options.failedList ? {} : { jobs: [] }, options.failedList ? 500 : 200); }
    if (path === scenario.sibling) {
      siblingCalls++;
      if (!hangs) return json(scenario.value);
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve, reject) => {
        const entry = { signal, resolve: () => resolve(json(scenario.value)) }; pending.push(entry);
        if (!options.ignoresAbort) signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
      });
    }
    if (path === "/api/storage/configuration/capability") return json({ canManage: true, credentialEditingAvailable: true });
    if (path === "/api/settings/storage?version=3") return json(settings);
    if (path === "/api/files/migrations/files") return json({ items: [], nextCursor: null });
    if (path === "/api/system-recovery/capabilities") return json(recoveryCapability);
    return json({ error: "UNEXPECTED_READ" }, 404);
  });
  return { pending, listCalls: () => listCalls, siblingCalls: () => siblingCalls,
    healthy() { options.failedList = false; hangs = false; },
    async mount() { let value!: ReturnType<typeof render>; await act(async () => { value = render(<MemoryRouter><scenario.Page /></MemoryRouter>); await flush(); }); return value; },
  };
}

describe.each(cases)("$name bounded status polling", scenario => {
  it("cancels the sibling of a failed read on every automatic round without leaving pending requests", async () => {
    const value = setup(scenario, { failedList: true }); const mounted = await value.mount();
    expect(value.listCalls()).toBe(1); expect(value.siblingCalls()).toBe(1);
    expect(value.pending.every(read => read.signal.aborted)).toBe(true);
    for (let round = 2; round <= 4; round++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); await flush(); });
      expect(value.listCalls()).toBe(round); expect(value.siblingCalls()).toBe(round);
      expect(value.pending.every(read => read.signal.aborted)).toBe(true);
    }
    expect(network.mock.calls.every(([, init]) => !["POST", "PUT"].includes(init?.method || ""))).toBe(true);
    mounted.unmount();
  });
  it("keeps an ignored cancellation in its slot and coalesces an explicit refresh until it settles", async () => {
    const value = setup(scenario, { failedList: true, ignoresAbort: true }); const mounted = await value.mount();
    expect(value.pending).toHaveLength(1); expect(value.pending[0].signal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); await flush(); });
    expect(value.listCalls()).toBe(1); expect(value.siblingCalls()).toBe(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: scenario.button })); await flush(); });
    expect(value.listCalls()).toBe(1);
    value.healthy(); await act(async () => { value.pending[0].resolve(); await flush(); });
    expect(value.listCalls()).toBe(2); expect(value.siblingCalls()).toBe(2); mounted.unmount();
  });
  it("shows the read deadline but does not replace its unfinished request", async () => {
    const value = setup(scenario, { ignoresAbort: true }); const mounted = await value.mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); await flush(); });
    expect(document.body.textContent).toContain("Reading status timed out");
    expect(value.pending[0].signal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); await flush(); });
    expect(value.listCalls()).toBe(1); expect(value.siblingCalls()).toBe(1);
    mounted.unmount(); await act(async () => { value.pending[0].resolve(); await flush(); });
  });
  it("pauses and cancels while hidden, then refreshes immediately on visibility restoration", async () => {
    const value = setup(scenario); const mounted = await value.mount();
    await act(async () => { hidden = true; document.dispatchEvent(new Event("visibilitychange")); await flush(); });
    expect(value.pending.every(read => read.signal.aborted)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); await flush(); });
    expect(value.listCalls()).toBe(1);
    value.healthy(); await act(async () => { hidden = false; document.dispatchEvent(new Event("visibilitychange")); await flush(); });
    expect(value.listCalls()).toBe(2); expect(value.siblingCalls()).toBe(2); mounted.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); await flush(); });
    expect(value.listCalls()).toBe(2);
  });
});

it("does not start older Recovery receipt lookups after a hidden round settles despite ignoring cancellation", async () => {
  sessionStorage.setItem("system-recovery-receipts", JSON.stringify([{ requestId: "old:request", jobId: "older:job" }]));
  const value = setup(cases[2], { ignoresAbort: true }); const mounted = await value.mount();
  await act(async () => { hidden = true; document.dispatchEvent(new Event("visibilitychange")); await flush(); });
  expect(value.pending[0].signal.aborted).toBe(true);
  await act(async () => { value.pending[0].resolve(); await flush(); });
  expect(network.mock.calls.filter(([path]) => String(path) === "/api/system-recovery/jobs/older%3Ajob")).toHaveLength(0);
  mounted.unmount();
});

it("restarts visible Migration access after its initially cancelled capability read finally settles", async () => {
  const value = setup(cases[1], { hangs: false }), fallback = network.getMockImplementation()!;
  let resolve!: (response: Response) => void, accessCalls = 0, accessSignal!: AbortSignal;
  const access = new Promise<Response>(yes => { resolve = yes; });
  network.mockImplementation((path, init) => {
    if (String(path) === "/api/storage/configuration/capability" && ++accessCalls === 1) { accessSignal = init?.signal as AbortSignal; return access; }
    return fallback(path, init);
  });
  const mounted = await value.mount(); expect(accessCalls).toBe(1); expect(value.listCalls()).toBe(0);
  await act(async () => {
    hidden = true; document.dispatchEvent(new Event("visibilitychange"));
    hidden = false; document.dispatchEvent(new Event("visibilitychange")); await flush();
  });
  expect(accessSignal.aborted).toBe(true);
  await act(async () => { resolve(json({ canManage: true, credentialEditingAvailable: true })); await flush(); });
  expect(accessCalls).toBe(2); expect(value.listCalls()).toBe(1);
  expect(screen.getByText("No migrations have been accepted.")).toBeTruthy(); mounted.unmount();
});

it("preserves a Recovery executor ACK against older capability denial and immediately reads current state", async () => {
  const value = setup(cases[2], { hangs: false }), fallback = network.getMockImplementation()!;
  let resolve!: (response: Response) => void, capabilityCalls = 0, enabled = true;
  const old = new Promise<Response>(yes => { resolve = yes; });
  network.mockImplementation((path, init) => {
    if (String(path) === "/api/system-recovery/capabilities") {
      if (++capabilityCalls === 2) return old;
      return Promise.resolve(json({ ...recoveryCapability, enabled }));
    }
    if (String(path) === "/api/system-recovery/executor" && init?.method === "POST") {
      enabled = false; return Promise.resolve(json({ ...recoveryCapability, enabled }));
    }
    return fallback(path, init);
  });
  const mounted = await value.mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); expect(capabilityCalls).toBe(2);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Disable system recovery executor" })); await flush(); });
  expect(screen.getByText("Independent execution is paused.")).toBeTruthy();
  await act(async () => { resolve(json({ error: "PRIVATE_OLDER_CAPABILITY" }, 403)); await flush(); });
  expect(document.body.textContent).not.toContain("System administrator access is required");
  expect(screen.getByText("Independent execution is paused.")).toBeTruthy(); expect(capabilityCalls).toBe(3);
  expect(network.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1); mounted.unmount();
});

it("preserves a Recovery maintenance ACK before its queued fresh read can start", async () => {
  const value = setup(cases[2], { hangs: false }), fallback = network.getMockImplementation()!;
  let resolve!: (response: Response) => void, lists = 0, current = maintenance;
  const old = new Promise<Response>(yes => { resolve = yes; });
  network.mockImplementation((path, init) => {
    if (String(path) === "/api/system-recovery/jobs" && ++lists === 2) return old;
    if (String(path) === "/api/system-recovery/maintenance" && init?.method === "POST") {
      const input = JSON.parse(String(init.body)); current = { ...maintenance, state: "draining", generation: 1, token: input.requestId };
      return Promise.resolve(json({ ...input, status: current }));
    }
    if (String(path) === "/api/system-recovery/maintenance") return Promise.resolve(json(current));
    if (String(path) === "/api/system-recovery/capabilities") return Promise.resolve(json({ ...recoveryCapability, maintenance: { state: current.state, checkpoint: null } }));
    return fallback(path, init);
  });
  const mounted = await value.mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); expect(lists).toBe(2);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stop new source writes" })); await flush(); });
  expect(lists).toBe(2);
  await act(async () => { resolve(json({ error: "PRIVATE_OLDER_LIST" }, 403)); await flush(); });
  expect(document.body.textContent).not.toContain("System administrator access is required");
  expect(screen.getByText(/The source write window is draining/)).toBeTruthy(); expect(lists).toBe(3);
  expect(network.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1); mounted.unmount();
});
