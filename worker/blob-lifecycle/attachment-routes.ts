import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { contentLengthWithin } from "../request-guards";
import {
  acceptAndUploadR2Asset, boundedR2UploadBody, getR2UploadRequestState,
  requireR2UploadRequestId, rethrowR2UploadError,
} from "../uploads/r2-upload-acceptance";
import type { Env } from "../types";

export const routes = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();

function uploadFilename(encoded: string | undefined, legacy: string | undefined): string {
  let filename = legacy || "upload";
  // The negotiated URI header is authoritative when both are supplied; old
  // clients with a request ID can continue using their legacy ASCII header.
  if (encoded !== undefined) {
    try { filename = decodeURIComponent(encoded); }
    catch { throw new HTTPException(400, { message: "Asset filename encoding is invalid" }); }
  }
  if (!filename.trim() || filename.includes("\0") || [...filename].length > 255) {
    throw new HTTPException(400, { message: "Asset filename is invalid" });
  }
  return filename;
}

routes.post("/assets", async (c) => {
  c.header("Cache-Control", "no-store");
  const requestId = requireR2UploadRequestId(c.req.header("x-upload-request-id"));
  if (!contentLengthWithin(c.req.raw, 10 * 1024 * 1024)) throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
  const contentType = c.req.header("content-type") || "application/octet-stream";
  if (!contentType.toLowerCase().startsWith("image/")) throw new HTTPException(415, { message: "Ordinary asset uploads must be images" });
  const filename = uploadFilename(c.req.header("x-filename-uri"), c.req.header("x-filename"));
  if (contentType.length > 200) throw new HTTPException(400, { message: "Asset metadata is too long" });
  const buffer = await boundedR2UploadBody(c.req.raw);
  if (buffer.byteLength > 10 * 1024 * 1024) throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
  const upload = await acceptAndUploadR2Asset(c.env, {
    requestId, ingress: "ordinary_image",
    originalName: filename,
    mimeType: contentType,
    actorEmail: c.get("userEmail"),
    bytes: buffer,
  }).catch(rethrowR2UploadError);
  if (upload.state.status === "ready") return c.json(upload.state.result,
    upload.fresh && !upload.state.result.deduplicated ? 201 : 200);
  return c.json(upload.state, upload.state.status === "pending" ? 202
    : upload.state.status === "expired" ? 410 : upload.state.status === "failed" ? 409 : 503);
});

routes.get("/r2-upload-requests/:requestId", async (c) => {
  c.header("Cache-Control", "no-store");
  const requestId = requireR2UploadRequestId(c.req.param("requestId"));
  const state = await getR2UploadRequestState(c.env, c.get("userEmail"), requestId).catch(rethrowR2UploadError);
  if (!state) throw new HTTPException(404, { message: "Upload request not found." });
  return c.json(state);
});
