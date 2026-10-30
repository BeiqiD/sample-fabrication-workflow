import type { Env } from "../types";
import { StorageCredentialUnavailableError } from "./credential-envelope";
import { captureStorageCredentialRoot, storageCredentialRootUnchanged } from "./installation-secret-seed";
import { compatibleStorageCredentialKeyring } from "./credential-setup";
import { d1StorageConfigurationDatabase } from "./configuration-d1";
import { createStorageConfigurationRegistry } from "./configuration-registry-core";
import { assertSystemAdministrator, canAdministerSystemSettings } from "./system-administrator";
export { StorageConfigurationError } from "./configuration-registry-core";

type ConfigurationEnvironment = Pick<Env, "DB" | "AUTH_MODE" | "SYSTEM_ADMIN_EMAILS" | "STORAGE_CREDENTIAL_KEYRING" | "INSTALLATION_SECRET_SEED">;
/** Trusted Cloudflare composition retains its independent Access policy. Local
 * runtimes compose the core with genuine SQL/current grants, without Env. */
function registry(env: ConfigurationEnvironment) {
  const captured = captureStorageCredentialRoot(env), database = env.DB;
  let history: { exists: boolean; checks: boolean; hasProtected: boolean } | undefined;
  return createStorageConfigurationRegistry({
    database: () => d1StorageConfigurationDatabase(env.DB),
    authorizeAdministrator: actor => canAdministerSystemSettings(env, actor),
    keyring: () => compatibleStorageCredentialKeyring(env, captured, value => { history = value; }),
    assertCredentialRootCurrent: () => {
      if (env.DB !== database || !storageCredentialRootUnchanged(env, captured)) throw new StorageCredentialUnavailableError();
    },
    enforceCredentialRootHistory: true,
    credentialRootHistoryWasEmpty: () => {
      if (!history) throw new StorageCredentialUnavailableError();
      return !history.exists;
    },
    credentialRootHistoryIncludesChecks: () => {
      if (!history) throw new StorageCredentialUnavailableError();
      return history.checks;
    },
    credentialRootHistoryHadProtectedPayloads: () => {
      if (!history) throw new StorageCredentialUnavailableError();
      return history.hasProtected;
    },
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
