import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES, type SystemRecoveryBackupPreview, type SystemRecoveryCapabilities,
  type SystemRecoveryJobStatus, type SystemRecoveryMaintenanceReceipt, type SystemRecoveryMaintenanceStatus,
  type SystemRecoveryPreview, type SystemRecoveryReceipt, type SystemRecoveryUploadInput,
} from "../shared/contracts/system-recovery";
import { hashResearchFile } from "../shared/domain/research-sha256";
import { SystemRecoveryPage } from "./pages/SystemRecoveryPage";

vi.mock("../shared/domain/research-sha256", async importOriginal => ({
  ...await importOriginal<typeof import("../shared/domain/research-sha256")>(), hashResearchFile: vi.fn(),
}));
const base = "/api/system-recovery", at = "2026-10-06T12:00:00.000Z", digest = "a".repeat(64);
const intentKey = "system-recovery-operation", uploadKey = "system-recovery-upload", maintenanceKey = "system-recovery-maintenance";
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
      generation: maintenance.generation + 1, token: input.action === "release" ? null : maintenance.token || input.requestId };
    const accepted = { ...input, status: maintenance }; maintenanceReceipts.set(input.requestId, accepted); return json(accepted);
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
    const value = receipts.get(decodeURIComponent(pathname.slice(`${base}/requests/`.length))); return value ? json(value) : json({}, 404);
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
beforeEach(() => {
  sessionStorage.clear(); jobs = []; receipts = new Map(); maintenanceReceipts = new Map(); preview = completePreview();
  capability = { supported: true, canManage: true, enabled: true, stale: false, lastHeartbeatAt: at, cadenceSeconds: 120, maxStepMs: 60000,
    reason: null, target: { configured: true, id: "isolated:1", mode: "fresh" }, maintenance: { state: "open", checkpoint: null } };
  maintenance = { state: "open", generation: 0, token: null, checkpoint: null, backupJobId: null, activeWriters: 0 };
  vi.mocked(hashResearchFile).mockReset(); vi.mocked(hashResearchFile).mockImplementation(async archive => ({ byteSize: archive.size, sha256: digest }));
  network.mockReset(); network.mockImplementation(async (path, options) => fallback(path, options)); vi.stubGlobal("fetch", network);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe("privileged website system backup and recovery workflow", () => {
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
    fireEvent.click(await enabled("Check or retry original request")); await screen.findByText(/original saved operation|Operation saved/);
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
});
