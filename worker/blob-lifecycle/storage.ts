import { ByteDeletionError } from "../files/byte-deleter";
import { legacyByteDeleter } from "../files/legacy-byte-deleter";
import { legacyByteReader } from "../files/legacy-byte-reader";
import type { Env } from "../types";
import type { BlobLocator } from "./types";

export type BlobReadResult =
  | { outcome: "available"; body: ReadableStream; contentType: string; etag: string | null; httpMetadata?: Readonly<Record<string, string>> }
  | { outcome: "missing" }
  | { outcome: "provider_unavailable"; message: string };

export type BlobStatResult =
  | { outcome: "available"; byteSize: number | null; contentType: string; etag: string | null }
  | { outcome: "missing" }
  | { outcome: "provider_unavailable"; message: string };

export async function statBlob(env: Env, locator: BlobLocator): Promise<BlobStatResult> {
  const selected = legacyByteReader(env, locator);
  if (selected.outcome !== "selected") return selected;
  const result = await selected.reader.stat(locator.objectKey);
  if (result.outcome === "available") {
    return { outcome: "available", byteSize: result.byteSize, contentType: result.contentType, etag: result.etag };
  }
  if (result.outcome === "missing") return result;
  return { outcome: "provider_unavailable", message: unavailableMessage(locator) };
}

export async function getBlob(env: Env, locator: BlobLocator): Promise<BlobReadResult> {
  const selected = legacyByteReader(env, locator);
  if (selected.outcome !== "selected") return selected;
  const result = await selected.reader.read(locator.objectKey);
  if (result.outcome === "available" || result.outcome === "missing") return result;
  return { outcome: "provider_unavailable", message: unavailableMessage(locator) };
}

function unavailableMessage(locator: BlobLocator) {
  return locator.storeKind === "r2" ? "R2 is unavailable" : "Managed storage is unavailable";
}

export async function removeBlob(env: Env, locator: BlobLocator) {
  const result = await legacyByteDeleter(env, locator).delete(locator.objectKey);
  if (result.outcome !== "acknowledged") throw new ByteDeletionError(result.outcome);
}
