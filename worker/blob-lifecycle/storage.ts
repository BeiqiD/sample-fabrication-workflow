import { managedStorage } from "../managed-storage";
import type { Env } from "../types";
import type { BlobLocator } from "./types";

export type BlobReadResult =
  | { outcome: "available"; body: ReadableStream; contentType: string; etag: string | null }
  | { outcome: "missing" }
  | { outcome: "provider_unavailable"; message: string };

export type BlobStatResult =
  | { outcome: "available"; byteSize: number | null; contentType: string; etag: string | null }
  | { outcome: "missing" }
  | { outcome: "provider_unavailable"; message: string };

export async function statBlob(env: Env, locator: BlobLocator): Promise<BlobStatResult> {
  if (locator.storeKind === "r2") {
    try {
      const object = await env.ASSETS.head(locator.objectKey);
      if (!object) return { outcome: "missing" };
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      return {
        outcome: "available",
        byteSize: Number.isSafeInteger(object.size) && object.size >= 0 ? object.size : null,
        contentType: headers.get("content-type") || "application/octet-stream",
        etag: object.httpEtag || null,
      };
    } catch (error) {
      return {
        outcome: "provider_unavailable",
        message: error instanceof Error ? error.message : "R2 is unavailable",
      };
    }
  }

  try {
    const storage = managedStorage(env);
    if (!storage || storage.provider !== locator.provider) {
      return { outcome: "provider_unavailable", message: "Managed storage is not configured" };
    }
    const object = await storage.stat(locator.objectKey);
    if (!object) return { outcome: "missing" };
    return { outcome: "available", ...object };
  } catch (error) {
    return {
      outcome: "provider_unavailable",
      message: error instanceof Error ? error.message : "Managed storage is unavailable",
    };
  }
}

export async function getBlob(env: Env, locator: BlobLocator): Promise<BlobReadResult> {
  if (locator.storeKind === "r2") {
    try {
      const object = await env.ASSETS.get(locator.objectKey);
      if (!object) return { outcome: "missing" };
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      return {
        outcome: "available",
        body: object.body,
        contentType: headers.get("content-type") || "application/octet-stream",
        etag: object.httpEtag || null,
      };
    } catch (error) {
      return {
        outcome: "provider_unavailable",
        message: error instanceof Error ? error.message : "R2 is unavailable",
      };
    }
  }

  try {
    const storage = managedStorage(env);
    if (!storage || storage.provider !== locator.provider) {
      return { outcome: "provider_unavailable", message: "Managed storage is not configured" };
    }
    const object = await storage.get(locator.objectKey);
    if (!object) return { outcome: "missing" };
    return {
      outcome: "available",
      body: object.body,
      contentType: object.contentType,
      etag: object.etag,
    };
  } catch (error) {
    return {
      outcome: "provider_unavailable",
      message: error instanceof Error ? error.message : "Managed storage is unavailable",
    };
  }
}

export async function removeBlob(env: Env, locator: BlobLocator) {
  if (locator.storeKind === "r2") {
    await env.ASSETS.delete(locator.objectKey);
    return;
  }
  const storage = managedStorage(env);
  if (!storage || storage.provider !== locator.provider) {
    throw new Error(`Managed storage provider ${locator.provider} is unavailable`);
  }
  await storage.delete(locator.objectKey);
}
