import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES, type SystemRecoveryBackupPreview, type SystemRecoveryCapabilities,
  type SystemRecoveryJobStatus, type SystemRecoveryMaintenanceReceipt, type SystemRecoveryMaintenanceStatus,
  type SystemRecoveryPreview, type SystemRecoveryReceipt, type SystemRecoveryUploadInput,
  type SystemRecoverySourceResumeInput, type SystemRecoverySourceResumeReceipt,
} from "../shared/contracts/system-recovery";
import { hashResearchFile } from "../shared/domain/research-sha256";
import { SystemRecoveryPage } from "./pages/SystemRecoveryPage";
import { readAuthentication } from "./lib/authentication-client";
import { checkpointStorage } from "./lib/browser-checkpoints";

vi.mock("../shared/domain/research-sha256", async importOriginal => ({
  ...await importOriginal<typeof import("../shared/domain/research-sha256")>(), hashResearchFile: vi.fn(),
}));
const base = "/api/system-recovery", at = "2026-10-06T12:00:00.000Z", digest = "a".repeat(64);
const intentKey = "system-recovery-operation", uploadKey = "system-recovery-upload", maintenanceKey = "system-recovery-maintenance";
const sourceResumeKey = "system-recovery-source-resume";
const sourceReleaseKey = "system-recovery-source-release";
const sourceBackupKey = "system-recovery-source-backup";
const workerPolicy: SystemRecoveryCapabilities["policy"] = { recoveryMapping: "explicit-profile", backupMaintenance: "planned-only",
  maintenanceWithoutTarget: false, recoveryCleanup: true, sourceResume: false };
const nodePolicy: SystemRecoveryCapabilities["policy"] = { recoveryMapping: "inert-preserve", backupMaintenance: "always",
  maintenanceWithoutTarget: true, recoveryCleanup: false, sourceResume: true };
const network = vi.fn<typeof fetch>();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function job(kind: SystemRecoveryJobStatus["kind"] = "backup", state: SystemRecoveryJobStatus["state"] = "queued", id = "backup:job"): SystemRecoveryJobStatus {
  return { id, requestId: "original-request", kind, state, phase: state === "preview" ? "ready" : state === "completed" ? "done" : "snapshot",
    acceptedAt: at, updatedAt: at, reason: null, progress: { completedFiles: 0, totalFiles: 1, bytesDone: 0, bytesTotal: 32 }, output: null, result: null };
}
function completePreview(): SystemRecoveryPreview {
  return { schema: "system-recovery-preview/1", archive: { schema: "system-backup/1", byteSize: 32, sha256: digest, complete: true, legacy: false, recoveryPoint: at },
    counts: { tables: 103, rows: 400, files: 1, bytes: 16, availableFiles: 1, unavailableFiles: 0 },
    files: [{ id: "file:1", purpose: "research_source", byteSize: 16, status: "packaged", reason: null, sourceProfileId: "source:r2" }],
    profiles: [{ id: "source:r2", adapterType: "r2", namespaceIdentity: "namespace-sha256" }],
    protectedSettings: { included: true, credentialRecovery: "quarantined", warnings: ["credential_quarantined"] }, oldJobs: { paused: 3, automaticReplay: false },
    target: { id: "isolated:1", available: true, reason: null }, source: { maintenanceRequired: true, checkpoint: null, mode: "historical" },
    canRecover: true, canCutover: false, reasons: [] };
}
let capability: SystemRecoveryCapabilities, maintenance: SystemRecoveryMaintenanceStatus, jobs: SystemRecoveryJobStatus[], preview: SystemRecoveryPreview;
let receipts: Map<string, SystemRecoveryReceipt>, maintenanceReceipts: Map<string, SystemRecoveryMaintenanceReceipt>;
let sourceResumeReceipts: Map<string, SystemRecoverySourceResumeReceipt>;
function sourceResumeReceipt(input: SystemRecoverySourceResumeInput): SystemRecoverySourceResumeReceipt {
  return { schema: "node-original-source-resume/1", ...input, sourceInstallationId: "original_installation", incarnation: "original_incarnation",
    sourceCheckpoint: digest, resumedAt: at, enabled: true, shadowEnabled: false, jobsEnabled: false, noBindingCutover: true, noJobReplay: true };
}
function backupPreview(): SystemRecoveryBackupPreview {
  return { schema: "system-backup-preview/1", available: true, reasons: [], includesProtectedSettings: true, credentialsRequireKeyring: true,
    bounds: { archiveBytes: 104857600, payloadBytes: 100663296, metadataBytes: 4194304, files: 100, maxStepMs: 60000 },
    maintenance: { state: maintenance.state, checkpoint: maintenance.checkpoint } };
}
function remember(value: SystemRecoveryJobStatus) { jobs = [value, ...jobs.filter(existing => existing.id !== value.id)]; }
function fallback(path: RequestInfo | URL, options?: RequestInit): Response {
  const url = new URL(String(path), "http://localhost"), method = options?.method || "GET", pathname = url.pathname;
  if (pathname === `${base}/capabilities` && method === "GET") return json({ ...capability, maintenance: { state: maintenance.state, checkpoint: maintenance.checkpoint } });
  if (pathname === `${base}/backup-preview` && method === "GET") return json(backupPreview());
  if (pathname === `${base}/maintenance` && method === "GET") return json(maintenance);
  if (pathname.startsWith(`${base}/maintenance/requests/`) && method === "GET") {
    const value = maintenanceReceipts.get(decodeURIComponent(pathname.slice(`${base}/maintenance/requests/`.length))); return value ? json(value) : json({}, 404);
  }
  if (pathname === `${base}/maintenance` && method === "POST") {
    const input = JSON.parse(String(options?.body));
    const existing = maintenanceReceipts.get(input.requestId); if (existing) return json(existing);
    if (input.expectedGeneration !== maintenance.generation) return json({}, 409);
    maintenance = { ...maintenance, state: input.action === "enter" ? "draining" : input.action === "finalize" ? "fenced" : "open",
      generation: maintenance.generation + (input.action === "finalize" && capability.policy.backupMaintenance === "always" ? 0 : 1),
      token: input.action === "release" ? null : maintenance.token || input.requestId,
      ...(input.action === "release" ? { checkpoint: null, backupJobId: null } : {}) };
    const accepted = { ...input, status: maintenance }; maintenanceReceipts.set(input.requestId, accepted); return json(accepted);
  }
  if (pathname.startsWith(`${base}/source-resume/requests/`) && method === "GET") {
    const value = sourceResumeReceipts.get(decodeURIComponent(pathname.slice(`${base}/source-resume/requests/`.length))); return value ? json(value) : json({}, 404);
  }
  if (pathname === `${base}/source-resume` && method === "POST") {
    const input = JSON.parse(String(options?.body)), accepted = sourceResumeReceipts.get(input.requestId) || sourceResumeReceipt(input);
    sourceResumeReceipts.set(input.requestId, accepted); return json(accepted);
  }
  if (pathname === `${base}/executor` && method === "POST") {
    const { enabled } = JSON.parse(String(options?.body)); capability = { ...capability, enabled, reason: enabled ? null : "executor_disabled" }; return json(capability);
  }
  if (pathname === `${base}/jobs` && method === "GET") return json({ jobs });
  if (pathname === `${base}/jobs` && method === "POST") {
    const input = JSON.parse(String(options?.body)), accepted = { ...job(), requestId: input.requestId }; remember(accepted);
    const receipt = { requestId: input.requestId, job: accepted, reused: false }; receipts.set(input.requestId, receipt); return json(receipt, 202);
  }
  if (pathname === `${base}/uploads` && method === "POST") {
    const input: SystemRecoveryUploadInput = JSON.parse(String(options?.body)), accepted = { ...job("upload", "awaiting_upload", "upload:job"), requestId: input.requestId,
      progress: { completedFiles: 0, totalFiles: 1, bytesDone: 0, bytesTotal: input.byteSize } }; remember(accepted);
    const receipt = { requestId: input.requestId, job: accepted, reused: false }; receipts.set(input.requestId, receipt); return json(receipt, 202);
  }
  if (pathname.startsWith(`${base}/requests/`) && method === "GET") {
    const requestId = decodeURIComponent(pathname.slice(`${base}/requests/`.length)), value = receipts.get(requestId);
    return value ? json(value) : json({ schema: "system-recovery-request-absent/1", requestId }, 404);
  }
  if (pathname.endsWith("/upload") && method === "PUT") {
    const accepted = { ...jobs.find(value => value.id === "upload:job")!, state: "queued" as const, phase: "validate" as const }; remember(accepted); return json(accepted);
  }
  if (pathname.endsWith("/upload-intent") && method === "GET") {
    const value = jobs.find(value => value.id === "upload:job")!; return json({ requestId: value.requestId, byteSize: value.progress.bytesTotal, sha256: digest });
  }
  if (pathname.endsWith("/preview") && method === "GET") return json(preview);
  if (pathname === `${base}/recoveries` && method === "POST") {
    const input = JSON.parse(String(options?.body)), accepted = { ...job("recovery", "queued", "recovery:job"), requestId: input.requestId }; remember(accepted);
    const receipt = { requestId: input.requestId, job: accepted, reused: false }; receipts.set(input.requestId, receipt); return json(receipt, 202);
  }
  if (pathname.endsWith("/control") && method === "POST") {
    const id = decodeURIComponent(pathname.slice(`${base}/jobs/`.length, -"/control".length)), original = jobs.find(value => value.id === id)!;
    const { action } = JSON.parse(String(options?.body));
    const accepted: SystemRecoveryJobStatus = { ...original, state: action === "pause" ? "paused" : action === "cancel" ? "cancelled" : action === "cleanup" ? original.state : "queued" };
    remember(accepted); return json(accepted);
  }
  if (pathname.endsWith("/cutover") && method === "POST") {
    const input = JSON.parse(String(options?.body)), id = decodeURIComponent(pathname.slice(`${base}/jobs/`.length, -"/cutover".length));
    const original = jobs.find(value => value.id === id)!, accepted = { ...original, result: { ...original.result!, cutover: true } }; remember(accepted);
    const receipt = { requestId: input.requestId, job: accepted, reused: false }; receipts.set(input.requestId, receipt); return json(receipt);
  }
  if (pathname.startsWith(`${base}/jobs/`) && method === "GET") {
    const value = jobs.find(item => item.id === decodeURIComponent(pathname.slice(`${base}/jobs/`.length))); return value ? json(value) : json({}, 404);
  }
  return json({ error: "PRIVATE_UNKNOWN_ROUTE" }, 404);
}
const calls = (path: string, method?: string) => network.mock.calls.filter(([url, options]) => String(url) === `${base}${path}` && (!method || options?.method === method));
const mutations = () => network.mock.calls.filter(([, options]) => ["POST", "PUT"].includes(options?.method || ""));
async function enabled(name: string) { const button = await screen.findByRole("button", { name }); await waitFor(() => expect(button.matches(":disabled")).toBe(false)); return button; }
async function mount() {
  const view = render(<MemoryRouter><SystemRecoveryPage /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText("Reading administrator recovery access…")).toBeNull()); return view;
}
function savedUpload(state: SystemRecoveryJobStatus["state"] = "preview") {
  const input = { requestId: "upload-request", byteSize: 32, sha256: digest };
  sessionStorage.setItem(uploadKey, JSON.stringify({ input, jobId: "upload:job" }));
  jobs = [{ ...job("upload", state, "upload:job"), requestId: input.requestId }]; return input;
}
function sourceBackup() {
  capability = { ...capability, enabled: false, policy: nodePolicy };
  jobs = [job("backup", "completed", "backup_job")];
  maintenance = { state: "fenced", generation: 1, token: "original_enter", checkpoint: digest, backupJobId: "backup_job", activeWriters: 0 };
}
function savedSourceRelease(): SystemRecoverySourceResumeInput {
  sourceBackup(); maintenance = { state: "open", generation: 2, token: null, checkpoint: null, backupJobId: null, activeWriters: 0 };
  const release: SystemRecoveryMaintenanceReceipt = { requestId: "original_release", action: "release", expectedGeneration: 1, status: maintenance };
  sessionStorage.setItem(sourceReleaseKey, JSON.stringify({ release, backupJobId: "backup_job" }));
  maintenanceReceipts.set(release.requestId, release);
  return { requestId: "original_resume", releaseRequestId: release.requestId, backupJobId: "backup_job", expectedGeneration: 2 };
}
beforeEach(() => {
  sessionStorage.clear(); jobs = []; receipts = new Map(); maintenanceReceipts = new Map(); sourceResumeReceipts = new Map(); preview = completePreview();
  capability = { supported: true, canManage: true, enabled: true, stale: false, lastHeartbeatAt: at, cadenceSeconds: 120, maxStepMs: 60000,
    reason: null, target: { configured: true, id: "isolated:1", mode: "fresh" }, maintenance: { state: "open", checkpoint: null }, policy: workerPolicy };
  maintenance = { state: "open", generation: 0, token: null, checkpoint: null, backupJobId: null, activeWriters: 0 };
  vi.mocked(hashResearchFile).mockReset(); vi.mocked(hashResearchFile).mockImplementation(async archive => ({ byteSize: archive.size, sha256: digest }));
  network.mockReset(); network.mockImplementation(async (path, options) => fallback(path, options)); vi.stubGlobal("fetch", network);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); sessionStorage.clear(); });

describe("privileged website system backup and recovery workflow", () => {
  it("does not resume old recovery bytes after an account change while the hash is pending before React cleanup", async () => {
    vi.stubEnv("VITE_LOCAL_AUTHENTICATION", "1");
    let principal = "local_6f3e32c5-d935-44ab-8567-0966b13d91ae", release!: () => void;
    network.mockImplementation(async (path, options) => String(path) === "/api/auth/session" ? json({ principal: { id: principal, actor: `local-account:${principal}`,
      capabilities: { systemAdministrator: true, fileEvidenceOperator: false } }, csrf: "A".repeat(43) }) : fallback(path, options));
    await readAuthentication(); const input = { requestId: "upload-request", byteSize: 32, sha256: digest };
    const original = JSON.stringify({ input, jobId: "upload:job" }); checkpointStorage().setItem(uploadKey, original);
    jobs = [{ ...job("upload", "awaiting_upload", "upload:job"), requestId: input.requestId }];
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(hashResearchFile).mockImplementation(async () => { await held; return input; });
    await mount(); fireEvent.change(screen.getByLabelText("System recovery ZIP"), { target: { files: [new File([new Uint8Array(32)], "original.zip", { type: "application/zip" })] } });
    fireEvent.click(await enabled("Resume original recovery upload")); await waitFor(() => expect(hashResearchFile).toHaveBeenCalledOnce());
    principal = "local_3408b493-0ff6-41eb-8f8b-0cfe7bb4ef1a"; await act(async () => readAuthentication()); await act(async () => release());
    expect(mutations()).toHaveLength(0); expect(checkpointStorage().length).toBe(0);
    expect([...Array(sessionStorage.length)].map((_, index) => sessionStorage.getItem(sessionStorage.key(index)!))).toEqual([original]);
  });
  it("returns focus to an explicitly focused Preview system backup after its original deferred GET", async () => {
    let finishPreview!: (value: Response) => void;
    let originalPreview!: Response;
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}/backup-preview` && options?.method === "GET") {
        originalPreview = fallback(path, options);
        return new Promise<Response>(resolve => { finishPreview = resolve; });
      }
      return fallback(path, options);
    });
    await mount();
    const preview = await enabled("Preview system backup");
    expect(document.activeElement).not.toBe(preview);
    preview.focus(); fireEvent.click(preview);
    expect(preview.matches(":disabled")).toBe(true);
    // Model the prior actual Chromium disabled-button blur; this is not a new browser proof.
    const originalTabIndex = document.body.getAttribute("tabindex");
    try { document.body.tabIndex = -1; document.body.focus(); }
    finally {
      if (originalTabIndex === null) document.body.removeAttribute("tabindex");
      else document.body.setAttribute("tabindex", originalTabIndex);
    }
    expect(document.activeElement).toBe(document.body);
    await act(async () => finishPreview(originalPreview));
    await screen.findByRole("button", { name: "Start durable system backup" });
    await waitFor(() => expect(document.activeElement).toBe(preview));
    expect(preview.isConnected).toBe(true); expect(preview.matches(":disabled")).toBe(false);
    expect(calls("/backup-preview", "GET")).toHaveLength(1); expect(mutations()).toHaveLength(0);
    expect(sessionStorage.getItem(intentKey)).toBeNull();
  });

  it("preserves focus moved to another native control while Preview system backup is pending", async () => {
    let finishPreview!: (value: Response) => void;
    let originalPreview!: Response;
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}/backup-preview` && options?.method === "GET") {
        originalPreview = fallback(path, options);
        return new Promise<Response>(resolve => { finishPreview = resolve; });
      }
      return fallback(path, options);
    });
    await mount();
    const preview = await enabled("Preview system backup");
    preview.focus(); fireEvent.click(preview); expect(preview.matches(":disabled")).toBe(true);
    const other = screen.getByRole("link", { name: "Research packages and reports" }); other.focus();
    expect(document.activeElement).toBe(other);
    await act(async () => finishPreview(originalPreview));
    await screen.findByRole("button", { name: "Start durable system backup" });
    expect(preview.matches(":disabled")).toBe(false); expect(document.activeElement).toBe(other);
    expect(calls("/backup-preview", "GET")).toHaveLength(1); expect(mutations()).toHaveLength(0);
    expect(sessionStorage.getItem(intentKey)).toBeNull();
  });

  it("reads administrator capability first and exposes no backup or target state to an ordinary actor", async () => {
    capability.canManage = false; await mount();
    expect(screen.getByRole("heading", { name: "Administrator access required" })).toBeTruthy();
    expect(calls("/capabilities", "GET")).toHaveLength(1); expect(calls("/jobs")).toHaveLength(0); expect(calls("/maintenance")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Preview system backup" })).toBeNull(); expect(mutations()).toHaveLength(0);
  });
  it("previews an ordinary backup and accepts one durable request only after the explicit start", async () => {
    await mount(); fireEvent.click(await enabled("Preview system backup"));
    await enabled("Start durable system backup"); expect(mutations()).toHaveLength(0);
    fireEvent.click(await enabled("Start durable system backup")); await screen.findByText(/Operation saved/);
    expect(calls("/jobs", "POST")).toHaveLength(1);
    expect(JSON.parse(String(calls("/jobs", "POST")[0][1]?.body))).toEqual({ requestId: expect.any(String), kind: "backup", mode: "historical" });
    expect(sessionStorage.getItem(intentKey)).toBeNull();
    expect(screen.getByText(/Canonical identities|canonical identities/)).toBeTruthy();
  });
  it("blocks a final planned backup until source writers are drained and fenced", async () => {
    await mount(); fireEvent.change(screen.getByLabelText("System backup mode"), { target: { value: "planned" } });
    fireEvent.click(await enabled("Preview system backup"));
    const start = await screen.findByRole("button", { name: "Start durable system backup" }); expect(start.matches(":disabled")).toBe(true);
    fireEvent.click(await enabled("Stop new source writes")); await screen.findByText(/source write window is draining/);
    expect(JSON.parse(String(calls("/maintenance", "POST")[0][1]?.body))).toEqual({ requestId: expect.any(String), action: "enter", expectedGeneration: 0 });
    fireEvent.click(await enabled("Confirm drained source fence")); await screen.findByText(/source write fence was confirmed/);
    fireEvent.click(await enabled("Preview system backup")); fireEvent.click(await enabled("Start durable system backup"));
    await screen.findByText(/Operation saved/);
    expect(JSON.parse(String(calls("/jobs", "POST")[0][1]?.body)).mode).toBe("planned");
  });
  it("allows a Node backup source fence without a target and requires it for historical backups", async () => {
    capability = { ...capability, policy: nodePolicy, target: { configured: false, id: null, mode: "fresh" } };
    await mount();
    expect(screen.queryByText(/Ordinary historical backups do not require a maintenance window/)).toBeNull();
    fireEvent.click(await enabled("Preview system backup"));
    expect((await screen.findByRole("button", { name: "Start durable system backup" })).matches(":disabled")).toBe(true);
    fireEvent.click(await enabled("Stop new source writes")); await screen.findByText(/source write window is draining/);
    fireEvent.click(await enabled("Confirm drained source fence")); await screen.findByText(/source write fence was confirmed/);
    fireEvent.click(await enabled("Preview system backup")); fireEvent.click(await enabled("Start durable system backup"));
    await screen.findByText(/Operation saved/);
    expect(calls("/maintenance", "POST").map(([, options]) => JSON.parse(String(options?.body))))
      .toEqual([{ requestId: expect.any(String), action: "enter", expectedGeneration: 0 },
        { requestId: expect.any(String), action: "finalize", expectedGeneration: 1 }]);
    expect(JSON.parse(String(calls("/jobs", "POST")[0][1]?.body))).toEqual({ requestId: expect.any(String), kind: "backup", mode: "historical" });
    expect(calls("/recoveries", "POST")).toHaveLength(0);
  });
  it("keeps Worker maintenance target admission while allowing ordinary backups without a target", async () => {
    capability = { ...capability, target: { configured: false, id: null, mode: "fresh" } };
    await mount();
    expect(screen.getByRole("button", { name: "Stop new source writes" }).matches(":disabled")).toBe(true);
    fireEvent.click(await enabled("Preview system backup")); fireEvent.click(await enabled("Start durable system backup"));
    await screen.findByText(/Operation saved/); expect(calls("/maintenance", "POST")).toHaveLength(0);
    expect(calls("/jobs", "POST")).toHaveLength(1);
  });
  it("keeps unknown or active source writers visible and does not permit forcing the fence", async () => {
    maintenance = { ...maintenance, state: "draining", generation: 1, token: "original-enter", activeWriters: 2 };
    await mount(); expect(screen.getByText(/Active accepted writers: 2/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm drained source fence" }).matches(":disabled")).toBe(true);
    expect(screen.getByText(/Expired leases never force/)).toBeTruthy(); expect(mutations()).toHaveLength(0);
  });
  it("reconciles a lost backup ACK with the original receipt without starting a duplicate", async () => {
    network.mockImplementation(async (path, options) => {
      const result = fallback(path, options);
      if (String(path) === `${base}/jobs` && options?.method === "POST") throw new Error("PRIVATE_LOST_ACK");
      return result;
    });
    await mount(); fireEvent.click(await enabled("Preview system backup")); fireEvent.click(await enabled("Start durable system backup"));
    await screen.findByRole("heading", { name: "Unconfirmed operation" });
    const original = JSON.parse(sessionStorage.getItem(intentKey)!); expect(original.action).toBe("backup");
    fireEvent.click(await enabled("Check original recovery request")); await screen.findByText(/original saved operation|Operation saved/);
    expect(calls("/jobs", "POST")).toHaveLength(1); expect(calls(`/requests/${original.input.requestId}`, "GET")).toHaveLength(1);
    expect(sessionStorage.getItem(intentKey)).toBeNull(); expect(document.body.textContent).not.toContain("PRIVATE_LOST_ACK");
  });
  it("recovers a stored maintenance intent from its exact receipt before reading fresh source state", async () => {
    const input = { requestId: "maintenance-request", action: "enter" as const, expectedGeneration: 0 };
    sessionStorage.setItem(maintenanceKey, JSON.stringify(input));
    maintenanceReceipts.set(input.requestId, { ...input, status: { ...maintenance, state: "draining", generation: 1, token: input.requestId } });
    maintenance = { ...maintenance, state: "fenced", generation: 2, token: input.requestId, activeWriters: 0 };
    await mount(); await waitFor(() => expect(sessionStorage.getItem(maintenanceKey)).toBeNull());
    const paths = network.mock.calls.map(([path]) => String(path));
    expect(paths.indexOf(`${base}/maintenance/requests/${input.requestId}`)).toBeLessThan(paths.indexOf(`${base}/maintenance`));
    expect(screen.getByText(/State: fenced/)).toBeTruthy(); expect(mutations()).toHaveLength(0);
  });
  it("does not infer a lost maintenance operation from a similar generation or state", async () => {
    const input = { requestId: "unconfirmed-enter", action: "enter", expectedGeneration: 0 };
    sessionStorage.setItem(maintenanceKey, JSON.stringify(input)); maintenance = { ...maintenance, state: "draining", generation: 1, token: "another-admin-enter" };
    await mount(); expect(sessionStorage.getItem(maintenanceKey)).not.toBeNull();
    expect(screen.getByText(/is unconfirmed\. Review current state/)).toBeTruthy(); expect(calls("/maintenance", "POST")).toHaveLength(0);
  });
  it.each([
    { route: "/maintenance", key: maintenanceKey, start: "Stop new source writes", retry: "Check or retry original maintenance request" },
    { route: "/source-resume", key: sourceResumeKey, start: "Resume source writes after backup", retry: "Check or retry original source resume request" },
  ])("retains a lost $route operation through a rejected retry and only clears it when its original receipt arrives", async ({ route, key, start, retry }) => {
    if (route === "/source-resume") savedSourceRelease();
    let attempts = 0;
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}${route}` && options?.method === "POST") {
        if (++attempts === 1) throw new Error("PRIVATE_LOST_OPERATION_ACK");
        return json({ error: "PRIVATE_RETRY_CONFLICT" }, 409);
      }
      return fallback(path, options);
    });
    const first = await mount(); fireEvent.click(await enabled(start));
    await waitFor(() => expect(calls(route, "POST")).toHaveLength(1));
    await enabled("Refresh recovery status"); const original = sessionStorage.getItem(key)!; expect(original).not.toBeNull();
    first.unmount(); const second = await mount();
    expect(sessionStorage.getItem(key)).toBe(original); expect(calls(route, "POST")).toHaveLength(1);
    fireEvent.click(await enabled(retry)); await waitFor(() => expect(calls(route, "POST")).toHaveLength(2));
    await enabled("Refresh recovery status");
    expect(sessionStorage.getItem(key)).toBe(original);
    expect(screen.getByRole("button", { name: start }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: retry })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/PRIVATE_LOST_OPERATION_ACK|PRIVATE_RETRY_CONFLICT/);
    // Complete the original server attempt after the retry and absent receipt.
    fallback(`${base}${route}`, { method: "POST", body: original });
    second.unmount(); await mount();
    await waitFor(() => expect(sessionStorage.getItem(key)).toBeNull());
    expect(calls(route, "POST")).toHaveLength(2); expect(mutations()).toHaveLength(2);
    if (route === "/source-resume") expect(sessionStorage.getItem(sourceReleaseKey)).toBeNull();
  });
  it("separates release from Node source resume and submits the original backup, release receipt and generation", async () => {
    sourceBackup(); capability = { ...capability, enabled: true }; await mount();
    expect(calls("/source-resume", "POST")).toHaveLength(0);
    fireEvent.click(await enabled("Release source maintenance window"));
    await waitFor(() => expect(sessionStorage.getItem(maintenanceKey)).toBeNull());
    const releaseInput = JSON.parse(String(calls("/maintenance", "POST")[0][1]?.body));
    expect(releaseInput).toEqual({ requestId: expect.any(String), action: "release", expectedGeneration: 1 });
    expect(calls("/source-resume", "POST")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Resume source writes after backup" }).matches(":disabled")).toBe(true);
    fireEvent.click(await enabled("Disable system recovery executor"));
    await waitFor(() => expect(calls("/executor", "POST")).toHaveLength(1));
    expect(JSON.parse(String(calls("/executor", "POST")[0][1]?.body))).toEqual({ enabled: false });
    fireEvent.click(await enabled("Resume source writes after backup"));
    await waitFor(() => expect(calls("/source-resume", "POST")).toHaveLength(1));
    expect(JSON.parse(String(calls("/source-resume", "POST")[0][1]?.body))).toEqual({ requestId: expect.any(String),
      releaseRequestId: releaseInput.requestId, backupJobId: "backup_job", expectedGeneration: 2 });
    await waitFor(() => expect(sessionStorage.getItem(sourceResumeKey)).toBeNull());
    expect(sessionStorage.getItem(sourceReleaseKey)).toBeNull(); expect(calls("/executor", "POST")).toHaveLength(1);
    expect(calls("/jobs", "POST")).toHaveLength(0); expect(calls("/recoveries", "POST")).toHaveLength(0);
  });
  it("reconciles a lost Node source resume ACK after reload with its exact receipt and no second mutation", async () => {
    savedSourceRelease();
    network.mockImplementation(async (path, options) => {
      const response = fallback(path, options);
      if (String(path) === `${base}/source-resume` && options?.method === "POST") throw new Error("PRIVATE_LOST_RESUME_ACK");
      return response;
    });
    const view = await mount(); fireEvent.click(await enabled("Resume source writes after backup"));
    await waitFor(() => expect(sessionStorage.getItem(sourceResumeKey)).not.toBeNull());
    const original = JSON.parse(sessionStorage.getItem(sourceResumeKey)!);
    expect(original).toEqual({ requestId: expect.any(String), releaseRequestId: "original_release", backupJobId: "backup_job", expectedGeneration: 2 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh recovery status" }).matches(":disabled")).toBe(false));
    view.unmount(); await mount();
    await waitFor(() => expect(sessionStorage.getItem(sourceResumeKey)).toBeNull());
    expect(calls(`/source-resume/requests/${original.requestId}`, "GET")).toHaveLength(1);
    expect(calls("/source-resume", "POST")).toHaveLength(1); expect(sessionStorage.getItem(sourceReleaseKey)).toBeNull();
    expect(document.body.textContent).not.toContain("PRIVATE_LOST_RESUME_ACK");
  });
  it("never infers a source resume ACK from an open source and retains the exact missing request across reload", async () => {
    const input = savedSourceRelease(); sessionStorage.setItem(sourceResumeKey, JSON.stringify(input));
    await mount();
    await waitFor(() => expect(calls(`/source-resume/requests/${input.requestId}`, "GET")).toHaveLength(1));
    expect(JSON.parse(sessionStorage.getItem(sourceResumeKey)!)).toEqual(input);
    expect(calls("/source-resume", "POST")).toHaveLength(0); expect(mutations()).toHaveLength(0);
    fireEvent.click(await enabled("Check or retry original source resume request"));
    await waitFor(() => expect(sessionStorage.getItem(sourceResumeKey)).toBeNull());
    expect(calls(`/source-resume/requests/${input.requestId}`, "GET")).toHaveLength(2);
    expect(calls("/source-resume", "POST")).toHaveLength(1);
    expect(JSON.parse(String(calls("/source-resume", "POST")[0][1]?.body))).toEqual(input);
  });
  it("blocks source resume when the current maintenance generation differs from its accepted release", async () => {
    savedSourceRelease(); maintenance = { ...maintenance, generation: 3 };
    await mount();
    expect(screen.getByRole("button", { name: "Resume source writes after backup" }).matches(":disabled")).toBe(true);
    expect(sessionStorage.getItem(sourceReleaseKey)).not.toBeNull(); expect(calls("/source-resume", "POST")).toHaveLength(0);
  });
  it("finishes an in-flight status read before source resume and keeps polling out of its exclusive write window", async () => {
    savedSourceRelease(); vi.useFakeTimers();
    let finishRead!: (value: Response) => void, finishResume!: (value: Response) => void, jobReads = 0, readSettled = false;
    const heldRead = new Promise<Response>(resolve => { finishRead = resolve; });
    const heldResume = new Promise<Response>(resolve => { finishResume = resolve; });
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}/jobs` && options?.method === "GET" && ++jobReads === 2) return heldRead;
      if (String(path) === `${base}/source-resume` && options?.method === "POST") {
        expect(readSettled).toBe(true); return heldResume;
      }
      return fallback(path, options);
    });
    const flushReads = async () => { for (let index = 0; index < 80; index++) await Promise.resolve(); };
    await act(async () => { render(<MemoryRouter><SystemRecoveryPage /></MemoryRouter>); await flushReads(); });
    const resume = screen.getByRole("button", { name: "Resume source writes after backup" });
    expect(resume.matches(":disabled")).toBe(false); expect(jobReads).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(jobReads).toBe(2);
    await act(async () => { fireEvent.click(resume); await flushReads(); });
    expect(resume.matches(":disabled")).toBe(true); expect(calls("/source-resume", "POST")).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(jobReads).toBe(2); expect(calls("/source-resume", "POST")).toHaveLength(0);
    await act(async () => { readSettled = true; finishRead(json({ jobs })); await flushReads(); });
    expect(calls("/source-resume", "POST")).toHaveLength(1);
    const readsBeforeHeldResume = network.mock.calls.filter(([, options]) => options?.method === "GET").length;
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(network.mock.calls.filter(([, options]) => options?.method === "GET")).toHaveLength(readsBeforeHeldResume);
    expect(calls("/source-resume", "POST")).toHaveLength(1); expect(sessionStorage.getItem(sourceResumeKey)).not.toBeNull();
    const original = calls("/source-resume", "POST")[0];
    await act(async () => { finishResume(fallback(...original)); await flushReads(); });
    expect(sessionStorage.getItem(sourceResumeKey)).toBeNull(); expect(sessionStorage.getItem(sourceReleaseKey)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(jobReads).toBe(3); expect(calls("/source-resume", "POST")).toHaveLength(1);
  });
  it("retains a newly released source backup when a scheduled jobs list omits that older job", async () => {
    sourceBackup(); vi.useFakeTimers(); let omitBackup = false;
    network.mockImplementation(async (path, options) => String(path) === `${base}/jobs` && options?.method === "GET" && omitBackup
      ? json({ jobs: [] }) : fallback(path, options));
    const flushReads = async () => { for (let index = 0; index < 80; index++) await Promise.resolve(); };
    await act(async () => { render(<MemoryRouter><SystemRecoveryPage /></MemoryRouter>); await flushReads(); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Release source maintenance window" })); await flushReads(); });
    const resume = screen.getByRole("button", { name: "Resume source writes after backup" });
    expect(resume.matches(":disabled")).toBe(false); expect(calls("/jobs/backup_job", "GET")).toHaveLength(0);
    omitBackup = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(calls("/jobs/backup_job", "GET")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "System backup" })).toBeTruthy();
    expect(resume.matches(":disabled")).toBe(false); expect(calls("/source-resume", "POST")).toHaveLength(0);
    expect(JSON.parse(sessionStorage.getItem(sourceReleaseKey)!).backupJobId).toBe("backup_job");
  });
  it("reconciles an old accepted release with its original saved backup after the source generation advances", async () => {
    sourceBackup();
    const input = { requestId: "old_release", action: "release" as const, expectedGeneration: 1 };
    const release: SystemRecoveryMaintenanceReceipt = { ...input,
      status: { state: "open", generation: 2, token: null, checkpoint: null, backupJobId: null, activeWriters: 0 } };
    sessionStorage.setItem(maintenanceKey, JSON.stringify(input));
    sessionStorage.setItem(sourceBackupKey, JSON.stringify({ jobId: "backup_job", generation: 1 }));
    maintenanceReceipts.set(input.requestId, release);
    maintenance = { state: "fenced", generation: 3, token: "new_enter", checkpoint: "b".repeat(64), backupJobId: "new_backup", activeWriters: 0 };
    jobs = [...jobs, job("backup", "completed", "new_backup")];
    await mount(); await waitFor(() => expect(sessionStorage.getItem(maintenanceKey)).toBeNull());
    expect(JSON.parse(sessionStorage.getItem(sourceReleaseKey)!)).toEqual({ release, backupJobId: "backup_job" });
    expect(screen.getByRole("button", { name: "Resume source writes after backup" }).matches(":disabled")).toBe(true);
    expect(calls(`/maintenance/requests/${input.requestId}`, "GET")).toHaveLength(1);
    expect(mutations()).toHaveLength(0);
  });
  it("keeps a retained source resume request private after administrator access is revoked", async () => {
    const input = savedSourceRelease(); sessionStorage.setItem(sourceResumeKey, JSON.stringify(input));
    await mount(); await waitFor(() => expect(calls(`/source-resume/requests/${input.requestId}`, "GET")).toHaveLength(1));
    network.mockImplementation(async (path, options) => String(path) === `${base}/capabilities` ? json({}, 403) : fallback(path, options));
    fireEvent.click(await enabled("Refresh recovery status")); await screen.findByRole("heading", { name: "Administrator access required" });
    expect(screen.queryByRole("button", { name: "Resume source writes after backup" })).toBeNull();
    expect(screen.queryByText(input.requestId)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(sourceResumeKey)!)).toEqual(input); expect(mutations()).toHaveLength(0);
  });
  it("reads administrator authority before reconciling a retained source resume request", async () => {
    const input = savedSourceRelease(); sessionStorage.setItem(sourceResumeKey, JSON.stringify(input)); capability.canManage = false;
    await mount(); expect(screen.getByRole("heading", { name: "Administrator access required" })).toBeTruthy();
    expect(calls(`/source-resume/requests/${input.requestId}`, "GET")).toHaveLength(0);
    expect(JSON.parse(sessionStorage.getItem(sourceResumeKey)!)).toEqual(input); expect(mutations()).toHaveLength(0);
  });
  it("hashes a selected archive with bounded chunks and keeps upload admission separate from target recovery", async () => {
    await mount(); const archive = new File(["x".repeat(32)], "backup.zip", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText("System recovery ZIP"), { target: { files: [archive] } });
    fireEvent.click(await enabled("Upload and validate recovery archive")); await screen.findByText(/Archive bytes accepted/);
    expect(hashResearchFile).toHaveBeenCalledWith(archive, { maxBytes: SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES, signal: expect.any(AbortSignal) });
    expect(calls("/uploads", "POST")).toHaveLength(1); expect(calls("/jobs/upload%3Ajob/upload", "PUT")[0][1]?.body).toBe(archive);
    expect(calls("/recoveries", "POST")).toHaveLength(0); expect(sessionStorage.getItem(uploadKey)).not.toBeNull();
  });
  it("reselects an accepted upload after reload and rejects differing bytes without a second acceptance", async () => {
    savedUpload("awaiting_upload"); vi.mocked(hashResearchFile).mockResolvedValue({ byteSize: 32, sha256: "b".repeat(64) });
    await mount(); fireEvent.change(screen.getByLabelText("System recovery ZIP"), { target: { files: [new File(["x".repeat(32)], "different.zip")] } });
    fireEvent.click(await enabled("Resume original recovery upload")); await screen.findByText(/differs from the accepted upload/);
    expect(calls("/uploads", "POST")).toHaveLength(0); expect(calls("/jobs/upload%3Ajob/upload", "PUT")).toHaveLength(0);
  });
  it("shows a full validation report, freezes explicit profile mappings and requires acknowledged historical recovery loss", async () => {
    savedUpload(); await mount(); await screen.findByText("Complete backup");
    expect(screen.getByText(/Recovery point:/).textContent).toContain(at);
    expect(screen.getByText(/Encrypted credentials are quarantined/)).toBeTruthy(); expect(screen.getByText(/never replayed automatically/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stage isolated recovery" }).matches(":disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Destination for source:r2"), { target: { value: "target:s3" } });
    fireEvent.change(screen.getByLabelText("Revision for source:r2"), { target: { value: "3" } });
    expect(screen.getByRole("button", { name: "Stage isolated recovery" }).matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByLabelText(/I understand that this recovers/)); fireEvent.click(await enabled("Stage isolated recovery"));
    await screen.findByText(/Operation saved/);
    expect(JSON.parse(String(calls("/recoveries", "POST")[0][1]?.body))).toEqual({ requestId: expect.any(String), uploadJobId: "upload:job", expectedTargetId: "isolated:1",
      mapping: [{ sourceProfileId: "source:r2", destinationProfileId: "target:s3", configurationRevision: 3 }], mode: "historical", acknowledgeLaterChanges: true, acknowledgePartial: false });
    expect(calls("/jobs/recovery%3Ajob/cutover", "POST")).toHaveLength(0);
  });
  it("keeps nonempty Node archive profile evidence and stages inert recovery with an empty mapping", async () => {
    capability = { ...capability, policy: nodePolicy }; savedUpload(); await mount(); await screen.findByText("Complete backup");
    expect(screen.getAllByText("source:r2").length).toBeGreaterThan(0);
    expect(screen.getByText("file:1")).toBeTruthy();
    expect(screen.queryByLabelText("Destination for source:r2")).toBeNull();
    expect(screen.queryByLabelText("Revision for source:r2")).toBeNull();
    expect(screen.getByRole("button", { name: "Stage isolated recovery" }).matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByLabelText(/I understand that this recovers/)); fireEvent.click(await enabled("Stage isolated recovery"));
    await screen.findByText(/Operation saved/);
    expect(JSON.parse(String(calls("/recoveries", "POST")[0][1]?.body))).toEqual({ requestId: expect.any(String), uploadJobId: "upload:job",
      expectedTargetId: "isolated:1", mapping: [], mode: "historical", acknowledgeLaterChanges: true, acknowledgePartial: false });
    expect(calls("/jobs/recovery%3Ajob/cutover", "POST")).toHaveLength(0);
  });
  it("does not permit Node archive staging when its isolated target is absent", async () => {
    capability = { ...capability, policy: nodePolicy, target: { configured: false, id: null, mode: "fresh" } };
    preview = { ...preview, target: { id: null, available: false, reason: "recovery_target_missing" }, canRecover: false };
    savedUpload(); await mount(); await screen.findByText("Complete backup");
    fireEvent.click(screen.getByLabelText(/I understand that this recovers/));
    expect(screen.getByRole("button", { name: "Stage isolated recovery" }).matches(":disabled")).toBe(true);
    expect(calls("/recoveries", "POST")).toHaveLength(0);
  });
  it.each(["completed", "cancelled"] as const)("retains Node %s recovery history while preserving backup and upload cleanup", async state => {
    capability = { ...capability, policy: nodePolicy };
    jobs = [job("recovery", state, "recovery_history"), job("backup", state, "backup_history"), job("upload", "preview", "upload_history")];
    await mount();
    const recovery = screen.getByText("recovery_history").closest("article")!;
    expect(within(recovery).queryByRole("button", { name: "Clean up job artifacts" })).toBeNull();
    for (const id of ["backup_history", "upload_history"]) {
      expect(within(screen.getByText(id).closest("article")!).getByRole("button", { name: "Clean up job artifacts" })).toBeTruthy();
    }
    expect(mutations()).toHaveLength(0);
  });
  it("labels partial outcomes and blocks staging and cutover until the required content is complete", async () => {
    savedUpload(); preview = { ...preview, archive: { ...preview.archive, complete: false }, counts: { ...preview.counts, availableFiles: 0, unavailableFiles: 1 },
      files: [{ ...preview.files[0], status: "missing", reason: "missing" }], canRecover: false, canCutover: false, reasons: ["partial_archive"] };
    await mount(); await screen.findByText("Partial backup"); expect(screen.getByText(/1 required file is unavailable/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Destination for source:r2"), { target: { value: "target:r2" } }); fireEvent.click(screen.getByLabelText(/I understand that this recovers/));
    expect(screen.getByRole("button", { name: "Stage isolated recovery" }).matches(":disabled")).toBe(true);
    expect(screen.getByText(/Partial archives remain available for inspection/)).toBeTruthy(); expect(calls("/recoveries", "POST")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Prepare reviewed cutover handoff" })).toBeNull();
  });
  it("prepares a reviewed deployment handoff only after verified target report and an explicit acknowledgement", async () => {
    const recovered = { ...job("recovery", "completed", "recovery:job"), phase: "ready" as const, result: { targetId: "isolated:1", ready: true, cutover: false, checkpoint: digest } };
    jobs = [recovered]; preview = { ...preview, canCutover: true, source: { ...preview.source, checkpoint: digest } };
    await mount(); fireEvent.click(await enabled("Review cutover preparation")); await screen.findByRole("heading", { name: "Cutover preparation" });
    expect(screen.getByRole("link", { name: "Download verified recovery report" }).getAttribute("href")).toBe(`${base}/jobs/recovery%3Ajob/report`);
    expect(screen.getByRole("button", { name: "Prepare reviewed cutover handoff" }).matches(":disabled")).toBe(true); expect(mutations()).toHaveLength(0);
    fireEvent.click(screen.getByLabelText(/I reviewed this verified target/)); fireEvent.click(await enabled("Prepare reviewed cutover handoff"));
    await screen.findByText(/this page has not changed the running database binding/);
    expect(JSON.parse(String(calls("/jobs/recovery%3Ajob/cutover", "POST")[0][1]?.body))).toEqual({ requestId: expect.any(String), expectedTargetId: "isolated:1", expectedCheckpoint: digest });
    expect(screen.getByText(/Once the target accepts new writes/)).toBeTruthy();
  });
  it("offers the safe attachment only for the selected verified recovery and clears it before another report loads", async () => {
    const recovered = { ...job("recovery", "completed", "recovery:job"), phase: "ready" as const,
      result: { targetId: "isolated:1", ready: true, cutover: false, checkpoint: digest } };
    jobs = [recovered, job("backup", "completed")]; await mount();
    expect(screen.queryByRole("link", { name: "Download verified recovery report" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "View recovery report" })[0]);
    const reportLink = await screen.findByRole("link", { name: "Download verified recovery report" });
    expect(reportLink.getAttribute("href")).toBe(`${base}/jobs/recovery%3Ajob/report`); expect(reportLink.hasAttribute("download")).toBe(true);
    expect(calls("/jobs/recovery%3Ajob/report")).toHaveLength(0); expect(mutations()).toHaveLength(0);
    let resolve!: (value: Response) => void;
    network.mockImplementation(async (path, options) => String(path) === `${base}/jobs/backup%3Ajob/preview`
      ? new Promise<Response>(accept => { resolve = accept; }) : fallback(path, options));
    fireEvent.click(screen.getAllByRole("button", { name: "View recovery report" })[1]);
    await waitFor(() => expect(calls("/jobs/backup%3Ajob/preview")).toHaveLength(1));
    expect(screen.queryByRole("link", { name: "Download verified recovery report" })).toBeNull();
    await act(async () => resolve(json({ ...preview, archive: { ...preview.archive, sha256: "b".repeat(64) } })));
    expect(screen.queryByRole("link", { name: "Download verified recovery report" })).toBeNull();
  });
  it("removes a verified report download when administrator access is revoked", async () => {
    jobs = [{ ...job("recovery", "completed", "recovery:job"), phase: "ready", result: { targetId: "isolated:1", ready: true, cutover: false, checkpoint: digest } }];
    await mount(); fireEvent.click(await enabled("View recovery report")); await screen.findByRole("link", { name: "Download verified recovery report" });
    network.mockImplementation(async (path, options) => String(path) === `${base}/capabilities` ? json({}, 403) : fallback(path, options));
    fireEvent.click(await enabled("Refresh recovery status")); await screen.findByRole("heading", { name: "Administrator access required" });
    expect(screen.queryByRole("link", { name: "Download verified recovery report" })).toBeNull(); expect(calls("/jobs/recovery%3Ajob/report")).toHaveLength(0);
  });
  it("drops privileged report state and retains operation identifiers when administrator access is revoked", async () => {
    savedUpload(); await mount(); await screen.findByText("Complete backup");
    network.mockImplementation(async (path, options) => String(path) === `${base}/capabilities` ? json({ error: "PRIVATE_ADMIN_POLICY" }, 403) : fallback(path, options));
    fireEvent.click(await enabled("Refresh recovery status")); await screen.findByRole("heading", { name: "Administrator access required" });
    expect(screen.queryByText("Complete backup")).toBeNull(); expect(screen.queryByRole("button", { name: "Stage isolated recovery" })).toBeNull();
    expect(sessionStorage.getItem(uploadKey)).not.toBeNull(); expect(document.body.textContent).not.toContain("PRIVATE_ADMIN_POLICY");
  });
  it("does not accept or upload a new request when session intent persistence fails", async () => {
    await mount(); fireEvent.click(await enabled("Preview system backup"));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage denied"); });
    fireEvent.click(await enabled("Start durable system backup")); await screen.findByText(/Browser session storage is unavailable/);
    expect(calls("/jobs", "POST")).toHaveLength(0);
  });
  it("rejects archives beyond the shared limit before hashing or any upload admission", async () => {
    await mount(); const archive = new File(["x".repeat(32)], "huge.zip"); Object.defineProperty(archive, "size", { value: SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES + 1 });
    fireEvent.change(screen.getByLabelText("System recovery ZIP"), { target: { files: [archive] } }); fireEvent.click(await enabled("Upload and validate recovery archive"));
    await screen.findByText(/between 22 bytes and 100 MiB/); expect(hashResearchFile).not.toHaveBeenCalled(); expect(calls("/uploads", "POST")).toHaveLength(0);
  });
  it("aborts reads when leaving and never starts an operation after a pending preview finishes", async () => {
    let resolve!: (value: Response) => void;
    network.mockImplementation(async (path, options) => String(path) === `${base}/backup-preview` ? new Promise<Response>(accept => { resolve = accept; }) : fallback(path, options));
    const view = await mount(); fireEvent.click(await enabled("Preview system backup"));
    await waitFor(() => expect(calls("/backup-preview")).toHaveLength(1)); const signal = calls("/backup-preview")[0][1]?.signal;
    view.unmount(); expect(signal?.aborted).toBe(true); await act(async () => resolve(json(backupPreview()))); expect(mutations()).toHaveLength(0);
  });

  it("returns keyboard focus within the same job after deferred pause, resume and cancellation without replay", async () => {
    jobs = [job()]; await mount();
    let resolve!: (value: Response) => void;
    network.mockImplementation(async (path, options) => String(path) === `${base}/jobs/backup%3Ajob/control` && options?.method === "POST"
      ? new Promise<Response>(accept => { resolve = accept; }) : fallback(path, options));
    const pause = await enabled("Pause"); pause.focus(); fireEvent.click(pause);
    await waitFor(() => expect(calls("/jobs/backup%3Ajob/control", "POST")).toHaveLength(1));
    expect(pause.matches(":disabled")).toBe(true);
    await act(async () => resolve(fallback(...calls("/jobs/backup%3Ajob/control", "POST")[0])));
    const resume = await enabled("Resume"); await waitFor(() => expect(document.activeElement).toBe(resume));
    expect(pause.isConnected).toBe(false);
    fireEvent.click(resume);
    await waitFor(() => expect(calls("/jobs/backup%3Ajob/control", "POST")).toHaveLength(2));
    expect(resume.matches(":disabled")).toBe(true);
    await act(async () => resolve(fallback(...calls("/jobs/backup%3Ajob/control", "POST")[1])));
    const nextPause = await enabled("Pause"); await waitFor(() => expect(document.activeElement).toBe(nextPause));
    expect(resume.isConnected).toBe(false);
    const cancel = await enabled("Cancel"); const article = cancel.closest("article"); expect(article).not.toBeNull();
    cancel.focus(); fireEvent.click(cancel);
    await waitFor(() => expect(calls("/jobs/backup%3Ajob/control", "POST")).toHaveLength(3));
    expect(cancel.matches(":disabled")).toBe(true);
    await act(async () => resolve(fallback(...calls("/jobs/backup%3Ajob/control", "POST")[2])));
    const status = article!.querySelector('p[role="status"]'); expect(status).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(status!.textContent).toContain("backup:job"); expect(status!.textContent).toContain("cancelled");
    expect(cancel.isConnected).toBe(false); expect(status!.getAttribute("tabindex")).toBe("-1");
    expect(calls("/jobs/backup%3Ajob/control", "POST").map(([, options]) => JSON.parse(String(options?.body)).action))
      .toEqual(["pause", "resume", "cancel"]);
    expect(mutations()).toHaveLength(3); expect(sessionStorage.getItem(intentKey)).toBeNull();
  });
  it("preserves focus moved to another native control while the same job pause response is pending", async () => {
    jobs = [job()]; await mount();
    let resolve!: (value: Response) => void;
    network.mockImplementation(async (path, options) => String(path) === `${base}/jobs/backup%3Ajob/control` && options?.method === "POST"
      ? new Promise<Response>(accept => { resolve = accept; }) : fallback(path, options));
    const pause = await enabled("Pause"); pause.focus(); fireEvent.click(pause);
    await waitFor(() => expect(calls("/jobs/backup%3Ajob/control", "POST")).toHaveLength(1));
    const other = screen.getByRole("link", { name: "Research packages and reports" }); other.focus();
    expect(document.activeElement).toBe(other);
    await act(async () => resolve(fallback(...calls("/jobs/backup%3Ajob/control", "POST")[0])));
    await enabled("Resume"); expect(pause.isConnected).toBe(false); expect(document.activeElement).toBe(other);
    expect(calls("/jobs/backup%3Ajob/control", "POST")).toHaveLength(1); expect(mutations()).toHaveLength(1);
  });
});

const rejectionKey = "system-recovery-operation-rejection", historyKey = "system-recovery-earlier-requests";
const operationKinds = ["backup", "upload", "recovery", "cutover"] as const;
function originalIntent(action: typeof operationKinds[number]) {
  if (action === "backup") return { action, input: { requestId: "original-backup", kind: "backup" as const, mode: "historical" as const } };
  if (action === "upload") return { action, input: { requestId: "original-upload", byteSize: 32, sha256: digest } };
  if (action === "recovery") return { action, input: { requestId: "original-recovery", uploadJobId: "upload:job", expectedTargetId: "isolated:1",
    mapping: [{ sourceProfileId: "source:r2", destinationProfileId: "target:s3", configurationRevision: 3 }], mode: "historical" as const,
    acknowledgeLaterChanges: true, acknowledgePartial: false } };
  return { action, jobId: "recovery:job", input: { requestId: "original-cutover", expectedTargetId: "isolated:1", expectedCheckpoint: digest } };
}
function storeOriginal(action: typeof operationKinds[number], rejected = false) {
  const intent = originalIntent(action); sessionStorage.setItem(intentKey, JSON.stringify(intent));
  if (rejected) sessionStorage.setItem(rejectionKey, JSON.stringify({ schema: "system-recovery-rejection/1", intent }));
  return intent;
}
const requestReads = (requestId: string) => calls(`/requests/${encodeURIComponent(requestId)}`, "GET");
const missingRequest = (requestId: string) => json({ schema: "system-recovery-request-absent/1", requestId }, 404);
function receiptFor(intent: ReturnType<typeof originalIntent>, id?: string): SystemRecoveryReceipt {
  const kind = intent.action === "cutover" ? "recovery" : intent.action;
  return { requestId: intent.input.requestId, reused: true,
    job: { ...job(kind, "queued", id ?? (intent.action === "cutover" ? intent.jobId : `${kind}:original`)), requestId: intent.input.requestId } };
}
function assertOperationLocked() {
  expect(screen.getByRole("button", { name: "Preview system backup" }).matches(":disabled")).toBe(true);
  expect(screen.queryByRole("button", { name: "Review new recovery work" })).toBeNull();
}

describe("recovery operation request reconciliation", () => {
  it.each(operationKinds)("keeps legacy %s intent uncertain after absent lookup and rejected explicit retry, including reload", async action => {
    const intent = storeOriginal(action), original = sessionStorage.getItem(intentKey);
    network.mockImplementation(async (path, options) => options?.method === "POST" ? json({}, 409) : fallback(path, options));
    const first = await mount(); await enabled("Retry original recovery request");
    expect(mutations()).toHaveLength(0); assertOperationLocked();
    fireEvent.click(await enabled("Check original recovery request")); await enabled("Retry original recovery request");
    expect(mutations()).toHaveLength(0); expect(requestReads(intent.input.requestId)).toHaveLength(2);
    fireEvent.click(await enabled("Retry original recovery request")); await enabled("Retry original recovery request");
    expect(mutations()).toHaveLength(1); expect(requestReads(intent.input.requestId)).toHaveLength(4);
    expect(JSON.parse(String(mutations()[0][1]?.body))).toEqual(intent.input);
    expect(sessionStorage.getItem(intentKey)).toBe(original); expect(sessionStorage.getItem(rejectionKey)).toBeNull(); assertOperationLocked();
    first.unmount(); await mount(); await enabled("Retry original recovery request");
    expect(sessionStorage.getItem(intentKey)).toBe(original); expect(mutations()).toHaveLength(1); assertOperationLocked();
  });

  it.each(operationKinds)("checks accepted %s before retry and reopens its same job without a POST", async action => {
    const intent = storeOriginal(action); await mount(); await enabled("Retry original recovery request");
    const receipt = receiptFor(intent); receipts.set(intent.input.requestId, receipt); remember(receipt.job);
    fireEvent.click(await enabled("Retry original recovery request")); await waitFor(() => expect(sessionStorage.getItem(intentKey)).toBeNull());
    expect(mutations()).toHaveLength(0); expect(requestReads(intent.input.requestId)).toHaveLength(2);
    expect(JSON.parse(sessionStorage.getItem(historyKey)!)).toEqual([{ intent, jobId: receipt.job.id }]);
    expect(screen.getByText(receipt.job.id, { selector: 'p[role="status"] code' })).toBeTruthy();
  });

  it.each(operationKinds)("retains complete rejected %s before an explicit fresh review and preserves it on reload", async action => {
    const intent = storeOriginal(action, true); const first = await mount();
    fireEvent.click(await enabled("Review new recovery work"));
    await waitFor(() => expect(sessionStorage.getItem(intentKey)).toBeNull());
    expect(requestReads(intent.input.requestId)).toHaveLength(2); expect(mutations()).toHaveLength(0);
    expect(JSON.parse(sessionStorage.getItem(historyKey)!)).toEqual([{ intent, jobId: null }]);
    expect(screen.getByRole("button", { name: "Preview system backup" }).matches(":disabled")).toBe(false);
    first.unmount(); await mount();
    fireEvent.click(await enabled(`Check earlier recovery request ${intent.input.requestId}`));
    await screen.findByText(/No receipt is recorded for this earlier request at this time/);
    expect(JSON.parse(sessionStorage.getItem(historyKey)!)).toEqual([{ intent, jobId: null }]); expect(mutations()).toHaveLength(0);
  });

  it.each(["lost", "malformed"] as const)("keeps a fresh backup %s ACK sticky when a later retry rejects", async fault => {
    let attempts = 0;
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}/jobs` && options?.method === "POST") {
        if (++attempts > 1) return json({}, 409);
        if (fault === "lost") throw new Error("PRIVATE_LOST_ACK");
        const input = JSON.parse(String(options.body)); return json({ requestId: input.requestId, job: {}, reused: false }, 202);
      }
      return fallback(path, options);
    });
    await mount(); fireEvent.click(await enabled("Preview system backup")); fireEvent.click(await enabled("Start durable system backup"));
    await enabled("Check original recovery request"); const original = sessionStorage.getItem(intentKey);
    fireEvent.click(await enabled("Check original recovery request")); await enabled("Retry original recovery request");
    fireEvent.click(await enabled("Retry original recovery request")); await enabled("Retry original recovery request");
    expect(calls("/jobs", "POST")).toHaveLength(2); expect(sessionStorage.getItem(intentKey)).toBe(original);
    expect(sessionStorage.getItem(rejectionKey)).toBeNull(); assertOperationLocked();
  });

  it("retains a first rejected backup until explicit review, and a raced receipt reopens the original job", async () => {
    network.mockImplementation(async (path, options) => String(path) === `${base}/jobs` && options?.method === "POST" ? json({}, 409) : fallback(path, options));
    await mount(); fireEvent.click(await enabled("Preview system backup")); fireEvent.click(await enabled("Start durable system backup"));
    await enabled("Review new recovery work"); const intent = JSON.parse(sessionStorage.getItem(intentKey)!);
    expect(JSON.parse(sessionStorage.getItem(rejectionKey)!).intent).toEqual(intent);
    const receipt = receiptFor(intent); receipts.set(intent.input.requestId, receipt); remember(receipt.job);
    const review = await enabled("Review new recovery work"); review.focus(); fireEvent.click(review);
    await waitFor(() => expect(sessionStorage.getItem(intentKey)).toBeNull());
    const pause = await enabled("Pause"); await waitFor(() => expect(document.activeElement).toBe(pause));
    expect(calls("/jobs", "POST")).toHaveLength(1); expect(requestReads(intent.input.requestId)).toHaveLength(2);
    expect(JSON.parse(sessionStorage.getItem(historyKey)!)).toEqual([{ intent, jobId: receipt.job.id }]);
  });

  it.each([
    ["generic JSON", () => json({}, 404)],
    ["wrong identifier", () => missingRequest("wrong-request")],
    ["HTML fallback", () => new Response("PRIVATE_ROUTE_FALLBACK", { status: 404, headers: { "content-type": "text/html" } })],
    ["unknown fields", () => json({ schema: "system-recovery-request-absent/1", requestId: "original-backup", private: true }, 404)],
  ] as const)("keeps %s lookup failures locked without exposing retry or replacement", async (_label, response) => {
    const intent = storeOriginal("backup", true);
    network.mockImplementation(async (path, options) => String(path) === `${base}/requests/${intent.input.requestId}` ? response() : fallback(path, options));
    await mount(); await enabled("Check original recovery request");
    expect(screen.queryByRole("button", { name: "Retry original recovery request" })).toBeNull(); assertOperationLocked();
    expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(intent); expect(mutations()).toHaveLength(0);
  });

  it("requires an exact whole-intent rejection marker rather than a request identifier match", async () => {
    const intent = storeOriginal("backup");
    sessionStorage.setItem(rejectionKey, JSON.stringify({ schema: "system-recovery-rejection/1", intent: { ...intent, input: { ...intent.input, mode: "planned" } } }));
    await mount(); await enabled("Retry original recovery request"); assertOperationLocked(); expect(mutations()).toHaveLength(0);
  });

  it("does not silently truncate earlier intents when reviewing the next operation", async () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({ intent: { ...originalIntent("backup"), input: { ...originalIntent("backup").input, requestId: `earlier-${index}` } }, jobId: null }));
    sessionStorage.setItem(historyKey, JSON.stringify(rows)); const intent = storeOriginal("recovery", true);
    await mount(); fireEvent.click(await enabled("Review new recovery work"));
    await waitFor(() => expect(sessionStorage.getItem(intentKey)).toBeNull());
    expect(JSON.parse(sessionStorage.getItem(historyKey)!)).toEqual([...rows, { intent, jobId: null }]); expect(mutations()).toHaveLength(0);
  });

  it("refuses to lose pending work if writing complete history fails", async () => {
    const intent = storeOriginal("backup", true); await mount(); const original = sessionStorage.getItem(intentKey);
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === historyKey) throw new Error("PRIVATE_QUOTA"); return write.call(this, key, value);
    });
    fireEvent.click(await enabled("Review new recovery work")); await screen.findByText(/Browser session storage is unavailable/);
    expect(sessionStorage.getItem(intentKey)).toBe(original); expect(sessionStorage.getItem(historyKey)).toBeNull(); expect(mutations()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Preview system backup" }).matches(":disabled")).toBe(true);
    expect(requestReads(intent.input.requestId)).toHaveLength(2);
  });

  it("keeps an earlier accepted job immutable and preserves a different current pending operation", async () => {
    const prior = originalIntent("upload"), current = storeOriginal("recovery"), original = sessionStorage.getItem(intentKey);
    sessionStorage.setItem(historyKey, JSON.stringify([{ intent: prior, jobId: null }]));
    await mount(); await enabled("Retry original recovery request");
    const receipt = receiptFor(prior); receipts.set(prior.input.requestId, receipt); remember(receipt.job);
    fireEvent.click(await enabled(`Check earlier recovery request ${prior.input.requestId}`));
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem(historyKey)!)[0].jobId).toBe(receipt.job.id));
    expect(sessionStorage.getItem(intentKey)).toBe(original); expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(current); expect(mutations()).toHaveLength(0);
    receipts.set(prior.input.requestId, receiptFor(prior, "different:job"));
    fireEvent.click(await enabled(`Check earlier recovery request ${prior.input.requestId}`));
    await screen.findByRole("alert");
    expect(JSON.parse(sessionStorage.getItem(historyKey)!)).toEqual([{ intent: prior, jobId: receipt.job.id }]);
    expect(sessionStorage.getItem(intentKey)).toBe(original); expect(mutations()).toHaveLength(0);
  });

  it.each(["check", "review"] as const)("does not apply %s after navigation or steal focus moved away while its exact lookup is pending", async operation => {
    const intent = storeOriginal("backup", true); const view = await mount(); await enabled("Review new recovery work");
    let finish!: (response: Response) => void;
    network.mockImplementation(async (path, options) => String(path) === `${base}/requests/${intent.input.requestId}`
      ? new Promise<Response>(resolve => { finish = resolve; }) : fallback(path, options));
    const name = operation === "check" ? "Check original recovery request" : "Review new recovery work";
    const button = await enabled(name); button.focus(); fireEvent.click(button);
    await waitFor(() => expect(requestReads(intent.input.requestId)).toHaveLength(2));
    const link = screen.getByRole("link", { name: "Research packages and reports" }); link.focus();
    const receipt = receiptFor(intent); remember(receipt.job);
    await act(async () => finish(json(receipt))); await enabled("Pause"); expect(document.activeElement).toBe(link);
    expect(mutations()).toHaveLength(0);
    view.unmount(); sessionStorage.setItem(intentKey, JSON.stringify(intent)); sessionStorage.setItem(rejectionKey, JSON.stringify({ schema: "system-recovery-rejection/1", intent }));
    network.mockImplementation(async (path, options) => fallback(path, options)); receipts.delete(intent.input.requestId);
    const next = await mount(); await enabled("Review new recovery work");
    network.mockImplementation(async (path, options) => String(path) === `${base}/requests/${intent.input.requestId}`
      ? new Promise<Response>(resolve => { finish = resolve; }) : fallback(path, options));
    fireEvent.click(await enabled(name)); await waitFor(() => expect(requestReads(intent.input.requestId)).toHaveLength(4));
    const original = sessionStorage.getItem(intentKey); next.unmount(); await act(async () => finish(json(receipt)));
    expect(sessionStorage.getItem(intentKey)).toBe(original); expect(mutations()).toHaveLength(0);
  });

  it("drops privileged state on a denied original receipt and retains its pending intent", async () => {
    const intent = storeOriginal("cutover"); await mount(); await enabled("Retry original recovery request");
    network.mockImplementation(async (path, options) => String(path) === `${base}/requests/${intent.input.requestId}` ? json({}, 403) : fallback(path, options));
    fireEvent.click(await enabled("Retry original recovery request")); await screen.findByRole("heading", { name: "Administrator access required" });
    expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(intent); expect(mutations()).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "Saved system work" })).toBeNull();
  });

  it("hands a focused read-only check to the matching accepted job and a fresh review to its status message", async () => {
    const intent = storeOriginal("backup", true); const first = await mount(); await enabled("Review new recovery work");
    const receipt = receiptFor(intent); receipts.set(intent.input.requestId, receipt); remember(receipt.job);
    const check = await enabled("Check original recovery request"); check.focus(); fireEvent.click(check);
    const pause = await enabled("Pause"); await waitFor(() => expect(document.activeElement).toBe(pause)); expect(mutations()).toHaveLength(0);
    first.unmount(); receipts.clear(); jobs = []; storeOriginal("backup", true); await mount();
    const review = await enabled("Review new recovery work"); review.focus(); fireEvent.click(review);
    const status = await screen.findByText(/Review a fresh backup preview or recovery report before creating new work/);
    await waitFor(() => expect(document.activeElement).toBe(status)); expect(status.getAttribute("tabindex")).toBe("-1"); expect(mutations()).toHaveLength(0);
  });
});

describe("recovery request receipt freshness", () => {
  it("keeps an accepted cutover receipt when an older overlapping poll finishes later", async () => {
    const intent = storeOriginal("cutover");
    const previous: SystemRecoveryJobStatus = { ...job("recovery", "completed", "recovery:job"), phase: "ready",
      result: { targetId: "isolated:1", ready: true, cutover: false, checkpoint: digest } };
    const timers = vi.spyOn(globalThis, "setTimeout");
    jobs = [previous]; await mount(); await enabled("Retry original recovery request");
    const timerIndex = timers.mock.calls.findIndex(([, delay]) => delay === 5000), poll = timers.mock.calls[timerIndex][0];
    expect(typeof poll).toBe("function"); clearTimeout(timers.mock.results[timerIndex].value);
    let finish!: (response: Response) => void;
    network.mockImplementation(async (path, options) => String(path) === `${base}/jobs` && options?.method === "GET"
      ? new Promise<Response>(resolve => { finish = resolve; }) : fallback(path, options));
    // Invoke the captured page poll at its existing boundary; no production
    // deadline or polling interval is changed by this mounted race fixture.
    await act(async () => { if (typeof poll === "function") poll(); });
    await waitFor(() => expect(calls("/jobs", "GET")).toHaveLength(2));
    const receipt: SystemRecoveryReceipt = { requestId: intent.input.requestId, reused: true,
      job: { ...previous, result: { ...previous.result!, cutover: true } } };
    receipts.set(intent.input.requestId, receipt); remember(receipt.job);
    fireEvent.click(await enabled("Check original recovery request"));
    await waitFor(() => expect(sessionStorage.getItem(intentKey)).toBeNull());
    expect(screen.getByText(/Target.*cutover handoff prepared/)).toBeTruthy();
    await act(async () => finish(json({ jobs: [previous] })));
    expect(screen.getByText(/Target.*cutover handoff prepared/)).toBeTruthy();
    expect(screen.queryByText(/Target.*verified and ready for cutover review/)).toBeNull(); expect(mutations()).toHaveLength(0);
  });
  it("blocks replacement when complete earlier history is malformed instead of discarding it", async () => {
    const corrupt = JSON.stringify([{ input: "unsupported-checkpoint" }]); sessionStorage.setItem(historyKey, corrupt);
    await mount(); expect(screen.getByRole("button", { name: "Preview system backup" }).matches(":disabled")).toBe(true);
    expect(screen.getByText(/Saved recovery request history could not be read/)).toBeTruthy();
    expect(sessionStorage.getItem(historyKey)).toBe(corrupt); expect(mutations()).toHaveLength(0);
  });
});

describe("recovery upload authority while hashing", () => {
  it.each([false, true])("stops a deferred %s-checkpoint upload when a real background access read denies the administrator", async resumed => {
    if (resumed) savedUpload("awaiting_upload");
    const savedBytes = sessionStorage.getItem(uploadKey), pendingBytes = sessionStorage.getItem(intentKey);
    let finishHash!: (value: { byteSize: number; sha256: string }) => void;
    vi.mocked(hashResearchFile).mockImplementation(() => new Promise(resolve => { finishHash = resolve; }));
    const timers = vi.spyOn(globalThis, "setTimeout"); await mount();
    const timerIndex = timers.mock.calls.findIndex(([, delay]) => delay === 5000), poll = timers.mock.calls[timerIndex][0];
    expect(typeof poll).toBe("function"); clearTimeout(timers.mock.results[timerIndex].value);
    const archive = new File([new Uint8Array(32)], "bounded-recovery.zip", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText("System recovery ZIP"), { target: { files: [archive] } });
    fireEvent.click(await enabled(resumed ? "Resume original recovery upload" : "Upload and validate recovery archive"));
    await waitFor(() => expect(hashResearchFile).toHaveBeenCalledOnce()); expect(mutations()).toHaveLength(0);
    network.mockImplementation(async (path, options) => String(path) === `${base}/capabilities` ? json({}, 403) : fallback(path, options));
    await act(async () => { if (typeof poll === "function") poll(); });
    await screen.findByRole("heading", { name: "Administrator access required" });
    await act(async () => finishHash({ byteSize: 32, sha256: digest }));
    expect(calls("/uploads", "POST")).toHaveLength(0); expect(calls("/jobs/upload%3Ajob/upload", "PUT")).toHaveLength(0);
    expect(mutations()).toHaveLength(0); expect(sessionStorage.getItem(intentKey)).toBe(pendingBytes);
    expect(sessionStorage.getItem(uploadKey)).toBe(savedBytes); expect(screen.queryByRole("heading", { name: "Saved system work" })).toBeNull();
  });
});
