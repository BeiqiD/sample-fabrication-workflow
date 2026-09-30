/** Installation-owned encryption only. These helpers never persist credentials,
 * invoke a provider, log key material, or return decrypted values to a browser. */
export const STORAGE_CREDENTIAL_ENVELOPE_VERSION = 1 as const;
export const MAX_STORAGE_CREDENTIAL_BYTES = 32 * 1024;
const MAX_KEYRING_BYTES = 4096;
const MAX_KEYS = 16;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface StorageCredentialIdentity {
  profileId: string;
  configurationRevision: number;
  credentialRef: string;
  namespaceSha256: string;
}
export interface StorageCredentialEnvelope {
  version: typeof STORAGE_CREDENTIAL_ENVELOPE_VERSION;
  keyId: string;
  nonce: string;
  ciphertext: string;
}
export interface StorageCredentialKeyring {
  version: 1;
  currentKeyId: string;
  /** Imported keys are non-extractable; the bootstrap JSON is not retained. */
  keys: ReadonlyMap<string, CryptoKey>;
}
export type StorageCredentialRead = { outcome: "available"; plaintext: string } | { outcome: "unavailable" };
export type StorageCredentialReenvelope = {
  outcome: "available";
  expected: StorageCredentialEnvelope;
  replacement: StorageCredentialEnvelope;
} | { outcome: "unavailable" };

export class StorageCredentialUnavailableError extends Error {
  constructor() { super("Storage credential encryption is unavailable."); this.name = "StorageCredentialUnavailableError"; }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, names: readonly string[]) {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function base64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
function bytes(value: unknown, maximum: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !value || value.length > Math.ceil(maximum / 3) * 4 || !BASE64.test(value))
    throw new StorageCredentialUnavailableError();
  const result = Uint8Array.from(atob(value), character => character.charCodeAt(0));
  if (result.length > maximum || base64(result) !== value) throw new StorageCredentialUnavailableError();
  return result;
}
function identity(input: StorageCredentialIdentity) {
  const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0");
  if (!input || !text(input.profileId) || !text(input.credentialRef) || !Number.isSafeInteger(input.configurationRevision)
    || input.configurationRevision < 1 || typeof input.namespaceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.namespaceSha256))
    throw new StorageCredentialUnavailableError();
}
function aad(input: StorageCredentialIdentity, keyId: string): Uint8Array<ArrayBuffer> {
  identity(input);
  if (!KEY_ID.test(keyId)) throw new StorageCredentialUnavailableError();
  // Fixed serialization and domain separation are part of envelope version 1.
  return encoder.encode(JSON.stringify({ kind: "storage-credential-envelope", version: STORAGE_CREDENTIAL_ENVELOPE_VERSION,
    profileId: input.profileId, configurationRevision: input.configurationRevision,
    credentialRef: input.credentialRef, namespaceSha256: input.namespaceSha256, keyId }));
}
function checkedEnvelope(value: unknown): StorageCredentialEnvelope {
  if (!record(value) || !exact(value, ["version", "keyId", "nonce", "ciphertext"])
    || value.version !== STORAGE_CREDENTIAL_ENVELOPE_VERSION || typeof value.keyId !== "string" || !KEY_ID.test(value.keyId))
    throw new StorageCredentialUnavailableError();
  const nonce = bytes(value.nonce, 12), ciphertext = bytes(value.ciphertext, MAX_STORAGE_CREDENTIAL_BYTES + 16);
  if (nonce.length !== 12 || ciphertext.length <= 16) throw new StorageCredentialUnavailableError();
  return { version: STORAGE_CREDENTIAL_ENVELOPE_VERSION, keyId: value.keyId, nonce: value.nonce as string, ciphertext: value.ciphertext as string };
}

/** STORAGE_CREDENTIAL_KEYRING is a Worker Secret containing:
 * {"version":1,"currentKeyId":"key-2026","keys":{"key-2026":"<base64 32 bytes>"}}
 * Keep old IDs/material until retained envelopes have been re-encrypted. */
export async function parseStorageCredentialKeyring(raw: unknown): Promise<StorageCredentialKeyring> {
  try {
    if (typeof raw !== "string" || encoder.encode(raw).length > MAX_KEYRING_BYTES) throw new StorageCredentialUnavailableError();
    const value: unknown = JSON.parse(raw);
    if (!record(value) || !exact(value, ["version", "currentKeyId", "keys"]) || value.version !== 1
      || typeof value.currentKeyId !== "string" || !KEY_ID.test(value.currentKeyId) || !record(value.keys))
      throw new StorageCredentialUnavailableError();
    const entries = Object.entries(value.keys);
    if (!entries.length || entries.length > MAX_KEYS || !Object.hasOwn(value.keys, value.currentKeyId)) throw new StorageCredentialUnavailableError();
    const keys = new Map<string, CryptoKey>();
    for (const [keyId, material] of entries) {
      if (!KEY_ID.test(keyId)) throw new StorageCredentialUnavailableError();
      const keyBytes = bytes(material, 32);
      if (keyBytes.length !== 32) throw new StorageCredentialUnavailableError();
      try { keys.set(keyId, await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"])); }
      finally { keyBytes.fill(0); }
    }
    return { version: 1, currentKeyId: value.currentKeyId, keys };
  } catch { throw new StorageCredentialUnavailableError(); }
}

export async function encryptStorageCredential(keyring: StorageCredentialKeyring, input: StorageCredentialIdentity,
  plaintext: string): Promise<StorageCredentialEnvelope> {
  try {
    const keyId = keyring.currentKeyId, key = keyring.keys.get(keyId);
    if (keyring.version !== 1 || !key || typeof plaintext !== "string") throw new StorageCredentialUnavailableError();
    const payload = encoder.encode(plaintext);
    if (!payload.length || payload.length > MAX_STORAGE_CREDENTIAL_BYTES || decoder.decode(payload) !== plaintext)
      throw new StorageCredentialUnavailableError();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    try {
      const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(input, keyId), tagLength: 128 }, key, payload);
      return { version: STORAGE_CREDENTIAL_ENVELOPE_VERSION, keyId, nonce: base64(nonce), ciphertext: base64(new Uint8Array(sealed)) };
    } finally { payload.fill(0); }
  } catch { throw new StorageCredentialUnavailableError(); }
}

/** Missing keys, swapped identities and authentication failures all preserve the
 * caller's stored ciphertext and return one safe unavailable outcome. */
export async function decryptStorageCredential(keyring: StorageCredentialKeyring, input: StorageCredentialIdentity,
  stored: unknown): Promise<StorageCredentialRead> {
  try {
    const envelope = checkedEnvelope(stored), key = keyring.keys.get(envelope.keyId);
    if (keyring.version !== 1 || !key) return { outcome: "unavailable" };
    const clear = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(envelope.nonce, 12),
      additionalData: aad(input, envelope.keyId), tagLength: 128 }, key, bytes(envelope.ciphertext, MAX_STORAGE_CREDENTIAL_BYTES + 16)));
    try { return { outcome: "available", plaintext: decoder.decode(clear) }; }
    finally { clear.fill(0); }
  } catch { return { outcome: "unavailable" }; }
}

/** Pure rotation preparation. The later persistence service must atomically CAS
 * its row revision AND every expected envelope field before replacing it. A
 * failed CAS keeps the newer stored envelope; never write this result blindly.
 * The profile/config/credential identity is retained and no I/O is performed. */
export async function reenvelopeStorageCredential(keyring: StorageCredentialKeyring, input: StorageCredentialIdentity,
  stored: unknown): Promise<StorageCredentialReenvelope> {
  try {
    const expected = checkedEnvelope(stored), opened = await decryptStorageCredential(keyring, input, expected);
    if (opened.outcome !== "available") return opened;
    const replacement = await encryptStorageCredential(keyring, input, opened.plaintext);
    return { outcome: "available", expected, replacement };
  } catch { return { outcome: "unavailable" }; }
}
