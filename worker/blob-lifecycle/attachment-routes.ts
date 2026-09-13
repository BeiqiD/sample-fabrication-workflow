import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { contentLengthWithin } from "../request-guards";
import {
  AttachmentIngestionUnavailableError,
  ingestR2Attachment,
  safeAttachmentObjectName,
} from "../attachment-ingestion";
import type { Env } from "../types";

export const routes = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();

routes.post("/assets", async (c) => {
  if (!contentLengthWithin(c.req.raw, 10 * 1024 * 1024)) throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
  const contentType = c.req.header("content-type") || "application/octet-stream";
  if (!contentType.toLowerCase().startsWith("image/")) throw new HTTPException(415, { message: "Ordinary asset uploads must be images" });
  const filename = c.req.header("x-filename") || "upload";
  if (filename.length > 255 || contentType.length > 200) throw new HTTPException(400, { message: "Asset metadata is too long" });
  const buffer = await c.req.arrayBuffer();
  if (buffer.byteLength > 10 * 1024 * 1024) throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
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
  const payload = {
    id: registration.record.id,
    key: registration.record.r2_key,
    deduplicated: registration.deduplicated,
  };
  return registration.deduplicated
    ? c.json(payload)
    : c.json(payload, 201);
});
