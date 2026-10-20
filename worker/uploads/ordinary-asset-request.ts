import { HTTPException } from "hono/http-exception";
import { normalizeR2UploadRequestId } from "../../shared/contracts/r2-upload";
import { contentLengthWithin } from "../request-guards";

/** Existing ordinary asset ingress metadata. This selects no actor, provider,
 * resource grant or runtime; callers retain the original Request for admission. */
export function ordinaryAssetUploadMetadata(request: Request) {
  const rawId = request.headers.get("x-upload-request-id");
  if (!rawId) throw new HTTPException(428, { message: "Reload the application before uploading files." });
  const requestId = normalizeR2UploadRequestId(rawId);
  if (!requestId) throw new HTTPException(400, { message: "A valid upload request ID is required." });
  if (!contentLengthWithin(request, 10 * 1024 * 1024))
    throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
  const mimeType = request.headers.get("content-type") || "application/octet-stream";
  if (!mimeType.toLowerCase().startsWith("image/"))
    throw new HTTPException(415, { message: "Ordinary asset uploads must be images" });
  const encoded = request.headers.get("x-filename-uri");
  let originalName = request.headers.get("x-filename") || "upload";
  if (encoded !== null) {
    try { originalName = decodeURIComponent(encoded); }
    catch { throw new HTTPException(400, { message: "Asset filename encoding is invalid" }); }
  }
  if (!originalName.trim() || originalName.includes("\0") || [...originalName].length > 255)
    throw new HTTPException(400, { message: "Asset filename is invalid" });
  if (mimeType.length > 200) throw new HTTPException(400, { message: "Asset metadata is too long" });
  return Object.freeze({ requestId, ingress: "ordinary_image" as const, originalName, mimeType });
}
