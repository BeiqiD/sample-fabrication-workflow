import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentStorageSettingsStatus } from "../shared/contracts/current-storage-settings";
import type { AcceptFileMigrationInput, FileJobStatus, FileMigrationPlan, FileMigrationRequestReceipt } from "../shared/contracts/file-jobs";
import { FileMigrationsPage } from "./pages/FileMigrationsPage";

const base = "/api/files/migrations", intentKey = "file-migration-acceptance";
const rejectionKey = "file-migration-acceptance-rejection", historyKey = "file-migration-earlier-requests";
const at = "2026-10-15T00:00:00.000Z", requestId = "22222222-2222-4222-8222-222222222222";
const original: AcceptFileMigrationInput = { requestId, fileIds: ["file:1"], target: { profileId: "destination", configurationRevision: 1 } };
const marker = (input = original) => ({ schema: "file-migration-rejection/1", input });
const network = vi.fn<typeof fetch>();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const missing = () => json({ schema: "file-migration-request-absent/1", requestId }, 404);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const settings = (): CurrentStorageSettingsStatus => ({ version: 3, kind: "storage-settings-status", readOnly: true, health: "not_checked",
  authority: { mode: "active", shadowConversions: "paused", fileAccess: "enabled" },
  roleDefaults: { state: "configured", policyRevision: 3, internal: { profileId: "source", adapterType: "r2", availability: "available" },
    originals: { profileId: "destination", adapterType: "s3", availability: "available" } },
  bindings: { r2: { configuration: "configured" }, managed: { provider: "none", configuration: "missing" } },
  profiles: { items: [
    { id: "source", adapterType: "r2", configurationRevision: 1, runtimeAccess: "read_write", bindingMatch: "matched", bindingRevision: null, availability: "available" },
    { id: "destination", adapterType: "s3", configurationRevision: 1, runtimeAccess: "read_write", bindingMatch: "matched", bindingRevision: 1, availability: "available" },
  ], hasMore: false, limit: 100 } });
const job = (): FileJobStatus => ({ id: "migration:original", actor: "private-admin@example.test", state: "queued", target: original.target,
  acceptedAt: at, updatedAt: at, reason: null, moved: 0, remaining: 1, failed: 0, cleanupPending: 0 });
const receipt = (): FileMigrationRequestReceipt => ({ requestId, input: structuredClone(original), job: job() });
const plan = (input: AcceptFileMigrationInput): FileMigrationPlan => ({ target: input.target,
  items: input.fileIds.map(fileId => ({ fileId, purpose: "research_source", sourceLocationId: `location:${fileId}`, sourceProfileId: "source",
    byteSize: 12, sha256: "a".repeat(64), status: "eligible" })), bytes: 12 * input.fileIds.length,
  retainedSourceBytes: 12 * input.fileIds.length, stagingBytes: 60 * input.fileIds.length, transferAndVerificationBytes: 36 * input.fileIds.length,
  maxTransferAndVerificationBytes: 180 * input.fileIds.length, maxAttemptsPerFile: 5, bytesVerified: false });
let jobs: FileJobStatus[];
function fallback(path: RequestInfo | URL, options?: RequestInit): Response {
  const url = String(path);
  if (url === "/api/storage/configuration/capability") return json({ canManage: true, credentialEditingAvailable: true });
  if (url === "/api/settings/storage?version=3") return json(settings());
  if (url === `${base}/files`) return json({ items: [{ fileId: "file:1", purpose: "research_source", byteSize: 12, sha256: "a".repeat(64),
    profileId: "source", locationId: "location:1" }], nextCursor: null });
  if (url === `${base}/executor`) return json({ enabled: true, stale: false, cadenceSeconds: 120, maxFilesPerStep: 1, maxStepMs: 60000, lastHeartbeatAt: at });
  if (url === base && options?.method === "GET") return json({ jobs });
  if (url === `${base}/plans`) return json(plan(JSON.parse(String(options?.body))));
  if (url === `${base}/requests/${encodeURIComponent(requestId)}`) return missing();
  return json({}, 404);
}
const calls = (path: string, method: string) => network.mock.calls.filter(([url, options]) => String(url) === `${base}${path}` && options?.method === method);
const posts = () => calls("", "POST");
const reads = () => calls(`/requests/${encodeURIComponent(requestId)}`, "GET");
const pending = () => JSON.parse(sessionStorage.getItem(intentKey) || "null");
const history = () => JSON.parse(sessionStorage.getItem(historyKey) || "[]");
function saveKnownRejection() {
  sessionStorage.setItem(intentKey, JSON.stringify(original));
  sessionStorage.setItem(rejectionKey, JSON.stringify(marker()));
}
async function enabled(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button.matches(":disabled")).toBe(false)); return button;
}
async function initialReadsSettled() {
  await screen.findByRole("option", { name: "s3: destination" });
  await screen.findByText("No migrations have been accepted.");
}
async function startFresh() {
  render(<FileMigrationsPage />); await initialReadsSettled();
  fireEvent.change(screen.getByLabelText("Migration destination"), { target: { value: "destination" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(await enabled("Preview migration"));
  fireEvent.click(await enabled("Start migration"));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(JSON.parse(String(posts()[0][1]?.body))).toEqual(original);
}
function expectLocked() {
  expect(pending()).toEqual(original);
  expect(screen.getByLabelText("Migration destination").matches(":disabled")).toBe(true);
  expect(screen.getByRole("checkbox").matches(":disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Preview migration" }).matches(":disabled")).toBe(true);
  expect(screen.queryByRole("button", { name: "Start migration" })).toBeNull();
  expect(document.body.textContent).not.toContain("PRIVATE");
}
function focusBody() {
  // Model the observed native-browser blur when a focused action becomes disabled.
  // These mounted checks do not claim to exercise native Chromium focus itself.
  document.body.setAttribute("tabindex", "-1"); document.body.focus(); expect(document.activeElement).toBe(document.body);
}
beforeEach(() => {
  sessionStorage.clear(); jobs = []; network.mockReset();
  network.mockImplementation(async (path, options) => fallback(path, options)); vi.stubGlobal("fetch", network);
  vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId);
});
afterEach(() => { cleanup(); document.body.removeAttribute("tabindex"); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe("File migration acceptance recovery", () => {
  it("keeps a fresh 409 and missing receipt locked until explicit replanning rechecks the receipt and retains every earlier request", async () => {
    const earlier = Array.from({ length: 24 }, (_, index) => ({ input: { ...original, requestId: `earlier:${index}` }, jobId: index ? null : "earlier:job" }));
    sessionStorage.setItem(historyKey, JSON.stringify(earlier));
    const secondRead = deferred<Response>(); let held = false;
    network.mockImplementation(async (path, options) => {
      if (String(path) === base && options?.method === "POST") return json({ error: "PRIVATE_REJECTED_ACCEPTANCE" }, 409);
      if (String(path) === `${base}/requests/${requestId}` && held) return secondRead.promise;
      return fallback(path, options);
    });
    await startFresh(); await enabled("Review a new migration plan");
    expectLocked(); expect(reads()).toHaveLength(1); expect(history()).toEqual(earlier);
    expect(JSON.parse(sessionStorage.getItem(rejectionKey)!)).toEqual(marker());
    // The ordinary check reads only; it neither creates a new request nor unlocks the plan.
    fireEvent.click(await enabled("Check original migration request"));
    await enabled("Review a new migration plan"); expect(reads()).toHaveLength(2); expect(posts()).toHaveLength(1); expectLocked();
    held = true; fireEvent.click(await enabled("Review a new migration plan"));
    await waitFor(() => expect(reads()).toHaveLength(3)); expectLocked(); expect(history()).toEqual(earlier);
    await act(async () => secondRead.resolve(missing()));
    await waitFor(() => expect(pending()).toBeNull());
    expect(sessionStorage.getItem(rejectionKey)).toBeNull(); expect(history()).toEqual([...earlier, { input: original, jobId: null }]);
    expect(history()).toHaveLength(25); expect(posts()).toHaveLength(1); expect(calls("/plans", "POST")).toHaveLength(1);
    expect((screen.getByLabelText("Migration destination") as HTMLSelectElement).value).toBe("");
    expect(screen.getByLabelText("Migration destination").matches(":disabled")).toBe(false);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: "Preview migration" }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: `Check earlier request ${requestId}` })).toBeTruthy();
  });

  it("keeps a lost ACK uncertain after GET 404 and an explicit retry's 409 plus GET 404", async () => {
    let attempt = 0;
    network.mockImplementation(async (path, options) => {
      if (String(path) === base && options?.method === "POST") {
        if (++attempt === 1) throw new Error("PRIVATE_LOST_ACK");
        return json({ error: "PRIVATE_RETRY_REJECTION" }, 409);
      }
      return fallback(path, options);
    });
    await startFresh(); await enabled("Check original migration request");
    expectLocked(); expect(reads()).toHaveLength(0); expect(sessionStorage.getItem(rejectionKey)).toBeNull();
    fireEvent.click(await enabled("Check original migration request"));
    await enabled("Retry original migration request"); expect(reads()).toHaveLength(1); expect(posts()).toHaveLength(1); expectLocked();
    expect(screen.queryByRole("button", { name: "Review a new migration plan" })).toBeNull();
    fireEvent.click(await enabled("Retry original migration request"));
    await enabled("Retry original migration request");
    expect(reads()).toHaveLength(3); expect(posts()).toHaveLength(2); expectLocked();
    expect(posts().map(([, options]) => JSON.parse(String(options?.body)))).toEqual([original, original]);
    expect(sessionStorage.getItem(rejectionKey)).toBeNull(); expect(history()).toEqual([]);
    expect(screen.queryByRole("button", { name: "Review a new migration plan" })).toBeNull();
  });

  it("treats a legacy raw pending DTO as uncertain and never promotes a later retry rejection into fresh-plan permission", async () => {
    sessionStorage.setItem(intentKey, JSON.stringify(original));
    network.mockImplementation(async (path, options) => String(path) === base && options?.method === "POST"
      ? json({ error: "PRIVATE_LEGACY_REJECTION" }, 409) : fallback(path, options));
    render(<FileMigrationsPage />); await initialReadsSettled(); await enabled("Retry original migration request");
    expectLocked(); expect(reads()).toHaveLength(1); expect(posts()).toHaveLength(0);
    fireEvent.click(await enabled("Retry original migration request")); await enabled("Retry original migration request");
    expect(reads()).toHaveLength(3); expect(posts()).toHaveLength(1); expectLocked();
    expect(sessionStorage.getItem(rejectionKey)).toBeNull();
    expect(screen.queryByRole("button", { name: "Review a new migration plan" })).toBeNull();
  });

  it("recovers a matching known-rejection marker on reload using GET only", async () => {
    saveKnownRejection(); render(<FileMigrationsPage />); await initialReadsSettled(); await enabled("Review a new migration plan");
    expectLocked(); expect(reads()).toHaveLength(1); expect(posts()).toHaveLength(0); expect(history()).toEqual([]);
    expect(JSON.parse(sessionStorage.getItem(rejectionKey)!)).toEqual(marker());
  });

  it.each([
    { label: "request identity", alter: (input: AcceptFileMigrationInput) => { input.requestId = "different:request"; } },
    { label: "file selection", alter: (input: AcceptFileMigrationInput) => { input.fileIds = ["different:file"]; } },
    { label: "destination profile", alter: (input: AcceptFileMigrationInput) => { input.target.profileId = "different:profile"; } },
    { label: "destination revision", alter: (input: AcceptFileMigrationInput) => { input.target.configurationRevision = 2; } },
  ])("does not apply a rejection marker with a different $label to the pending request", async ({ alter }) => {
    saveKnownRejection(); const different = structuredClone(original); alter(different);
    sessionStorage.setItem(rejectionKey, JSON.stringify(marker(different)));
    render(<FileMigrationsPage />); await initialReadsSettled(); await enabled("Retry original migration request");
    expectLocked(); expect(posts()).toHaveLength(0); expect(reads()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Review a new migration plan" })).toBeNull();
  });

  it.each(["malformed", "different-input", "network", "server", "unauthorized", "forbidden"] as const)(
    "retains the original request and marker when the explicit replan receipt is %s", async outcome => {
      saveKnownRejection(); render(<FileMigrationsPage />); await initialReadsSettled(); await enabled("Review a new migration plan");
      const bad = receipt(); bad.input.fileIds = ["unrelated:file"];
      let privateBody: ReturnType<typeof vi.spyOn> | undefined;
      network.mockImplementation(async (path, options) => {
        if (String(path) === `${base}/requests/${requestId}`) {
          if (outcome === "network") throw new Error("PRIVATE_RECEIPT_NETWORK");
          if (outcome === "malformed") return json({ secret: "PRIVATE_MALFORMED_RECEIPT" });
          if (outcome === "different-input") return json(bad);
          const response = json({ secret: "PRIVATE_RECEIPT_ERROR" }, outcome === "server" ? 500 : outcome === "unauthorized" ? 401 : 403);
          privateBody = vi.spyOn(response, "json"); return response;
        }
        return fallback(path, options);
      });
      fireEvent.click(await enabled("Review a new migration plan"));
      await waitFor(() => expect(reads()).toHaveLength(2));
      if (outcome === "unauthorized" || outcome === "forbidden") {
        await screen.findByText("System administrator access is required to manage File migrations.");
        expect(screen.queryByLabelText("Migration destination")).toBeNull();
      } else {
        await screen.findByRole("alert"); await enabled("Check original migration request"); expectLocked();
      }
      expect(pending()).toEqual(original); expect(JSON.parse(sessionStorage.getItem(rejectionKey)!)).toEqual(marker());
      expect(history()).toEqual([]); expect(posts()).toHaveLength(0);
      expect(screen.queryByRole("button", { name: "Review a new migration plan" })).toBeNull();
      expect(document.body.textContent).not.toContain("PRIVATE"); if (privateBody) expect(privateBody).not.toHaveBeenCalled();
    });

  it.each(["generic-route", "html", "wrong-request", "extra-field", "malformed-json"] as const)(
    "does not treat a %s 404 as proof that the original request is absent", async outcome => {
      saveKnownRejection();
      network.mockImplementation(async (path, options) => {
        if (String(path) !== `${base}/requests/${requestId}`) return fallback(path, options);
        if (outcome === "generic-route") return json({ error: "PRIVATE_ROUTE_NOT_FOUND" }, 404);
        if (outcome === "html") return new Response("<h1>PRIVATE_PROXY_NOT_FOUND</h1>", { status: 404, headers: { "content-type": "text/html" } });
        if (outcome === "malformed-json") return new Response("PRIVATE_NOT_JSON", { status: 404, headers: { "content-type": "application/json" } });
        return json({ schema: "file-migration-request-absent/1", requestId: outcome === "wrong-request" ? "different:request" : requestId,
          ...(outcome === "extra-field" ? { privateCredential: "PRIVATE_UNKNOWN_FIELD" } : {}) }, 404);
      });
      render(<FileMigrationsPage />); await initialReadsSettled(); await screen.findByRole("alert");
      await enabled("Check original migration request"); expectLocked();
      expect(screen.queryByRole("button", { name: "Retry original migration request" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Review a new migration plan" })).toBeNull();
      expect(JSON.parse(sessionStorage.getItem(rejectionKey)!)).toEqual(marker()); expect(history()).toEqual([]); expect(posts()).toHaveLength(0);
      expect(reads()).toHaveLength(1);
    });

  it("reconciles a late accepted receipt during explicit replanning and retains its exact saved job without another POST", async () => {
    saveKnownRejection(); const recheck = deferred<Response>();
    render(<FileMigrationsPage />); await initialReadsSettled(); await enabled("Review a new migration plan");
    network.mockImplementation(async (path, options) => String(path) === `${base}/requests/${requestId}` ? recheck.promise : fallback(path, options));
    fireEvent.click(await enabled("Review a new migration plan"));
    await waitFor(() => expect(reads()).toHaveLength(2)); expectLocked(); expect(history()).toEqual([]);
    jobs = [job()]; await act(async () => recheck.resolve(json(receipt())));
    await screen.findByText(`Migration ${job().id} accepted. You can leave this page while the executor continues.`);
    await enabled("Pause job"); expect(pending()).toBeNull(); expect(sessionStorage.getItem(rejectionKey)).toBeNull();
    expect(history()).toEqual([{ input: original, jobId: job().id }]); expect(posts()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Start migration" })).toBeNull(); expect(calls("/plans", "POST")).toHaveLength(0);
  });

  it.each(["queued", "completed"] as const)("moves focused Check to only its accepted %s job after the deferred receipt and saved-job refresh", async state => {
    saveKnownRejection(); const recheck = deferred<Response>(), list = deferred<Response>(); let holdList = false;
    render(<FileMigrationsPage />); await initialReadsSettled();
    const origin = await enabled("Check original migration request");
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}/requests/${requestId}`) return recheck.promise;
      if (String(path) === base && options?.method === "GET" && holdList) return list.promise;
      return fallback(path, options);
    });
    origin.focus(); fireEvent.click(origin); await waitFor(() => expect(origin.matches(":disabled")).toBe(true)); focusBody();
    const accepted = receipt(); accepted.job.state = state;
    if (state === "completed") Object.assign(accepted.job, { moved: 1, remaining: 0 });
    const other = { ...job(), id: "unrelated:job" }; jobs = [other, accepted.job]; holdList = true;
    await act(async () => recheck.resolve(json(accepted)));
    await waitFor(() => expect(origin.isConnected).toBe(false)); expect(document.activeElement).toBe(document.body);
    expect(screen.queryByRole("heading", { name: accepted.job.id })).toBeNull();
    await act(async () => { holdList = false; list.resolve(json({ jobs })); });
    const row = screen.getByRole("heading", { name: accepted.job.id }).closest("li")!;
    const target = state === "queued" ? within(row).getByRole("button", { name: "Pause job" }) : within(row).getByRole("status");
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(target.isConnected).toBe(true); expect(posts()).toHaveLength(0); expect(pending()).toBeNull();
    expect(history()).toEqual([{ input: original, jobId: accepted.job.id }]);
  });

  it.each(["missing", "accepted"] as const)("moves focused Replan after fresh metadata and the final %s receipt remove that action", async outcome => {
    saveKnownRejection(); const metadata = deferred<Response>(), recheck = deferred<Response>();
    render(<FileMigrationsPage />); await initialReadsSettled();
    const origin = await enabled("Review a new migration plan");
    network.mockImplementation(async (path, options) => {
      if (String(path) === "/api/settings/storage?version=3") return metadata.promise;
      if (String(path) === `${base}/requests/${requestId}`) return recheck.promise;
      return fallback(path, options);
    });
    origin.focus(); fireEvent.click(origin); await waitFor(() => expect(origin.matches(":disabled")).toBe(true)); focusBody();
    expect(reads()).toHaveLength(1); expectLocked();
    await act(async () => metadata.resolve(json(settings())));
    await waitFor(() => expect(reads()).toHaveLength(2)); expect(document.activeElement).toBe(document.body); expectLocked();
    if (outcome === "accepted") jobs = [job()];
    await act(async () => recheck.resolve(outcome === "accepted" ? json(receipt()) : missing()));
    const target = outcome === "accepted" ? await enabled("Pause job") : screen.getByLabelText("Migration destination");
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(origin.isConnected).toBe(false); expect(target.matches(":disabled")).toBe(false); expect(posts()).toHaveLength(0);
    expect(history()).toEqual([{ input: original, jobId: outcome === "accepted" ? job().id : null }]);
  });

  it.each(["Check original migration request", "Review a new migration plan"] as const)(
    "preserves a move away from focused %s even if focus returns to the body before settlement", async label => {
      saveKnownRejection(); const recheck = deferred<Response>();
      render(<FileMigrationsPage />); await initialReadsSettled(); const origin = await enabled(label);
      network.mockImplementation(async (path, options) => String(path) === `${base}/requests/${requestId}` ? recheck.promise : fallback(path, options));
      origin.focus(); fireEvent.click(origin); await waitFor(() => expect(origin.matches(":disabled")).toBe(true));
      const other = screen.getByRole("link", { name: "Storage settings" }); other.focus(); expect(document.activeElement).toBe(other); focusBody();
      if (label === "Check original migration request") jobs = [job()];
      await act(async () => recheck.resolve(label === "Check original migration request" ? json(receipt()) : missing()));
      await waitFor(() => expect(origin.isConnected).toBe(false));
      if (label === "Check original migration request") await enabled("Pause job");
      else await waitFor(() => expect(screen.getByLabelText("Migration destination").matches(":disabled")).toBe(false));
      expect(document.activeElement).toBe(document.body); expect(posts()).toHaveLength(0);
    });

  it("retains the original request when refreshed metadata fails before explicit replanning can perform its final receipt check", async () => {
    saveKnownRejection(); render(<FileMigrationsPage />); await initialReadsSettled(); await enabled("Review a new migration plan");
    network.mockImplementation(async (path, options) => String(path) === `${base}/files`
      ? json({ secret: "PRIVATE_INVENTORY_FAILURE" }, 500) : fallback(path, options));
    fireEvent.click(await enabled("Review a new migration plan"));
    await screen.findByText("Storage profiles and File inventory could not be read. Retry only refreshes metadata; it does not start a migration.");
    await enabled("Check original migration request"); expectLocked(); expect(reads()).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem(rejectionKey)!)).toEqual(marker()); expect(history()).toEqual([]); expect(posts()).toHaveLength(0);
  });

  it("reads a late accepted earlier request without changing a different pending migration or its rejection marker", async () => {
    const current: AcceptFileMigrationInput = { requestId: "current:request", fileIds: ["file:1"], target: { profileId: "source", configurationRevision: 1 } };
    const preserved = { input: { ...original, requestId: "even:earlier" }, jobId: "even:earlier:job" };
    sessionStorage.setItem(intentKey, JSON.stringify(current)); sessionStorage.setItem(rejectionKey, JSON.stringify(marker(current)));
    sessionStorage.setItem(historyKey, JSON.stringify([{ input: original, jobId: null }, preserved]));
    const pendingBytes = sessionStorage.getItem(intentKey), markerBytes = sessionStorage.getItem(rejectionKey), late = deferred<Response>();
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}/requests/${encodeURIComponent(current.requestId)}`) return json({ schema: "file-migration-request-absent/1", requestId: current.requestId }, 404);
      if (String(path) === `${base}/requests/${requestId}`) return late.promise;
      return fallback(path, options);
    });
    render(<FileMigrationsPage />); await initialReadsSettled(); await enabled("Review a new migration plan");
    expect(reads()).toHaveLength(0);
    fireEvent.click(await enabled(`Check earlier request ${requestId}`)); await waitFor(() => expect(reads()).toHaveLength(1));
    expect(history()).toEqual([{ input: original, jobId: null }, preserved]);
    jobs = [job()]; await act(async () => late.resolve(json(receipt())));
    await screen.findByText(`Earlier request ${requestId} has saved migration ${job().id}. Its original work is retained.`);
    await enabled(`Check earlier request ${requestId}`);
    expect(history()).toEqual([preserved, { input: original, jobId: job().id }]);
    expect(sessionStorage.getItem(intentKey)).toBe(pendingBytes); expect(sessionStorage.getItem(rejectionKey)).toBe(markerBytes);
    expect(screen.getByLabelText("Migration destination").matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Check original migration request" })).toBeTruthy();
    expect(posts()).toHaveLength(0); expect(calls("/plans", "POST")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("PRIVATE");
  });

  it("rejects an earlier receipt that would replace its already retained accepted job", async () => {
    saveKnownRejection(); const prior = { input: { ...original, requestId: "earlier:accepted" }, jobId: "earlier:accepted:job" };
    sessionStorage.setItem(historyKey, JSON.stringify([prior]));
    const pendingBytes = sessionStorage.getItem(intentKey), markerBytes = sessionStorage.getItem(rejectionKey), historyBytes = sessionStorage.getItem(historyKey);
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}/requests/${encodeURIComponent(prior.input.requestId)}`) {
        return json({ requestId: prior.input.requestId, input: prior.input, job: { ...job(), id: "different:accepted:job" } });
      }
      return fallback(path, options);
    });
    render(<FileMigrationsPage />); await initialReadsSettled(); await enabled("Review a new migration plan");
    fireEvent.click(await enabled(`Check earlier request ${prior.input.requestId}`));
    await screen.findByRole("alert"); await enabled(`Check earlier request ${prior.input.requestId}`);
    expect(sessionStorage.getItem(historyKey)).toBe(historyBytes); expect(sessionStorage.getItem(intentKey)).toBe(pendingBytes);
    expect(sessionStorage.getItem(rejectionKey)).toBe(markerBytes); expectLocked();
    expect(screen.queryByText("different:accepted:job")).toBeNull(); expect(screen.getByText(prior.jobId)).toBeTruthy();
    expect(calls(`/requests/${encodeURIComponent(prior.input.requestId)}`, "GET")).toHaveLength(1); expect(posts()).toHaveLength(0);
  });

  it.each(["missing", "accepted"] as const)("keeps the original checkpoint if history cannot be saved after the %s receipt check", async outcome => {
    saveKnownRejection(); render(<FileMigrationsPage />); await initialReadsSettled(); await enabled("Review a new migration plan");
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === historyKey) throw new DOMException("PRIVATE_STORAGE_QUOTA", "QuotaExceededError");
      return write.call(this, key, value);
    });
    network.mockImplementation(async (path, options) => String(path) === `${base}/requests/${requestId}`
      ? outcome === "accepted" ? json(receipt()) : missing() : fallback(path, options));
    fireEvent.click(await enabled("Review a new migration plan"));
    await screen.findByText("Browser request checkpoints could not be retained. Keep the original migration request and restore session storage before continuing.");
    await enabled("Check original migration request"); expectLocked();
    expect(JSON.parse(sessionStorage.getItem(rejectionKey)!)).toEqual(marker()); expect(history()).toEqual([]); expect(posts()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("accepted. You can leave");
  });

  it.each(["missing", "accepted"] as const)("does not retire the original request when its pending replan read returns %s after unmount", async outcome => {
    saveKnownRejection(); const recheck = deferred<Response>();
    const mounted = render(<FileMigrationsPage />); await initialReadsSettled(); await enabled("Review a new migration plan");
    network.mockImplementation(async (path, options) => String(path) === `${base}/requests/${requestId}` ? recheck.promise : fallback(path, options));
    fireEvent.click(await enabled("Review a new migration plan")); await waitFor(() => expect(reads()).toHaveLength(2));
    const signal = reads()[1][1]?.signal; expect(signal?.aborted).toBe(false);
    mounted.unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => recheck.resolve(outcome === "accepted" ? json(receipt()) : missing()));
    expect(pending()).toEqual(original); expect(JSON.parse(sessionStorage.getItem(rejectionKey)!)).toEqual(marker());
    expect(history()).toEqual([]); expect(posts()).toHaveLength(0);
  });
});
