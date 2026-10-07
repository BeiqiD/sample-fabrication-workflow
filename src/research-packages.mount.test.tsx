import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchExecutorStatus, ResearchExportPlanInput, ResearchJobStatus, ResearchPackagePreview,
  ResearchRequestReceipt, ResearchUploadInput } from "../shared/contracts/research-package-api";
import { RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES } from "../shared/contracts/research-package-api";
import { hashResearchFile } from "../shared/domain/research-sha256";
import { sourceFromBlob, validateStoreArchive } from "../shared/domain/research-archive";
import { ResearchPackagesPage } from "./pages/ResearchPackagesPage";

// These mounted tests qualify the browser workflow, while the SHA/ZIP suites
// separately qualify byte validation. The actual client and DTO guards run here.
vi.mock("../shared/domain/research-sha256", async importOriginal => ({
  ...await importOriginal<typeof import("../shared/domain/research-sha256")>(), hashResearchFile: vi.fn(),
}));
vi.mock("../shared/domain/research-archive", async importOriginal => ({
  ...await importOriginal<typeof import("../shared/domain/research-archive")>(), sourceFromBlob: vi.fn(), validateStoreArchive: vi.fn(),
}));

const base = "/api/packages", at = "2026-10-06T09:00:00.000Z", sha256 = "a".repeat(64);
const intentKey = "research-package-operation", uploadKey = "research-package-upload", receiptsKey = "research-package-receipts";
const network = vi.fn<typeof fetch>();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const job = (kind: ResearchJobStatus["kind"] = "data_package", state: ResearchJobStatus["state"] = "queued", id = "export:job"): ResearchJobStatus => ({
  id, requestId: "original:request", kind, state, phase: state === "completed" ? "done" : state === "preview" ? "preview" : "snapshot",
  acceptedAt: at, updatedAt: at, reason: null, progress: { completedFiles: 0, totalFiles: 1, bytesDone: 0, bytesTotal: 12 }, output: null, result: null,
});
const packagePreview = (): ResearchPackagePreview => ({ schema: "research-package-preview/1", kind: "data_package",
  roots: [{ kind: "sample", id: "sample:1" }], counts: { records: 14, files: 1, bytes: 12 }, archiveBytes: 2048, metadataBytes: 512,
  warnings: [], complete: true, capabilities: { dataPackage: { available: true, reasons: [] }, report: { available: true, reasons: [] } },
  dependencies: [], source: { installationId: "source:installation", packageId: "source:package", payloadSha256: sha256 },
  rolePolicyRevision: 3, naming: { suffix: " (imported)", conflicts: [{ kind: "sample", sourceId: "sample:1", sourceName: "S-1", destinationName: "S-1 (imported)" }] },
  targets: [{ purpose: "research_source", role: "originals", profileId: "s3:originals", configurationRevision: 3, available: true }], existingImportJobId: null,
});
let jobs: ResearchJobStatus[], executor: ResearchExecutorStatus, receipts: Map<string, ResearchRequestReceipt>;
let importPreview: ResearchPackagePreview;
function fallback(path: RequestInfo | URL, options?: RequestInit): Response {
  const url = new URL(String(path), "http://localhost"), method = options?.method || "GET";
  if (url.pathname === `${base}/jobs` && method === "GET") return json({ jobs });
  if (url.pathname === `${base}/executor` && method === "GET") return json(executor);
  if (url.pathname === `${base}/plans` && method === "POST") {
    const input: ResearchExportPlanInput = JSON.parse(String(options?.body));
    return json({ ...packagePreview(), kind: input.kind, roots: input.roots, source: null, naming: null, targets: [] });
  }
  if (url.pathname.startsWith(`${base}/requests/`) && method === "GET") {
    const receipt = receipts.get(decodeURIComponent(url.pathname.slice(`${base}/requests/`.length)));
    return receipt ? json(receipt) : json({ error: "PRIVATE_MISSING_RECEIPT" }, 404);
  }
  if (url.pathname === `${base}/jobs` && method === "POST") {
    const input = JSON.parse(String(options?.body)), accepted = { ...job(input.kind), requestId: input.requestId };
    jobs = [accepted, ...jobs.filter(value => value.id !== accepted.id)];
    const receipt = { requestId: input.requestId, job: accepted, reused: false }; receipts.set(input.requestId, receipt); return json(receipt, 202);
  }
  if (url.pathname === `${base}/uploads` && method === "POST") {
    const input: ResearchUploadInput = JSON.parse(String(options?.body));
    const accepted = { ...job("upload", "awaiting_upload", "upload:job"), requestId: input.requestId,
      progress: { completedFiles: 0, totalFiles: 1, bytesDone: 0, bytesTotal: input.byteSize } };
    jobs = [accepted, ...jobs.filter(value => value.id !== accepted.id)];
    const receipt = { requestId: input.requestId, job: accepted, reused: false }; receipts.set(input.requestId, receipt); return json(receipt, 202);
  }
  if (url.pathname === `${base}/jobs/upload%3Ajob/upload` && method === "PUT") {
    const uploaded = { ...jobs.find(value => value.id === "upload:job")!, state: "queued" as const, phase: "validate" as const };
    jobs = [uploaded, ...jobs.filter(value => value.id !== uploaded.id)]; return json(uploaded);
  }
  if (url.pathname === `${base}/jobs/upload%3Ajob/preview` && method === "GET") {
    const suffix = url.searchParams.get("suffix") ?? " (imported)";
    const value = structuredClone(importPreview);
    if (value.naming) { value.naming.suffix = suffix; value.naming.conflicts.forEach(conflict => { conflict.destinationName = `${conflict.sourceName}${suffix}`; }); }
    return json(value);
  }
  if (url.pathname === `${base}/jobs/upload%3Ajob/upload-intent` && method === "GET") {
    const upload = jobs.find(value => value.id === "upload:job")!;
    return json({ requestId: upload.requestId, byteSize: upload.progress.bytesTotal, sha256 });
  }
  if (url.pathname === `${base}/jobs/upload%3Ajob` && method === "GET") return json(jobs.find(value => value.id === "upload:job"));
  if (url.pathname === `${base}/imports` && method === "POST") {
    const input = JSON.parse(String(options?.body));
    const accepted = { ...job("import", "completed", "import:job"), requestId: input.requestId,
      result: { roots: [{ kind: "sample" as const, id: "destination:sample" }], reused: false } };
    jobs = [accepted, ...jobs.filter(value => value.id !== accepted.id)];
    const receipt = { requestId: input.requestId, job: accepted, reused: false }; receipts.set(input.requestId, receipt); return json(receipt, 202);
  }
  if (url.pathname.endsWith("/control") && method === "POST") {
    const id = decodeURIComponent(url.pathname.slice(`${base}/jobs/`.length, -"/control".length));
    const { action } = JSON.parse(String(options?.body)), value = jobs.find(item => item.id === id)!;
    const nextState: ResearchJobStatus["state"] = action === "pause" ? "paused" : action === "cancel" ? "cancelled" : action === "cleanup" ? value.state : "queued";
    const controlled = { ...value, state: nextState, reason: action === "pause" ? "operator_paused" : action === "cancel" ? "operator_cancelled" : null };
    jobs = [controlled, ...jobs.filter(item => item.id !== id)]; return json(controlled);
  }
  return json({ error: "PRIVATE_UNKNOWN_ROUTE" }, 404);
}
const callsTo = (path: string, method?: string) => network.mock.calls.filter(([url, options]) => String(url) === `${base}${path}` && (!method || options?.method === method));
const savedMutations = () => network.mock.calls.filter(([path, options]) => ["POST", "PUT"].includes(options?.method || "") && String(path) !== `${base}/plans`);
const enabled = async (name: string) => { const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button.matches(":disabled")).toBe(false)); return button; };
async function mount(query = "") {
  const mounted = render(<MemoryRouter initialEntries={[`/settings/data${query}`]}><ResearchPackagesPage /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText("Reading saved package work…")).toBeNull()); return mounted;
}
async function previewExport() {
  fireEvent.click(await enabled("Preview export"));
  return enabled(/report/.test((screen.getByLabelText("Export format") as HTMLSelectElement).value) ? "Start report export" : "Start data package export");
}
function rememberUpload(state: ResearchJobStatus["state"] = "preview") {
  const input = { requestId: "upload:request", byteSize: 12, sha256 };
  sessionStorage.setItem(uploadKey, JSON.stringify({ input, jobId: "upload:job" }));
  jobs = [{ ...job("upload", state, "upload:job"), requestId: input.requestId }]; return input;
}
beforeEach(() => {
  sessionStorage.clear(); jobs = []; receipts = new Map(); importPreview = packagePreview();
  executor = { supported: true, enabled: true, stale: false, canManage: false, lastHeartbeatAt: at, cadenceSeconds: 120, maxStepMs: 60000, reason: null };
  vi.mocked(hashResearchFile).mockReset(); vi.mocked(hashResearchFile).mockImplementation(async file => ({ byteSize: file.size, sha256 }));
  vi.mocked(sourceFromBlob).mockReset(); vi.mocked(sourceFromBlob).mockImplementation(file => ({ byteSize: file.size, read: vi.fn() }));
  vi.mocked(validateStoreArchive).mockReset(); vi.mocked(validateStoreArchive).mockResolvedValue({ byteSize: 12, sha256, entries: [], metadata: new Map() });
  network.mockReset(); network.mockImplementation(async (path, options) => fallback(path, options)); vi.stubGlobal("fetch", network);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe("native research package browser workflow", () => {
  it.each(["data_package", "report"] as const)("prefills a selected Sample and previews %s before explicit acceptance", async kind => {
    await mount(`?rootType=sample&rootId=sample%3A1&kind=${kind}`);
    expect((screen.getByLabelText("Sample and Project roots") as HTMLTextAreaElement).value).toBe("sample:sample:1");
    expect((screen.getByLabelText("Export format") as HTMLSelectElement).value).toBe(kind);
    const start = await previewExport();
    expect(JSON.parse(String(callsTo("/plans", "POST")[0][1]?.body))).toEqual({ kind, roots: [{ kind: "sample", id: "sample:1" }] });
    expect(savedMutations()).toHaveLength(0); fireEvent.click(start);
    await screen.findByText(/Operation saved/); expect(callsTo("/jobs", "POST")).toHaveLength(1);
    expect(JSON.parse(String(callsTo("/jobs", "POST")[0][1]?.body))).toEqual({ requestId: expect.any(String), kind, roots: [{ kind: "sample", id: "sample:1" }] });
    expect(sessionStorage.getItem(intentKey)).toBeNull(); expect(screen.queryByRole("link", { name: /Download/ })).toBeNull();
  });

  it("shows the server's human research context and omitted provenance as escaped text without starting work", async () => {
    const markup = '<img src=x onerror="alert(1)">Anneal <script>unsafe</script>';
    const dependencies: ResearchPackagePreview["dependencies"] = [
      { targetType: "sample", id: "context:sample:1", outcome: "included", reason: null, label: "Sample S-17" },
      { targetType: "run", id: "context:run:1", outcome: "included", reason: null, label: "Run 3 — annealing" },
      { targetType: "step", id: "context:step:1", outcome: "included", reason: null, label: markup },
      { targetType: "sample", id: "context:excluded:1", outcome: "excluded", reason: "outside_selected_scope", label: "Sample outside the selection" },
      { targetType: "run", id: "context:tombstoned:1", outcome: "tombstoned", reason: "source_deleted", label: "Retired Run 2" },
    ];
    network.mockImplementation(async (path, options) => {
      const response = fallback(path, options);
      return String(path) === `${base}/plans` ? json({ ...await response.json(), dependencies }) : response;
    });
    await mount("?rootType=sample&rootId=sample%3A1"); await previewExport();
    expect(screen.getByRole("heading", { name: "Included research context" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Excluded or unresolved dependencies" })).toBeTruthy();
    for (const dependency of dependencies) {
      expect(screen.getByText(dependency.label!)).toBeTruthy();
      expect(screen.getByText(dependency.id)).toBeTruthy();
    }
    expect(screen.getByText(/context:excluded:1/).closest("li")?.textContent).toContain("excluded");
    expect(screen.getByText(/context:tombstoned:1/).closest("li")?.textContent).toContain("tombstoned");
    expect(document.querySelector(".research-package-preview img, .research-package-preview script")).toBeNull();
    expect(callsTo("/plans", "POST")).toHaveLength(1);
    expect(savedMutations()).toHaveLength(0); expect(callsTo("/jobs", "POST")).toHaveLength(0);
    expect(sessionStorage.getItem(intentKey)).toBeNull();
  });

  it("allows queued acceptance while execution is paused, without offering administrator controls to a normal user", async () => {
    executor.enabled = false; executor.stale = true; executor.lastHeartbeatAt = null; executor.reason = "executor_disabled";
    await mount("?rootType=project&rootId=project%3A1");
    expect(screen.getByText("Execution is paused.")).toBeTruthy();
    expect(screen.getByText(/Refreshing or polling this page does not execute it/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Administrator executor controls" })).toBeNull();
    fireEvent.click(await previewExport()); await screen.findByText(/Operation saved/);
    expect(savedMutations().map(([path]) => path)).toEqual([`${base}/jobs`]);
    expect(screen.getByText("queued")).toBeTruthy();
    expect(network.mock.calls.filter(([path, options]) => String(path).includes("executor") && options?.method !== "GET")).toHaveLength(0);
  });

  it("disables unsupported runtime actions while still exposing saved metadata", async () => {
    executor.supported = false; executor.enabled = false; executor.reason = "unsupported_runtime";
    await mount("?rootType=sample&rootId=sample%3A1");
    expect(screen.getByText("Package jobs are unavailable on this runtime.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview export" }).matches(":disabled")).toBe(true);
    expect((screen.getByLabelText("Native package ZIP") as HTMLInputElement).disabled).toBe(true);
    expect(savedMutations()).toHaveLength(0);
  });

  it("uploads the selected File, waits for a server preview and requires explicit research-copy publication", async () => {
    await mount(); const file = new File(["archive data"], "研究.zip", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText("Native package ZIP"), { target: { files: [file] } });
    fireEvent.click(await enabled("Upload and validate package"));
    await screen.findByText("Package uploaded. Validation is saved independently of this page.");
    expect(hashResearchFile).toHaveBeenCalledWith(file, expect.objectContaining({ maxBytes: RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES, signal: expect.any(AbortSignal) }));
    expect(sourceFromBlob).toHaveBeenCalledWith(file);
    expect(validateStoreArchive).toHaveBeenCalledWith(expect.objectContaining({ byteSize: file.size }), expect.objectContaining({ expectedSha256: sha256 }));
    const put = callsTo("/jobs/upload%3Ajob/upload", "PUT")[0]; expect(put[1]?.body).toBe(file);
    expect(savedMutations().map(([path]) => path)).toEqual([`${base}/uploads`, `${base}/jobs/upload%3Ajob/upload`]);
    expect(screen.queryByRole("button", { name: "Import research copy" })).toBeNull();
    jobs = jobs.map(value => value.id === "upload:job" ? { ...value, state: "preview" as const, phase: "preview" as const } : value);
    fireEvent.click(await enabled("Check uploaded package"));
    const accept = await enabled("Import research copy"); expect(callsTo("/imports", "POST")).toHaveLength(0);
    expect(screen.getByText(/Source identity is preserved as provenance/)).toBeTruthy();
    expect(screen.getByText("s3:originals")).toBeTruthy(); fireEvent.click(accept);
    await screen.findByRole("link", { name: "Open imported sample" });
    expect(JSON.parse(String(callsTo("/imports", "POST")[0][1]?.body))).toEqual({ requestId: expect.any(String), uploadJobId: "upload:job", anotherCopy: false, expectedRolePolicyRevision: 3, naming: { suffix: " (imported)" } });
    expect(sessionStorage.getItem(intentKey)).toBeNull();
  });

  it("retains a lost acceptance across reload, checks it with GET only and retries only the exact original intent", async () => {
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}/jobs` && options?.method === "POST" && callsTo("/jobs", "POST").length === 1) {
        expect(JSON.parse(sessionStorage.getItem(intentKey)!).input).toEqual(JSON.parse(String(options.body)));
        throw new Error("PRIVATE_PROVIDER_CREDENTIAL");
      }
      return fallback(path, options);
    });
    const first = await mount("?rootType=sample&rootId=sample%3A1"); fireEvent.click(await previewExport());
    await screen.findByRole("button", { name: "Check or retry original request" });
    await screen.findByText(/Check the original request before retrying/);
    const original = JSON.parse(String(callsTo("/jobs", "POST")[0][1]?.body)); first.unmount();
    await mount("?rootType=project&rootId=changed-selection");
    await screen.findByText(/No receipt is recorded yet/);
    expect(callsTo("/jobs", "POST")).toHaveLength(1);
    expect(callsTo(`/requests/${encodeURIComponent(original.requestId)}`, "GET")).toHaveLength(1);
    expect(screen.getByLabelText("Sample and Project roots").matches(":disabled")).toBe(true);
    expect(document.body.textContent).not.toContain("PRIVATE");
    fireEvent.click(await enabled("Check or retry original request"));
    await waitFor(() => expect(sessionStorage.getItem(intentKey)).toBeNull());
    expect(callsTo("/jobs", "POST")).toHaveLength(2);
    expect(JSON.parse(String(callsTo("/jobs", "POST")[1][1]?.body))).toEqual(original);
    expect(callsTo(`/requests/${encodeURIComponent(original.requestId)}`, "GET")).toHaveLength(2);
  });

  it("recovers an acknowledged original request by receipt on reload without replaying its acceptance", async () => {
    const original = { requestId: "lost:ack", kind: "report", roots: [{ kind: "sample", id: "sample:1" }] };
    sessionStorage.setItem(intentKey, JSON.stringify({ action: "export", input: original }));
    const accepted = { ...job("report", "queued"), requestId: original.requestId };
    jobs = [accepted]; receipts.set(original.requestId, { requestId: original.requestId, job: accepted, reused: false });
    await mount(); await waitFor(() => expect(sessionStorage.getItem(intentKey)).toBeNull());
    expect(callsTo("/requests/lost%3Aack", "GET")).toHaveLength(1); expect(savedMutations()).toHaveLength(0);
    expect(screen.getByText("Offline report export")).toBeTruthy();
  });

  it("refuses different reselected bytes before PUT or new acceptance of an awaiting upload", async () => {
    rememberUpload("awaiting_upload"); vi.mocked(hashResearchFile).mockResolvedValue({ byteSize: 12, sha256: "b".repeat(64) });
    await mount(); expect(screen.getByText(/reselect the original/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Native package ZIP"), { target: { files: [new File(["archive data"], "different.zip")] } });
    fireEvent.click(await enabled("Resume original upload"));
    await screen.findByText(/This file differs from the accepted upload/);
    expect(savedMutations()).toHaveLength(0); expect(JSON.parse(sessionStorage.getItem(uploadKey)!).input.sha256).toBe(sha256);
  });

  it("recovers an awaiting upload in a fresh session with metadata GETs and resumes only a manually reselected matching File", async () => {
    jobs = [{ ...job("upload", "awaiting_upload", "upload:job"), requestId: "prior:upload:request" }];
    await mount(); expect(sessionStorage.getItem(uploadKey)).toBeNull();
    fireEvent.click(await enabled("Continue this upload"));
    await screen.findByText("Saved upload selected. Reselect the original ZIP to verify and continue it.");
    expect(callsTo("/jobs/upload%3Ajob/upload-intent", "GET")).toHaveLength(1);
    expect(callsTo("/jobs/upload%3Ajob", "GET")).toHaveLength(1); expect(savedMutations()).toHaveLength(0);
    expect(JSON.parse(sessionStorage.getItem(uploadKey)!)).toEqual({ jobId: "upload:job", input: { requestId: "prior:upload:request", byteSize: 12, sha256 } });
    const file = new File(["archive data"], "original.zip", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText("Native package ZIP"), { target: { files: [file] } });
    fireEvent.click(await enabled("Resume original upload"));
    await screen.findByText("Package uploaded. Validation is saved independently of this page.");
    expect(savedMutations().map(([path]) => path)).toEqual([`${base}/jobs/upload%3Ajob/upload`]);
    expect(callsTo("/jobs/upload%3Ajob/upload", "PUT")[0][1]?.body).toBe(file); expect(callsTo("/uploads", "POST")).toHaveLength(0);
    fireEvent.click(await enabled("Select another package"));
    expect(sessionStorage.getItem(uploadKey)).toBeNull(); expect(screen.getByRole("button", { name: "Review uploaded package" })).toBeTruthy();
    expect(savedMutations()).toHaveLength(1);
  });

  it("keeps the name input available after editing, invalidates the stale summary and imports only the refreshed suffix", async () => {
    rememberUpload(); await mount(); await enabled("Import research copy");
    fireEvent.change(screen.getByLabelText("Imported name suffix"), { target: { value: "（新副本）" } });
    expect((screen.getByLabelText("Imported name suffix") as HTMLInputElement).value).toBe("（新副本）");
    expect(screen.queryByRole("button", { name: "Import research copy" })).toBeNull();
    expect(callsTo("/imports", "POST")).toHaveLength(0);
    fireEvent.click(await enabled("Refresh import preview"));
    const accept = await enabled("Import research copy"); expect(screen.getByText("S-1（新副本）")).toBeTruthy();
    expect(network.mock.calls.some(([path, options]) => String(path) === `${base}/jobs/upload%3Ajob/preview?suffix=${encodeURIComponent("（新副本）")}` && options?.method === "GET")).toBe(true);
    fireEvent.click(accept); await screen.findByRole("link", { name: "Open imported sample" });
    expect(JSON.parse(String(callsTo("/imports", "POST")[0][1]?.body)).naming).toEqual({ suffix: "（新副本）" });
  });

  it("discards a late polling preview after the user selects another package", async () => {
    rememberUpload(); let resolvePreview!: (response: Response) => void, previewStarted = false;
    const response = new Promise<Response>(resolve => { resolvePreview = resolve; });
    network.mockImplementation(async (path, options) => {
      if (String(path).startsWith(`${base}/jobs/upload%3Ajob/preview?`) && options?.method === "GET") {
        previewStarted = true; return response;
      }
      return fallback(path, options);
    });
    // The initial metadata poll exposes the saved upload while its preview GET
    // is still pending; selecting another package is an enabled local action.
    await mount(); await waitFor(() => expect(previewStarted).toBe(true));
    fireEvent.click(await enabled("Select another package"));
    expect(sessionStorage.getItem(uploadKey)).toBeNull(); expect(screen.queryByRole("button", { name: "Import research copy" })).toBeNull();
    const stale = packagePreview(); stale.source!.packageId = "late:discarded:package";
    await act(async () => { resolvePreview(json(stale)); await response; for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(screen.queryByRole("button", { name: "Import research copy" })).toBeNull();
    expect(screen.queryByLabelText("Imported name suffix")).toBeNull(); expect(document.body.textContent).not.toContain("late:discarded:package");
    expect((screen.getByLabelText("Native package ZIP") as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Review uploaded package" })).toBeTruthy();
    expect(sessionStorage.getItem(uploadKey)).toBeNull(); expect(savedMutations()).toHaveLength(0);
  });

  it("blocks an incomplete native import and renders untrusted naming labels as plain text", async () => {
    rememberUpload(); importPreview.complete = false; importPreview.warnings = ["mandatory_payload_missing"];
    importPreview.capabilities.dataPackage = { available: false, reasons: ["mandatory_payload_missing"] };
    importPreview.dependencies = [{ targetType: "file", id: "missing:1", outcome: "unavailable", reason: "source_unavailable" }];
    importPreview.naming!.conflicts[0].sourceName = '<img src=x onerror="alert(1)">';
    await mount(); const importButton = await screen.findByRole("button", { name: "Import research copy" });
    expect((importButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Import is blocked/)).toBeTruthy(); expect(screen.getByText("missing:1")).toBeTruthy();
    expect(document.body.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(document.querySelector(".research-package-preview img")).toBeNull(); expect(savedMutations()).toHaveLength(0);
  });

  it("blocks a fresh copy when a complete preview has no admitted destination policy revision", async () => {
    rememberUpload(); importPreview.rolePolicyRevision = null;
    await mount(); const importButton = await screen.findByRole("button", { name: "Import research copy" });
    expect((importButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(importButton); expect(callsTo("/imports", "POST")).toHaveLength(0); expect(sessionStorage.getItem(intentKey)).toBeNull();
  });

  it("retries a lost import ACK with its original policy revision after newer defaults appear in a preview", async () => {
    rememberUpload();
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}/imports` && options?.method === "POST") {
        if (callsTo("/imports", "POST").length === 1) throw new Error("PRIVATE_PROVIDER_DETAIL");
        return json({ error: "PRIVATE_STALE_POLICY" }, 409);
      }
      return fallback(path, options);
    });
    const first = await mount(); fireEvent.click(await enabled("Import research copy"));
    await screen.findByText(/Check the original request before retrying/);
    const original = JSON.parse(String(callsTo("/imports", "POST")[0][1]?.body));
    expect(original.expectedRolePolicyRevision).toBe(3); first.unmount(); importPreview.rolePolicyRevision = 4;
    await mount(); await screen.findByText(/No receipt is recorded yet/);
    await waitFor(() => expect(network.mock.calls.filter(([path]) => String(path).includes("/preview?")).length).toBe(2));
    expect(callsTo("/imports", "POST")).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem(intentKey)!).input).toEqual(original);
    fireEvent.click(await enabled("Check or retry original request"));
    await screen.findByText("The preview or destination policy changed. Refresh the preview before accepting new work.");
    await waitFor(() => expect(sessionStorage.getItem(intentKey)).toBeNull());
    expect(callsTo("/imports", "POST")).toHaveLength(2);
    expect(JSON.parse(String(callsTo("/imports", "POST")[1][1]?.body))).toEqual(original);
    expect(importPreview.rolePolicyRevision).toBe(4);
  });

  it("checks the receipt after a definitive import conflict and requires a fresh preview and request before accepting changed destinations", async () => {
    rememberUpload();
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}/imports` && options?.method === "POST" && callsTo("/imports", "POST").length === 1) {
        importPreview.rolePolicyRevision = 4; return json({ error: "PRIVATE_STALE_POLICY" }, 409);
      }
      return fallback(path, options);
    });
    await mount(); fireEvent.click(await enabled("Import research copy"));
    await screen.findByText("The preview or destination policy changed. Refresh the preview before accepting new work.");
    const original = JSON.parse(String(callsTo("/imports", "POST")[0][1]?.body));
    expect(callsTo(`/requests/${encodeURIComponent(original.requestId)}`, "GET")).toHaveLength(1);
    expect(sessionStorage.getItem(intentKey)).toBeNull(); expect(screen.queryByRole("button", { name: "Import research copy" })).toBeNull();
    expect(callsTo("/imports", "POST")).toHaveLength(1); expect(document.body.textContent).not.toContain("PRIVATE_STALE_POLICY");
    fireEvent.click(await enabled("Refresh import preview")); fireEvent.click(await enabled("Import research copy"));
    await screen.findByText("Research copy published.");
    const replacement = JSON.parse(String(callsTo("/imports", "POST")[1][1]?.body));
    expect(replacement.expectedRolePolicyRevision).toBe(4); expect(original.expectedRolePolicyRevision).toBe(3);
    expect(replacement.requestId).not.toBe(original.requestId); expect(replacement.uploadJobId).toBe(original.uploadJobId);
  });

  it("shows a fixed helpful immutable-media conflict from a preview GET without accepting an import", async () => {
    rememberUpload();
    network.mockImplementation(async (path, options) => String(path).includes("/preview?")
      ? json({ error: "Package copy preflight is unsupported or conflicts with existing immutable content.", reason: "definition_media_destination_conflict" }, 409)
      : fallback(path, options));
    await mount(); await screen.findByText("An existing immutable definition uses files in another destination. Keep its original file destination or choose another scope.");
    expect(screen.queryByRole("button", { name: "Import research copy" })).toBeNull();
    expect(callsTo("/imports", "POST")).toHaveLength(0); expect(savedMutations()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("PRIVATE"); expect(sessionStorage.getItem(intentKey)).toBeNull();
  });

  it("shows the safe preflight reason after a rejected import's receipt is absent instead of labeling it a stale policy", async () => {
    rememberUpload();
    network.mockImplementation(async (path, options) => String(path) === `${base}/imports` && options?.method === "POST"
      ? json({ error: "Package copy preflight is unsupported or conflicts with existing immutable content.", reason: "destination_name_conflict" }, 409)
      : fallback(path, options));
    await mount(); fireEvent.click(await enabled("Import research copy"));
    await screen.findByText("A destination name cannot be assigned safely. Choose another suffix and refresh the preview.");
    const input = JSON.parse(String(callsTo("/imports", "POST")[0][1]?.body));
    expect(callsTo(`/requests/${encodeURIComponent(input.requestId)}`, "GET")).toHaveLength(1);
    expect(sessionStorage.getItem(intentKey)).toBeNull(); expect(screen.queryByRole("button", { name: "Import research copy" })).toBeNull();
    expect(document.body.textContent).not.toContain("The preview or destination policy changed");
    expect(document.body.textContent).not.toContain("PRIVATE"); expect(callsTo("/imports", "POST")).toHaveLength(1);
  });

  it("retains an uncertain conflict and confirms an existing receipt without changing its original intent or accepting again", async () => {
    rememberUpload(); let receiptReads = 0;
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}/imports` && options?.method === "POST") {
        const input = JSON.parse(String(options.body));
        const reused = { ...job("import", "completed", "existing:import"), requestId: "older:accepted:request",
          result: { roots: [{ kind: "sample" as const, id: "existing:sample" }], reused: true } };
        receipts.set(input.requestId, { requestId: input.requestId, job: reused, reused: true }); importPreview.rolePolicyRevision = 4;
        return json({ error: "PRIVATE_CONFLICT_DETAIL" }, 409);
      }
      if (String(path).includes("/requests/") && ++receiptReads === 1) throw new Error("PRIVATE_RECEIPT_UNAVAILABLE");
      return fallback(path, options);
    });
    await mount(); fireEvent.click(await enabled("Import research copy"));
    await enabled("Check or retry original request");
    const original = JSON.parse(String(callsTo("/imports", "POST")[0][1]?.body));
    await waitFor(() => expect(receiptReads).toBe(1));
    expect(JSON.parse(sessionStorage.getItem(intentKey)!).input).toEqual(original); expect(original.expectedRolePolicyRevision).toBe(3);
    expect(document.body.textContent).not.toContain("PRIVATE");
    fireEvent.click(await enabled("Check or retry original request"));
    await screen.findByText("The existing completed import is available.");
    expect(sessionStorage.getItem(intentKey)).toBeNull(); expect(callsTo("/imports", "POST")).toHaveLength(1);
    expect(callsTo(`/requests/${encodeURIComponent(original.requestId)}`, "GET")).toHaveLength(2);
    expect(JSON.parse(sessionStorage.getItem(receiptsKey)!)).toContainEqual({ requestId: original.requestId, jobId: "existing:import", reused: true });
  });

  it("blocks a partial native export while allowing an explicitly previewed available report", async () => {
    network.mockImplementation(async (path, options) => {
      const response = fallback(path, options);
      if (String(path) !== `${base}/plans`) return response;
      const value = await response.json(); value.complete = false; value.capabilities.dataPackage = { available: false, reasons: ["unresolved_reference"] };
      value.dependencies = [{ targetType: "sample", id: "missing:sample", outcome: "not_found", reason: "unresolved_reference" }]; return json(value);
    });
    await mount("?rootType=sample&rootId=sample%3A1"); fireEvent.click(await enabled("Preview export"));
    const native = await screen.findByRole("button", { name: "Start data package export" });
    expect((native as HTMLButtonElement).disabled).toBe(true); expect(savedMutations()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Export format"), { target: { value: "report" } });
    expect(screen.queryByRole("button", { name: "Start report export" })).toBeNull();
    fireEvent.click(await previewExport()); await screen.findByText(/Operation saved/);
    expect(JSON.parse(String(callsTo("/jobs", "POST")[0][1]?.body)).kind).toBe("report");
  });

  it("aliases a new ordinary receipt to an existing import and creates another copy only through its explicit action", async () => {
    rememberUpload(); importPreview.existingImportJobId = "existing:import"; importPreview.rolePolicyRevision = 4;
    const existing = { ...job("import", "completed", "existing:import"), requestId: "old:import:request",
      result: { roots: [{ kind: "sample" as const, id: "existing:sample" }], reused: false } };
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}/imports` && options?.method === "POST" && !JSON.parse(String(options.body)).anotherCopy) {
        const input = JSON.parse(String(options.body)), receipt = { requestId: input.requestId, job: existing, reused: true };
        receipts.set(input.requestId, receipt); jobs = [existing, ...jobs]; return json(receipt, 202);
      }
      return fallback(path, options);
    });
    await mount(); fireEvent.click(await enabled("Open existing import"));
    await screen.findByText("The existing completed import is available.");
    const ordinary = JSON.parse(String(callsTo("/imports", "POST")[0][1]?.body));
    expect(ordinary.anotherCopy).toBe(false); expect(ordinary.requestId).not.toBe(existing.requestId); expect(ordinary.expectedRolePolicyRevision).toBe(4);
    expect(JSON.parse(sessionStorage.getItem(receiptsKey)!)).toContainEqual({ requestId: ordinary.requestId, jobId: existing.id, reused: true });
    expect(sessionStorage.getItem(intentKey)).toBeNull();
    fireEvent.click(await enabled("Import another copy")); await screen.findByText("Research copy published.");
    const copy = JSON.parse(String(callsTo("/imports", "POST")[1][1]?.body));
    expect(copy.anotherCopy).toBe(true); expect(copy.requestId).not.toBe(ordinary.requestId); expect(copy.uploadJobId).toBe(ordinary.uploadJobId);
    expect(copy.expectedRolePolicyRevision).toBe(4);
  });

  it("keeps ordinary-copy receipt reuse visible after reload without changing the historical job result or creating another copy", async () => {
    rememberUpload(); importPreview.existingImportJobId = "existing:import";
    const existing = { ...job("import", "completed", "existing:import"), requestId: "old:import:request",
      result: { roots: [{ kind: "sample" as const, id: "existing:sample" }], reused: false } };
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}/imports` && options?.method === "POST") {
        const input = JSON.parse(String(options.body)), receipt = { requestId: input.requestId, job: existing, reused: true };
        receipts.set(input.requestId, receipt); jobs = [existing, ...jobs]; return json(receipt, 202);
      }
      return fallback(path, options);
    });
    const first = await mount(); fireEvent.click(await enabled("Open existing import"));
    await screen.findByText("An existing saved import was returned. This request did not create another research copy.");
    const original = JSON.parse(String(callsTo("/imports", "POST")[0][1]?.body));
    expect(JSON.parse(sessionStorage.getItem(receiptsKey)!)).toContainEqual({ requestId: original.requestId, jobId: existing.id, reused: true });
    expect(existing.result.reused).toBe(false); fireEvent.click(await enabled("Select another package")); first.unmount();
    await mount(); await screen.findByText("The existing completed import is available.");
    expect(screen.getByRole("link", { name: "Open imported sample" }).getAttribute("href")).toBe("/samples/existing%3Asample");
    expect(callsTo("/imports", "POST")).toHaveLength(1); expect(existing.result.reused).toBe(false);
    expect(JSON.parse(sessionStorage.getItem(receiptsKey)!)).toContainEqual({ requestId: original.requestId, jobId: existing.id, reused: true });
  });

  it("recovers an older aliased import absent from the latest job list using GET only", async () => {
    sessionStorage.setItem(receiptsKey, JSON.stringify([{ requestId: "alias:req", jobId: "old:import", reused: true }]));
    const older = { ...job("import", "completed", "old:import"), requestId: "original:older:request",
      result: { roots: [{ kind: "sample" as const, id: "older:root" }], reused: false } };
    jobs = [job("report", "queued", "latest:report")];
    network.mockImplementation(async (path, options) => String(path) === `${base}/jobs/old%3Aimport` && options?.method === "GET"
      ? json(older) : fallback(path, options));
    await mount(); await screen.findByText("The existing completed import is available.");
    expect(screen.getByRole("link", { name: "Open imported sample" }).getAttribute("href")).toBe("/samples/older%3Aroot");
    expect(screen.getByText("old:import")).toBeTruthy(); expect(screen.getByText("latest:report")).toBeTruthy();
    expect(callsTo("/jobs/old%3Aimport", "GET")).toHaveLength(1); expect(savedMutations()).toHaveLength(0);
    expect(network.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true); expect(older.result.reused).toBe(false);
  });

  it("reads an import's frozen accepted naming and destinations with GET only", async () => {
    const accepted = packagePreview(); accepted.rolePolicyRevision = 3;
    accepted.naming = { suffix: " (frozen)", conflicts: [{ kind: "sample", sourceId: "sample:1", sourceName: "S-1", destinationName: "S-1 (frozen)" }] };
    accepted.targets[0].profileId = "frozen:originals"; accepted.targets[0].configurationRevision = 1;
    jobs = [job("import", "completed", "import:job")]; importPreview.rolePolicyRevision = 4;
    network.mockImplementation(async (path, options) => String(path) === `${base}/jobs/import%3Ajob/preview` && options?.method === "GET"
      ? json(accepted) : fallback(path, options));
    await mount(); fireEvent.click(await enabled("View accepted scope"));
    await screen.findByRole("heading", { name: "Accepted import scope" });
    expect(screen.getByRole("heading", { name: "Accepted copy naming" })).toBeTruthy();
    expect(screen.getByText("Accepted destination policy revision: 3.")).toBeTruthy();
    expect(screen.getByText("S-1 (frozen)")).toBeTruthy(); expect(screen.getByText("frozen:originals")).toBeTruthy();
    expect(screen.queryByLabelText("Imported name suffix")).toBeNull();
    expect(callsTo("/jobs/import%3Ajob/preview", "GET")).toHaveLength(1); expect(savedMutations()).toHaveLength(0);
    fireEvent.click(await enabled("Close accepted scope"));
    expect(screen.queryByRole("heading", { name: "Accepted import scope" })).toBeNull(); expect(savedMutations()).toHaveLength(0);
  });

  it("polls metadata, exposes independent controls and download availability, and aborts reads on unmount", async () => {
    vi.useFakeTimers(); jobs = [{ ...job("report", "paused"), reason: "operator_paused" }]; executor.stale = true;
    let mounted!: ReturnType<typeof render>;
    await act(async () => { mounted = render(<MemoryRouter><ResearchPackagesPage /></MemoryRouter>); for (let i = 0; i < 30; i++) await Promise.resolve(); });
    expect(screen.getByText("Execution is enabled, but no recent heartbeat was recorded.")).toBeTruthy(); expect(savedMutations()).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resume" })); for (let i = 0; i < 30; i++) await Promise.resolve(); });
    expect(savedMutations().map(([path]) => path)).toEqual([`${base}/jobs/export%3Ajob/control`]);
    expect(JSON.parse(String(savedMutations()[0][1]?.body))).toEqual({ action: "resume" });
    jobs = [{ ...jobs[0], state: "completed", phase: "done", output: { available: true, byteSize: 2048, sha256, expiresAt: at } }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByRole("link", { name: "Download offline report" }).getAttribute("href")).toBe(`${base}/jobs/export%3Ajob/download`);
    expect(savedMutations()).toHaveLength(1); expect(network.mock.calls.some(([path]) => String(path).endsWith("/download"))).toBe(false);
    jobs[0].output!.available = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByRole("link", { name: "Download offline report" })).toBeNull();
    const count = network.mock.calls.length, signals = network.mock.calls.map(([, options]) => options?.signal).filter(Boolean);
    mounted.unmount(); expect(signals.every(signal => signal!.aborted)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); expect(network).toHaveBeenCalledTimes(count);
  });

  it("hides mutation surfaces after access revocation without reading or displaying the private error body", async () => {
    jobs = [job("data_package", "running")]; const errorBody = vi.fn(async () => ({ credentials: "PRIVATE_PROVIDER_DETAIL" }));
    network.mockImplementation(async (path, options) => {
      if (String(path).endsWith("/control")) { const response = json({ credentials: "PRIVATE_PROVIDER_DETAIL" }, 403); vi.spyOn(response, "json").mockImplementation(errorBody); return response; }
      return fallback(path, options);
    });
    await mount(); fireEvent.click(await enabled("Pause"));
    await screen.findByRole("alert"); expect(screen.queryByLabelText("Native package ZIP")).toBeNull();
    expect(screen.queryByLabelText("Sample and Project roots")).toBeNull(); expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(document.body.textContent).not.toContain("PRIVATE_PROVIDER_DETAIL"); expect(errorBody).not.toHaveBeenCalled();
    expect(savedMutations()).toHaveLength(1); expect(screen.getByText(/Sign in with an account allowed/)).toBeTruthy();
  });
});
