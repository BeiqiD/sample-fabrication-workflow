import { checkedStorageConfigurationStatus, type SaveStorageCandidateInput, type StorageConfigurationStatus } from "../../shared/contracts/storage-configuration";
import { checkedStorageCandidateCheck, checkedStorageCandidateCheckId, checkedStorageCandidateCheckList, checkedStorageCandidateCheckProfileId,
  checkedStartStorageCandidateCheckInput, type StartStorageCandidateCheckInput, type StorageCandidateCheck, type StorageCandidateCheckList } from "../../shared/contracts/storage-candidate-check";

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
  save: async (input: SaveStorageCandidateInput, signal?: AbortSignal): Promise<void> => {
    // No automatic replay: a lost response is reconciled by reading saved drafts.
    await request("/candidates", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal });
  },
  startCheck: async (input: StartStorageCandidateCheckInput, signal?: AbortSignal): Promise<StorageCandidateCheck> => {
    const checked = checkedStartStorageCandidateCheckInput(input);
    const result = checkedStorageCandidateCheck(await request("/checks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(checked), signal }));
    if (result.id !== checked.checkId || result.profileId !== checked.profileId || result.revision !== checked.expectedRevision) throw new Error("Invalid storage test response.");
    return result;
  },
  readCheck: async (checkId: string, signal?: AbortSignal): Promise<StorageCandidateCheck> => {
    const id = checkedStorageCandidateCheckId(checkId);
    const result = checkedStorageCandidateCheck(await request(`/checks/${encodeURIComponent(id)}`, { method: "GET", signal }));
    if (result.id !== id) throw new Error("Invalid storage test response.");
    return result;
  },
  listChecks: async (profileId: string, signal?: AbortSignal): Promise<StorageCandidateCheckList> => {
    const id = checkedStorageCandidateCheckProfileId(profileId);
    const result = checkedStorageCandidateCheckList(await request(`/checks?profileId=${encodeURIComponent(id)}`, { method: "GET", signal }));
    if (result.items.some(item => item.profileId !== id)) throw new Error("Invalid storage test response.");
    return result;
  },
  cleanupCheck: async (checkId: string, signal?: AbortSignal): Promise<StorageCandidateCheck> => {
    const id = checkedStorageCandidateCheckId(checkId);
    const result = checkedStorageCandidateCheck(await request(`/checks/${encodeURIComponent(id)}/cleanup`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal }));
    if (result.id !== id) throw new Error("Invalid storage test response.");
    return result;
  },
};
