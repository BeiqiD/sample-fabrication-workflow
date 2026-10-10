import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchExecutorStatus, ResearchExportInput, ResearchExportPlanInput, ResearchJobStatus,
  ResearchPackagePreview, ResearchRequestReceipt } from "../shared/contracts/research-package-api";
import { ResearchPackagesPage } from "./pages/ResearchPackagesPage";

const base = "/api/packages", intentKey = "research-package-operation", receiptsKey = "research-package-receipts";
const at = "2026-10-09T09:00:00.000Z";
const originalA: ResearchExportInput = { requestId: "original:A", kind: "data_package", roots: [{ kind: "sample", id: "sample:A" }] };
const originalB: ResearchExportInput = { requestId: "22222222-2222-4222-8222-222222222222", kind: "report", roots: [{ kind: "sample", id: "sample:B" }] };
const intentA = { action: "export", input: originalA };
const intentB = { action: "export", input: originalB };
const network = vi.fn<typeof fetch>();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function job(input: ResearchExportInput, id: string): ResearchJobStatus {
  return { id, requestId: input.requestId, kind: input.kind, state: "queued", phase: "snapshot", acceptedAt: at, updatedAt: at,
    reason: null, progress: { completedFiles: 0, totalFiles: 1, bytesDone: 0, bytesTotal: 12 }, output: null, result: null };
}
function preview(input: ResearchExportPlanInput): ResearchPackagePreview {
  return { schema: "research-package-preview/1", kind: input.kind, roots: input.roots, counts: { records: 1, files: 1, bytes: 12 },
    archiveBytes: 2048, metadataBytes: 512, warnings: [], complete: true,
    capabilities: { dataPackage: { available: true, reasons: [] }, report: { available: true, reasons: [] } },
    dependencies: [], source: null, rolePolicyRevision: null, naming: null, targets: [], existingImportJobId: null };
}
const executor: ResearchExecutorStatus = { supported: true, enabled: true, stale: false, canManage: false,
  lastHeartbeatAt: at, cadenceSeconds: 120, maxStepMs: 60000, reason: null };
const receiptA: ResearchRequestReceipt = { requestId: originalA.requestId, job: job(originalA, "job:A"), reused: false };
const receiptB: ResearchRequestReceipt = { requestId: originalB.requestId, job: job(originalB, "job:B"), reused: false };
let firstA: ReturnType<typeof deferred<Response>>, secondA: ReturnType<typeof deferred<Response>>, ackB: ReturnType<typeof deferred<Response>>;
let aReads: number, acceptedB: number, missingBReceipt: boolean, jobs: ResearchJobStatus[];
const calls = (path: string, method: string) => network.mock.calls.filter(([url, options]) => String(url) === `${base}${path}` && options?.method === method);
const mutations = () => network.mock.calls.filter(([url, options]) => ["POST", "PUT"].includes(options?.method || "") && String(url) !== `${base}/plans`);
async function enabled(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button.matches(":disabled")).toBe(false));
  return button;
}
function mount(query = "?rootType=sample&rootId=sample%3AB&kind=report") {
  return render(<MemoryRouter initialEntries={[`/settings/data${query}`]}><ResearchPackagesPage /></MemoryRouter>);
}
async function beginCrossedReceipts() {
  sessionStorage.setItem(intentKey, JSON.stringify(intentA));
  const mounted = mount();
  await waitFor(() => expect(aReads).toBe(1));
  fireEvent.click(await enabled("Check or retry original request"));
  await waitFor(() => expect(aReads).toBe(2));
  await act(async () => { secondA.resolve(json(receiptA)); });
  await screen.findByText(/Operation saved/);
  await waitFor(() => expect(sessionStorage.getItem(intentKey)).toBeNull());
  fireEvent.click(await enabled("Preview export"));
  fireEvent.click(await enabled("Start report export"));
  await waitFor(() => expect(calls("/jobs", "POST")).toHaveLength(1));
  expect(JSON.parse(String(calls("/jobs", "POST")[0][1]?.body))).toEqual(originalB);
  expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(intentB);
  return mounted;
}
type LateOutcome = "success" | "missing" | "network" | "server" | "denied";
async function settleOldA(outcome: LateOutcome) {
  await act(async () => {
    if (outcome === "network") firstA.reject(new Error("PRIVATE_OLD_A_NETWORK"));
    else firstA.resolve(outcome === "success" ? json(receiptA) : json({ secret: "PRIVATE_OLD_A_RESPONSE" },
      outcome === "missing" ? 404 : outcome === "server" ? 500 : 403));
  });
  // The initial receipt task has finished; its normal metadata poll may run.
  await waitFor(() => expect(calls("/jobs", "GET").length).toBeGreaterThan(0));
}
function expectPendingB() {
  expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(intentB);
  expect(screen.getByRole("heading", { name: "Unconfirmed operation" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Check or retry original request" }).matches(":disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Start report export" }).matches(":disabled")).toBe(true);
  expect(screen.getByLabelText("Sample and Project roots").matches(":disabled")).toBe(true);
  expect(screen.queryByText(/Operation saved/)).toBeNull();
  expect(screen.queryByText(/No receipt is recorded yet/)).toBeNull();
  expect(screen.queryByText(/Sign in with an account/)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.body.textContent).not.toContain("PRIVATE");
  expect(mutations()).toHaveLength(1);
}
async function loseBAck() {
  await act(async () => { ackB.reject(new Error("PRIVATE_LOST_B_ACK")); });
  await screen.findByText("The package response is unavailable. Check the original request before retrying.");
  await enabled("Check or retry original request");
  expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(intentB);
  expect(document.body.textContent).not.toContain("PRIVATE");
}
beforeEach(() => {
  sessionStorage.clear(); aReads = 0; acceptedB = 0; missingBReceipt = false; jobs = [receiptA.job];
  firstA = deferred<Response>(); secondA = deferred<Response>(); ackB = deferred<Response>();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(originalB.requestId as ReturnType<Crypto["randomUUID"]>);
  network.mockReset();
  network.mockImplementation(async (url, options) => {
    const path = String(url), method = options?.method || "GET";
    if (path === `${base}/requests/${encodeURIComponent(originalA.requestId)}` && method === "GET") {
      aReads++;
      return aReads === 1 ? firstA.promise : aReads === 2 ? secondA.promise : json(receiptA);
    }
    if (path === `${base}/requests/${encodeURIComponent(originalB.requestId)}` && method === "GET") {
      return missingBReceipt ? json({ secret: "PRIVATE_MISSING_B_RECEIPT" }, 404) : json(receiptB);
    }
    if (path === `${base}/plans` && method === "POST") return json(preview(JSON.parse(String(options?.body))));
    if (path === `${base}/jobs` && method === "POST") {
      expect(JSON.parse(String(options?.body))).toEqual(originalB);
      if (!acceptedB) { acceptedB++; jobs = [receiptB.job, ...jobs]; return ackB.promise; }
      // The exact request is idempotent and returns the already accepted job.
      return json(receiptB, 202);
    }
    if (path === `${base}/jobs` && method === "GET") return json({ jobs });
    if (path === `${base}/executor` && method === "GET") return json(executor);
    throw new Error(`Unexpected mocked package request: ${method} ${path}`);
  });
  vi.stubGlobal("fetch", network);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe("research package receipt ownership", () => {
  it.each(["success", "missing", "network", "server", "denied"] as const)("ignores late A %s while B awaits its ACK and recovers B on reload without replay", async outcome => {
    const mounted = await beginCrossedReceipts();
    await settleOldA(outcome);
    expectPendingB();
    await loseBAck();
    mounted.unmount();
    mount("?rootType=project&rootId=changed%3Aselection&kind=data_package");
    await screen.findByText(/Operation saved/);
    await waitFor(() => expect(sessionStorage.getItem(intentKey)).toBeNull());
    expect(calls(`/requests/${encodeURIComponent(originalB.requestId)}`, "GET")).toHaveLength(1);
    expect(mutations()).toHaveLength(1); expect(acceptedB).toBe(1);
    expect(screen.getByText("job:B")).toBeTruthy();
    expect((screen.getByLabelText("Sample and Project roots") as HTMLTextAreaElement).value).toBe("project:changed:selection");
    expect(JSON.parse(sessionStorage.getItem(receiptsKey)!)).toEqual([
      { requestId: originalB.requestId, jobId: "job:B", reused: false },
      { requestId: originalA.requestId, jobId: "job:A", reused: false },
    ]);
  });

  it("retains B's original payload through reload and retries only that request when its receipt is missing", async () => {
    const mounted = await beginCrossedReceipts();
    await settleOldA("success"); expectPendingB(); await loseBAck();
    missingBReceipt = true; mounted.unmount();
    mount("?rootType=project&rootId=changed%3Aselection&kind=data_package");
    await screen.findByText(/No receipt is recorded yet/);
    expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(intentB);
    expect(screen.getByLabelText("Sample and Project roots").matches(":disabled")).toBe(true);
    expect(mutations()).toHaveLength(1);
    fireEvent.click(await enabled("Check or retry original request"));
    await screen.findByText(/Operation saved/);
    await waitFor(() => expect(sessionStorage.getItem(intentKey)).toBeNull());
    expect(calls(`/requests/${encodeURIComponent(originalB.requestId)}`, "GET")).toHaveLength(2);
    expect(calls("/jobs", "POST").map(([, options]) => JSON.parse(String(options?.body)))).toEqual([originalB, originalB]);
    expect(mutations()).toHaveLength(2); expect(acceptedB).toBe(1);
    expect(JSON.parse(sessionStorage.getItem(receiptsKey)!)[0]).toEqual({ requestId: originalB.requestId, jobId: "job:B", reused: false });
  });

  it("consumes the current saved A receipt normally without starting a mutation", async () => {
    sessionStorage.setItem(intentKey, JSON.stringify(intentA)); mount();
    await waitFor(() => expect(aReads).toBe(1));
    await act(async () => { firstA.resolve(json(receiptA)); });
    await screen.findByText(/Operation saved/);
    expect(sessionStorage.getItem(intentKey)).toBeNull(); expect(mutations()).toHaveLength(0);
    expect(JSON.parse(sessionStorage.getItem(receiptsKey)!)).toEqual([{ requestId: originalA.requestId, jobId: "job:A", reused: false }]);
  });

  it.each([401, 403])("retains the current A identity on access denial %s without reading its private body", async status => {
    sessionStorage.setItem(intentKey, JSON.stringify(intentA)); mount();
    await waitFor(() => expect(aReads).toBe(1));
    const response = json({ secret: "PRIVATE_CURRENT_A_RESPONSE" }, status);
    const body = vi.spyOn(response, "json");
    await act(async () => { firstA.resolve(response); });
    await screen.findByText(/Sign in with an account allowed/);
    expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(intentA);
    expect(screen.queryByLabelText("Sample and Project roots")).toBeNull();
    expect(body).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain("PRIVATE");
    expect(mutations()).toHaveLength(0);
  });
});
