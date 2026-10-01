import { checkedStorageConfigurationStatus, type SaveStorageCandidateInput, type StorageConfigurationStatus } from "../../shared/contracts/storage-configuration";

export interface StorageConfigurationCapability { canManage: boolean; credentialEditingAvailable: boolean }
export class StorageConfigurationRequestError extends Error {
  constructor(readonly status: number) { super("Storage configuration request failed."); }
}
async function request(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(`/api/storage/configuration${path}`, {
    cache: "no-store", credentials: "same-origin", redirect: "error", ...init,
  });
  if (!response.ok) throw new StorageConfigurationRequestError(response.status);
  return response.json();
}
export const storageConfigurationClient = {
  capability: async (signal?: AbortSignal): Promise<StorageConfigurationCapability> => {
    const value = await request("/capability", { method: "GET", signal });
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 2 || !("canManage" in value) || !("credentialEditingAvailable" in value)
      || typeof value.canManage !== "boolean" || typeof value.credentialEditingAvailable !== "boolean"
      || !value.canManage && value.credentialEditingAvailable) throw new Error("Invalid storage capability response.");
    return { canManage: value.canManage, credentialEditingAvailable: value.credentialEditingAvailable };
  },
  read: async (signal?: AbortSignal): Promise<StorageConfigurationStatus> => checkedStorageConfigurationStatus(await request("", { method: "GET", signal })),
  save: async (input: SaveStorageCandidateInput): Promise<void> => {
    // No automatic replay: a lost response is reconciled by reading saved drafts.
    await request("/candidates", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  },
};
