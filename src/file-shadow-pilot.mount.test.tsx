import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileShadowPilotPage } from "./pages/FileShadowPilotPage";
import { sha256Hex, stableJson } from "../shared/domain/content-addressing";
import type { PilotJournal } from "./lib/file-shadow-pilot-client";

const incarnation = "11111111-1111-4111-8111-111111111111";
const hash = "a".repeat(64);
const journalKey = "file-shadow-pilot-operation-v1";
const key = (id = "reference-a") => ({ consumerKind: "project_content_attachment", consumerId: id, consumerSubId: "", fileSlot: "primary" });
const frozenProfile = { profileId: "registered-r2-profile", configurationRevision: 1 };
const profile = (runtimeState = "read_write") => ({
  id: frozenProfile.profileId, adapter_type: "r2", configuration_revision: 1,
  namespace_identity: JSON.stringify({ kind: "cloudflare-r2", accountId: "b".repeat(32), bucketName: "existing-bucket" }),
  configuration_source: "bootstrap", credential_reference: null, runtime_state: runtimeState,
});
const runtime = (enabled = 1) => ({ incarnation, enabled, enabled_by: "operator@example.test", updated_at: "2026-09-27T22:00:00.000Z" });
function status(enabled = 1, mode = "overlap") {
  return { mode, epoch: 10, ...runtime(enabled), current_count: 2, resolved_count: 0,
    unresolved_count: 0, pending_count: 2, unfinished_attempts: 0 };
}
function baseline(id = "reference-a", runtimeState = "read_write") {
  const identity = key(id), locator = { storeKind: "r2", provider: "r2", objectKey: "private-source-object-key" };
  return {
    version: 1, kind: "file-shadow-baseline", bytesVerified: false, key: identity,
    schemaSha256: "b".repeat(64), authority: { singleton: 1, revision: 1, mode: "overlap" }, epoch: 10,
    runtime: runtime(), head: { consumer_kind: identity.consumerKind, consumer_id: id,
      consumer_sub_id: "", file_slot: "primary", generation: 1, occurrence_id: `occurrence-${id}`,
      present: 1, source_rowid: "1", source_sha256: hash, observed_epoch: 10 },
    record: { key: identity, source: { id, asset_id: "asset-a" }, related: {}, fileId: null, locator,
      registries: [{ id: "asset-a", byte_size: 157, sha256: hash, status: "ready" }], receipts: [],
      profiles: [profile(runtimeState)], mappings: [], lifecycle: [], retention: [], peers: [],
      purpose: "research_source", status: "ready_to_verify", reasons: [], baselineSha256: hash },
    decision: null, purpose: "research_source", sourceLocator: locator, sourceProfile: frozenProfile,
    status: "ready_to_verify", reasons: [] as string[], baselineSha256: hash,
  };
}
const row = (id: string) => ({ consumer_kind: key(id).consumerKind, consumer_id: id, consumer_sub_id: "", file_slot: "primary", generation: 1, occurrence_id: `occurrence-${id}`, state: "pending" });
function pending<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
type RequestRecord = { path: string; method: string; body: Record<string, unknown> | null };
type Handler = (request: RequestRecord) => unknown | Promise<unknown>;
const requests: RequestRecord[] = [];
const handlers = new Map<string, Handler>();
const network = vi.fn<typeof fetch>();
const writes = () => requests.filter(({ path }) => ["enable", "disable", "profiles/enable", "convert", "reconcile", "cancel", "withdraw"].some((command) => path === `/api/files/shadow/${command}`));

beforeEach(() => {
  localStorage.clear(); requests.length = 0; handlers.clear(); network.mockReset();
  handlers.set("/api/files/shadow/status", () => status());
  handlers.set("/api/files/shadow/consumers", () => ({ records: [row("reference-a"), row("reference-b")], nextCursor: null }));
  handlers.set("/api/files/shadow/baseline", (request) => baseline((request.body?.key as ReturnType<typeof key>).consumerId));
  network.mockImplementation(async (input, init) => {
    const path = new URL(String(input), "https://app.example.test").pathname;
    const request = { path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null };
    requests.push(request);
    const handler = handlers.get(path);
    if (!handler) throw new Error(`Unexpected request: ${request.method} ${path}`);
    const response = await handler(request);
    if (response instanceof Response) return response;
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", network);
  let held = false;
  Object.defineProperty(navigator, "locks", { configurable: true, value: {
    request: async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => {
      if (held) return callback(null);
      held = true;
      try { return await callback({ name: journalKey, mode: "exclusive" }); } finally { held = false; }
    },
  } });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount(strict = false) {
  const result = render(strict ? <StrictMode><FileShadowPilotPage /></StrictMode> : <FileShadowPilotPage />);
  await screen.findByRole("button", { name: "Inspect project_content_attachment reference-a (no sub-ID) primary" });
  return result;
}
async function inspect(id = "reference-a") {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: `Inspect project_content_attachment ${id} (no sub-ID) primary` })); });
}
async function confirmConversion() {
  fireEvent.click(screen.getByRole("checkbox", { name: "I have reviewed this reference, its purpose, byte size, SHA-256 and the exact R2 profile." }));
  const button = screen.getByRole("button", { name: "Convert this reference" }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  return button;
}
function receipt(operationId: string, attemptState = "unknown", id = "reference-a") {
  return { operationId, occurrenceId: `occurrence-${id}`, status: "pending", attemptId: "22222222-2222-4222-8222-222222222222", attemptState, fileId: null, locationId: null, nextAction: ["staged", "failed"].includes(attemptState) ? "inspect" : "reconcile" };
}
function saveUnknownJournal() {
  const journal: PilotJournal = { version: 1,
    request: { operationId: "33333333-3333-4333-8333-333333333333", key: key(), expectedBaselineSha256: hash,
      destinationProfile: frozenProfile as PilotJournal["request"]["destinationProfile"], runtimeIncarnation: incarnation },
    proof: { generation: 1, occurrenceId: "occurrence-reference-a", purpose: "research_source", expectedBytes: 157, expectedSha256: hash },
    receipt: null };
  localStorage.setItem(journalKey, JSON.stringify(journal));
  return journal;
}
async function withdrawn(request: PilotJournal["request"]) {
  return { operationId: request.operationId, status: "withdrawn", request, requestSha256: await sha256Hex(stableJson(request)),
    occurrenceId: null, attemptId: null, attemptState: null, fileId: null, locationId: null, nextAction: "none" };
}

describe("File shadow pilot explicit command and recovery boundaries", () => {
  it("keeps StrictMode mounting, list refresh and baseline reads free of commands", async () => {
    await mount(true);
    expect(writes()).toEqual([]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh status" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh list" })); });
    await inspect();
    expect(requests.some(({ path }) => path.endsWith("/baseline"))).toBe(true);
    expect(writes()).toEqual([]);
    expect(localStorage.getItem(journalKey)).toBeNull();
    expect((screen.getByRole("button", { name: "Convert this reference" }) as HTMLButtonElement).disabled).toBe(true);
    for (const privateValue of ["private-source-object-key", "existing-bucket", "operator@example.test"]) {
      expect(document.body.textContent).not.toContain(privateValue);
    }
  });

  it.each(["ambiguous", "non-r2"])("does not offer a conversion for %s evidence", async (kind) => {
    const evidence = baseline();
    if (kind === "ambiguous") { evidence.status = "ambiguous"; evidence.reasons = ["consumer_purpose_unresolved", "namespace_evidence_missing"]; }
    else { evidence.sourceLocator.provider = "switchdrive"; evidence.sourceLocator.storeKind = "managed"; evidence.record.profiles[0].adapter_type = "switchdrive"; }
    handlers.set("/api/files/shadow/baseline", () => evidence);
    await mount(); await inspect();
    const convert = screen.queryByRole("button", { name: "Convert this reference" }) as HTMLButtonElement | null;
    expect(convert === null || convert.disabled).toBe(true);
    expect(writes()).toEqual([]);
  });

  it("requires explicit overlap consent and rereads the baseline after enabling", async () => {
    handlers.set("/api/files/shadow/status", () => status(0, "legacy"));
    const beforeEnable = baseline();
    beforeEnable.authority.mode = "legacy"; beforeEnable.runtime.enabled = 0;
    handlers.set("/api/files/shadow/baseline", () => beforeEnable);
    handlers.set("/api/files/shadow/enable", () => {
      handlers.set("/api/files/shadow/status", () => status());
      const enabled = baseline(); enabled.baselineSha256 = "c".repeat(64);
      handlers.set("/api/files/shadow/baseline", () => enabled);
      return status();
    });
    await mount(); await inspect();
    const enable = screen.getByRole("button", { name: "Enable overlap" }) as HTMLButtonElement;
    expect(enable.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "I understand that overlap remains enabled after pausing." }));
    await act(async () => { fireEvent.click(enable); });
    expect(writes().map(({ path }) => path)).toEqual(["/api/files/shadow/enable"]);
    expect(requests.filter(({ path }) => path.endsWith("/baseline"))).toHaveLength(1);
    const oldConvert = screen.queryByRole("button", { name: "Convert this reference" }) as HTMLButtonElement | null;
    expect(oldConvert === null || oldConvert.disabled).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reread baseline" })); });
    handlers.set("/api/files/shadow/convert", (request) => receipt(String(request.body?.operationId), "unknown", (request.body?.key as ReturnType<typeof key>).consumerId));
    const convert = await confirmConversion();
    await act(async () => { fireEvent.click(convert); });
    expect(writes().find(({ path }) => path.endsWith("/convert"))?.body?.expectedBaselineSha256).toBe("c".repeat(64));
  });

  it("invalidates the inspected evidence when the exact R2 profile is admitted", async () => {
    handlers.set("/api/files/shadow/baseline", () => baseline("reference-a", "read_only"));
    handlers.set("/api/files/shadow/profiles/enable", (request) => {
      expect(request.body?.profile).toEqual(frozenProfile);
      const writable = baseline(); writable.baselineSha256 = "d".repeat(64);
      handlers.set("/api/files/shadow/baseline", () => writable);
      return status();
    });
    await mount(); await inspect();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Admit exact R2 profile" })); });
    expect(writes().map(({ path }) => path)).toEqual(["/api/files/shadow/profiles/enable"]);
    expect(requests.filter(({ path }) => path.endsWith("/baseline"))).toHaveLength(1);
    const oldConvert = screen.queryByRole("button", { name: "Convert this reference" }) as HTMLButtonElement | null;
    expect(oldConvert === null || oldConvert.disabled).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reread baseline" })); });
    handlers.set("/api/files/shadow/convert", (request) => receipt(String(request.body?.operationId)));
    const convert = await confirmConversion();
    await act(async () => { fireEvent.click(convert); });
    expect(writes().find(({ path }) => path.endsWith("/convert"))?.body?.expectedBaselineSha256).toBe("d".repeat(64));
  });

  it("discards an in-flight response when another reference is selected", async () => {
    const first = pending<ReturnType<typeof baseline>>();
    handlers.set("/api/files/shadow/baseline", (request) => (request.body?.key as ReturnType<typeof key>).consumerId === "reference-a" ? first.promise : baseline("reference-b"));
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Inspect project_content_attachment reference-a (no sub-ID) primary" }));
    await inspect("reference-b");
    await act(async () => { first.resolve(baseline("reference-a")); });
    handlers.set("/api/files/shadow/convert", (request) => receipt(String(request.body?.operationId), "unknown", "reference-b"));
    const convert = await confirmConversion();
    await act(async () => { fireEvent.click(convert); });
    expect(writes().filter(({ path }) => path.endsWith("/convert"))).toHaveLength(1);
    expect(writes().find(({ path }) => path.endsWith("/convert"))?.body?.key).toEqual(key("reference-b"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("distinguishes references sharing a parent by the full consumer key", async () => {
    const shared = { consumerKind: "state_representation_asset", consumerId: "shared-state", fileSlot: "primary" };
    handlers.set("/api/files/shadow/consumers", () => ({ records: ["asset-a", "asset-b"].map((subId) => ({
      ...row("shared-state"), consumer_kind: shared.consumerKind, consumer_sub_id: subId,
    })), nextCursor: null }));
    handlers.set("/api/files/shadow/baseline", (request) => {
      const input = request.body?.key as ReturnType<typeof key>, result = baseline("shared-state");
      result.key = input; result.record.key = input;
      result.head.consumer_kind = input.consumerKind; result.head.consumer_sub_id = input.consumerSubId;
      return result;
    });
    render(<FileShadowPilotPage />);
    const second = await screen.findByRole("button", { name: "Inspect state_representation_asset shared-state asset-b primary" });
    expect(screen.getByRole("button", { name: "Inspect state_representation_asset shared-state asset-a primary" })).toBeTruthy();
    await act(async () => { fireEvent.click(second); });
    handlers.set("/api/files/shadow/convert", (request) => receipt(String(request.body?.operationId), "unknown", "shared-state"));
    const convert = await confirmConversion();
    await act(async () => { fireEvent.click(convert); });
    expect(writes()[0].body?.key).toEqual({ ...shared, consumerSubId: "asset-b" });
  });

  it("shows historical empty and NUL identities unambiguously and sends their exact values", async () => {
    const identity = { ...key(""), consumerSubId: "asset\0suffix" };
    handlers.set("/api/files/shadow/consumers", () => ({ records: [{ ...row(""), consumer_sub_id: identity.consumerSubId }], nextCursor: null }));
    handlers.set("/api/files/shadow/baseline", (request) => {
      expect(request.body?.key).toEqual(identity);
      const result = baseline("");
      result.key = identity; result.record.key = identity; result.head.consumer_sub_id = identity.consumerSubId;
      return result;
    });
    handlers.set("/api/files/shadow/convert", (request) => receipt(String(request.body?.operationId), "unknown", ""));
    render(<FileShadowPilotPage />);
    const list = within(screen.getByRole("region", { name: "Current references" }));
    const inspectButton = await list.findByRole("button", { name: /^Inspect / });
    expect(list.getByText('""')).toBeTruthy();
    expect(list.getByText('"asset\\u0000suffix"')).toBeTruthy();
    await act(async () => { fireEvent.click(inspectButton); });
    const selected = within(screen.getByRole("region", { name: "Selected reference" }));
    expect(selected.getAllByText('""').length).toBeGreaterThan(0);
    expect(selected.getByText('"asset\\u0000suffix"')).toBeTruthy();
    const convert = await confirmConversion();
    await act(async () => { fireEvent.click(convert); });
    expect(writes()[0].body?.key).toEqual(identity);
    const saved = within(screen.getByRole("region", { name: "Saved operation" }));
    expect(saved.getByText('""')).toBeTruthy();
    expect(saved.getByText('"asset\\u0000suffix"')).toBeTruthy();
  });

  it("persists the single operation before sending, fences synchronous clicks and preserves it after a lost response and reload", async () => {
    const response = pending<unknown>();
    handlers.set("/api/files/shadow/convert", (request) => {
      expect(localStorage.getItem(journalKey)).toContain(String(request.body?.operationId));
      return response.promise;
    });
    const view = await mount(); await inspect();
    const convert = await confirmConversion();
    act(() => { fireEvent.click(convert); fireEvent.click(convert); });
    await waitFor(() => expect(writes().filter(({ path }) => path.endsWith("/convert"))).toHaveLength(1));
    const command = writes().find(({ path }) => path.endsWith("/convert"))!;
    const operationId = String(command.body?.operationId);
    await act(async () => { response.reject(new Error("Response lost after the server accepted the copy")); });
    expect(localStorage.getItem(journalKey)).toContain(operationId);
    view.unmount();
    handlers.set("/api/files/shadow/status", () => status(0));
    handlers.set("/api/files/shadow/operation", (request) => {
      expect(request.body?.operationId).toBe(operationId);
      return receipt(operationId);
    });
    await mount(true);
    expect(writes().filter(({ path }) => path.endsWith("/convert"))).toHaveLength(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Inspect saved operation" })); });
    expect(requests.filter(({ path }) => path.endsWith("/operation"))).toHaveLength(1);
    expect(writes().filter(({ path }) => path.endsWith("/convert"))).toHaveLength(1);
    const dismiss = screen.queryByRole("button", { name: "Dismiss completed operation" }) as HTMLButtonElement | null;
    expect(dismiss === null || dismiss.disabled).toBe(true);
    const reconcile = screen.queryByRole("button", { name: "Reconcile recorded copy" }) as HTMLButtonElement | null;
    expect(reconcile === null || reconcile.disabled).toBe(true);
    expect(localStorage.getItem(journalKey)).toContain(operationId);
  });

  it("keeps an unknown copy as the only operation until explicit reconciliation resolves it", async () => {
    handlers.set("/api/files/shadow/convert", (request) => receipt(String(request.body?.operationId)));
    await mount(); await inspect();
    const convert = await confirmConversion();
    await act(async () => { fireEvent.click(convert); });
    const operationId = String(writes()[0].body?.operationId);
    await inspect("reference-b");
    const otherConvert = screen.queryByRole("button", { name: "Convert this reference" }) as HTMLButtonElement | null;
    expect(otherConvert === null || otherConvert.disabled).toBe(true);
    for (const name of ["Dismiss completed operation", "Cancel unstarted operation"]) {
      const button = screen.queryByRole("button", { name }) as HTMLButtonElement | null;
      expect(button === null || button.disabled).toBe(true);
    }
    expect(writes().map(({ path }) => path)).toEqual(["/api/files/shadow/convert"]);
    handlers.set("/api/files/shadow/reconcile", (request) => {
      expect(request.body?.operationId).toBe(operationId);
      return { ...receipt(operationId, "published"), status: "resolved", nextAction: "none", fileId: "file-a", locationId: "location-a" };
    });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reconcile recorded copy" })); });
    expect(writes().map(({ path }) => path)).toEqual(["/api/files/shadow/convert", "/api/files/shadow/reconcile"]);
    expect((screen.getByRole("button", { name: "Dismiss completed operation" }) as HTMLButtonElement).disabled).toBe(false);
    expect(localStorage.getItem(journalKey)).toContain(operationId);
  });

  it("does not reconcile a newer operation that replaced the receipt shown in this tab", async () => {
    handlers.set("/api/files/shadow/convert", (request) => receipt(String(request.body?.operationId)));
    await mount(); await inspect();
    const convert = await confirmConversion();
    await act(async () => { fireEvent.click(convert); });
    const replacementId = "33333333-3333-4333-8333-333333333333";
    const replacement = JSON.parse(localStorage.getItem(journalKey)!);
    replacement.request.operationId = replacementId;
    replacement.receipt.operationId = replacementId;
    // Another tab can finish the displayed operation and save its successor
    // before this tab receives the asynchronous storage event.
    localStorage.setItem(journalKey, JSON.stringify(replacement));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reconcile recorded copy" })); });
    expect(writes().map(({ path }) => path)).toEqual(["/api/files/shadow/convert"]);
    expect(JSON.parse(localStorage.getItem(journalKey)!).request.operationId).toBe(replacementId);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("only cancels an unstarted copy after the operator explicitly requests it", async () => {
    handlers.set("/api/files/shadow/convert", (request) => receipt(String(request.body?.operationId), "staged"));
    await mount(); await inspect();
    const convert = await confirmConversion();
    await act(async () => { fireEvent.click(convert); });
    expect(writes().map(({ path }) => path)).toEqual(["/api/files/shadow/convert"]);
    const operationId = String(writes()[0].body?.operationId);
    handlers.set("/api/files/shadow/cancel", (request) => {
      expect(request.body?.operationId).toBe(operationId);
      return { ...receipt(operationId, "cancelled"), status: "cancelled", nextAction: "none" };
    });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel unstarted operation" })); });
    expect(writes().map(({ path }) => path)).toEqual(["/api/files/shadow/convert", "/api/files/shadow/cancel"]);
    expect(localStorage.getItem(journalKey)).toContain(operationId);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Dismiss completed operation" })); });
    expect(localStorage.getItem(journalKey)).toBeNull();
    expect(writes()).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Convert this reference" })).toBeNull();
  });

  it("can pause while a conversion response is still pending without replacing its saved operation", async () => {
    const response = pending<unknown>();
    handlers.set("/api/files/shadow/convert", () => response.promise);
    handlers.set("/api/files/shadow/disable", () => {
      handlers.set("/api/files/shadow/status", () => status(0));
      return status(0);
    });
    await mount(); await inspect();
    const convert = await confirmConversion();
    fireEvent.click(convert);
    await waitFor(() => expect(writes().filter(({ path }) => path.endsWith("/convert"))).toHaveLength(1));
    const operationId = String(writes()[0].body?.operationId);
    const pause = screen.getByRole("button", { name: "Pause conversions" }) as HTMLButtonElement;
    expect(pause.disabled).toBe(false);
    await act(async () => { fireEvent.click(pause); fireEvent.click(pause); });
    expect(writes().map(({ path }) => path)).toEqual(["/api/files/shadow/convert", "/api/files/shadow/disable"]);
    expect(localStorage.getItem(journalKey)).toContain(operationId);
    await act(async () => { response.reject(new Error("Conversion response still unavailable after pause")); });
    expect(localStorage.getItem(journalKey)).toContain(operationId);
    expect(writes().filter(({ path }) => path.endsWith("/convert"))).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Resume conversions" })).toBeTruthy();
  });

  it("ignores a conversion status read that arrives after a newer pause", async () => {
    const oldStatus = pending<ReturnType<typeof status>>();
    let statusReads = 0;
    handlers.set("/api/files/shadow/status", () => ++statusReads === 2 ? oldStatus.promise : status());
    handlers.set("/api/files/shadow/convert", (request) => receipt(String(request.body?.operationId)));
    handlers.set("/api/files/shadow/disable", () => status(0));
    await mount(); await inspect();
    const convert = await confirmConversion();
    fireEvent.click(convert);
    await waitFor(() => expect(statusReads).toBe(2));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Pause conversions" })); });
    expect(screen.getByRole("button", { name: "Resume conversions" })).toBeTruthy();
    await act(async () => { oldStatus.resolve(status()); });
    expect(screen.getByRole("button", { name: "Resume conversions" })).toBeTruthy();
    expect(writes().map(({ path }) => path)).toEqual(["/api/files/shadow/convert", "/api/files/shadow/disable"]);
  });

  it("keeps a rejected request through 404 and only closes it on an explicit server confirmation while paused", async () => {
    handlers.set("/api/files/shadow/convert", () => new Response("{}", { status: 409 }));
    const view = await mount(); await inspect();
    const convert = await confirmConversion();
    await act(async () => { fireEvent.click(convert); });
    expect(await screen.findByText(/The command was not confirmed/)).toBeTruthy();
    const saved = localStorage.getItem(journalKey), original = (JSON.parse(saved!) as PilotJournal).request;
    view.unmount(); handlers.set("/api/files/shadow/status", () => status(0));
    handlers.set("/api/files/shadow/operation", () => new Response("{}", { status: 404 }));
    await mount(true);
    expect(writes().map(({ path }) => path)).toEqual(["/api/files/shadow/convert"]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Inspect saved operation" })); });
    expect(await screen.findByText(/No receipt is visible yet/)).toBeTruthy();
    expect(localStorage.getItem(journalKey)).toBe(saved);
    expect(screen.queryByRole("button", { name: "Dismiss completed operation" })).toBeNull();
    handlers.set("/api/files/shadow/withdraw", async (request) => {
      expect(request.body).toEqual(original);
      return withdrawn(original);
    });
    const close = screen.getByRole("button", { name: "Close unaccepted request" }) as HTMLButtonElement;
    expect(close.disabled).toBe(false);
    await act(async () => { fireEvent.click(close); });
    expect(await screen.findByText("Closed before acceptance")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(journalKey)!).request).toEqual(original);
    expect(screen.queryByRole("button", { name: "Close unaccepted request" })).toBeNull();
    expect(writes().map(({ path }) => path)).toEqual(["/api/files/shadow/convert", "/api/files/shadow/withdraw"]);
    // Dismissal revalidates the durable request with native Web Crypto. React
    // act alone does not await that work; keep it pending until explicitly released.
    const digestReady = pending<void>();
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
      const result = await nativeDigest(...args);
      await digestReady.promise;
      return result;
    });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Dismiss completed operation" })); });
    expect(digest).toHaveBeenCalledOnce();
    expect(JSON.parse(localStorage.getItem(journalKey)!).receipt.status).toBe("withdrawn");
    expect((screen.getByRole("button", { name: "Dismiss completed operation" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { digestReady.resolve(); });
    await waitFor(() => {
      expect(localStorage.getItem(journalKey)).toBeNull();
      expect(screen.queryByRole("heading", { name: "Saved operation" })).toBeNull();
    });
  });

  it("keeps an accepted operation when the server cannot withdraw its request", async () => {
    const original = saveUnknownJournal().request;
    handlers.set("/api/files/shadow/withdraw", () => receipt(original.operationId));
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close unaccepted request" })); });
    expect(screen.getByRole("button", { name: "Reconcile recorded copy" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss completed operation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close unaccepted request" })).toBeNull();
    expect(JSON.parse(localStorage.getItem(journalKey)!).receipt.status).toBe("pending");
    expect(writes().map(({ path }) => path)).toEqual(["/api/files/shadow/withdraw"]);
  });

  it("retains a lost withdrawal response across reload and reads back the same terminal identity", async () => {
    const original = saveUnknownJournal().request, saved = localStorage.getItem(journalKey);
    handlers.set("/api/files/shadow/withdraw", () => { throw new Error("lost after commit"); });
    const view = await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close unaccepted request" })); });
    expect(await screen.findByText(/The response was lost/)).toBeTruthy();
    expect(localStorage.getItem(journalKey)).toBe(saved);
    view.unmount(); await mount();
    expect(writes()).toHaveLength(1);
    handlers.set("/api/files/shadow/operation", () => withdrawn(original));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Inspect saved operation" })); });
    expect(await screen.findByText("Closed before acceptance")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(journalKey)!).request).toEqual(original);
    expect(writes()).toHaveLength(1);
  });

  it("does not withdraw a newer journal using a stale displayed action", async () => {
    const journal = saveUnknownJournal();
    await mount();
    const button = screen.getByRole("button", { name: "Close unaccepted request" });
    journal.request.operationId = "44444444-4444-4444-8444-444444444444";
    localStorage.setItem(journalKey, JSON.stringify(journal));
    await act(async () => { fireEvent.click(button); });
    expect(await screen.findByText(/changed in another tab/)).toBeTruthy();
    expect(writes()).toEqual([]);
    expect(JSON.parse(localStorage.getItem(journalKey)!).request.operationId).toBe(journal.request.operationId);
  });

  it("can pause while an explicit withdrawal owns the journal lock", async () => {
    const original = saveUnknownJournal().request, response = pending<unknown>();
    handlers.set("/api/files/shadow/withdraw", () => response.promise);
    handlers.set("/api/files/shadow/disable", () => status(0));
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close unaccepted request" })); });
    const pause = screen.getByRole("button", { name: "Pause conversions" }) as HTMLButtonElement;
    expect(pause.disabled).toBe(false);
    await act(async () => { fireEvent.click(pause); });
    expect(screen.getByText("Paused")).toBeTruthy();
    await act(async () => { response.resolve(await withdrawn(original)); });
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(await screen.findByText("Closed before acceptance")).toBeTruthy();
    expect(writes().map(({ path }) => path)).toEqual(["/api/files/shadow/withdraw", "/api/files/shadow/disable"]);
    expect(JSON.parse(localStorage.getItem(journalKey)!).request).toEqual(original);
  });
});
