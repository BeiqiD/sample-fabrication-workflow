import { validateCommentAcceptedItemResultV21, type CommentAcceptedItemResultV21 } from "./comment-acceptance";
import { validSha256 } from "./comment-submissions";

/** Live V26 Local receipt, exactly as enumerated by immutable0024. This value
 * records an already committed typed File publication; it grants no provider,
 * Request, Group or resource authority. Historical /2 and archive validators
 * remain unchanged and cannot admit /3 through their original branches. */
export interface LocalCommentAcceptedItemResult {
  schema: "comment-upload/3"; storeKind: "file"; provider: "local";
  blobRecordId: string; fileId: string; storageProfileId: string; storageProfileRevision: 1;
  objectKey: string; sha256: string; byteSize: number; deduplicated: boolean;
}
export type CommentAcceptedItemResultV26 = CommentAcceptedItemResultV21 | LocalCommentAcceptedItemResult;
function text(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && [...value].length <= maximum && !value.includes("\0");
}
export function validateLocalCommentAcceptedItemResult(value: unknown,
  context: { maxByteSize?: number } = {}): LocalCommentAcceptedItemResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local accepted Comment upload result");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== ["schema", "storeKind", "provider", "blobRecordId", "fileId", "storageProfileId",
    "storageProfileRevision", "objectKey", "sha256", "byteSize", "deduplicated"].sort().join(",")
    || row.schema !== "comment-upload/3" || row.storeKind !== "file" || row.provider !== "local"
    || !text(row.blobRecordId) || !text(row.fileId) || !text(row.storageProfileId) || row.storageProfileRevision !== 1
    || !text(row.objectKey, 4096) || !validSha256(row.sha256) || !Number.isSafeInteger(row.byteSize)
    || Number(row.byteSize) < 1 || Number(row.byteSize) > (context.maxByteSize ?? 100 * 1024 * 1024)
    || typeof row.deduplicated !== "boolean") throw new Error("Invalid local accepted Comment upload result");
  return value as LocalCommentAcceptedItemResult;
}
/** Explicit current Local consumers may also decode historical receipts. This
 * does not allow their provider to be opened; the live issuer checks the exact
 * profile/role/physical tuple before every read and publication. */
export function validateCommentAcceptedItemResultV26(value: unknown,
  context: { maxByteSize?: number } = {}): CommentAcceptedItemResultV26 {
  if (value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).schema === "comment-upload/3")
    return validateLocalCommentAcceptedItemResult(value, context);
  return validateCommentAcceptedItemResultV21(value, context);
}
