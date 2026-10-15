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
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { sessionStorage.clear(); network.mockReset(); vi.stubGlobal("fetch", network);
  network.mockImplementation(async path => String(path) === settingsPath ? json(snapshot()) : json({}, 404)); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });
async function ready() { const button = await screen.findByRole("button", { name: "Update profile activation" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); return button; }

describe("activation context and recovery", () => {
  it("isolates uncertain activation intents on candidate switches and ignores a late receipt from the previous candidate", async () => {
    const old = input("candidate", "old-intent"), other = input("other", "other-intent"), pending = deferred<Response>();
    sessionStorage.setItem("storage-profile-activation:candidate", JSON.stringify(old)); sessionStorage.setItem("storage-profile-activation:other", JSON.stringify(other));
    network.mockImplementation(async path => String(path).endsWith("/old-intent") ? pending.promise : String(path) === settingsPath ? json(snapshot()) : json({}, 404));
    const mounted = render(<StorageProfileActivation {...props()} />);
    await waitFor(() => expect(network.mock.calls.some(([path]) => String(path).endsWith("/old-intent"))).toBe(true));
    const oldSignal = network.mock.calls.find(([path]) => String(path).endsWith("/old-intent"))![1]?.signal;
    mounted.rerender(<StorageProfileActivation {...props("other")} />); await screen.findByText(/The activation result is unconfirmed/);
    expect(oldSignal?.aborted).toBe(true); expect(network.mock.calls.some(([path]) => String(path).endsWith("/other-intent"))).toBe(true);
    await act(async () => pending.resolve(json(receipt(old))));
    expect(screen.queryByText(/Profile activation confirmed/)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem("storage-profile-activation:candidate")!)).toEqual(old);
    expect(JSON.parse(sessionStorage.getItem("storage-profile-activation:other")!)).toEqual(other); expect(mutations()).toHaveLength(0);
  });
  it("does not reconcile or replay another candidate's remembered intent when the next candidate has no pending operation", async () => {
    const old = input(); sessionStorage.setItem("storage-profile-activation:candidate", JSON.stringify(old));
    network.mockImplementation(async (path, options) => options?.method === "POST" ? json({}, 503)
      : String(path) === settingsPath ? json(snapshot()) : json({}, 404));
    const mounted = render(<StorageProfileActivation {...props()} />); await screen.findByText(/The activation result is unconfirmed/);
    const reads = network.mock.calls.filter(([path]) => String(path).endsWith("/unconfirmed")).length;
    mounted.rerender(<StorageProfileActivation {...props("other")} />); fireEvent.click(await ready());
    await screen.findByText(/The activation result is unconfirmed/);
    expect(network.mock.calls.filter(([path]) => String(path).endsWith("/unconfirmed"))).toHaveLength(reads);
    expect(JSON.parse(sessionStorage.getItem("storage-profile-activation:candidate")!)).toEqual(old);
    expect(JSON.parse(String(mutations()[0][1]?.body)).candidateProfileId).toBe("other");
  });
  it("retains the original intent after revocation while allowing status reads without re-enabling writes", async () => {
    const value = props(); network.mockImplementation(async (path, options) => options?.method === "POST"
      ? json({ error: "private-provider-detail" }, 403) : String(path) === settingsPath ? json(snapshot()) : json({}, 404));
    render(<StorageProfileActivation {...value} />); fireEvent.click(await ready());
    await screen.findByText(/System administrator access is required. Refresh saved candidates/); expect(value.onForbidden).toHaveBeenCalledOnce();
    const refresh = screen.getByRole("button", { name: "Refresh activation status" }); expect((refresh as HTMLButtonElement).disabled).toBe(false);
    const retry = screen.getByRole("button", { name: "Check or retry activation" }); expect((retry as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(refresh); await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
    expect((retry as HTMLButtonElement).disabled).toBe(true); expect(mutations()).toHaveLength(1);
    expect(sessionStorage.getItem("storage-profile-activation:candidate")).not.toBeNull(); expect(document.body.textContent).not.toContain("private-provider-detail");
  });
  it("does not offer a native activation for an R2 profile despite matching candidate evidence", async () => {
    render(<StorageProfileActivation {...props()} nativeProfileId="r2" />); const button = await screen.findByRole("button", { name: "Activate profile" });
    await waitFor(() => expect(screen.queryByText("Reading activation status…")).toBeNull());
    expect((button as HTMLButtonElement).disabled).toBe(true); expect(mutations()).toHaveLength(0);
  });
});
