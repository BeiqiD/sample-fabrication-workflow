// Canonical metadata contract. Registration never admits a provider or writer.
// This private V26 source remains uncomposed until paired schema qualification.
import { sha256Hex } from "../domain/content-addressing.ts";

export interface LocalVolumeNamespace {
  readonly kind: "local-volume";
  readonly volumeId: string;
  readonly rootId: string;
  readonly namespaceRevision: 1;
}
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEYS = ["kind", "volumeId", "rootId", "namespaceRevision"] as const;
export class LocalVolumeNamespaceError extends Error {
  constructor() { super("Invalid local volume namespace"); this.name = "LocalVolumeNamespaceError"; }
}
function invalid(): never { throw new LocalVolumeNamespaceError(); }

/** Provisioned UUIDs are exact lower-case UUIDv4 values. Neither paths nor
 * profile IDs belong to this preimage. Reordered input fields produce the same
 * fixed-order canonical output, while a stored noncanonical string is rejected. */
export function checkedLocalVolumeNamespace(value: unknown): Readonly<LocalVolumeNamespace> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const item = value as Record<string, unknown>;
  if (Reflect.ownKeys(item).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(item, key))) invalid();
  const kind = item.kind, volumeId = item.volumeId, rootId = item.rootId, namespaceRevision = item.namespaceRevision;
  if (kind !== "local-volume" || typeof volumeId !== "string" || !UUID_V4.test(volumeId)
    || typeof rootId !== "string" || !UUID_V4.test(rootId) || namespaceRevision !== 1) invalid();
  return Object.freeze({ kind: "local-volume", volumeId, rootId, namespaceRevision: 1 });
}
export function canonicalLocalVolumeNamespace(value: unknown): string {
  return JSON.stringify(checkedLocalVolumeNamespace(value));
}
export function checkedStoredLocalVolumeNamespace(value: unknown): Readonly<LocalVolumeNamespace> {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 256) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return invalid(); }
  const namespace = checkedLocalVolumeNamespace(parsed);
  if (JSON.stringify(namespace) !== value) invalid();
  return namespace;
}
export async function localVolumeStorageProfileId(value: unknown): Promise<string> {
  return `storage-profile:local:${await sha256Hex(canonicalLocalVolumeNamespace(value))}`;
}
