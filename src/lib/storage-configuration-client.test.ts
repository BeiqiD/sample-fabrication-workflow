import { afterEach, describe, expect, it, vi } from "vitest";
import { storageConfigurationClient, StorageConfigurationRequestError } from "./storage-configuration-client";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
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
});
