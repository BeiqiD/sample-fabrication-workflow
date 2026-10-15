import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentStorageSettingsStatus } from "../shared/contracts/current-storage-settings";
import type { AcceptFileMigrationInput, FileJobStatus, FileMigrationItems, FileMigrationPlan } from "../shared/contracts/file-jobs";
import { FileMigrationsPage } from "./pages/FileMigrationsPage";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const network = vi.fn<typeof fetch>(), base = "/api/files/migrations", intentKey = "file-migration-acceptance";
const at = "2026-10-05T00:00:00.000Z", bytes = 1024 * 1024;
const settings = (): CurrentStorageSettingsStatus => ({ version: 3, kind: "storage-settings-status", readOnly: true, health: "not_checked",
  authority: { mode: "active", shadowConversions: "paused", fileAccess: "enabled" },
  roleDefaults: { state: "configured", policyRevision: 3, internal: { profileId: "source", adapterType: "r2", availability: "available" },
    originals: { profileId: "destination", adapterType: "s3", availability: "available" } },
  bindings: { r2: { configuration: "configured" }, managed: { provider: "none", configuration: "missing" } },
  profiles: { items: [
    { id: "source", adapterType: "r2", configurationRevision: 1, runtimeAccess: "read_write", bindingMatch: "matched", bindingRevision: null, availability: "available" },
    { id: "destination", adapterType: "s3", configurationRevision: 1, runtimeAccess: "read_write", bindingMatch: "matched", bindingRevision: 1, availability: "available" },
    { id: "unavailable", adapterType: "s3", configurationRevision: 1, runtimeAccess: "read_write", bindingMatch: "mismatch", bindingRevision: null, availability: "unavailable" },
  ], hasMore: false, limit: 100 } });
const job = (state: FileJobStatus["state"] = "queued"): FileJobStatus => ({ id: "job:1", actor: "private-admin@example.test", state,
  target: { profileId: "destination", configurationRevision: 1 }, acceptedAt: at, updatedAt: at, reason: null,
  moved: 0, remaining: 1, failed: 0, cleanupPending: 0 });
const details = (): FileMigrationItems => ({ items: [{ fileId: "file:1", purpose: "research_source", state: "copying", reason: "write_settlement_required",
  sourceLocationId: "location:1", sourceProfileId: "source", destinationLocationId: null, byteSize: bytes, sha256: "a".repeat(64),
  attempt: { id: "attempt:1", state: "unknown", settled: false }, attemptState: "unknown", attemptCount: 1, maxAttempts: 5,
  artifactCleanupPending: 1, sourceCleanupPending: false,
  cleanupState: "not_requested", cleanup: { requestedAt: null, notBefore: null, releasedToGcAt: null, deleted: false } }], hasMore: false });
const plan = (input: AcceptFileMigrationInput): FileMigrationPlan => ({ target: input.target, items: input.fileIds.map(fileId => ({ fileId,
  purpose: "research_source", sourceLocationId: `location:${fileId}`, sourceProfileId: "source", byteSize: bytes, sha256: "a".repeat(64), status: "eligible" })),
  bytes: bytes * input.fileIds.length, retainedSourceBytes: bytes * input.fileIds.length, stagingBytes: bytes * input.fileIds.length * 5,
  transferAndVerificationBytes: bytes * input.fileIds.length * 3, maxTransferAndVerificationBytes: bytes * input.fileIds.length * 15,
  maxAttemptsPerFile: 5, bytesVerified: false });
let jobs: FileJobStatus[], currentSettings: CurrentStorageSettingsStatus;
let executor: { enabled: boolean; stale: boolean; cadenceSeconds: 120; maxFilesPerStep: 1; maxStepMs: 60000; lastHeartbeatAt: string | null };
function fallback(path: RequestInfo | URL, options?: RequestInit): Response {
  const url = String(path);
  if (url === "/api/storage/configuration/capability") return json({ canManage: true, credentialEditingAvailable: true });
  if (url === "/api/settings/storage?version=3") return json(currentSettings);
  if (url === `${base}/files`) return json({ items: [{ fileId: "file:1", purpose: "research_source", byteSize: bytes,
    sha256: "a".repeat(64), profileId: "source", locationId: "location:1" }], nextCursor: null });
  if (url === `${base}/executor`) return json(executor);
  if (url === base && options?.method === "GET") return json({ jobs });
  if (url === `${base}/plans`) return json(plan(JSON.parse(String(options?.body))));
  if (url === `${base}/job%3A1/items`) return json(details());
  if (url.startsWith(`${base}/requests/`)) return json({ schema: "file-migration-request-absent/1", requestId: decodeURIComponent(url.slice(`${base}/requests/`.length)) }, 404);
  return json({}, 404);
}
const mutations = () => network.mock.calls.filter(([, options]) => options?.method === "POST");
const acceptCalls = () => mutations().filter(([path]) => path === base);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function choose() {
  await screen.findByRole("option", { name: "s3: destination" });
  expect(screen.queryByRole("option", { name: "s3: unavailable" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Migration destination"), { target: { value: "destination" } });
  fireEvent.click(screen.getByRole("checkbox"));
}
async function preview() {
  await choose(); fireEvent.click(screen.getByRole("button", { name: "Preview migration" }));
  const start = await screen.findByRole("button", { name: "Start migration" });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false)); return start;
}
beforeEach(() => {
  sessionStorage.clear(); jobs = []; currentSettings = settings();
  executor = { enabled: true, stale: false, cadenceSeconds: 120, maxFilesPerStep: 1, maxStepMs: 60000, lastHeartbeatAt: at };
  network.mockReset(); network.mockImplementation(async (path, options) => fallback(path, options)); vi.stubGlobal("fetch", network);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe("saved File migrations", () => {
  it("moves a focused Start to only its accepted migration's Pause after the original receipt and saved-job refresh settle", async () => {
    const acceptance = deferred<Response>(), list = deferred<Response>(); let holdList = false;
    const other = { ...job(), id: "other:job" }; jobs = [other];
    network.mockImplementation(async (path, options) => {
      if (String(path) === base && options?.method === "POST") return acceptance.promise;
      if (String(path) === base && options?.method === "GET" && holdList) return list.promise;
      return fallback(path, options);
    });
    render(<FileMigrationsPage />); const start = await preview(); start.focus(); fireEvent.click(start);
    await waitFor(() => expect(start.matches(":disabled")).toBe(true));
    const submitted = JSON.parse(String(acceptCalls()[0][1]?.body)), accepted = { ...job(), target: submitted.target };
    // Model the body focus seen in the original Start202 Chromium failure, without claiming another browser run.
    const originalTabIndex = document.body.getAttribute("tabindex");
    try {
      document.body.tabIndex = -1; document.body.focus(); expect(document.activeElement).toBe(document.body);
      jobs = [accepted, other]; holdList = true; await act(async () => acceptance.resolve(json(accepted, 202)));
      await waitFor(() => expect(start.isConnected).toBe(false));
      expect(document.activeElement).toBe(document.body);
      expect(screen.queryByRole("heading", { name: "job:1" })).toBeNull();
      await act(async () => { holdList = false; list.resolve(json({ jobs })); });
      const row = screen.getByRole("heading", { name: "job:1" }).closest("li")!, pause = within(row).getByRole("button", { name: "Pause job" });
      await waitFor(() => expect(document.activeElement).toBe(pause)); expect(pause.isConnected).toBe(true); expect(pause.matches(":disabled")).toBe(false);
      expect(document.activeElement).not.toBe(within(screen.getByRole("heading", { name: "other:job" }).closest("li")!).getByRole("button", { name: "Pause job" }));
      expect(acceptCalls()).toHaveLength(1); expect(mutations().map(([path]) => path)).toEqual([`${base}/plans`, base]);
      expect(JSON.parse(String(acceptCalls()[0][1]?.body))).toEqual(submitted); expect(sessionStorage.getItem(intentKey)).toBeNull();
    } finally {
      if (originalTabIndex === null) document.body.removeAttribute("tabindex"); else document.body.setAttribute("tabindex", originalTabIndex);
    }
  });

  it("preserves a move away from pending Start even if focus returns to the body before its accepted migration appears", async () => {
    const acceptance = deferred<Response>();
    network.mockImplementation(async (path, options) => String(path) === base && options?.method === "POST" ? acceptance.promise : fallback(path, options));
    render(<FileMigrationsPage />); const start = await preview(); start.focus(); fireEvent.click(start);
    await waitFor(() => expect(start.matches(":disabled")).toBe(true));
    const other = screen.getByRole("link", { name: "Storage settings" }); other.focus(); expect(document.activeElement).toBe(other);
    const originalTabIndex = document.body.getAttribute("tabindex");
    try {
      document.body.tabIndex = -1; document.body.focus(); expect(document.activeElement).toBe(document.body);
      jobs = [job()]; await act(async () => acceptance.resolve(json(jobs[0], 202)));
      const pause = await screen.findByRole("button", { name: "Pause job" }); await waitFor(() => expect(pause.matches(":disabled")).toBe(false));
      expect(document.activeElement).toBe(document.body); expect(acceptCalls()).toHaveLength(1); expect(sessionStorage.getItem(intentKey)).toBeNull();
    } finally {
      if (originalTabIndex === null) document.body.removeAttribute("tabindex"); else document.body.setAttribute("tabindex", originalTabIndex);
    }
  });

  it("does not transfer accepted Start focus to a refreshed job with the same id but a different acceptance", async () => {
    const acceptance = deferred<Response>(), accepted = job();
    network.mockImplementation(async (path, options) => String(path) === base && options?.method === "POST" ? acceptance.promise : fallback(path, options));
    render(<FileMigrationsPage />); const start = await preview(); start.focus(); fireEvent.click(start);
    await waitFor(() => expect(start.matches(":disabled")).toBe(true));
    const originalTabIndex = document.body.getAttribute("tabindex");
    try {
      document.body.tabIndex = -1; document.body.focus();
      jobs = [{ ...accepted, acceptedAt: "2026-10-05T00:00:01.000Z", updatedAt: "2026-10-05T00:00:01.000Z" }];
      await act(async () => acceptance.resolve(json(accepted, 202)));
      const pause = await screen.findByRole("button", { name: "Pause job" }); await waitFor(() => expect(pause.matches(":disabled")).toBe(false));
      expect(document.activeElement).toBe(document.body); expect(acceptCalls()).toHaveLength(1); expect(sessionStorage.getItem(intentKey)).toBeNull();
    } finally {
      if (originalTabIndex === null) document.body.removeAttribute("tabindex"); else document.body.setAttribute("tabindex", originalTabIndex);
    }
  });

  it("does not apply a late prior page's accepted Start focus after the same migration identifier is remounted", async () => {
    const acceptance = deferred<Response>();
    network.mockImplementation(async (path, options) => String(path) === base && options?.method === "POST" ? acceptance.promise : fallback(path, options));
    const first = render(<FileMigrationsPage />); const start = await preview(); start.focus(); fireEvent.click(start);
    await waitFor(() => expect(start.matches(":disabled")).toBe(true));
    const signal = acceptCalls()[0][1]?.signal; first.unmount(); expect(signal?.aborted).toBe(true);
    jobs = [job()]; render(<FileMigrationsPage />); await screen.findByRole("button", { name: "Pause job" });
    const other = screen.getByRole("link", { name: "Storage settings" }); other.focus();
    await act(async () => acceptance.resolve(json(jobs[0], 202)));
    expect(document.activeElement).toBe(other); expect(acceptCalls()).toHaveLength(1);
    expect(sessionStorage.getItem(intentKey)).not.toBeNull(); expect(screen.getByRole("button", { name: "Check original migration request" })).toBeTruthy();
  });

  it("denies nonadministrators before reading inventory or invoking saved work", async () => {
    sessionStorage.setItem(intentKey, JSON.stringify({ requestId: "previous", fileIds: ["file:1"], target: job().target }));
    network.mockResolvedValue(json({ canManage: false, credentialEditingAvailable: false }));
    render(<FileMigrationsPage />); await screen.findByText("System administrator access is required to manage File migrations.");
    expect(network).toHaveBeenCalledOnce(); expect(screen.queryByRole("combobox")).toBeNull(); expect(mutations()).toHaveLength(0);
    expect(sessionStorage.getItem(intentKey)).not.toBeNull();
  });

  it("previews bounded metadata and blocks an ineligible File without executing work", async () => {
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}/plans`) { const value = plan(JSON.parse(String(options?.body)));
        value.items[0].sourceProfileId = "destination"; value.items[0].status = "same_profile"; return json(value); }
      return fallback(path, options);
    });
    render(<FileMigrationsPage />); await choose(); fireEvent.click(screen.getByRole("button", { name: "Preview migration" }));
    const start = await screen.findByRole("button", { name: "Start migration" }); expect((start as HTMLButtonElement).disabled).toBe(true);
    await screen.findByText("file:1: Already on the destination profile");
    expect(screen.getByText(/One pass transfers and verifies 3.00 MiB/)).toBeTruthy();
    expect(screen.getByText(/Up to 5 attempts per file may use 15.00 MiB/)).toBeTruthy();
    expect(mutations().map(([path]) => path)).toEqual([`${base}/plans`]); expect(acceptCalls()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("private-admin");
  });

  it("returns keyboard focus to the same Preview button after a delayed metadata preview", async () => {
    const response = deferred<Response>();
    network.mockImplementation(async (path, options) => String(path) === `${base}/plans` ? response.promise : fallback(path, options));
    render(<FileMigrationsPage />); await choose();
    const button = screen.getByRole("button", { name: "Preview migration" }); button.focus();
    expect(document.activeElement).toBe(button); fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    // Model the native Chromium blur observed when the focused action becomes disabled.
    const originalTabIndex = document.body.getAttribute("tabindex");
    try {
      document.body.setAttribute("tabindex", "-1"); document.body.focus(); expect(document.activeElement).toBe(document.body);
      const submitted = JSON.parse(String(mutations()[0][1]?.body));
      await act(async () => response.resolve(json(plan(submitted))));
      await waitFor(() => expect(document.activeElement).toBe(button));
      expect((button as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByRole("button", { name: "Start migration" })).toBeTruthy();
      expect(mutations().map(([path]) => path)).toEqual([`${base}/plans`]); expect(acceptCalls()).toHaveLength(0);
    } finally {
      if (originalTabIndex === null) document.body.removeAttribute("tabindex"); else document.body.setAttribute("tabindex", originalTabIndex);
    }
  });

  it("keeps focus on another native control when a delayed Preview completes", async () => {
    const response = deferred<Response>();
    network.mockImplementation(async (path, options) => String(path) === `${base}/plans` ? response.promise : fallback(path, options));
    render(<FileMigrationsPage />); await choose();
    const button = screen.getByRole("button", { name: "Preview migration" }); button.focus(); fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    const other = screen.getByRole("link", { name: "Storage settings" }); other.focus(); expect(document.activeElement).toBe(other);
    const submitted = JSON.parse(String(mutations()[0][1]?.body));
    await act(async () => response.resolve(json(plan(submitted))));
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(document.activeElement).toBe(other);
    expect(mutations().map(([path]) => path)).toEqual([`${base}/plans`]); expect(acceptCalls()).toHaveLength(0);
  });

  it("keeps same-job keyboard continuity through delayed Pause, Resume and Cancel after status refresh settles", async () => {
    jobs = [job(), { ...job(), id: "job:2" }];
    let controlReply = deferred<Response>(), listReply = deferred<Response>(), holdList = false;
    network.mockImplementation(async (path, options) => {
      if (String(path).startsWith(`${base}/job%3A1/`) && options?.method === "POST") return controlReply.promise;
      if (String(path) === base && options?.method === "GET" && holdList) return listReply.promise;
      return fallback(path, options);
    });
    render(<FileMigrationsPage />); await screen.findByRole("button", { name: "View files in job:1" });
    const row = screen.getByRole("heading", { name: "job:1" }).closest("li")!;
    const otherRow = screen.getByRole("heading", { name: "job:2" }).closest("li")!;
    expect(document.activeElement).toBe(document.body);
    const originalTabIndex = document.body.getAttribute("tabindex");
    try {
      for (const [index, action, label, state, nextLabel] of [
        [1, "pause", "Pause job", "paused", "Resume job"],
        [2, "resume", "Resume job", "queued", "Pause job"],
        [3, "cancel", "Cancel remaining files", "cancelled", null],
      ] as const) {
        controlReply = deferred<Response>(); listReply = deferred<Response>();
        const origin = within(row).getByRole("button", { name: label }); origin.focus(); fireEvent.click(origin);
        await waitFor(() => expect((origin as HTMLButtonElement).disabled).toBe(true));
        expect(mutations().at(-1)?.[0]).toBe(`${base}/job%3A1/${action}`);
        // Model the native disabled-control blur seen in the original Chromium characterization.
        document.body.setAttribute("tabindex", "-1"); document.body.focus(); expect(document.activeElement).toBe(document.body);
        jobs = [{ ...jobs[0], state, updatedAt: `2026-10-05T00:00:0${index}.000Z` }, jobs[1]]; holdList = true;
        await act(async () => controlReply.resolve(json(jobs[0])));
        await waitFor(() => expect(network.mock.calls.filter(([path, options]) => path === base && options?.method === "GET").length).toBe(index + 1));
        expect(document.activeElement).toBe(document.body); expect((origin as HTMLButtonElement).disabled).toBe(true);
        holdList = false; await act(async () => listReply.resolve(json({ jobs })));
        const next = nextLabel ? within(row).getByRole("button", { name: nextLabel }) : within(row).getByRole("status");
        await waitFor(() => expect(document.activeElement).toBe(next));
        expect(next.isConnected).toBe(true); expect(origin.isConnected).toBe(false);
        expect(document.activeElement).not.toBe(within(otherRow).getByRole("button", { name: "Pause job" }));
        expect(mutations().map(([path]) => path)).toEqual(["pause", "resume", "cancel"].slice(0, index).map(action => `${base}/job%3A1/${action}`));
      }
      expect(within(row).queryByRole("button", { name: "Resume job" })).toBeNull();
      expect(within(row).getByRole("status").textContent).toContain("cancelled");
      expect(acceptCalls()).toHaveLength(0);
    } finally {
      if (originalTabIndex === null) document.body.removeAttribute("tabindex"); else document.body.setAttribute("tabindex", originalTabIndex);
    }
  });

  it("does not reclaim job focus after the user moves elsewhere even if focus later returns to the body", async () => {
    jobs = [job()]; const response = deferred<Response>();
    network.mockImplementation(async (path, options) => String(path) === `${base}/job%3A1/pause` ? response.promise : fallback(path, options));
    render(<FileMigrationsPage />); const origin = await screen.findByRole("button", { name: "Pause job" });
    origin.focus(); fireEvent.click(origin); await waitFor(() => expect((origin as HTMLButtonElement).disabled).toBe(true));
    const other = screen.getByRole("link", { name: "Storage settings" }); other.focus(); expect(document.activeElement).toBe(other);
    const originalTabIndex = document.body.getAttribute("tabindex");
    try {
      document.body.setAttribute("tabindex", "-1"); document.body.focus(); expect(document.activeElement).toBe(document.body);
      jobs = [{ ...job("paused"), updatedAt: "2026-10-05T00:00:01.000Z" }];
      await act(async () => response.resolve(json(jobs[0])));
      const next = await screen.findByRole("button", { name: "Resume job" });
      await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
      expect(document.activeElement).toBe(document.body); expect(mutations().map(([path]) => path)).toEqual([`${base}/job%3A1/pause`]);
    } finally {
      if (originalTabIndex === null) document.body.removeAttribute("tabindex"); else document.body.setAttribute("tabindex", originalTabIndex);
    }
  });

  it("returns a failed delayed job control to its original enabled button without replay", async () => {
    jobs = [job()]; const response = deferred<Response>();
    network.mockImplementation(async (path, options) => String(path) === `${base}/job%3A1/pause` ? response.promise : fallback(path, options));
    render(<FileMigrationsPage />); const origin = await screen.findByRole("button", { name: "Pause job" });
    origin.focus(); fireEvent.click(origin); await waitFor(() => expect((origin as HTMLButtonElement).disabled).toBe(true));
    const originalTabIndex = document.body.getAttribute("tabindex");
    try {
      document.body.setAttribute("tabindex", "-1"); document.body.focus(); expect(document.activeElement).toBe(document.body);
      await act(async () => response.resolve(json({ error: "private-provider-detail" }, 503)));
      await screen.findByRole("alert"); await waitFor(() => expect(document.activeElement).toBe(origin));
      expect((origin as HTMLButtonElement).disabled).toBe(false); expect(origin.isConnected).toBe(true);
      expect(screen.queryByRole("button", { name: "Resume job" })).toBeNull();
      expect(document.body.textContent).not.toContain("private-provider-detail");
      expect(mutations().map(([path]) => path)).toEqual([`${base}/job%3A1/pause`]);
    } finally {
      if (originalTabIndex === null) document.body.removeAttribute("tabindex"); else document.body.setAttribute("tabindex", originalTabIndex);
    }
  });

  it("does not transfer a late cancelled page's job focus to the same identifier after remount", async () => {
    jobs = [job()]; const response = deferred<Response>();
    network.mockImplementation(async (path, options) => String(path) === `${base}/job%3A1/pause` ? response.promise : fallback(path, options));
    const mounted = render(<FileMigrationsPage />); const origin = await screen.findByRole("button", { name: "Pause job" });
    origin.focus(); fireEvent.click(origin); await waitFor(() => expect((origin as HTMLButtonElement).disabled).toBe(true));
    const originalSignal = mutations()[0][1]?.signal; mounted.unmount(); expect(originalSignal?.aborted).toBe(true);
    render(<FileMigrationsPage />); const current = await screen.findByRole("button", { name: "Pause job" });
    const other = screen.getByRole("link", { name: "Storage settings" }); other.focus();
    jobs = [{ ...job("paused"), updatedAt: "2026-10-05T00:00:01.000Z" }];
    await act(async () => response.resolve(json(jobs[0])));
    expect(document.activeElement).toBe(other); expect(current.isConnected).toBe(true); expect(origin.isConnected).toBe(false);
    expect((current as HTMLButtonElement).disabled).toBe(false); expect(screen.queryByRole("button", { name: "Resume job" })).toBeNull();
    expect(mutations().map(([path]) => path)).toEqual([`${base}/job%3A1/pause`]);
  });

  it("reconciles a lost acceptance response with its original receipt across remount without a second POST", async () => {
    let original: AcceptFileMigrationInput | null = null;
    network.mockImplementation(async (path, options) => {
      if (String(path) === base && options?.method === "POST") {
        const submitted = JSON.parse(String(options.body)); expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(submitted);
        original = submitted; jobs = [job()]; throw new Error("private-provider-detail");
      }
      if (original && String(path) === `${base}/requests/${original.requestId}`) return json({ requestId: original.requestId, input: original, job: job() });
      return fallback(path, options);
    });
    const mounted = render(<FileMigrationsPage />); fireEvent.click(await preview());
    await screen.findByRole("button", { name: "Check original migration request" });
    await waitFor(() => expect(screen.getByText(/request is unavailable/)).toBeTruthy());
    const submitted = JSON.parse(String(acceptCalls()[0][1]?.body)); expect(sessionStorage.getItem(intentKey)).not.toBeNull();
    expect(document.body.textContent).not.toContain("private-provider-detail"); mounted.unmount();
    currentSettings.profiles.items[1].availability = "unavailable"; currentSettings.profiles.items[1].bindingMatch = "mismatch";
    currentSettings.profiles.items[1].bindingRevision = null; currentSettings.roleDefaults.originals!.availability = "unavailable";
    render(<FileMigrationsPage />); await screen.findByRole("button", { name: "View files in job:1" });
    await waitFor(() => expect(sessionStorage.getItem(intentKey)).toBeNull());
    expect(network.mock.calls.filter(([path]) => String(path) === `${base}/requests/${submitted.requestId}`)).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem("file-migration-earlier-requests")!)).toEqual([{ input: submitted, jobId: "job:1" }]);
    expect(screen.getByText(/Migration job:1 accepted/)).toBeTruthy(); expect(acceptCalls()).toHaveLength(1);
  });

  it("aborts the browser request while keeping accepted work and the original retry intent durable", async () => {
    const response = deferred<Response>();
    network.mockImplementation(async (path, options) => {
      if (String(path) === base && options?.method === "POST") { jobs = [job("running")]; return response.promise; }
      return fallback(path, options);
    });
    const mounted = render(<FileMigrationsPage />); fireEvent.click(await preview()); await waitFor(() => expect(acceptCalls()).toHaveLength(1));
    const signal = acceptCalls()[0][1]?.signal; mounted.unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => response.resolve(json(job("running"), 202))); expect(sessionStorage.getItem(intentKey)).not.toBeNull();
    render(<FileMigrationsPage />); await screen.findByRole("button", { name: "Pause job" });
    expect(screen.getByRole("button", { name: "Check original migration request" })).toBeTruthy(); expect(acceptCalls()).toHaveLength(1);
  });

  it("keeps cancel and source cleanup separate explicit controls and never resumes a recovered paused job automatically", async () => {
    jobs = [{ ...job("paused"), cleanupPending: 1, reason: "operator_paused" }];
    network.mockImplementation(async (path, options) => {
      if (String(path) === `${base}/job%3A1/cancel`) { jobs = [{ ...jobs[0], state: "cancelled", reason: "operator_cancelled" }]; return json(jobs[0]); }
      if (String(path) === `${base}/job%3A1/cleanup`) return json(jobs[0]);
      return fallback(path, options);
    });
    render(<FileMigrationsPage />); await screen.findByRole("button", { name: "Resume job" }); expect(mutations()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel remaining files" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Resume job" })).toBeNull());
    expect(mutations().map(([path]) => path)).toEqual([`${base}/job%3A1/cancel`]);
    fireEvent.click(screen.getByRole("button", { name: "Request source cleanup" }));
    await waitFor(() => expect(mutations()).toHaveLength(2));
    expect(mutations().map(([path]) => path)).toEqual([`${base}/job%3A1/cancel`, `${base}/job%3A1/cleanup`]);
  });

  it("polls saved progress and heartbeat only, shows uncertain writes, and stops all reads on unmount", async () => {
    vi.useFakeTimers(); jobs = [{ ...job("paused"), reason: "write_settlement_required" }]; executor.stale = true;
    let mounted!: ReturnType<typeof render>;
    await act(async () => { mounted = render(<FileMigrationsPage />); for (let i = 0; i < 30; i++) await Promise.resolve(); });
    expect(screen.getByText(/Enabled, but no recent heartbeat/)).toBeTruthy(); expect(mutations()).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "View files in job:1" })); for (let i = 0; i < 20; i++) await Promise.resolve(); });
    expect(screen.getByText(/previous write has not been confirmed/)).toBeTruthy(); expect(screen.getByText(/1\/5 attempts/)).toBeTruthy();
    jobs = [{ ...job("completed"), moved: 1, remaining: 0, cleanupPending: 1 }]; executor.stale = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText(/completed · 1 moved · 0 remaining/)).toBeTruthy(); expect(mutations()).toHaveLength(0);
    const calls = network.mock.calls.length, signals = network.mock.calls.map(([, options]) => options?.signal).filter(Boolean);
    mounted.unmount(); expect(signals.every(signal => signal?.aborted)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); expect(network).toHaveBeenCalledTimes(calls);
  });

  it("removes controls after administrator revocation and hides private server errors", async () => {
    jobs = [job("running")]; network.mockImplementation(async (path, options) =>
      String(path) === `${base}/job%3A1/pause` ? json({ error: "private-credential-detail" }, 403) : fallback(path, options));
    render(<FileMigrationsPage />); fireEvent.click(await screen.findByRole("button", { name: "Pause job" }));
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull()); expect(screen.queryByRole("button", { name: "Pause job" })).toBeNull();
    expect(document.body.textContent).toContain("System administrator access is required");
    expect(document.body.textContent).not.toContain("private-credential-detail"); expect(mutations()).toHaveLength(1);
  });

  it("explains exhausted retry history while retaining independent review and cleanup controls", async () => {
    jobs = [{ ...job("paused"), remaining: 0, failed: 1, cleanupPending: 1, reason: "retry_limit_exhausted" }];
    render(<FileMigrationsPage />); const retry = await screen.findByRole("button", { name: "Retry failed files" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/reached its five-attempt limit. Review the files before planning another migration/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Request source cleanup" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "View files in job:1" })).toBeTruthy(); expect(mutations()).toHaveLength(0);
  });

  it("keeps a released temporary copy pending until physical cleanup while the original source stays usable", async () => {
    jobs = [{ ...job("paused"), remaining: 0, failed: 1, cleanupPending: 1 }]; const value = details();
    Object.assign(value.items[0], { state: "failed", attemptState: "failed", attempt: { id: "attempt:1", state: "failed", settled: true },
      cleanupState: "released_to_gc", cleanup: { requestedAt: at, notBefore: at, releasedToGcAt: at, deleted: false } });
    network.mockImplementation(async (path, options) => String(path) === `${base}/job%3A1/items` ? json(value) : fallback(path, options));
    render(<FileMigrationsPage />); fireEvent.click(await screen.findByRole("button", { name: "View files in job:1" }));
    await screen.findByText("1 temporary copy is awaiting physical cleanup."); expect(screen.getByText(/cleanup released to gc/)).toBeTruthy();
    value.items[0].artifactCleanupPending = 0; value.items[0].cleanupState = "complete"; jobs[0].cleanupPending = 0;
    await waitFor(() => expect((screen.getByRole("button", { name: /^Refresh$/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /^Refresh$/ }));
    await screen.findByText(/cleanup complete/); expect(screen.queryByText("1 temporary copy is awaiting physical cleanup.")).toBeNull();
    expect(value.items[0].cleanup.deleted).toBe(false); expect(mutations()).toHaveLength(0);
  });
});
