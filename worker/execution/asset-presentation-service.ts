import { HTTPException } from "hono/http-exception";
import type { RunStepAssetPresentationInput } from "../../shared/types";
import { isCanonicalMimeType } from "../../shared/mime-type";
import type { FileBusinessMetadataDatabase, FileBusinessMetadataStatement } from "../files/business-metadata-sql";

export function validRunStepAssetPresentation(
  value: unknown,
): value is RunStepAssetPresentationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<RunStepAssetPresentationInput>;
  return typeof candidate.filename === "string"
    && !candidate.filename.includes("\u0000")
    && candidate.filename.trim().length >= 1
    && [...candidate.filename].length <= 255
    && isCanonicalMimeType(candidate.mimeType)
    && typeof candidate.byteSize === "number"
    && Number.isSafeInteger(candidate.byteSize)
    && candidate.byteSize >= 0;
}

export async function resolveRunStepAssetPresentationWithDatabase<Statement extends FileBusinessMetadataStatement<Statement>>(
  db: FileBusinessMetadataDatabase<Statement>,
  assetId: string,
  requested: RunStepAssetPresentationInput | undefined,
): Promise<RunStepAssetPresentationInput> {
  const blob = await db.prepare(`
    SELECT original_name, mime_type, byte_size
    FROM assets WHERE id = ? AND status = 'ready'
    LIMIT 1
  `).bind(assetId).first<{
    original_name: string;
    mime_type: string;
    byte_size: number;
  }>();
  if (!blob) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const presentation = requested ?? {
    filename: blob.original_name,
    mimeType: blob.mime_type,
    byteSize: Number(blob.byte_size),
  };
  if (presentation.byteSize !== Number(blob.byte_size)) {
    throw new HTTPException(400, { message: "The uploaded diagram size does not match the selected asset" });
  }
  return presentation;
}
