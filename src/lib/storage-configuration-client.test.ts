import { afterEach, describe, expect, it, vi } from "vitest";
import { storageConfigurationClient, StorageConfigurationRequestError } from "./storage-configuration-client";
import type { StorageCandidateCheck } from "../../shared/contracts/storage-candidate-check";
import type { StorageCredentialReenvelopeReceipt } from "../../shared/contracts/storage-credential-reenvelope";
import type { StorageProfileAdmissionReceipt } from "../../shared/contracts/storage-profile-admission";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const checkId = "0f5f7a34-5532-4463-bf51-8c5eb9537f63";
const check = (): StorageCandidateCheck => ({ id: checkId, profileId: "candidate-example", revision: 2, status: "succeeded", write: "passed", read: "passed",
  metadata: "passed", delete: "passed", cleanup: "confirmed_absent", code: null, createdAt: "2026-10-02T08:00:00.000Z", updatedAt: "2026-10-02T08:00:01.000Z", completedAt: "2026-10-02T08:00:01.000Z" });
const reenvelopeInput = { operationId: checkId, profileId: "candidate-example", revision: 2, credentialRef: "opaque-reference", expectedEnvelopeRevision: 1 };
const reenvelopeReceipt = (): StorageCredentialReenvelopeReceipt => ({ operationId: checkId, profileId: "candidate-example", revision: 2,
  credentialRef: "opaque-reference", previousEnvelopeRevision: 1, envelopeRevision: 2, outcome: "reenveloped",
  createdAt: "2026-10-02T10:00:00.000Z", createdBy: "admin@example.org" });
afterEach(() => vi.unstubAllGlobals());
describe("storage candidate client", () => {
  it("reads private capability and metadata with same-origin no-cache requests", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ canManage: true, credentialEditingAvailable: false }))
      .mockResolvedValueOnce(json({ scope: "system", credentialEditingAvailable: false, candidates: { items: [], hasMore: false } }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    expect(await storageConfigurationClient.capability(controller.signal)).toEqual({ canManage: true, credentialEditingAvailable: false });
    expect(await storageConfigurationClient.read(controller.signal)).toMatchObject({ candidates: { items: [] } });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/storage/configuration/capability", "/api/storage/configuration"]);
    for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ method: "GET", cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal });
  });

  it("rejects unsafe metadata and inconsistent capability before rendering", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ canManage: false, credentialEditingAvailable: true }))
      .mockResolvedValueOnce(json({ canManage: false, credentialEditingAvailable: false, administratorEmails: "private-admin@example.org" }))
      .mockResolvedValueOnce(json({ scope: "system", credentialEditingAvailable: false, candidates: { items: [], hasMore: false }, credentialEnvelope: "private-ciphertext" }));
    vi.stubGlobal("fetch", fetch);
    await expect(storageConfigurationClient.capability()).rejects.toThrow("Invalid storage capability response.");
    await expect(storageConfigurationClient.capability()).rejects.toThrow("Invalid storage capability response.");
    await expect(storageConfigurationClient.read()).rejects.toThrow("Invalid storage configuration.");
  });

  it("does not consume raw server errors or automatically replay failed writes", async () => {
    const response = json({ error: "private-secret private-provider-detail" }, 503), parse = vi.spyOn(response, "json");
    const fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal("fetch", fetch);
    const input = { expectedRevision: null, label: "DAV archive", namespace: { kind: "webdav" as const, endpoint: "https://dav.example.org", root: "" },
      credentials: { mode: "replace" as const, value: { username: "user", password: "private-secret" } } };
    await expect(storageConfigurationClient.save(input)).rejects.toMatchObject({ name: "Error", message: "Storage configuration request failed.", status: 503 });
    expect(fetch).toHaveBeenCalledOnce(); expect(parse).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    expect(new StorageConfigurationRequestError(409).status).toBe(409);
  });

  it("uses an explicit test identifier and private reads without replaying provider writes", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(check())).mockResolvedValueOnce(json(check()))
      .mockResolvedValueOnce(json({ items: [check()], hasMore: false })).mockResolvedValueOnce(json(check()));
    vi.stubGlobal("fetch", fetch); const controller = new AbortController();
    const input = { checkId, profileId: "candidate-example", expectedRevision: 2 };
    await storageConfigurationClient.startCheck(input, controller.signal);
    await storageConfigurationClient.readCheck(checkId, controller.signal);
    await storageConfigurationClient.listChecks("candidate-example", controller.signal);
    await storageConfigurationClient.cleanupCheck(checkId, controller.signal);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/storage/configuration/checks", `/api/storage/configuration/checks/${checkId}`,
      "/api/storage/configuration/checks?profileId=candidate-example", `/api/storage/configuration/checks/${checkId}/cleanup`]);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify(input) });
    expect(fetch.mock.calls[3][1]).toMatchObject({ method: "POST", body: "{}" });
    for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal });
  });

  it("rejects private fields and test results bound to a different candidate or revision", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ ...check(), credentialEnvelope: "private" }))
      .mockResolvedValueOnce(json({ ...check(), revision: 3 })).mockResolvedValueOnce(json({ items: [{ ...check(), profileId: "another" }], hasMore: false }));
    vi.stubGlobal("fetch", fetch);
    await expect(storageConfigurationClient.readCheck(checkId)).rejects.toThrow("Invalid storage candidate check.");
    await expect(storageConfigurationClient.startCheck({ checkId, profileId: "candidate-example", expectedRevision: 2 })).rejects.toThrow("Invalid storage test response.");
    await expect(storageConfigurationClient.listChecks("candidate-example")).rejects.toThrow("Invalid storage test response.");
  });

  it("keeps a lost test or cleanup response unresolved without retries or raw error text", async () => {
    const response = json({ error: "private-provider-details" }, 503), parse = vi.spyOn(response, "json");
    const fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal("fetch", fetch);
    await expect(storageConfigurationClient.startCheck({ checkId, profileId: "candidate-example", expectedRevision: 2 })).rejects.toMatchObject({ status: 503 });
    await expect(storageConfigurationClient.cleanupCheck(checkId)).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(2); expect(parse).not.toHaveBeenCalled();
  });

  it("uses scoped private encryption metadata and a caller-owned operation identifier", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ items: [{ profileId: "candidate-example", revision: 2,
      credentialRef: "opaque-reference", envelopeRevision: 1, isCurrentCandidate: true, status: "needs_reenvelope" }], hasMore: false }))
      .mockResolvedValueOnce(json(reenvelopeReceipt())).mockResolvedValueOnce(json(reenvelopeReceipt()));
    vi.stubGlobal("fetch", fetch); const controller = new AbortController();
    await storageConfigurationClient.listCredentialEnvelopes("candidate-example", controller.signal);
    await storageConfigurationClient.reenvelopeCredential(reenvelopeInput, controller.signal);
    await storageConfigurationClient.readCredentialReenvelope(checkId, controller.signal);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/storage/configuration/credential-envelopes?profileId=candidate-example",
      "/api/storage/configuration/credential-reenvelopes", `/api/storage/configuration/credential-reenvelopes/${checkId}`]);
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify(reenvelopeInput) });
    for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal });
  });

  it("rejects secret-bearing encryption metadata and receipts outside the requested context", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ items: [{ profileId: "another-profile", revision: 1, credentialRef: "opaque-reference",
      envelopeRevision: 1, isCurrentCandidate: false, status: "current" }], hasMore: false }))
      .mockResolvedValueOnce(json({ ...reenvelopeReceipt(), keyId: "private-key" }))
      .mockResolvedValueOnce(json({ ...reenvelopeReceipt(), credentialRef: "another-reference" }))
      .mockResolvedValueOnce(json({ ...reenvelopeReceipt(), operationId: "af5f7a34-5532-4463-bf51-8c5eb9537f63" }));
    vi.stubGlobal("fetch", fetch);
    await expect(storageConfigurationClient.listCredentialEnvelopes("candidate-example")).rejects.toThrow("Invalid credential encryption response.");
    await expect(storageConfigurationClient.readCredentialReenvelope(checkId)).rejects.toThrow("Invalid storage credential re-envelope.");
    await expect(storageConfigurationClient.reenvelopeCredential(reenvelopeInput)).rejects.toThrow("Invalid credential encryption response.");
    await expect(storageConfigurationClient.readCredentialReenvelope(checkId)).rejects.toThrow("Invalid credential encryption response.");
  });

  it("rejects invalid encryption intents before fetch and does not replay an unavailable result", async () => {
    const response = json({ error: "private-keyring-details" }, 503), parse = vi.spyOn(response, "json");
    const fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal("fetch", fetch);
    await expect(storageConfigurationClient.reenvelopeCredential({ ...reenvelopeInput, expectedEnvelopeRevision: 0 })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(storageConfigurationClient.reenvelopeCredential(reenvelopeInput)).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledOnce(); expect(parse).not.toHaveBeenCalled();
  });
});

describe("storage profile registration client", () => {
  const input = { operationId: checkId, profileId: "candidate-example", expectedRevision: 2, expectedEnvelopeRevision: 3, checkId };
  const receipt = (): StorageProfileAdmissionReceipt => ({ operationId: checkId, profileId: "candidate-example", revision: 2,
    envelopeRevision: 3, checkId, nativeProfileId: `storage-profile:aws-s3:${"a".repeat(64)}`, configurationRevision: 1,
    runtimeAccess: "read_only", createdAt: "2026-10-02T10:00:00.000Z", createdBy: "admin@example.org" });

  it("uses exact caller-owned registration input and private receipt reads", async () => {
    const fetch = vi.fn().mockImplementation(async () => json(receipt())); vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    expect(await storageConfigurationClient.registerProfile(input, controller.signal)).toEqual(receipt());
    expect(await storageConfigurationClient.readProfileRegistration(checkId, controller.signal)).toEqual(receipt());
    await storageConfigurationClient.findProfileRegistration({ profileId: "candidate-example", expectedRevision: 2 }, controller.signal);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/storage/configuration/registrations", `/api/storage/configuration/registrations/${checkId}`,
      "/api/storage/configuration/registrations?profileId=candidate-example&expectedRevision=2"]);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify(input) });
    for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal });
  });

  it("rejects private and mismatched mutation receipts but accepts another candidate's existing registration lookup", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ ...receipt(), namespace: "private-namespace" }))
      .mockResolvedValueOnce(json({ ...receipt(), envelopeRevision: 4 }))
      .mockResolvedValueOnce(json({ ...receipt(), operationId: "af5f7a34-5532-4463-bf51-8c5eb9537f63" }))
      .mockResolvedValueOnce(json({ ...receipt(), profileId: "earlier-candidate", revision: 7 })); vi.stubGlobal("fetch", fetch);
    await expect(storageConfigurationClient.registerProfile(input)).rejects.toThrow("Invalid storage profile admission.");
    await expect(storageConfigurationClient.registerProfile(input)).rejects.toThrow("Invalid storage profile registration response.");
    await expect(storageConfigurationClient.readProfileRegistration(checkId)).rejects.toThrow("Invalid storage profile registration response.");
    await expect(storageConfigurationClient.findProfileRegistration({ profileId: "candidate-example", expectedRevision: 2 })).resolves.toMatchObject({ profileId: "earlier-candidate", revision: 7 });
  });

  it("does not fetch invalid inputs or replay an unavailable registration", async () => {
    const response = json({ error: "private-details" }, 503), parse = vi.spyOn(response, "json");
    const fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal("fetch", fetch);
    await expect(storageConfigurationClient.registerProfile({ ...input, expectedEnvelopeRevision: 0 })).rejects.toThrow();
    await expect(storageConfigurationClient.readProfileRegistration("invalid")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(storageConfigurationClient.registerProfile(input)).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledOnce(); expect(parse).not.toHaveBeenCalled();
  });
});

describe("storage candidate evidence client", () => {
  const readiness = () => ({ profileId: "candidate-example", revision: 2, observedAt: "2026-10-02T10:00:00.000Z",
    credential: { envelopeRevision: 1, status: "current" }, evidence: { currentConfigurationSuccessCount: 3,
      historicalConfigurationSuccessCount: 55, exactCurrentContextSuccess: { checkId, completedAt: "2026-10-02T08:00:01.000Z" },
      inProgressCount: 0, unresolvedCleanupCount: 1 }, canActivate: false });
  const input = { profileId: "candidate-example", expectedRevision: 2 };

  it("reads a dated private observation for an exact candidate revision without provider writes", async () => {
    const fetch = vi.fn().mockResolvedValue(json(readiness())); vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    expect(await storageConfigurationClient.readReadiness(input, controller.signal)).toEqual(readiness());
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/storage/configuration/readiness?profileId=candidate-example&expectedRevision=2",
      { method: "GET", cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal });
  });

  it("rejects invalid requests before fetch and mismatched revisions or candidates before rendering", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ ...readiness(), revision: 3 }))
      .mockResolvedValueOnce(json({ ...readiness(), profileId: "another-candidate" })); vi.stubGlobal("fetch", fetch);
    await expect(storageConfigurationClient.readReadiness({ ...input, expectedRevision: 0 })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(storageConfigurationClient.readReadiness(input)).rejects.toThrow("Invalid storage check evidence response.");
    await expect(storageConfigurationClient.readReadiness(input)).rejects.toThrow("Invalid storage check evidence response.");
  });

  it("rejects missing, private or activation-bearing response fields", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const { observedAt: _missing, ...missing } = readiness();
    for (const value of [missing, { ...readiness(), canActivate: true },
      { ...readiness(), credential: { ...readiness().credential, keyId: "private-key" } },
      { ...readiness(), evidence: { ...readiness().evidence, currentConfigurationSuccessCount: undefined } }]) {
      fetch.mockResolvedValueOnce(json(value));
      await expect(storageConfigurationClient.readReadiness(input)).rejects.toThrow("Invalid storage candidate readiness.");
    }
  });

  it("preserves historical exact matching evidence when current credentials cannot be decrypted", async () => {
    const value = { ...readiness(), credential: { envelopeRevision: 1, status: "unavailable" } };
    const fetch = vi.fn().mockResolvedValueOnce(json(value)).mockResolvedValueOnce(json({ error: "private-keyring-details" }, 403));
    vi.stubGlobal("fetch", fetch);
    expect(await storageConfigurationClient.readReadiness(input)).toEqual(value);
    await expect(storageConfigurationClient.readReadiness(input)).rejects.toMatchObject({ status: 403, message: "Storage configuration request failed." });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
