import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchExecutorStatus, ResearchExportInput, ResearchExportPlanInput, ResearchImportInput, ResearchJobStatus,
  ResearchPackagePreview, ResearchRequestReceipt, ResearchUploadInput } from "../shared/contracts/research-package-api";
import { ResearchPackagesPage } from "./pages/ResearchPackagesPage";

type Intent = { action: "export"; input: ResearchExportInput } | { action: "upload"; input: ResearchUploadInput } | { action: "import"; input: ResearchImportInput };
const base = "/api/packages", intentKey = "research-package-operation", rejectionKey = "research-package-operation-rejection";
const historyKey = "research-package-earlier-requests", receiptsKey = "research-package-receipts";
const at = "2026-10-15T00:00:00.000Z", requestId = "22222222-2222-4222-8222-222222222222";
const original: Intent = { action: "export", input: { requestId, kind: "report", roots: [{ kind: "sample", id: "sample:1" }] } };
const marker = (intent: Intent = original) => ({ schema: "research-package-rejection/1", intent });
const network = vi.fn<typeof fetch>();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const missing = (id = requestId) => json({ schema: "research-package-request-absent/1", requestId: id }, 404);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const job = (kind: ResearchJobStatus["kind"] = "report", id = "package:original"): ResearchJobStatus => ({ id, requestId, kind,
  state: "queued", phase: "snapshot", acceptedAt: at, updatedAt: at, reason: null,
  progress: { completedFiles: 0, totalFiles: 1, bytesDone: 0, bytesTotal: 12 }, output: null, result: null });
const receipt = (): ResearchRequestReceipt => ({ requestId, job: job(), reused: false });
const preview = (input: ResearchExportPlanInput): ResearchPackagePreview => ({ schema: "research-package-preview/1", kind: input.kind,
  roots: input.roots, counts: { records: 1, files: 1, bytes: 12 }, archiveBytes: 2048, metadataBytes: 512, warnings: [], complete: true,
  capabilities: { dataPackage: { available: true, reasons: [] }, report: { available: true, reasons: [] } },
  dependencies: [], source: null, rolePolicyRevision: null, naming: null, targets: [], existingImportJobId: null });
const executor: ResearchExecutorStatus = { supported: true, enabled: true, stale: false, canManage: false,
  lastHeartbeatAt: at, cadenceSeconds: 120, maxStepMs: 60000, reason: null };
let jobs: ResearchJobStatus[];
function fallback(path: RequestInfo | URL, options?: RequestInit): Response {
  const url = new URL(String(path), "http://localhost"), method = options?.method || "GET";
  if (url.pathname === `${base}/jobs` && method === "GET") return json({ jobs });
  if (url.pathname === `${base}/executor` && method === "GET") return json(executor);
  if (url.pathname === `${base}/plans` && method === "POST") return json(preview(JSON.parse(String(options?.body))));
  if (url.pathname.startsWith(`${base}/requests/`) && method === "GET") return missing(decodeURIComponent(url.pathname.slice(`${base}/requests/`.length)));
  if (url.pathname.startsWith(`${base}/jobs/`) && method === "GET") {
    const found = jobs.find(row => row.id === decodeURIComponent(url.pathname.slice(`${base}/jobs/`.length)));
    return found ? json(found) : json({}, 404);
  }
  return json({ error: "PRIVATE_UNKNOWN_PACKAGE_ROUTE" }, 404);
}
const calls = (path: string, method: string) => network.mock.calls.filter(([url, options]) => String(url) === `${base}${path}` && options?.method === method);
const reads = () => calls(`/requests/${encodeURIComponent(requestId)}`, "GET");
const mutations = () => network.mock.calls.filter(([url, options]) => ["POST", "PUT"].includes(options?.method || "") && String(url) !== `${base}/plans`);
const pending = () => JSON.parse(sessionStorage.getItem(intentKey) || "null");
const history = () => JSON.parse(sessionStorage.getItem(historyKey) || "[]");
function saveKnownRejection(intent: Intent = original) {
  sessionStorage.setItem(intentKey, JSON.stringify(intent)); sessionStorage.setItem(rejectionKey, JSON.stringify(marker(intent)));
}
async function enabled(name: string) {
  const button = await screen.findByRole("button", { name }); await waitFor(() => expect(button.matches(":disabled")).toBe(false)); return button;
}
function mount() {
  return render(<MemoryRouter initialEntries={["/settings/data?rootType=sample&rootId=sample%3A1&kind=report"]}><ResearchPackagesPage /></MemoryRouter>);
}
async function settled() { await screen.findByText("No package jobs are recorded for your account."); }
async function startFresh() {
  mount(); await settled(); fireEvent.click(await enabled("Preview export")); fireEvent.click(await enabled("Start report export"));
  await waitFor(() => expect(calls("/jobs", "POST")).toHaveLength(1));
  expect(JSON.parse(String(calls("/jobs", "POST")[0][1]?.body))).toEqual(original.input);
}
function expectLocked(intent: Intent = original) {
  expect(pending()).toEqual(intent); expect(screen.getByLabelText("Sample and Project roots").matches(":disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Preview export" }).matches(":disabled")).toBe(true);
  expect((screen.getByLabelText("Native package ZIP") as HTMLInputElement).disabled).toBe(true);
  expect(document.body.textContent).not.toContain("PRIVATE");
}
beforeEach(() => {
  sessionStorage.clear(); jobs = []; network.mockReset(); network.mockImplementation(async (path, options) => fallback(path, options));
  vi.stubGlobal("fetch", network); vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe("research package request recovery", () => {
  it("blocks new package requests while preserving unreadable earlier-request history byte for byte", async () => {
    const malformed = '{"unreadable-history":'; sessionStorage.setItem(historyKey, malformed);
    mount(); await settled();
    expect(screen.getByRole("alert").textContent).toMatch(/Saved package request history could not be read/);
    expect(screen.getByLabelText("Sample and Project roots").matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Preview export" }).matches(":disabled")).toBe(true);
    expect(screen.getByLabelText("Native package ZIP").matches(":disabled")).toBe(true);
    expect(sessionStorage.getItem(historyKey)).toBe(malformed); expect(pending()).toBeNull();
    expect(mutations()).toHaveLength(0); expect(calls("/plans", "POST")).toHaveLength(0); expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it.each(["original", "earlier"] as const)("retains a positive %s receipt and its job when an older held poll finishes afterwards", async source => {
    vi.useFakeTimers();
    if (source === "original") sessionStorage.setItem(intentKey, JSON.stringify(original));
    else sessionStorage.setItem(historyKey, JSON.stringify([{ intent: original, receipt: null }]));
    await act(async () => { mount(); for (let i = 0; i < 40; i++) await Promise.resolve(); });
    expect(screen.getByText("No package jobs are recorded for your account.")).toBeTruthy();
    const oldPoll = deferred<Response>();
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}/jobs` && options?.method === "GET") return oldPoll.promise;
      if (String(path) === `${base}/requests/${requestId}`) return json(receipt());
      return fallback(path, options);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(calls("/jobs", "GET")).toHaveLength(2);
    const origin = screen.getByRole("button", { name: source === "original" ? "Check original package request" : `Check earlier package request ${requestId}` });
    await act(async () => { origin.focus(); fireEvent.click(origin); for (let i = 0; i < 40; i++) await Promise.resolve(); });
    expect(screen.getByText(job().id)).toBeTruthy(); expect(history()).toEqual([{ intent: original, receipt: receipt() }]);
    await act(async () => { oldPoll.resolve(json({ jobs: [] })); for (let i = 0; i < 40; i++) await Promise.resolve(); });
    expect(screen.getByText(job().id)).toBeTruthy(); expect(history()).toEqual([{ intent: original, receipt: receipt() }]);
    expect(pending()).toBeNull(); expect(mutations()).toHaveLength(0);
  });

  it("keeps a fresh import review empty when an older upload-preview poll finishes afterwards", async () => {
    vi.useFakeTimers();
    const input: ResearchUploadInput = { requestId: "upload:request", byteSize: 12, sha256: "a".repeat(64) };
    const uploadJob: ResearchJobStatus = { ...job("upload", "upload:original"), requestId: input.requestId, state: "preview", phase: "preview" };
    const rejectedImport: Intent = { action: "import", input: { requestId, uploadJobId: uploadJob.id, anotherCopy: false,
      expectedRolePolicyRevision: 3, naming: { suffix: " (imported)" } } };
    saveKnownRejection(rejectedImport); sessionStorage.setItem("research-package-upload", JSON.stringify({ input, jobId: uploadJob.id })); jobs = [uploadJob];
    const importScope = { ...preview({ kind: "data_package", roots: [{ kind: "sample", id: "sample:1" }] }), rolePolicyRevision: 3 };
    let hold = false; const oldPreview = deferred<Response>();
    network.mockImplementation(async (path, options) => String(path) === `${base}/jobs/upload%3Aoriginal/preview?suffix=%20(imported)`
      ? hold ? oldPreview.promise : json(importScope) : fallback(path, options));
    await act(async () => { mount(); for (let i = 0; i < 50; i++) await Promise.resolve(); });
    expect(screen.getByRole("button", { name: "Import research copy" })).toBeTruthy(); hold = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review a new package request" })); for (let i = 0; i < 40; i++) await Promise.resolve(); });
    expect(pending()).toBeNull(); expect(screen.queryByRole("button", { name: "Import research copy" })).toBeNull();
    await act(async () => { oldPreview.resolve(json(importScope)); for (let i = 0; i < 40; i++) await Promise.resolve(); });
    expect(screen.queryByRole("button", { name: "Import research copy" })).toBeNull();
    expect(history()).toEqual([{ intent: rejectedImport, receipt: null }]); expect(mutations()).toHaveLength(0);
  });

  it("keeps a fresh 409 and typed absence locked until explicit review rechecks the original receipt and retains all earlier intents", async () => {
    const earlier = Array.from({ length: 24 }, (_, index) => ({ intent: { ...original, input: { ...original.input, requestId: `earlier:${index}` } }, receipt: null }));
    sessionStorage.setItem(historyKey, JSON.stringify(earlier));
    const finalRead = deferred<Response>(); let hold = false;
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}/jobs` && options?.method === "POST") return json({ error: "PRIVATE_FRESH_REJECTION" }, 409);
      if (String(path) === `${base}/requests/${requestId}` && hold) return finalRead.promise;
      return fallback(path, options);
    });
    await startFresh(); await enabled("Review a new package request"); expectLocked(); expect(reads()).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem(rejectionKey)!)).toEqual(marker()); expect(history()).toEqual(earlier);
    fireEvent.click(await enabled("Check original package request")); await enabled("Review a new package request");
    expectLocked(); expect(reads()).toHaveLength(2); expect(mutations()).toHaveLength(1);
    hold = true; fireEvent.click(await enabled("Review a new package request")); await waitFor(() => expect(reads()).toHaveLength(3));
    expectLocked(); expect(history()).toEqual(earlier);
    await act(async () => finalRead.resolve(missing()));
    await waitFor(() => expect(pending()).toBeNull()); await enabled("Preview export");
    expect(sessionStorage.getItem(rejectionKey)).toBeNull(); expect(history()).toEqual([...earlier, { intent: original, receipt: null }]);
    expect(history()).toHaveLength(25); expect(mutations()).toHaveLength(1); expect(calls("/plans", "POST")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Start report export" })).toBeNull();
    expect(screen.getByRole("button", { name: `Check earlier package request ${requestId}` })).toBeTruthy();
  });

  it("keeps a lost ACK uncertain after typed absence and an explicit original retry's 409 plus typed absence", async () => {
    let attempts = 0;
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}/jobs` && options?.method === "POST") {
        if (++attempts === 1) throw new Error("PRIVATE_LOST_PACKAGE_ACK"); return json({ error: "PRIVATE_RETRY_REJECTION" }, 409);
      }
      return fallback(path, options);
    });
    await startFresh(); await enabled("Check original package request"); expectLocked(); expect(reads()).toHaveLength(0);
    fireEvent.click(await enabled("Check original package request")); await enabled("Retry original package request");
    expect(reads()).toHaveLength(1); expect(mutations()).toHaveLength(1); expectLocked();
    expect(screen.queryByRole("button", { name: "Review a new package request" })).toBeNull();
    fireEvent.click(await enabled("Retry original package request")); await enabled("Retry original package request");
    expect(reads()).toHaveLength(3); expect(mutations()).toHaveLength(2); expectLocked();
    expect(calls("/jobs", "POST").map(([, options]) => JSON.parse(String(options?.body)))).toEqual([original.input, original.input]);
    expect(sessionStorage.getItem(rejectionKey)).toBeNull(); expect(history()).toEqual([]);
    expect(screen.queryByRole("button", { name: "Review a new package request" })).toBeNull();
  });

  it("keeps a legacy pending intent uncertain even when an explicit later retry is rejected", async () => {
    sessionStorage.setItem(intentKey, JSON.stringify(original));
    network.mockImplementation(async (path, options) => String(path) === `${base}/jobs` && options?.method === "POST"
      ? json({ error: "PRIVATE_LEGACY_REJECTION" }, 409) : fallback(path, options));
    mount(); await settled(); await enabled("Retry original package request"); expectLocked(); expect(mutations()).toHaveLength(0);
    fireEvent.click(await enabled("Retry original package request")); await enabled("Retry original package request");
    expect(reads()).toHaveLength(3); expect(mutations()).toHaveLength(1); expectLocked();
    expect(sessionStorage.getItem(rejectionKey)).toBeNull(); expect(screen.queryByRole("button", { name: "Review a new package request" })).toBeNull();
  });

  it.each([
    { label: "upload", intent: { action: "upload", input: { requestId, byteSize: 12, sha256: "a".repeat(64) } } as Intent },
  ])("restores an exact known-rejection marker for the $label intent using GET only", async ({ intent }) => {
    saveKnownRejection(intent); mount(); await settled(); await enabled("Review a new package request");
    expectLocked(intent); expect(reads()).toHaveLength(1); expect(mutations()).toHaveLength(0); expect(history()).toEqual([]);
    expect(JSON.parse(sessionStorage.getItem(rejectionKey)!)).toEqual(marker(intent));
  });

  it.each([
    { label: "export root", other: { action: "export", input: { ...original.input, roots: [{ kind: "project", id: "other:project" }] } } },
  ])("does not apply a rejection marker with a different $label to the pending intent", async ({ other }) => {
    saveKnownRejection(); sessionStorage.setItem(rejectionKey, JSON.stringify(marker(other as Intent)));
    mount(); await settled(); await enabled("Retry original package request"); expectLocked();
    expect(screen.queryByRole("button", { name: "Review a new package request" })).toBeNull(); expect(mutations()).toHaveLength(0);
  });

  it.each(["generic-route", "wrong-request"] as const)(
    "does not treat a %s 404 as proof that an original package request is absent", async outcome => {
      saveKnownRejection();
      network.mockImplementation(async (path, options) => {
        if (String(path) !== `${base}/requests/${requestId}`) return fallback(path, options);
        if (outcome === "generic-route") return json({ error: "PRIVATE_PACKAGE_ROUTE_NOT_FOUND" }, 404);
        return json({ schema: "research-package-request-absent/1", requestId: "different:request" }, 404);
      });
      mount(); await settled(); await screen.findByRole("alert"); await enabled("Check original package request"); expectLocked();
      expect(screen.queryByRole("button", { name: "Retry original package request" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Review a new package request" })).toBeNull();
      expect(JSON.parse(sessionStorage.getItem(rejectionKey)!)).toEqual(marker()); expect(history()).toEqual([]); expect(mutations()).toHaveLength(0);
    });

  it.each(["wrong-kind", "forbidden"] as const)(
    "keeps the pending intent when explicit new-request review receives a %s receipt", async outcome => {
      saveKnownRejection(); mount(); await settled(); await enabled("Review a new package request");
      let privateBody: ReturnType<typeof vi.spyOn> | undefined;
      network.mockImplementation(async (path, options) => {
        if (String(path) !== `${base}/requests/${requestId}`) return fallback(path, options);
        if (outcome === "wrong-kind") return json({ ...receipt(), job: job("data_package") });
        const response = json({ secret: "PRIVATE_RECEIPT_ERROR" }, 403);
        privateBody = vi.spyOn(response, "json"); return response;
      });
      fireEvent.click(await enabled("Review a new package request")); await waitFor(() => expect(reads()).toHaveLength(2));
      if (outcome === "forbidden") {
        await screen.findByText(/Sign in with an account allowed to use the application/);
        expect(screen.queryByLabelText("Sample and Project roots")).toBeNull();
      } else { await screen.findByRole("alert"); await enabled("Check original package request"); expectLocked(); }
      expect(pending()).toEqual(original); expect(JSON.parse(sessionStorage.getItem(rejectionKey)!)).toEqual(marker());
      expect(history()).toEqual([]); expect(mutations()).toHaveLength(0);
      expect(screen.queryByRole("button", { name: "Review a new package request" })).toBeNull();
      expect(document.body.textContent).not.toContain("PRIVATE"); if (privateBody) expect(privateBody).not.toHaveBeenCalled();
    });

  it("accepts an exact late saved receipt during explicit new-request review instead of starting another operation", async () => {
    saveKnownRejection(); const recheck = deferred<Response>(); mount(); await settled(); await enabled("Review a new package request");
    network.mockImplementation(async (path, options) => String(path) === `${base}/requests/${requestId}` ? recheck.promise : fallback(path, options));
    fireEvent.click(await enabled("Review a new package request")); await waitFor(() => expect(reads()).toHaveLength(2)); expectLocked();
    jobs = [job()]; await act(async () => recheck.resolve(json(receipt())));
    await waitFor(() => expect(pending()).toBeNull()); await enabled("Preview export");
    expect(history()).toEqual([{ intent: original, receipt: receipt() }]); expect(sessionStorage.getItem(rejectionKey)).toBeNull();
    expect(mutations()).toHaveLength(0); expect(calls("/plans", "POST")).toHaveLength(0); expect(screen.getByText(job().id)).toBeTruthy();
  });

  it.each(["queued", "completed"] as const)("moves an owned Check to only its accepted %s job after the deferred original receipt", async state => {
    saveKnownRejection(); const checked = deferred<Response>(); mount(); await settled();
    const origin = await enabled("Check original package request");
    network.mockImplementation(async (path, options) => String(path) === `${base}/requests/${requestId}` ? checked.promise : fallback(path, options));
    origin.focus(); fireEvent.click(origin); await waitFor(() => expect(origin.matches(":disabled")).toBe(true));
    const oldTabIndex = document.body.getAttribute("tabindex");
    try {
      // Model native disabled-control blur; this remains a mounted focus check.
      document.body.tabIndex = -1; document.body.focus();
      const saved = receipt(); saved.job.state = state; if (state === "completed") saved.job.phase = "done";
      jobs = [saved.job, { ...job(), id: "unrelated:package" }];
      await act(async () => checked.resolve(json(saved)));
      const row = screen.getByText(saved.job.id).closest("article")!;
      const target = state === "queued" ? within(row).getByRole("button", { name: "Pause" }) : within(row).getByRole("status");
      await waitFor(() => expect(document.activeElement).toBe(target));
      expect(origin.isConnected).toBe(false); expect(pending()).toBeNull(); expect(mutations()).toHaveLength(0);
    } finally { if (oldTabIndex === null) document.body.removeAttribute("tabindex"); else document.body.setAttribute("tabindex", oldTabIndex); }
  });

  it.each([false, true])("returns fresh-review focus only while its original action remains owned (moved away: %s)", async moved => {
    saveKnownRejection(); const checked = deferred<Response>(); mount(); await settled();
    const origin = await enabled("Review a new package request");
    network.mockImplementation(async (path, options) => String(path) === `${base}/requests/${requestId}` ? checked.promise : fallback(path, options));
    origin.focus(); fireEvent.click(origin); await waitFor(() => expect(origin.matches(":disabled")).toBe(true));
    const oldTabIndex = document.body.getAttribute("tabindex");
    try {
      if (moved) screen.getByRole("link", { name: "Storage settings" }).focus();
      document.body.tabIndex = -1; document.body.focus();
      await act(async () => checked.resolve(missing()));
      await enabled("Preview export"); expect(origin.isConnected).toBe(false);
      await waitFor(() => expect(document.activeElement).toBe(moved ? document.body : screen.getByRole("button", { name: "Preview export" })));
      expect(pending()).toBeNull(); expect(history()).toEqual([{ intent: original, receipt: null }]); expect(mutations()).toHaveLength(0);
    } finally { if (oldTabIndex === null) document.body.removeAttribute("tabindex"); else document.body.setAttribute("tabindex", oldTabIndex); }
  });

  it("reconciles a reused import receipt whose saved job retains its older original request identity", async () => {
    const intent: Intent = { action: "import", input: { requestId, uploadJobId: "upload:original", anotherCopy: false,
      expectedRolePolicyRevision: 3, naming: { suffix: " (copy)" } } };
    const reused: ResearchRequestReceipt = { requestId, reused: true, job: { ...job("import", "import:older"), requestId: "older:import:request", state: "completed", phase: "done",
      result: { roots: [{ kind: "sample", id: "imported:sample" }], reused: false } } };
    sessionStorage.setItem(intentKey, JSON.stringify(intent)); jobs = [reused.job];
    network.mockImplementation(async (path, options) => String(path) === `${base}/requests/${requestId}` ? json(reused) : fallback(path, options));
    mount(); await screen.findByRole("link", { name: "Open imported sample" }); await waitFor(() => expect(pending()).toBeNull());
    expect(screen.getByRole("link", { name: "Open imported sample" }).getAttribute("href")).toBe("/samples/imported%3Asample");
    expect(history()).toEqual([{ intent, receipt: reused }]);
    expect(JSON.parse(sessionStorage.getItem(receiptsKey)!)).toContainEqual({ requestId, jobId: reused.job.id, reused: true });
    expect(reused.job.requestId).toBe("older:import:request"); expect(mutations()).toHaveLength(0); expect(reads()).toHaveLength(1);
  });

  it("keeps the original intent if history cannot be saved after the missing final receipt check", async () => {
    saveKnownRejection(); mount(); await settled(); await enabled("Review a new package request");
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === historyKey) throw new DOMException("PRIVATE_STORAGE_QUOTA", "QuotaExceededError"); return write.call(this, key, value);
    });
    network.mockImplementation(async (path, options) => String(path) === `${base}/requests/${requestId}` ? missing() : fallback(path, options));
    fireEvent.click(await enabled("Review a new package request")); await screen.findByRole("alert"); await enabled("Check original package request");
    expectLocked(); expect(JSON.parse(sessionStorage.getItem(rejectionKey)!)).toEqual(marker()); expect(history()).toEqual([]); expect(mutations()).toHaveLength(0);
  });

  it("does not retire an original intent when a final review read returns accepted after unmount", async () => {
    saveKnownRejection(); const recheck = deferred<Response>(); const mounted = mount(); await settled(); await enabled("Review a new package request");
    network.mockImplementation(async (path, options) => String(path) === `${base}/requests/${requestId}` ? recheck.promise : fallback(path, options));
    fireEvent.click(await enabled("Review a new package request")); await waitFor(() => expect(reads()).toHaveLength(2));
    const signal = reads()[1][1]?.signal; expect(signal?.aborted).toBe(false); mounted.unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => recheck.resolve(json(receipt())));
    expect(pending()).toEqual(original); expect(JSON.parse(sessionStorage.getItem(rejectionKey)!)).toEqual(marker()); expect(history()).toEqual([]); expect(mutations()).toHaveLength(0);
  });

  it("reads an earlier package receipt without changing a different pending operation or its rejection marker", async () => {
    const current: Intent = { action: "upload", input: { requestId: "current:upload", byteSize: 24, sha256: "b".repeat(64) } };
    saveKnownRejection(current); sessionStorage.setItem(historyKey, JSON.stringify([{ intent: original, receipt: null }]));
    const pendingBytes = sessionStorage.getItem(intentKey), markerBytes = sessionStorage.getItem(rejectionKey), late = deferred<Response>();
    network.mockImplementation(async (path, options) => String(path) === `${base}/requests/${requestId}` ? late.promise : fallback(path, options));
    mount(); await settled(); await enabled("Review a new package request"); expect(reads()).toHaveLength(0);
    fireEvent.click(await enabled(`Check earlier package request ${requestId}`)); await waitFor(() => expect(reads()).toHaveLength(1));
    expect(history()).toEqual([{ intent: original, receipt: null }]); jobs = [job()]; await act(async () => late.resolve(json(receipt())));
    await waitFor(() => expect(history()).toEqual([{ intent: original, receipt: receipt() }]));
    await enabled(`Check earlier package request ${requestId}`);
    expect(sessionStorage.getItem(intentKey)).toBe(pendingBytes); expect(sessionStorage.getItem(rejectionKey)).toBe(markerBytes);
    expectLocked(current); expect(mutations()).toHaveLength(0); expect(calls("/plans", "POST")).toHaveLength(0);
  });
});
