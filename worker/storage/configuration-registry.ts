import type { Env } from "../types";
import { parseStorageCredentialKeyring } from "./credential-envelope";
import { d1StorageConfigurationDatabase } from "./configuration-d1";
import { createStorageConfigurationRegistry } from "./configuration-registry-core";
import { assertSystemAdministrator, canAdministerSystemSettings } from "./system-administrator";
export { StorageConfigurationError } from "./configuration-registry-core";

type ConfigurationEnvironment = Pick<Env, "DB" | "AUTH_MODE" | "SYSTEM_ADMIN_EMAILS" | "STORAGE_CREDENTIAL_KEYRING">;
/** Trusted Cloudflare composition retains its independent Access policy. Local
 * runtimes compose the core with genuine SQL/current grants, without Env. */
function registry(env: ConfigurationEnvironment) {
  return createStorageConfigurationRegistry({
    database: () => d1StorageConfigurationDatabase(env.DB),
    authorizeAdministrator: actor => canAdministerSystemSettings(env, actor),
    keyring: () => parseStorageCredentialKeyring(env.STORAGE_CREDENTIAL_KEYRING),
  });
}
export async function storageCredentialEditingAvailable(env: ConfigurationEnvironment) {
  return registry(env).storageCredentialEditingAvailable();
}
export async function readStorageConfiguration(env: ConfigurationEnvironment, actor: string) {
  assertSystemAdministrator(env, actor);
  return registry(env).readStorageConfiguration(actor);
}
export async function saveStorageCandidate(env: ConfigurationEnvironment, raw: unknown, actor: string) {
  assertSystemAdministrator(env, actor);
  return registry(env).saveStorageCandidate(raw, actor);
}
