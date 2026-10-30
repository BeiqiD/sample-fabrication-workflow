/** Versioned installation-root transport. These helpers perform no I/O and do
 * not retain the seed. Call generation only after an administrator asks for it. */
export const INSTALLATION_SECRET_SEED_NAME = "INSTALLATION_SECRET_SEED" as const;
export const INSTALLATION_SECRET_SEED_PREFIX = "sfi-seed-v1." as const;
export const INSTALLATION_SECRET_SEED_BYTES = 32;
const PAYLOAD = /^[A-Za-z0-9_-]{43}$/;

export class InstallationSecretSeedError extends Error {
  constructor() { super("Invalid installation secret seed."); this.name = "InstallationSecretSeedError"; }
}

function encoded(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Validates canonical version/encoding/length, not the entropy of supplied
 * bytes. A seed must originate from a cryptographic random generator; accepting
 * a password and hashing/padding it is deliberately not supported. The caller
 * owns the returned bytes and should clear them after use where practical. */
export function checkedInstallationSecretSeed(value: unknown): Uint8Array<ArrayBuffer> {
  let result: Uint8Array<ArrayBuffer> | undefined;
  try {
    if (typeof value !== "string" || value.length !== INSTALLATION_SECRET_SEED_PREFIX.length + 43
      || !value.startsWith(INSTALLATION_SECRET_SEED_PREFIX)) throw new InstallationSecretSeedError();
    const payload = value.slice(INSTALLATION_SECRET_SEED_PREFIX.length);
    if (!PAYLOAD.test(payload)) throw new InstallationSecretSeedError();
    result = Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/") + "="), character => character.charCodeAt(0));
    if (result.length !== INSTALLATION_SECRET_SEED_BYTES || encoded(result) !== payload) throw new InstallationSecretSeedError();
    return result;
  } catch {
    result?.fill(0);
    throw new InstallationSecretSeedError();
  }
}

/** Uses exactly 32 CSPRNG bytes. A browser must be in a secure context. Clearing
 * temporary byte buffers is best effort; JavaScript strings and clipboard
 * contents cannot be promised to disappear from memory. */
export function generateInstallationSecretSeed(): string {
  const bytes = new Uint8Array(INSTALLATION_SECRET_SEED_BYTES);
  try {
    if ("isSecureContext" in globalThis && !globalThis.isSecureContext) throw new InstallationSecretSeedError();
    globalThis.crypto.getRandomValues(bytes);
    return INSTALLATION_SECRET_SEED_PREFIX + encoded(bytes);
  } catch { throw new InstallationSecretSeedError(); }
  finally { bytes.fill(0); }
}
