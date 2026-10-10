import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentStorageSettingsStatus } from "../shared/contracts/current-storage-settings";
import type { ResearchExecutorStatus, ResearchJobStatus, ResearchPackagePreview } from "../shared/contracts/research-package-api";
import type { SystemRecoveryBackupPreview, SystemRecoveryCapabilities, SystemRecoveryJobStatus, SystemRecoveryMaintenanceStatus } from "../shared/contracts/system-recovery";
import { exportAll } from "./lib/exportAll";
import { ExportPage } from "./pages/ExportPage";
import { ResearchPackagesPage } from "./pages/ResearchPackagesPage";
import { StorageSettingsPage } from "./pages/StorageSettingsPage";
import { SystemRecoveryPage } from "./pages/SystemRecoveryPage";

vi.mock("./lib/exportAll", () => ({ exportAll: vi.fn() }));

const at = "2026-10-08T11:00:00.000Z";
const settingsPath = "/api/settings/storage?version=3", accessPath = "/api/storage/configuration/capability";
const network = vi.fn<typeof fetch>();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const mutations = () => network.mock.calls.filter(([, options]) => !["GET", "HEAD"].includes(options?.method ?? "GET"));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function storage(): CurrentStorageSettingsStatus {
  return { version: 3, kind: "storage-settings-status", readOnly: true, health: "not_checked",
    authority: { mode: "active", shadowConversions: "paused", fileAccess: "enabled" },
    roleDefaults: { state: "configured", policyRevision: 3,
      internal: { profileId: "r2-profile", adapterType: "r2", availability: "available" },
      originals: { profileId: "r2-profile", adapterType: "r2", availability: "available" } },
    bindings: { r2: { configuration: "configured" }, managed: { provider: "none", configuration: "missing" } },
    profiles: { items: [{ id: "r2-profile", adapterType: "r2", configurationRevision: 1, runtimeAccess: "read_write",
      bindingMatch: "matched", bindingRevision: null, availability: "available" }], hasMore: false, limit: 100 } };
}
function packageJob(): ResearchJobStatus {
  return { id: "saved:package", requestId: "accepted:package", kind: "report", state: "paused", phase: "snapshot",
    acceptedAt: at, updatedAt: at, reason: "operator_paused", progress: { completedFiles: 0, totalFiles: 1, bytesDone: 0, bytesTotal: 12 },
    output: null, result: null };
}
const executor: ResearchExecutorStatus = { supported: true, enabled: false, stale: false, lastHeartbeatAt: null,
  reason: "executor_disabled", canManage: false, cadenceSeconds: 120, maxStepMs: 60000 };
function recoveryJob(): SystemRecoveryJobStatus {
  return { id: "saved:backup", requestId: "accepted:backup", kind: "backup", state: "paused", phase: "snapshot",
    acceptedAt: at, updatedAt: at, reason: "operator_paused", progress: { completedFiles: 0, totalFiles: 1, bytesDone: 0, bytesTotal: 12 },
    output: null, result: null };
}
const recoveryAccess: SystemRecoveryCapabilities = { supported: true, canManage: true, enabled: false, stale: false,
  lastHeartbeatAt: null, reason: "executor_disabled", cadenceSeconds: 120, maxStepMs: 60000,
  target: { configured: false, id: null, mode: "fresh" }, maintenance: { state: "open", checkpoint: null } };
const maintenance: SystemRecoveryMaintenanceStatus = { state: "open", generation: 0, token: null, checkpoint: null,
  backupJobId: null, activeWriters: 0 };
const exportPreview: ResearchPackagePreview = { schema: "research-package-preview/1", kind: "report", roots: [{ kind: "sample", id: "sample:1" }],
  counts: { records: 1, files: 0, bytes: 0 }, archiveBytes: null, metadataBytes: 100, warnings: [], complete: true,
  capabilities: { dataPackage: { available: true, reasons: [] }, report: { available: true, reasons: [] } },
  dependencies: [], rolePolicyRevision: null, targets: [], naming: null, source: null, existingImportJobId: null };
const backupPreview: SystemRecoveryBackupPreview = { schema: "system-backup-preview/1", available: true, reasons: [],
  includesProtectedSettings: true, credentialsRequireKeyring: true,
  bounds: { archiveBytes: 104857600, payloadBytes: 100663296, metadataBytes: 4194304, files: 100, maxStepMs: 60000 },
  maintenance: { state: "open", checkpoint: null } };

function mountData() { return render(<MemoryRouter><ResearchPackagesPage /></MemoryRouter>); }
function mountRecovery() { return render(<MemoryRouter><SystemRecoveryPage /></MemoryRouter>); }

beforeEach(() => {
  sessionStorage.clear(); network.mockReset(); vi.stubGlobal("fetch", network); vi.mocked(exportAll).mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

const savedWorkCases = [
  { name: "package", mount: mountData, base: "/api/packages", refresh: "Refresh status", retry: "Retry reading package status",
    empty: "No package jobs are recorded for your account.", reading: "Reading saved package work…", key: "research-package-operation",
    writeError: "Research packages are unavailable. Check File access and storage configuration." },
  { name: "recovery", mount: mountRecovery, base: "/api/system-recovery", refresh: "Refresh recovery status", retry: "Retry reading recovery status",
    empty: "No system backup or recovery jobs are recorded.", reading: "Reading administrator recovery access…", key: "system-recovery-operation",
    writeError: "System recovery is unavailable. Review storage, executor and isolated target configuration." },
] as const;
function savedWorkRead(path: RequestInfo | URL, unavailable: boolean, value: unknown = []): Response {
  const url = String(path);
  if (url.endsWith("/executor")) return json(executor);
  if (url.endsWith("/capabilities")) return json(recoveryAccess);
  if (url.endsWith("/maintenance")) return json(maintenance);
  return unavailable ? json({}, 503) : json({ jobs: value });
}

describe("Phase 5E truthful Settings and Data read states", () => {
  it("keeps an unresolved storage access check distinct from a confirmed read-only actor", async () => {
    const access = deferred<Response>();
    network.mockImplementation(async path => String(path) === settingsPath ? json(storage()) : access.promise);
    render(<StorageSettingsPage />);
    await screen.findByText("Checking administrator access…");
    expect(screen.queryByText("Only system administrators can change upload destinations.")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    await act(async () => { access.resolve(json({ canManage: false, credentialEditingAvailable: false })); });
    await screen.findByText("Only system administrators can change upload destinations.");
    expect(screen.queryByText("Checking administrator access…")).toBeNull(); expect(mutations()).toHaveLength(0);
  });

  it("retries an unavailable access read without resubmitting a retained storage save", async () => {
    const original = { operationId: "original:storage-save", expectedPolicyRevision: 3,
      internalProfileId: "r2-profile", originalsProfileId: "r2-profile" };
    sessionStorage.setItem("storage-role-policy:pending", JSON.stringify(original));
    let unavailable = true;
    network.mockImplementation(async path => String(path) === settingsPath ? json(storage()) : String(path) === accessPath
      ? unavailable ? json({ credentials: "PRIVATE_ACCESS_DETAIL" }, 503) : json({ canManage: true, credentialEditingAvailable: true })
        : json({}, 404));
    render(<StorageSettingsPage />); await screen.findByRole("alert");
    expect(screen.getByText(/Administrator access could not be checked/)).toBeTruthy();
    expect(screen.queryByText("Only system administrators can change upload destinations.")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull(); expect(document.body.textContent).not.toContain("PRIVATE_ACCESS_DETAIL");
    const settingsReads = network.mock.calls.filter(([path]) => String(path) === settingsPath).length;
    const accessReads = network.mock.calls.filter(([path]) => String(path) === accessPath).length;
    unavailable = false; fireEvent.click(screen.getByRole("button", { name: "Retry access check" }));
    await screen.findByRole("button", { name: "Check or retry save" });
    await screen.findByText("The save result is unconfirmed. Check or retry the original save before making another selection.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(JSON.parse(sessionStorage.getItem("storage-role-policy:pending")!)).toEqual(original);
    expect(network.mock.calls.some(([path]) => String(path).endsWith("/defaults/original%3Astorage-save"))).toBe(true);
    expect(network.mock.calls.filter(([path]) => String(path) === settingsPath)).toHaveLength(settingsReads);
    expect(network.mock.calls.filter(([path]) => String(path) === accessPath)).toHaveLength(accessReads + 1);
    expect(mutations()).toHaveLength(0);
  });

  it("retries one capability read in StrictMode and accepts actual denial without rereading settings", async () => {
    const retried = deferred<Response>(); let retry = false;
    network.mockImplementation(async path => String(path) === settingsPath ? json(storage()) : retry ? retried.promise : json({}, 503));
    render(<StrictMode><StorageSettingsPage /></StrictMode>); await screen.findByRole("alert");
    const settingsReads = network.mock.calls.filter(([path]) => String(path) === settingsPath).length;
    const accessReads = network.mock.calls.filter(([path]) => String(path) === accessPath).length;
    retry = true; fireEvent.click(screen.getByRole("button", { name: "Retry access check" }));
    expect(screen.getByText("Checking administrator access…")).toBeTruthy();
    expect(screen.queryByText("Only system administrators can change upload destinations.")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(network.mock.calls.filter(([path]) => String(path) === accessPath)).toHaveLength(accessReads + 1);
    expect(network.mock.calls.filter(([path]) => String(path) === settingsPath)).toHaveLength(settingsReads);
    await act(async () => { retried.resolve(json({ canManage: false, credentialEditingAvailable: false })); });
    await screen.findByText("Only system administrators can change upload destinations.");
    expect(screen.queryByRole("alert")).toBeNull(); expect(screen.queryByRole("combobox")).toBeNull(); expect(mutations()).toHaveLength(0);
  });

  it("treats a forbidden storage capability as denial while exposing no private response", async () => {
    network.mockImplementation(async path => String(path) === settingsPath ? json(storage()) : json({ credentials: "PRIVATE_POLICY" }, 403));
    render(<StorageSettingsPage />); await screen.findByText("Only system administrators can change upload destinations.");
    expect(screen.queryByText(/could not be checked/)).toBeNull(); expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.body.textContent).not.toContain("PRIVATE_POLICY"); expect(mutations()).toHaveLength(0);
  });

  it("does not claim empty package work after a failed first read and retries only its GETs", async () => {
    let unavailable = true;
    network.mockImplementation(async path => String(path).endsWith("/executor") ? json(executor)
      : unavailable ? json({ credentials: "PRIVATE_PACKAGE_DETAIL" }, 503) : json({ jobs: [] }));
    mountData(); await screen.findByRole("alert");
    expect(screen.queryByText("No package jobs are recorded for your account.")).toBeNull();
    expect(screen.getByText("Saved package work has not been read. Refresh status to check it.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("PRIVATE_PACKAGE_DETAIL");
    unavailable = false; fireEvent.click(screen.getByRole("button", { name: "Retry reading package status" }));
    await screen.findByText("No package jobs are recorded for your account.");
    expect(screen.queryByRole("alert")).toBeNull(); expect(mutations()).toHaveLength(0);
  });

  it.each(savedWorkCases.flatMap(scenario => ["network", "HTTP 500"].map(failure => ({ ...scenario, failure }))))(
    "keeps a failed first $name read separate from an unconfirmed write ($failure)", async scenario => {
      let unavailable = true;
      network.mockImplementation(async path => {
        if (unavailable && String(path) === `${scenario.base}/jobs`) {
          if (scenario.failure === "network") throw new TypeError("PRIVATE_STATUS_DETAIL");
          return json({ credentials: "PRIVATE_STATUS_DETAIL" }, 500);
        }
        return savedWorkRead(path, false);
      });
      scenario.mount();
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(scenario.name === "package"
        ? "Package status could not be read. Retry the status check."
        : "Recovery access or status could not be read. Retry the status check.");
      expect(alert.textContent).not.toContain("original request");
      expect(screen.queryByRole("heading", { name: "Unconfirmed operation" })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Administrator access required" })).toBeNull();
      expect(screen.queryByText(scenario.empty)).toBeNull();
      expect(document.body.textContent).not.toContain("PRIVATE_STATUS_DETAIL");
      expect(sessionStorage.getItem(scenario.key)).toBeNull();
      expect(mutations()).toHaveLength(0);

      const readsBeforeRetry = network.mock.calls.length;
      unavailable = false; fireEvent.click(screen.getByRole("button", { name: scenario.retry }));
      await screen.findByText(scenario.empty);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(network.mock.calls.slice(readsBeforeRetry).map(([path]) => String(path))).toEqual(scenario.name === "package"
        ? [`${scenario.base}/jobs`, `${scenario.base}/executor`]
        : [`${scenario.base}/capabilities`, `${scenario.base}/jobs`, `${scenario.base}/maintenance`]);
      expect(mutations()).toHaveLength(0);
      expect(sessionStorage.getItem(scenario.key)).toBeNull();
    },
  );

  it("keeps read package jobs and an unconfirmed request intact when a later status read fails", async () => {
    const original = { action: "export", input: { requestId: "unconfirmed:package", kind: "report", roots: [{ kind: "sample", id: "sample:1" }] } };
    sessionStorage.setItem("research-package-operation", JSON.stringify(original));
    let unavailable = false;
    network.mockImplementation(async path => String(path).includes("/requests/") ? json({}, 404)
      : String(path).endsWith("/executor") ? json(executor)
        : unavailable ? json({}, 503) : json({ jobs: [packageJob()] }));
    mountData(); await screen.findByText("saved:package");
    unavailable = true; fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await screen.findByRole("alert");
    expect(screen.getAllByText("saved:package")).toHaveLength(1);
    expect(screen.getByText("Showing previously read package work. Its current status could not be refreshed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check or retry original request" })).toBeTruthy();
    expect(JSON.parse(sessionStorage.getItem("research-package-operation")!)).toEqual(original);
    expect(screen.queryByText("No package jobs are recorded for your account.")).toBeNull(); expect(mutations()).toHaveLength(0);
  });

  it("distinguishes an allowed recovery capability from an unavailable first job read", async () => {
    let unavailable = true;
    network.mockImplementation(async path => String(path).endsWith("/capabilities") ? json(recoveryAccess)
      : String(path).endsWith("/maintenance") ? json(maintenance)
        : unavailable ? json({ credentials: "PRIVATE_RECOVERY_DETAIL" }, 503) : json({ jobs: [] }));
    mountRecovery(); await screen.findByRole("alert");
    expect(screen.queryByText("No system backup or recovery jobs are recorded.")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Administrator access required" })).toBeNull();
    expect(screen.getByText("Saved system work has not been read. Refresh recovery status to check it.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("PRIVATE_RECOVERY_DETAIL");
    unavailable = false; fireEvent.click(screen.getByRole("button", { name: "Retry reading recovery status" }));
    await screen.findByText("No system backup or recovery jobs are recorded.");
    expect(screen.queryByRole("alert")).toBeNull(); expect(mutations()).toHaveLength(0);
  });

  it("keeps recovery work and the original backup intent when refresh fails", async () => {
    const original = { action: "backup", input: { requestId: "unconfirmed:backup", kind: "backup", mode: "historical" } };
    sessionStorage.setItem("system-recovery-operation", JSON.stringify(original));
    let unavailable = false;
    network.mockImplementation(async path => String(path).includes("/requests/") ? json({}, 404)
      : String(path).endsWith("/capabilities") ? json(recoveryAccess)
        : String(path).endsWith("/maintenance") ? json(maintenance)
          : unavailable ? json({}, 503) : json({ jobs: [recoveryJob()] }));
    mountRecovery(); await screen.findByText("saved:backup");
    unavailable = true; fireEvent.click(screen.getByRole("button", { name: "Refresh recovery status" }));
    await screen.findByRole("alert"); expect(screen.getAllByText("saved:backup")).toHaveLength(1);
    expect(screen.getByText("Showing previously read system work. Its current status could not be refreshed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check or retry original request" })).toBeTruthy();
    expect(JSON.parse(sessionStorage.getItem("system-recovery-operation")!)).toEqual(original);
    expect(screen.queryByText("No system backup or recovery jobs are recorded.")).toBeNull(); expect(mutations()).toHaveLength(0);
  });

  it("does not describe an unavailable administrator capability as a proved denial", async () => {
    network.mockResolvedValue(json({ credentials: "PRIVATE_CAPABILITY" }, 503));
    mountRecovery(); await screen.findByRole("alert");
    expect(screen.queryByRole("heading", { name: "Administrator access required" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Preview system backup" })).toBeNull();
    expect(network.mock.calls.every(([path]) => String(path).endsWith("/capabilities"))).toBe(true);
    expect(document.body.textContent).not.toContain("PRIVATE_CAPABILITY"); expect(mutations()).toHaveLength(0);
  });

  it("retains the genuine recovery denial boundary and never reads privileged saved work", async () => {
    network.mockResolvedValue(json({ ...recoveryAccess, canManage: false }));
    mountRecovery(); await screen.findByRole("heading", { name: "Administrator access required" });
    expect(screen.queryByRole("button", { name: "Preview system backup" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry reading recovery status" })).toBeNull();
    expect(network.mock.calls.every(([path]) => String(path).endsWith("/capabilities"))).toBe(true); expect(mutations()).toHaveLength(0);
  });

  it.each(savedWorkCases)("hides previously empty $name work after refresh fails and announces a read-only retry", async scenario => {
    let unavailable = false;
    let retry: ReturnType<typeof deferred<Response>> | null = null;
    network.mockImplementation(async path => String(path) === `${scenario.base}/jobs` && retry
      ? retry.promise : savedWorkRead(path, unavailable));
    scenario.mount(); await screen.findByText(scenario.empty);
    unavailable = true; fireEvent.click(screen.getByRole("button", { name: scenario.refresh }));
    await screen.findByRole("alert"); expect(screen.queryByText(scenario.empty)).toBeNull();
    unavailable = false; retry = deferred<Response>();
    fireEvent.click(screen.getByRole("button", { name: scenario.retry }));
    expect(screen.getByRole("status").textContent).toBe(scenario.reading);
    expect(screen.queryByText(scenario.empty)).toBeNull();
    expect(screen.getByRole("button", { name: scenario.refresh }).matches(":disabled")).toBe(true);
    await act(async () => { retry!.resolve(json({ jobs: [] })); });
    await screen.findByText(scenario.empty); expect(screen.queryByRole("alert")).toBeNull(); expect(mutations()).toHaveLength(0);
  });

  it.each(savedWorkCases)("clears only read-owned $name failure after a successful background poll", async scenario => {
    vi.useFakeTimers(); let unavailable = true;
    network.mockImplementation(async path => savedWorkRead(path, unavailable));
    await act(async () => { scenario.mount(); for (let index = 0; index < 80; index++) await Promise.resolve(); });
    expect(screen.getByRole("alert")).toBeTruthy(); expect(screen.queryByText(scenario.empty)).toBeNull();
    unavailable = false; await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByRole("alert")).toBeNull(); expect(screen.getByText(scenario.empty)).toBeTruthy(); expect(mutations()).toHaveLength(0);
  });

  it.each(savedWorkCases)("does not erase an unconfirmed $name write failure during read failure or recovery", async scenario => {
    let unavailable = false;
    network.mockImplementation(async (path, options) => {
      const url = String(path);
      if (url === "/api/packages/plans") return json(exportPreview);
      if (url === "/api/system-recovery/backup-preview") return json(backupPreview);
      if (options?.method === "POST") return json({}, 503);
      return savedWorkRead(path, unavailable);
    });
    scenario.mount(); await screen.findByText(scenario.empty);
    if (scenario.name === "package") {
      fireEvent.change(screen.getByLabelText("Export format"), { target: { value: "report" } });
      fireEvent.change(screen.getByLabelText("Sample and Project roots"), { target: { value: "sample:sample:1" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
      const start = await screen.findByRole("button", { name: "Start report export" });
      expect(JSON.parse(String(network.mock.calls.find(([path]) => String(path) === "/api/packages/plans")![1]?.body))).toEqual({
        kind: "report", roots: [{ kind: "sample", id: "sample:1" }],
      });
      await waitFor(() => expect(start.matches(":disabled")).toBe(false)); fireEvent.click(start);
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Preview system backup" }));
      const start = await screen.findByRole("button", { name: "Start durable system backup" });
      await waitFor(() => expect(start.matches(":disabled")).toBe(false)); fireEvent.click(start);
    }
    await screen.findByRole("heading", { name: "Unconfirmed operation" });
    await waitFor(() => expect(screen.getAllByText(scenario.writeError)).toHaveLength(1));
    const original = sessionStorage.getItem(scenario.key);
    expect(original).not.toBeNull();
    const writeCount = mutations().length;
    unavailable = true; fireEvent.click(screen.getByRole("button", { name: scenario.refresh }));
    await screen.findByRole("button", { name: scenario.retry });
    expect(screen.queryByText(scenario.empty)).toBeNull();
    unavailable = false; fireEvent.click(screen.getByRole("button", { name: scenario.retry }));
    await screen.findByText(scenario.empty);
    expect(screen.queryByRole("button", { name: scenario.retry })).toBeNull();
    expect(screen.getAllByText(scenario.writeError)).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Unconfirmed operation" })).toBeTruthy();
    expect(sessionStorage.getItem(scenario.key)).toBe(original); expect(mutations()).toHaveLength(writeCount);
    expect(network.mock.calls.filter(([path, options]) => String(path) === `${scenario.base}/jobs` && options?.method === "POST")).toHaveLength(1);
  });

  it("announces archive preparation before any asset callback and keeps one zero-asset download", async () => {
    const pending = deferred<Awaited<ReturnType<typeof exportAll>>>();
    vi.mocked(exportAll).mockReturnValue(pending.promise);
    const createUrl = vi.fn(() => "blob:empty-archive"), revokeUrl = vi.fn();
    vi.stubGlobal("URL", class extends URL { static createObjectURL = createUrl; static revokeObjectURL = revokeUrl; });
    const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ExportPage />); fireEvent.click(screen.getByRole("button", { name: "Download full ZIP" }));
    expect(screen.getByRole("status").textContent).toBe("Building archive…");
    const building = screen.getByRole("button", { name: "Building archive…" });
    expect(building.matches(":disabled")).toBe(true); fireEvent.click(building);
    expect(vi.mocked(exportAll)).toHaveBeenCalledTimes(1); expect(screen.queryByRole("link", { name: "Download prepared ZIP" })).toBeNull();
    await act(async () => { pending.resolve({ archive: new Blob(["empty"], { type: "application/zip" }), filename: "empty.zip", results: [], warnings: [] }); });
    expect(screen.getByRole("status").textContent).toBe("Archive ready. Assets included: 0 / 0.");
    expect(screen.getByRole("link", { name: "Download prepared ZIP" }).getAttribute("download")).toBe("empty.zip");
    expect(download).toHaveBeenCalledTimes(1); expect(createUrl).toHaveBeenCalledTimes(1); expect(revokeUrl).not.toHaveBeenCalled();
  });
});
