import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentStorageSettingsStatus } from "../shared/contracts/current-storage-settings";
import type { StorageCandidate } from "../shared/contracts/storage-configuration";
import type { StorageCandidateReadiness } from "../shared/contracts/storage-candidate-readiness";
import type { NativeStorageActivationInput } from "../shared/contracts/storage-policy";
import { StorageProfileActivation } from "./pages/StorageProfileActivation";

const nativeId = `storage-profile:aws-s3:${"a".repeat(64)}`, checkId = "0f5f7a34-5532-4463-bf51-8c5eb9537f63";
const settingsPath = "/api/settings/storage?version=3", activationPath = "/api/storage/configuration/activations";
const candidate = (id = "candidate"): StorageCandidate => ({ profileId: id, revision: 2, label: "Research files", namespace: {
  kind: "s3", endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", bucket: "private-bucket", root: "private-root", forcePathStyle: true,
  expectedBucketOwner: "123456789012" }, credentials: { status: "configured", ref: "private-ref" }, createdAt: "2026-10-05T00:00:00.000Z", createdBy: "private-admin" });
const evidence = (id = "candidate"): StorageCandidateReadiness => ({ profileId: id, revision: 2, observedAt: "2026-10-05T00:00:00.000Z",
  credential: { status: "current", envelopeRevision: 4 }, evidence: { currentConfigurationSuccessCount: 1, historicalConfigurationSuccessCount: 0,
    exactCurrentContextSuccess: { checkId, completedAt: "2026-10-05T00:00:00.000Z" }, inProgressCount: 0, unresolvedCleanupCount: 0 }, canActivate: false });
const snapshot = (): CurrentStorageSettingsStatus => ({ version: 3, kind: "storage-settings-status", readOnly: true, health: "not_checked",
  authority: { mode: "active", shadowConversions: "paused", fileAccess: "enabled" },
  roleDefaults: { state: "configured", policyRevision: 3, internal: { profileId: "r2", adapterType: "r2", availability: "available" },
    originals: { profileId: nativeId, adapterType: "s3", availability: "available" } },
  bindings: { r2: { configuration: "configured" }, managed: { provider: "none", configuration: "missing" } },
  profiles: { items: [{ id: "r2", adapterType: "r2", configurationRevision: 1, runtimeAccess: "read_write", bindingMatch: "matched",
    bindingRevision: null, availability: "available" }, { id: nativeId, adapterType: "s3", configurationRevision: 1, runtimeAccess: "read_write",
    bindingMatch: "matched", bindingRevision: 1, availability: "available" }], hasMore: false, limit: 100 } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const input = (id = "candidate", operationId = "unconfirmed"): NativeStorageActivationInput => ({ operationId, nativeProfileId: nativeId, candidateProfileId: id,
  expectedCandidateRevision: 2, expectedEnvelopeRevision: 4, checkId, expectedBindingRevision: 1 });
const receipt = (intent: NativeStorageActivationInput) => ({ operationId: intent.operationId, nativeProfileId: intent.nativeProfileId,
  candidateProfileId: intent.candidateProfileId, candidateRevision: intent.expectedCandidateRevision, envelopeRevision: intent.expectedEnvelopeRevision,
  checkId: intent.checkId, bindingRevision: 2, createdAt: "2026-10-05T00:00:00.000Z", createdBy: "private-admin" });
const network = vi.fn<typeof fetch>();
const props = (id = "candidate") => ({ candidate: candidate(id), nativeProfileId: nativeId, evidence: evidence(id), blocked: false,
  onForbidden: vi.fn(), onStaleEvidence: vi.fn() });
const mutations = () => network.mock.calls.filter(([, options]) => options?.method === "POST");
// Mounted synthetic read/receipt controls only; no actual provider or deployment.
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { sessionStorage.clear(); network.mockReset(); vi.stubGlobal("fetch", network);
  network.mockImplementation(async path => String(path) === settingsPath ? json(snapshot()) : json({}, 404)); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });
async function ready() { const button = await screen.findByRole("button", { name: "Update profile activation" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); return button; }

describe("5F Storage activation read-status recovery", () => {
  it("clears a failed initial read during a read-only refresh and does not describe unknown state as paused", async () => {
    const refreshed = deferred<Response>(); let reads = 0;
    network.mockImplementation(async path => String(path) === settingsPath
      ? ++reads === 1 ? json({ error: "private-status-detail" }, 503) : refreshed.promise : json({}, 404));
    render(<StorageProfileActivation {...props()} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Activation settings are unavailable. Refresh activation status to try again.");
    expect(screen.queryByText(/Activation is unavailable while file access or configuration work is paused/)).toBeNull();
    expect((screen.getByRole("button", { name: "Activate profile" }) as HTMLButtonElement).disabled).toBe(true);
    const refresh = screen.getByRole("button", { name: "Refresh activation status" });
    fireEvent.click(refresh);
    expect(screen.queryByRole("alert")).toBeNull(); expect(screen.getByText("Reading activation status…")).toBeTruthy();
    expect((refresh as HTMLButtonElement).disabled).toBe(true); expect(mutations()).toHaveLength(0);
    await act(async () => refreshed.resolve(json(snapshot()))); await ready();
    expect(screen.queryByText(/Activation settings are unavailable/)).toBeNull();
    expect(screen.queryByText(/Activation is unavailable while file access or configuration work is paused/)).toBeNull();
    expect(network.mock.calls.filter(([path]) => String(path) === settingsPath)).toHaveLength(2);
    expect(mutations()).toHaveLength(0); expect(sessionStorage.length).toBe(0);
    expect(document.body.textContent).not.toContain("private-status-detail");
  });
  it("preserves the exact remembered unconfirmed activation and its guidance across a failed read and successful status refresh", async () => {
    const original = input(); sessionStorage.setItem("storage-profile-activation:candidate", JSON.stringify(original));
    let reads = 0;
    network.mockImplementation(async path => String(path) === settingsPath
      ? ++reads === 1 ? json({}, 503) : json(snapshot()) : json({}, 404));
    render(<StorageProfileActivation {...props()} />);
    await screen.findByRole("alert"); await screen.findByText(/The activation result is unconfirmed/);
    const receiptReads = network.mock.calls.filter(([path]) => String(path).endsWith("/unconfirmed")).length;
    const refresh = screen.getByRole("button", { name: "Refresh activation status" });
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(refresh);
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull(); expect(screen.getByText(/The activation result is unconfirmed/)).toBeTruthy();
    expect(screen.getByText(/candidate revision 2 is awaiting confirmation/)).toBeTruthy();
    expect(JSON.parse(sessionStorage.getItem("storage-profile-activation:candidate")!)).toEqual(original);
    expect(network.mock.calls.filter(([path]) => String(path).endsWith("/unconfirmed"))).toHaveLength(receiptReads);
    expect(mutations()).toHaveLength(0);
  });
  it("keeps a confirmed synthetic receipt visible when the following status read fails, then refreshes status without replaying activation", async () => {
    let reads = 0;
    network.mockImplementation(async (path, options) => {
      if (String(path) === settingsPath) return ++reads === 2 ? json({}, 503) : json(snapshot());
      if (String(path) === activationPath && options?.method === "POST") return json(receipt(JSON.parse(String(options.body))));
      return json({}, 404);
    });
    render(<StorageProfileActivation {...props()} />); fireEvent.click(await ready());
    await screen.findByRole("alert"); expect(screen.getByText(/Profile activation confirmed/)).toBeTruthy();
    expect(sessionStorage.getItem("storage-profile-activation:candidate")).toBeNull(); expect(mutations()).toHaveLength(1);
    expect(screen.queryByText(/Activation is unavailable while file access or configuration work is paused/)).toBeNull();
    const refresh = screen.getByRole("button", { name: "Refresh activation status" }); fireEvent.click(refresh); await ready();
    expect(screen.queryByRole("alert")).toBeNull(); expect(screen.getByText(/Profile activation confirmed/)).toBeTruthy();
    expect(mutations()).toHaveLength(1); expect(network.mock.calls.filter(([path]) => String(path) === settingsPath)).toHaveLength(3);
  });
  it("retains access-denied guidance and disabled writes after a successful status refresh without falsely calling File access paused", async () => {
    let reads = 0; const value = props();
    network.mockImplementation(async path => String(path) === settingsPath
      ? ++reads === 1 ? json({ error: "private-admin-detail" }, 403) : json(snapshot()) : json({}, 404));
    render(<StorageProfileActivation {...value} />);
    await screen.findByText(/System administrator access is required. Refresh saved candidates/);
    expect(screen.queryByRole("alert")).toBeNull(); expect(value.onForbidden).toHaveBeenCalledOnce();
    const refresh = screen.getByRole("button", { name: "Refresh activation status" }); fireEvent.click(refresh);
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText(/System administrator access is required. Refresh saved candidates/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Update profile activation" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/Activation is unavailable while file access or configuration work is paused/)).toBeNull();
    expect(mutations()).toHaveLength(0); expect(value.onForbidden).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("private-admin-detail");
  });
});
