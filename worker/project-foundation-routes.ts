import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  acceptAndUploadR2Asset, boundedR2UploadBody, requireR2UploadRequestId, rethrowR2UploadError,
} from "./uploads/r2-upload-acceptance";
import { contentLengthWithin } from "./request-guards";
import type { Env } from "./types";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };

const MAX_PROJECT_ATTACHMENT_UPLOAD_BYTES = 10 * 1024 * 1024;

function projectUploadFilename(encoded: string | undefined) {
  if (!encoded) throw new HTTPException(400, { message: "A Project attachment filename is required" });
  let filename: string;
  try {
    filename = decodeURIComponent(encoded);
  } catch {
    throw new HTTPException(400, { message: "Project attachment filename encoding is invalid" });
  }
  if (!filename.trim() || filename.includes("\u0000") || [...filename].length > 255) {
    throw new HTTPException(400, { message: "Project attachment filename is invalid" });
  }
  return filename;
}

export const routes = new Hono<AppBindings>();

routes.post("/project-assets", async (c) => {
  c.header("Cache-Control", "no-store");
  const requestId = requireR2UploadRequestId(c.req.header("x-upload-request-id"));
  if (!contentLengthWithin(c.req.raw, MAX_PROJECT_ATTACHMENT_UPLOAD_BYTES)) {
    throw new HTTPException(413, { message: "Project attachment uploads are limited to 10 MB" });
  }
  const contentType = (c.req.header("content-type") || "application/octet-stream").trim();
  const filename = projectUploadFilename(c.req.header("x-project-filename-uri"));
  if (!contentType || contentType.length > 200) {
    throw new HTTPException(400, { message: "Project attachment MIME metadata is invalid" });
  }
  const buffer = await boundedR2UploadBody(c.req.raw);
  if (buffer.byteLength > MAX_PROJECT_ATTACHMENT_UPLOAD_BYTES) {
    throw new HTTPException(413, { message: "Project attachment uploads are limited to 10 MB" });
  }

  const upload = await acceptAndUploadR2Asset(c.env, {
    requestId, ingress: "project_attachment",
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
