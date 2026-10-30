import { checkedInstallationSecretSeed } from "../../shared/contracts/installation-secret-seed";
import { parseStorageCredentialKeyring, StorageCredentialUnavailableError, type StorageCredentialKeyring } from "./credential-envelope";

export interface StorageCredentialRootEnvironment {
  STORAGE_CREDENTIAL_KEYRING?: string;
  INSTALLATION_SECRET_SEED?: string;
}
export interface StorageCredentialRootCapture {
  readonly STORAGE_CREDENTIAL_KEYRING: string | undefined;
  readonly INSTALLATION_SECRET_SEED: string | undefined;
}
export interface ResolvedStorageCredentialRoot {
  source: "legacy_keyring" | "installation_seed";
  keyring: StorageCredentialKeyring;
}

/** These exact UTF-8 strings and output lengths form derivation version 1.
 * They are public fixed domain/version contexts, not an installation-specific
 * salt that needs a second backup. Changing one requires a new key version and
 * explicit historical-key retention; it must never silently replace v1. */
export const INSTALLATION_SEED_HKDF_SALT = "sample-fabrication-workflow:installation-secret-seed:hkdf-sha256:v1";
export const INSTALLATION_SEED_STORAGE_KEY_INFO = "sample-fabrication-workflow:storage-credential-encryption:aes-256-gcm:v1";
export const INSTALLATION_SEED_STORAGE_KEY_ID_INFO = "sample-fabrication-workflow:storage-credential-key-id:v1";
const encoder = new TextEncoder();

/** A request must capture both mechanisms. In-flight authorization/configuration
 * fences must also observe addition/removal of the other possible root. Never
 * serialize this private capture into API metadata, logs or browser state. */
export function captureStorageCredentialRoot(env: StorageCredentialRootEnvironment): StorageCredentialRootCapture {
  return Object.freeze({ STORAGE_CREDENTIAL_KEYRING: env.STORAGE_CREDENTIAL_KEYRING, INSTALLATION_SECRET_SEED: env.INSTALLATION_SECRET_SEED });
}
export function storageCredentialRootUnchanged(env: StorageCredentialRootEnvironment, captured: StorageCredentialRootCapture): boolean {
  return env.STORAGE_CREDENTIAL_KEYRING === captured.STORAGE_CREDENTIAL_KEYRING
    && env.INSTALLATION_SECRET_SEED === captured.INSTALLATION_SECRET_SEED;
}

/** Pure root resolution only. The caller separately owns current administrator
 * authorization, database-history/recovery checks and request configuration
 * fences. This resolver never installs, stores, rotates or resets a root. */
export async function resolveStorageCredentialRoot(env: StorageCredentialRootEnvironment | StorageCredentialRootCapture): Promise<ResolvedStorageCredentialRoot> {
  let seed: Uint8Array<ArrayBuffer> | undefined, keyIdBytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    const captured = captureStorageCredentialRoot(env);
    const legacyConfigured = captured.STORAGE_CREDENTIAL_KEYRING !== undefined;
    const seedConfigured = captured.INSTALLATION_SECRET_SEED !== undefined;
    // An empty or malformed configured secret is still configuration. There is
    // no automatic precedence, migration, fallback or retry with another root.
    if (legacyConfigured === seedConfigured) throw new StorageCredentialUnavailableError();
    if (legacyConfigured) return { source: "legacy_keyring", keyring: await parseStorageCredentialKeyring(captured.STORAGE_CREDENTIAL_KEYRING) };
    seed = checkedInstallationSecretSeed(captured.INSTALLATION_SECRET_SEED);
    const root = await crypto.subtle.importKey("raw", seed, "HKDF", false, ["deriveKey", "deriveBits"]);
    const parameters = { name: "HKDF", hash: "SHA-256", salt: encoder.encode(INSTALLATION_SEED_HKDF_SALT) };
    const key = await crypto.subtle.deriveKey({ ...parameters, info: encoder.encode(INSTALLATION_SEED_STORAGE_KEY_INFO) }, root,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    // A separate HKDF domain yields a stable 128-bit public key identifier. It
    // identifies this seed/version without using the AES key as its own ID.
    keyIdBytes = new Uint8Array(await crypto.subtle.deriveBits({ ...parameters,
      info: encoder.encode(INSTALLATION_SEED_STORAGE_KEY_ID_INFO) }, root, 128));
    const keyId = "seed-v1-" + Array.from(keyIdBytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return { source: "installation_seed", keyring: { version: 1, currentKeyId: keyId, keys: new Map([[keyId, key]]) } };
  } catch { throw new StorageCredentialUnavailableError(); }
  finally { seed?.fill(0); keyIdBytes?.fill(0); }
}
