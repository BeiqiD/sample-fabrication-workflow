import { sha256Hex } from "../shared/content-addressing";
import type { ManagedStorage } from "./managed-storage";
import type { Env } from "./types";
import {
  findReusableManagedObject,
  findReusableR2Asset,
  type ReusableManagedObject,
  type ReusableR2Asset,
} from "./blob-lifecycle/reuse";
import {
  BlobRegistrationAuthorityUnavailableError,
  ManagedRegistrationByteSizeMismatchError,
  registerManagedObject,
  registerR2Asset,
} from "./blob-lifecycle/registration";

export interface AttachmentBlobHandle {
  storeKind: "r2" | "managed";
  provider: string;
  objectKey: string;
  blobRecordId: string;
  sha256: string;
  byteSize: number;
}

export class AttachmentIngestionUnavailableError extends Error {
  constructor(readonly publicMessage: string) {
    super(publicMessage);
    this.name = "AttachmentIngestionUnavailableError";
  }
}

export class AttachmentIngestionByteSizeMismatchError extends Error {
  constructor() {
    super("Attachment size changed during upload");
    this.name = "AttachmentIngestionByteSizeMismatchError";
  }
}

export function safeAttachmentObjectName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
}

function throwIngestionError(error: unknown): never {
  if (error instanceof BlobRegistrationAuthorityUnavailableError) {
    throw new AttachmentIngestionUnavailableError(error.publicMessage);
  }
  if (error instanceof ManagedRegistrationByteSizeMismatchError) {
    throw new AttachmentIngestionByteSizeMismatchError();
  }
  throw error;
}

function r2Handle(record: ReusableR2Asset): AttachmentBlobHandle {
  return {
    storeKind: "r2",
    provider: "r2",
    objectKey: record.r2_key,
    blobRecordId: record.id,
    sha256: record.sha256,
    byteSize: Number(record.byte_size),
  };
}

function managedHandle(record: ReusableManagedObject): AttachmentBlobHandle {
  return {
    storeKind: "managed",
    provider: record.provider,
    objectKey: record.object_key,
    blobRecordId: record.id,
    sha256: record.sha256,
    byteSize: Number(record.byte_size),
  };
}

export interface R2AttachmentIngestionInput {
  originalName: string;
  mimeType: string;
  actorEmail: string;
  bytes: ArrayBuffer;
  registrationId?: string;
  objectKey: (registrationId: string) => string | Promise<string>;
}

export interface R2AttachmentIngestionResult {
  handle: AttachmentBlobHandle;
  record: ReusableR2Asset;
  deduplicated: boolean;
}

export async function ingestR2Attachment(
  env: Env,
  input: R2AttachmentIngestionInput,
): Promise<R2AttachmentIngestionResult> {
  const sha256 = await sha256Hex(input.bytes);
  const id = input.registrationId ?? crypto.randomUUID();
  const objectKey = await input.objectKey(id);

  try {
    const registration = await registerR2Asset(env, {
      id,
      objectKey,
      originalName: input.originalName,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      sha256,
      actorEmail: input.actorEmail,
      bytes: input.bytes,
      findWinner: () => findReusableR2Asset(env, sha256),
    });
    return {
      handle: r2Handle(registration.asset),
      record: registration.asset,
      deduplicated: registration.deduplicated,
    };
  } catch (error) {
    throwIngestionError(error);
  }
}

export interface ManagedAttachmentIngestionInput {
  originalName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  actorEmail: string;
  body: ReadableStream;
  registrationId?: string;
  objectKey: (registrationId: string) => string | Promise<string>;
}

export interface ManagedAttachmentIngestionResult {
  handle: AttachmentBlobHandle;
  record: ReusableManagedObject;
  deduplicated: boolean;
}

export async function ingestManagedAttachment(
  env: Env,
  storage: ManagedStorage,
  input: ManagedAttachmentIngestionInput,
): Promise<ManagedAttachmentIngestionResult> {
  const id = input.registrationId ?? crypto.randomUUID();
  const objectKey = await input.objectKey(id);

  try {
    const registration = await registerManagedObject(env, storage, {
      id,
      objectKey,
      originalName: input.originalName,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      sha256: input.sha256,
      actorEmail: input.actorEmail,
      body: input.body,
      findWinner: () => findReusableManagedObject(
        env,
        storage.provider,
        input.sha256,
        input.byteSize,
      ),
    });
    return {
      handle: managedHandle(registration.object),
      record: registration.object,
      deduplicated: registration.deduplicated,
    };
  } catch (error) {
    throwIngestionError(error);
  }
}
