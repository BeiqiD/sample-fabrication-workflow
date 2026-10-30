import type { LocalVolumeNamespace } from "./local-volume-profile";

export interface RegisterLocalProfileInput {
  readonly operationId: string;
  /** An opaque ID in trusted installation configuration, never a path. */
  readonly volumeDescriptorId: string;
}
export interface LocalProfileRegistrationReceipt {
  readonly operationId: string;
  readonly storageProfileId: string;
  readonly namespace: Readonly<LocalVolumeNamespace>;
  readonly namespaceSha256: string;
  readonly configurationRevision: 1;
  /** Historical registration mode; this is not the current runtime mode. */
  readonly registeredMode: "read_only";
  readonly createdAt: string;
  readonly actor: string;
}
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class LocalProfileRegistrationInputError extends Error {
  constructor() { super("Invalid local profile registration"); this.name = "LocalProfileRegistrationInputError"; }
}
export function checkedRegisterLocalProfileInput(value: unknown): Readonly<RegisterLocalProfileInput> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalProfileRegistrationInputError();
  const record = value as Record<string, unknown>;
  if (Reflect.ownKeys(record).length !== 2 || !Object.hasOwn(record, "operationId") || !Object.hasOwn(record, "volumeDescriptorId")) {
    throw new LocalProfileRegistrationInputError();
  }
  const operationId = record.operationId, volumeDescriptorId = record.volumeDescriptorId;
  if (typeof operationId !== "string" || !UUID_V4.test(operationId) || typeof volumeDescriptorId !== "string" || !UUID_V4.test(volumeDescriptorId)) {
    throw new LocalProfileRegistrationInputError();
  }
  return Object.freeze({ operationId, volumeDescriptorId });
}
