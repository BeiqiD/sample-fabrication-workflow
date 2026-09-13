import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  AttachmentIngestionUnavailableError,
  ingestR2Attachment,
  safeAttachmentObjectName,
} from "./attachment-ingestion";
import { contentLengthWithin } from "./request-guards";
import type { Env } from "./types";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };
type ProjectAssetRow = {
  id: string;
  r2_key: string;
  original_name: string;
  mime_type: string;
  byte_size: number;
};

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

function returnReusableProjectAsset(
  row: ProjectAssetRow,
  deduplicated = true,
) {
  return { id: row.id, key: row.r2_key, deduplicated };
}

export const routes = new Hono<AppBindings>();

routes.post("/project-assets", async (c) => {
  if (!contentLengthWithin(c.req.raw, MAX_PROJECT_ATTACHMENT_UPLOAD_BYTES)) {
    throw new HTTPException(413, { message: "Project attachment uploads are limited to 10 MB" });
  }
  const contentType = (c.req.header("content-type") || "application/octet-stream").trim();
  const filename = projectUploadFilename(c.req.header("x-project-filename-uri"));
  if (!contentType || contentType.length > 200) {
    throw new HTTPException(400, { message: "Project attachment MIME metadata is invalid" });
  }
  const buffer = await c.req.arrayBuffer();
  if (buffer.byteLength > MAX_PROJECT_ATTACHMENT_UPLOAD_BYTES) {
    throw new HTTPException(413, { message: "Project attachment uploads are limited to 10 MB" });
  }

  const registration = await ingestR2Attachment(c.env, {
    originalName: filename,
    mimeType: contentType,
    actorEmail: c.get("userEmail"),
    bytes: buffer,
    objectKey: (id) => `${new Date().toISOString().slice(0, 10)}/${id}-${safeAttachmentObjectName(filename)}`,
  }).catch((error: unknown) => {
    if (error instanceof AttachmentIngestionUnavailableError) {
      throw new HTTPException(503, { message: error.publicMessage });
    }
    throw error;
  });
  const payload = returnReusableProjectAsset(
    registration.record,
    registration.deduplicated,
  );
  return registration.deduplicated
    ? c.json(payload)
    : c.json(payload, 201);
});
