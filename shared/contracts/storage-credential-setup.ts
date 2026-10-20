export const STORAGE_CREDENTIAL_SETUP_STATES = [
  "setup_required", "legacy_ready", "seed_ready", "restore_required", "configuration_conflict", "unavailable",
] as const;
export type StorageCredentialSetupState = typeof STORAGE_CREDENTIAL_SETUP_STATES[number];
/** Administrator-only, non-secret installation status. Never include root/key
 * material, key IDs, ciphertext or provider credentials in this response. */
export interface StorageCredentialSetupStatus {
  version: 1;
  runtime: "cloudflare_worker";
  state: StorageCredentialSetupState;
}
export function checkedStorageCredentialSetupStatus(value: unknown): StorageCredentialSetupStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 3 || !("version" in value) || !("runtime" in value) || !("state" in value)
    || value.version !== 1 || value.runtime !== "cloudflare_worker"
    || !STORAGE_CREDENTIAL_SETUP_STATES.includes(value.state as StorageCredentialSetupState)) {
    throw new Error("Invalid storage credential setup response.");
  }
  return { version: 1, runtime: "cloudflare_worker", state: value.state as StorageCredentialSetupState };
}
