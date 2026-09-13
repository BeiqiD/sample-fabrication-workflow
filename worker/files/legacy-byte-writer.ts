import type { Env } from "../types";
import type { ManagedStorage } from "../managed-storage";
import { writeVerifiedBytes } from "./byte-writer";
import { verifyByteStream, verifyStoredBytes, type ByteExpectation } from "./byte-verification";
import { cloudflareSha256 } from "./storage-adapters/cloudflare-sha256";
import { r2ByteReader } from "./storage-adapters/r2-reader";
import { managedByteReader } from "./storage-adapters/managed-reader";
import { r2ByteWriter } from "./storage-adapters/r2-writer";
import { managedByteWriter } from "./storage-adapters/managed-writer";

type Address = ByteExpectation & { objectKey: string };
type WriteMetadata = Address & { originalName: string; mimeType: string };

// Runtime composition only. Both capabilities must refer to the same concrete
// instance. No profile/default selection, SQL, retry, or deletion happens here.
export async function writeR2Bytes(env: Env, input: WriteMetadata & { bytes: ArrayBuffer }): Promise<void> {
  await writeVerifiedBytes({ reader: r2ByteReader(env.ASSETS), writer: r2ByteWriter(env.ASSETS), createHash: cloudflareSha256 },
    { ...input, key: input.objectKey, body: input.bytes, contentType: input.mimeType, filename: input.originalName });
}
export async function verifyR2Bytes(env: Env, input: Address): Promise<void> {
  await verifyStoredBytes(r2ByteReader(env.ASSETS), input.objectKey, input, cloudflareSha256);
}
export async function writeManagedBytes(storage: ManagedStorage, input: WriteMetadata & { body: ReadableStream<Uint8Array> }): Promise<void> {
  await writeVerifiedBytes({ reader: managedByteReader(storage), writer: managedByteWriter(storage), createHash: cloudflareSha256 },
    { ...input, key: input.objectKey, contentType: input.mimeType, filename: input.originalName });
}
export async function verifyManagedBytes(storage: ManagedStorage, input: Address): Promise<void> {
  await verifyStoredBytes(managedByteReader(storage), input.objectKey, input, cloudflareSha256);
}
export async function verifyUploadBody(body: ReadableStream<Uint8Array>, input: ByteExpectation): Promise<void> {
  await verifyByteStream(body, input, cloudflareSha256, "source");
}
