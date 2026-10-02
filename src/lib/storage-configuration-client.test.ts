import { afterEach, describe, expect, it, vi } from "vitest";
import { storageConfigurationClient, StorageConfigurationRequestError } from "./storage-configuration-client";
import type { StorageCandidateCheck } from "../../shared/contracts/storage-candidate-check";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const checkId = "0f5f7a34-5532-4463-bf51-8c5eb9537f63";
const check = (): StorageCandidateCheck => ({ id: checkId, profileId: "candidate-example", revision: 2, status: "succeeded", write: "passed", read: "passed",
  metadata: "passed", delete: "passed", cleanup: "confirmed_absent", code: null, createdAt: "2026-10-02T08:00:00.000Z", updatedAt: "2026-10-02T08:00:01.000Z", completedAt: "2026-10-02T08:00:01.000Z" });
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
});
