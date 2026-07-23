import type { ManagedStorageStatus } from "../shared/types";
import {
  SwitchdriveAuthenticationError,
  SwitchdriveStorage,
  switchdriveConfiguration,
} from "./switchdrive-storage";
import type { Env } from "./types";

export interface ManagedStoragePut {
  key: string;
  body: ReadableStream;
  contentType: string;
  filename: string;
  sha256: string;
  byteSize: number;
}

export interface ManagedStorageObject {
  body: ReadableStream;
  contentType: string;
  etag: string | null;
}

export interface ManagedStorage {
  readonly provider: string;
  readonly authentication: ManagedStorageStatus["authentication"];
  check(): Promise<void>;
  put(input: ManagedStoragePut): Promise<{ byteSize: number }>;
  get(key: string): Promise<ManagedStorageObject | null>;
  delete(key: string): Promise<void>;
}

export function managedStorage(env: Env): ManagedStorage | null {
  if (env.MANAGED_STORAGE_PROVIDER?.trim().toLowerCase() === "switchdrive") {
    const configuration = switchdriveConfiguration(env);
    return configuration ? new SwitchdriveStorage(configuration) : null;
  }
  return null;
}

export async function managedStorageStatus(env: Env): Promise<ManagedStorageStatus> {
  const provider = env.MANAGED_STORAGE_PROVIDER?.trim().toLowerCase() || null;
  let storage: ManagedStorage | null = null;
  try {
    storage = managedStorage(env);
  } catch {
    return {
      provider,
      available: false,
      authentication: "not_configured",
      message: provider === "switchdrive"
        ? "The configured SWITCHdrive WebDAV address or storage root is invalid. File attachments are disabled."
        : "The configured file storage provider is invalid. File attachments are disabled.",
    };
  }
  if (storage) {
    try {
      await storage.check();
      return {
        provider: storage.provider,
        available: true,
        authentication: storage.authentication,
        message: "SWITCHdrive is connected. Original files are stored there without modification.",
      };
    } catch (error) {
      console.warn("Managed storage connection check failed", error instanceof Error ? error.name : "UnknownError");
      return {
        provider: storage.provider,
        available: false,
        authentication: storage.authentication,
        message: error instanceof SwitchdriveAuthenticationError
          ? "SWITCHdrive rejected the configured username or App Passcode. File attachments are disabled."
          : "SWITCHdrive could not be reached or its WebDAV address is invalid. File attachments are disabled.",
      };
    }
  }
  return {
    provider,
    available: false,
    authentication: "not_configured",
    message: provider
      ? provider === "switchdrive"
        ? "Complete the SWITCHdrive WebDAV address, username, and App Passcode to enable file attachments."
        : "The configured file storage provider is not supported. File attachments are disabled."
      : "Connect a file storage provider to enable file attachments. Attachment links remain available.",
  };
}

export function managedObjectKey(
  submissionId: string,
  itemId: string,
  filename: string,
  sample?: { id: string; code: string },
) {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180) || "attachment";
  const safeCode = sample?.code.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "sample";
  const prefix = sample
    ? `samples/${safeCode}--${sample.id}/comment-attachments`
    : "shared-comment-attachments";
  return `${prefix}/${submissionId}/${itemId}-${safeName}`;
}
