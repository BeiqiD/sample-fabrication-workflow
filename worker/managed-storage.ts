import type { ManagedStorageStatus } from "../shared/types";
import type { Env } from "./types";

export interface ManagedStoragePut {
  key: string;
  body: ReadableStream;
  contentType: string;
  filename: string;
  sha256: string;
}

export interface ManagedStorageObject {
  body: ReadableStream;
  contentType: string;
  etag: string | null;
}

export interface ManagedStorage {
  readonly provider: string;
  readonly authentication: ManagedStorageStatus["authentication"];
  put(input: ManagedStoragePut): Promise<{ byteSize: number }>;
  get(key: string): Promise<ManagedStorageObject | null>;
  delete(key: string): Promise<void>;
}

export function managedStorage(env: Env): ManagedStorage | null {
  // File attachments deliberately have no R2 fallback. A provider is returned
  // here only after its external-drive adapter and server-side authentication
  // have both been configured.
  void env;
  return null;
}

export function managedStorageStatus(env: Env): ManagedStorageStatus {
  const storage = managedStorage(env);
  if (storage) {
    return {
      provider: storage.provider,
      available: true,
      authentication: storage.authentication,
      message: "Managed attachments use a server-side storage binding. No drive credentials are exposed to the browser.",
    };
  }
  const provider = env.MANAGED_STORAGE_PROVIDER || null;
  return {
    provider,
    available: false,
    authentication: provider ? "oauth" : "not_configured",
    message: provider
      ? "The configured file storage provider is not connected or authenticated. File attachments are disabled."
      : "Connect a file storage provider to enable file attachments. Attachment links remain available.",
  };
}

export function managedObjectKey(submissionId: string, itemId: string, filename: string) {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180) || "attachment";
  return `comment-attachments/${submissionId}/${itemId}-${safeName}`;
}
