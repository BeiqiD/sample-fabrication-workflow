import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchExecutorStatus, ResearchJobStatus } from "../shared/contracts/research-package-api";
import type { SystemRecoveryCapabilities, SystemRecoveryJobStatus, SystemRecoveryMaintenanceStatus } from "../shared/contracts/system-recovery";
import { ResearchPackagesPage } from "./pages/ResearchPackagesPage";
import { SystemRecoveryPage } from "./pages/SystemRecoveryPage";

const oldAt = "2026-10-09T10:00:00.000Z", ackAt = "2026-10-09T10:01:00.000Z", freshAt = "2026-10-09T10:02:00.000Z";
const network = vi.fn<typeof fetch>();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function packageJob(state: ResearchJobStatus["state"], updatedAt = oldAt): ResearchJobStatus {
  return { id: "package:job", requestId: "package:request", kind: "report", state, phase: "snapshot", acceptedAt: oldAt, updatedAt,
    reason: null, progress: { completedFiles: 0, totalFiles: 1, bytesDone: 0, bytesTotal: 12 }, output: null, result: null };
}
function recoveryJob(state: SystemRecoveryJobStatus["state"], updatedAt = oldAt): SystemRecoveryJobStatus {
  return { id: "recovery:job", requestId: "recovery:request", kind: "backup", state, phase: "snapshot", acceptedAt: oldAt, updatedAt,
    reason: null, progress: { completedFiles: 0, totalFiles: 1, bytesDone: 0, bytesTotal: 12 }, output: null, result: null };
}
type PublicJob = ResearchJobStatus | SystemRecoveryJobStatus;
const scenarios = [
  { name: "packages", base: "/api/packages", selector: ".research-package-job", paused: packageJob("paused"),
    resumed: packageJob("queued", ackAt), cancelled: packageJob("cancel_requested", ackAt),
    freshResume: packageJob("running", freshAt), freshCancel: packageJob("cancelled", freshAt),
    retryLabel: "Retry reading package status", deniedText: "Sign in with an account allowed" },
  { name: "recovery", base: "/api/system-recovery", selector: ".system-recovery-job", paused: recoveryJob("paused"),
    resumed: recoveryJob("queued", ackAt), cancelled: recoveryJob("cancelled", ackAt),
    freshResume: recoveryJob("running", freshAt), freshCancel: recoveryJob("cancelled", freshAt),
    retryLabel: "Retry reading recovery status", deniedText: "System administrator access is required" },
] as const;
type Scenario = typeof scenarios[number];
const executor: ResearchExecutorStatus = { supported: true, enabled: true, stale: false, canManage: false,
  lastHeartbeatAt: oldAt, cadenceSeconds: 120, maxStepMs: 60000, reason: null };
const capability: SystemRecoveryCapabilities = { supported: true, canManage: true, enabled: true, stale: false,
  lastHeartbeatAt: oldAt, cadenceSeconds: 120, maxStepMs: 60000, reason: null,
  target: { configured: true, id: "target:isolated", mode: "fresh" }, maintenance: { state: "open", checkpoint: null } };
const maintenance: SystemRecoveryMaintenanceStatus = { state: "open", generation: 0, token: null, checkpoint: null,
  backupJobId: null, activeWriters: 0 };
let oldList: ReturnType<typeof deferred<Response>>, controlAck: ReturnType<typeof deferred<Response>>;
let jobsReadCount: number, authoritative: PublicJob, freshReadFailure: number | null;
const mutations = () => network.mock.calls.filter(([, options]) => ["POST", "PUT"].includes(options?.method || ""));
function installNetwork(scenario: Scenario) {
  authoritative = scenario.paused;
  network.mockImplementation(async (url, options) => {
    const path = String(url), method = options?.method || "GET";
    if (path === `${scenario.base}/jobs` && method === "GET") {
      jobsReadCount++;
      if (jobsReadCount === 2) return oldList.promise;
      return freshReadFailure ? json({ secret: "PRIVATE_FRESH_READ_RESPONSE" }, freshReadFailure) : json({ jobs: [authoritative] });
    }
    if (path === `${scenario.base}/jobs/${encodeURIComponent(scenario.paused.id)}/control` && method === "POST") return controlAck.promise;
    if (path === "/api/packages/executor" && method === "GET") return json(executor);
    if (path === "/api/system-recovery/capabilities" && method === "GET") return json(capability);
    if (path === "/api/system-recovery/maintenance" && method === "GET") return json(maintenance);
    throw new Error(`Unexpected mocked job request: ${method} ${path}`);
  });
}
function jobElement(scenario: Scenario) {
  const element = document.querySelector<HTMLElement>(scenario.selector);
  expect(element).not.toBeNull(); return element!;
}
function expectJob(scenario: Scenario, expected: PublicJob) {
  const element = jobElement(scenario);
  expect(element.textContent).toContain(expected.state.replaceAll("_", " "));
  expect(element.querySelector("time")?.getAttribute("datetime")).toBe(expected.updatedAt);
  expect(within(element).queryByRole("button", { name: "Resume" })).toBeNull();
}
function expectOneControl(scenario: Scenario, action: "resume" | "cancel") {
  expect(mutations()).toHaveLength(1);
  expect(mutations()[0][0]).toBe(`${scenario.base}/jobs/${encodeURIComponent(scenario.paused.id)}/control`);
  expect(JSON.parse(String(mutations()[0][1]?.body))).toEqual({ action });
}
async function open(scenario: Scenario) {
  installNetwork(scenario);
  await act(async () => { render(<MemoryRouter>{scenario.name === "packages" ? <ResearchPackagesPage /> : <SystemRecoveryPage />}</MemoryRouter>); });
  expect(jobsReadCount).toBe(1);
  expect(within(jobElement(scenario)).getByRole("button", { name: "Resume" }).matches(":disabled")).toBe(false);
}
async function beginControl(scenario: Scenario, action: "resume" | "cancel") {
  await act(async () => { fireEvent.click(within(jobElement(scenario)).getByRole("button", { name: action === "resume" ? "Resume" : "Cancel" })); });
  expectOneControl(scenario, action);
  expect(within(jobElement(scenario)).getByRole("button", { name: "Resume" }).matches(":disabled")).toBe(true);
}
async function holdNextPoll() {
  await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
  expect(jobsReadCount).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(jobsReadCount).toBe(2);
}
async function acknowledge(scenario: Scenario, action: "resume" | "cancel") {
  authoritative = action === "resume" ? scenario.resumed : scenario.cancelled;
  await act(async () => { controlAck.resolve(json(authoritative)); });
  expectJob(scenario, authoritative);
}
async function nextPoll() {
  const previous = jobsReadCount;
  await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
  expect(jobsReadCount).toBe(previous);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(jobsReadCount).toBe(previous + 1);
}
beforeEach(() => {
  sessionStorage.clear(); vi.useFakeTimers(); network.mockReset(); vi.stubGlobal("fetch", network);
  oldList = deferred<Response>(); controlAck = deferred<Response>(); jobsReadCount = 0; freshReadFailure = null;
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe.each(scenarios)("$name control ACK owns rendered job state", scenario => {
  it.each([
    { action: "resume", timing: "before control" }, { action: "cancel", timing: "before control" },
    { action: "resume", timing: "during control" }, { action: "cancel", timing: "during control" },
  ] as const)("keeps $action ACK after an old list begun $timing and accepts the next current list", async ({ action, timing }) => {
    await open(scenario);
    if (timing === "before control") { await holdNextPoll(); await beginControl(scenario, action); }
    else { await beginControl(scenario, action); await holdNextPoll(); }
    await acknowledge(scenario, action);
    await act(async () => { oldList.resolve(json({ jobs: [scenario.paused] })); });
    expectJob(scenario, action === "resume" ? scenario.resumed : scenario.cancelled);
    expect(screen.queryByRole("alert")).toBeNull(); expectOneControl(scenario, action);
    authoritative = action === "resume" ? scenario.freshResume : scenario.freshCancel;
    await nextPoll();
    expectJob(scenario, authoritative); expectOneControl(scenario, action);
    expect(jobsReadCount).toBe(3);
  });

  it.each([500, 403])("ignores old %s failure after Cancel ACK while later current failures still apply", async status => {
    await open(scenario); await holdNextPoll(); await beginControl(scenario, "cancel"); await acknowledge(scenario, "cancel");
    const response = json({ secret: "PRIVATE_OLD_READ_RESPONSE" }, status), body = vi.spyOn(response, "json");
    await act(async () => { oldList.resolve(response); });
    expectJob(scenario, scenario.cancelled);
    expect(screen.queryByRole("alert")).toBeNull(); expect(document.body.textContent).not.toContain(scenario.deniedText);
    expect(document.body.textContent).not.toContain("PRIVATE"); expect(body).not.toHaveBeenCalled(); expectOneControl(scenario, "cancel");
    // The same ownership check must not suppress later authoritative errors.
    freshReadFailure = status === 500 ? 403 : 500;
    await nextPoll();
    expect(screen.getByRole("alert")).toBeTruthy();
    if (freshReadFailure === 403) {
      expect(document.body.textContent).toContain(scenario.deniedText);
      expect(document.querySelector(scenario.selector)).toBeNull();
    } else {
      expectJob(scenario, scenario.cancelled);
      freshReadFailure = null; authoritative = scenario.freshCancel;
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: scenario.retryLabel })); });
      expectJob(scenario, authoritative); expect(screen.queryByRole("alert")).toBeNull();
    }
    expect(document.body.textContent).not.toContain("PRIVATE"); expectOneControl(scenario, "cancel");
  });

  it("keeps a current authorization denial when a still-pending control ACK arrives", async () => {
    await open(scenario); await beginControl(scenario, "cancel"); await holdNextPoll();
    const response = json({ secret: "PRIVATE_CURRENT_ACCESS_RESPONSE" }, 403), body = vi.spyOn(response, "json");
    await act(async () => { oldList.resolve(response); });
    const denialMessage = scenario.name === "packages"
      ? "Your application access does not allow this research package operation."
      : "System administrator access is required for backup and recovery.";
    expect(screen.getByRole("alert").textContent).toBe(denialMessage);
    expect(document.querySelector(scenario.selector)).toBeNull();
    await act(async () => { controlAck.resolve(json(scenario.cancelled)); });
    expect(screen.getByRole("alert").textContent).toBe(denialMessage);
    expect(document.querySelector(scenario.selector)).toBeNull();
    expect(document.body.textContent).not.toContain("Saved job state updated");
    expect(document.body.textContent).not.toContain("PRIVATE"); expect(body).not.toHaveBeenCalled();
    expectOneControl(scenario, "cancel");
  });
});
