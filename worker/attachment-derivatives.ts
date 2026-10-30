import {
  isTiffMetadata,
  normalizedAttachmentClassificationMimeType,
} from "../shared/tiff";
import { isSafeInlineRasterMimeType } from "./media-response";

export const BROWSER_PREVIEW_DERIVATIVE_KIND = "browser_preview" as const;
export const COMMENT_RASTER_PREVIEW_GENERATOR_VERSION = "comment-raster-webp-1600-q45-v1" as const;
export const COMMENT_TIFF_PREVIEW_GENERATOR_VERSION = "comment-tiff-webp-1600-q45-v1" as const;
export const ATTACHMENT_DERIVATIVE_LEASE_MS = 30 * 24 * 60 * 60 * 1000;

type DerivativeKind = typeof BROWSER_PREVIEW_DERIVATIVE_KIND;

type RegisterReadyDerivativeInput = {
  sourceSha256: string;
  sourceByteSize: number;
  derivativeKind?: DerivativeKind;
  generatorVersion: string;
  derivedAssetId: string;
  actorEmail: string | null;
};

type RecordDerivativeFailureInput = {
  sourceSha256: string;
  sourceByteSize: number;
  derivativeKind?: DerivativeKind;
  generatorVersion: string;
  errorCode: string;
  actorEmail: string | null;
};

export type AttachmentDerivative = {
  id: string;
  sourceSha256: string;
  sourceByteSize: number;
  derivativeKind: DerivativeKind;
  generatorVersion: string;
  derivedAssetId: string;
  assetKey: string;
  mimeType: string;
  byteSize: number;
  retainUntil: string;
};

export type AttachmentBrowserPreview = {
  source: "original" | "derivative";
  assetId: string;
  assetKey: string;
  mimeType: string;
  byteSize: number;
  derivativeId: string | null;
  generatorVersion: string | null;
};

function derivativeLeaseUntil(now: Date) {
  return new Date(now.getTime() + ATTACHMENT_DERIVATIVE_LEASE_MS).toISOString();
}

function validSha256(value: string) {
  return /^[a-f0-9]{64}$/.test(value);
}

function validSourceByteSize(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

function validGeneratorVersion(value: string) {
  return value.length >= 1 && value.length <= 128 && !value.includes("\u0000");
}

export function attachmentPreviewGeneratorVersion(
  filename: string,
  mimeType: string,
) {
  if (filename.includes("\u0000") || mimeType.includes("\u0000")) return null;
  if (isTiffMetadata(filename, mimeType)) {
    return COMMENT_TIFF_PREVIEW_GENERATOR_VERSION;
  }
  const normalized = normalizedAttachmentClassificationMimeType(mimeType);
  return normalized?.startsWith("image/")
    ? COMMENT_RASTER_PREVIEW_GENERATOR_VERSION
    : null;
}

async function readyDerivativeRow(
  db: D1Database,
  sourceSha256: string,
  sourceByteSize: number,
  derivativeKind: DerivativeKind,
  generatorVersion: string,
) {
  return db.prepare(`
    SELECT ad.id,
           ad.source_sha256,
           ad.source_byte_size,
           ad.derivative_kind,
           ad.generator_version,
           ad.derived_asset_id,
           ad.retain_until,
           a.r2_key,
           a.mime_type,
           a.byte_size
    FROM attachment_derivatives ad
    JOIN attachment_derivative_browser_safe_assets a
      ON a.id = ad.derived_asset_id
    WHERE ad.source_sha256 = ?
      AND ad.source_byte_size = ?
      AND ad.derivative_kind = ?
      AND ad.generator_version = ?
      AND ad.status = 'ready'
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = a.r2_key
          AND bg.state IN ('deleting', 'deleted')
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = a.r2_key
      )
    LIMIT 1
  `).bind(
    sourceSha256,
    sourceByteSize,
    derivativeKind,
    generatorVersion,
  ).first<{
    id: string;
    source_sha256: string;
    source_byte_size: number;
    derivative_kind: DerivativeKind;
    generator_version: string;
    derived_asset_id: string;
    retain_until: string;
    r2_key: string;
    mime_type: string;
    byte_size: number;
  }>();
}

function serializeDerivative(
  row: NonNullable<Awaited<ReturnType<typeof readyDerivativeRow>>>,
): AttachmentDerivative {
  return {
    id: row.id,
    sourceSha256: row.source_sha256,
    sourceByteSize: Number(row.source_byte_size),
    derivativeKind: row.derivative_kind,
    generatorVersion: row.generator_version,
    derivedAssetId: row.derived_asset_id,
    assetKey: row.r2_key,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    retainUntil: row.retain_until,
  };
}

function identityInputValid({
  sourceSha256,
  sourceByteSize,
  generatorVersion,
}: {
  sourceSha256: string;
  sourceByteSize: number;
  generatorVersion: string;
}) {
  return validSha256(sourceSha256)
    && validSourceByteSize(sourceByteSize)
    && validGeneratorVersion(generatorVersion);
}

async function touchReadyDerivativeLease(
  db: D1Database,
  sourceSha256: string,
  sourceByteSize: number,
  derivativeKind: DerivativeKind,
  generatorVersion: string,
  now: Date,
) {
  const nowIso = now.toISOString();
  const retainUntil = derivativeLeaseUntil(now);
  await db.prepare(`
    UPDATE attachment_derivatives
    SET retain_until = CASE
          WHEN retain_until IS NULL OR datetime(retain_until) < datetime(?)
            THEN ?
          ELSE retain_until
        END,
        updated_at = ?
    WHERE source_sha256 = ?
      AND source_byte_size = ?
      AND derivative_kind = ?
      AND generator_version = ?
      AND status = 'ready'
      AND EXISTS (
        SELECT 1
        FROM attachment_derivative_browser_safe_assets a
        WHERE a.id = attachment_derivatives.derived_asset_id
          AND NOT EXISTS (
            SELECT 1 FROM blob_gc_ledger bg
            WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
              AND bg.object_key = a.r2_key
              AND bg.state IN ('deleting', 'deleted')
          )
          AND NOT EXISTS (
            SELECT 1 FROM blob_integrity_quarantine biq
            WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
              AND biq.object_key = a.r2_key
          )
      )
  `).bind(
    retainUntil,
    retainUntil,
    nowIso,
    sourceSha256,
    sourceByteSize,
    derivativeKind,
    generatorVersion,
  ).run();
}

/**
 * Trusted producer boundary. The caller must have generated `derivedAssetId`
 * server-side from the verified source identity. Client-uploaded previews and
 * domain relationship metadata are not evidence of derivation and must never
 * call this registration path.
 */
export async function registerReadyAttachmentDerivative(
  db: D1Database,
  input: RegisterReadyDerivativeInput,
  now = new Date(),
): Promise<AttachmentDerivative> {
  const derivativeKind = input.derivativeKind ?? BROWSER_PREVIEW_DERIVATIVE_KIND;
  if (!identityInputValid(input)) {
    throw new Error("Attachment derivative identity is invalid");
  }
  const nowIso = now.toISOString();
  const retainUntil = derivativeLeaseUntil(now);

  await db.prepare(`
    INSERT INTO attachment_derivatives (
      id,
      source_sha256,
      source_byte_size,
      derivative_kind,
      generator_version,
      derived_asset_id,
      status,
      error_code,
      retain_until,
      actor_email,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?, ?, ?)
    ON CONFLICT(
      source_sha256,
      source_byte_size,
      derivative_kind,
      generator_version
    ) DO UPDATE SET
      status = 'ready',
      derived_asset_id = CASE
        WHEN attachment_derivatives.status = 'failed'
          OR NOT EXISTS (
            SELECT 1
            FROM attachment_derivative_browser_safe_assets current_asset
            WHERE current_asset.id = attachment_derivatives.derived_asset_id
              AND NOT EXISTS (
                SELECT 1 FROM blob_gc_ledger bg
                WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
                  AND bg.object_key = current_asset.r2_key
                  AND bg.state IN ('deleting', 'deleted')
              )
              AND NOT EXISTS (
                SELECT 1 FROM blob_integrity_quarantine biq
                WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
                  AND biq.object_key = current_asset.r2_key
              )
          )
          THEN excluded.derived_asset_id
        ELSE attachment_derivatives.derived_asset_id
      END,
      error_code = NULL,
      retain_until = CASE
        WHEN attachment_derivatives.retain_until IS NULL
          OR datetime(attachment_derivatives.retain_until) < datetime(excluded.retain_until)
          THEN excluded.retain_until
        ELSE attachment_derivatives.retain_until
      END,
      actor_email = COALESCE(attachment_derivatives.actor_email, excluded.actor_email),
      updated_at = excluded.updated_at
  `).bind(
    crypto.randomUUID(),
    input.sourceSha256,
    input.sourceByteSize,
    derivativeKind,
    input.generatorVersion,
    input.derivedAssetId,
    retainUntil,
    input.actorEmail,
    nowIso,
    nowIso,
  ).run();

  const row = await readyDerivativeRow(
    db,
    input.sourceSha256,
    input.sourceByteSize,
    derivativeKind,
    input.generatorVersion,
  );
  if (!row) throw new Error("Attachment derivative registration was not completed");
  return serializeDerivative(row);
}

export async function recordAttachmentDerivativeFailure(
  db: D1Database,
  input: RecordDerivativeFailureInput,
  now = new Date(),
) {
  const derivativeKind = input.derivativeKind ?? BROWSER_PREVIEW_DERIVATIVE_KIND;
  const errorCode = input.errorCode.trim();
  if (!identityInputValid(input)
    || !errorCode
    || errorCode.includes("\u0000")) {
    throw new Error("Attachment derivative failure identity is invalid");
  }
  const nowIso = now.toISOString();
  await db.prepare(`
    INSERT INTO attachment_derivatives (
      id,
      source_sha256,
      source_byte_size,
      derivative_kind,
      generator_version,
      derived_asset_id,
      status,
      error_code,
      retain_until,
      actor_email,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, 'failed', ?, NULL, ?, ?, ?)
    ON CONFLICT(
      source_sha256,
      source_byte_size,
      derivative_kind,
      generator_version
    ) DO UPDATE SET
      error_code = excluded.error_code,
      actor_email = COALESCE(attachment_derivatives.actor_email, excluded.actor_email),
      updated_at = excluded.updated_at
    WHERE attachment_derivatives.status = 'failed'
  `).bind(
    crypto.randomUUID(),
    input.sourceSha256,
    input.sourceByteSize,
    derivativeKind,
    input.generatorVersion,
    errorCode.slice(0, 500),
    input.actorEmail,
    nowIso,
    nowIso,
  ).run();
}

export async function resolveAttachmentDerivative(
  db: D1Database,
  {
    sourceSha256,
    sourceByteSize,
    generatorVersion,
    derivativeKind = BROWSER_PREVIEW_DERIVATIVE_KIND,
  }: {
    sourceSha256: string;
    sourceByteSize: number;
    generatorVersion: string;
    derivativeKind?: DerivativeKind;
  },
  now = new Date(),
) {
  if (!identityInputValid({ sourceSha256, sourceByteSize, generatorVersion })) {
    return null;
  }
  await touchReadyDerivativeLease(
    db,
    sourceSha256,
    sourceByteSize,
    derivativeKind,
    generatorVersion,
    now,
  );
  const row = await readyDerivativeRow(
    db,
    sourceSha256,
    sourceByteSize,
    derivativeKind,
    generatorVersion,
  );
  return row ? serializeDerivative(row) : null;
}

async function liveR2Asset(db: D1Database, assetId: string) {
  return db.prepare(`
    SELECT a.id, a.r2_key, a.original_name, a.mime_type, a.byte_size, a.sha256
    FROM assets a
    WHERE a.id = ? AND a.status = 'ready'
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = a.r2_key
          AND bg.state IN ('deleting', 'deleted')
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = a.r2_key
      )
    LIMIT 1
  `).bind(assetId).first<{
    id: string;
    r2_key: string;
    original_name: string;
    mime_type: string;
    byte_size: number;
    sha256: string | null;
  }>();
}

export async function resolveR2AttachmentBrowserPreview(
  db: D1Database,
  assetId: string,
  now = new Date(),
): Promise<AttachmentBrowserPreview | null> {
  const source = await liveR2Asset(db, assetId);
  if (!source) return null;
  if (isSafeInlineRasterMimeType(source.mime_type)) {
    return {
      source: "original",
      assetId: source.id,
      assetKey: source.r2_key,
      mimeType: source.mime_type,
      byteSize: Number(source.byte_size),
      derivativeId: null,
      generatorVersion: null,
    };
  }
  if (!source.sha256) return null;
  const generatorVersion = attachmentPreviewGeneratorVersion(
    source.original_name,
    source.mime_type,
  );
  if (!generatorVersion) return null;
  const derivative = await resolveAttachmentDerivative(db, {
    sourceSha256: source.sha256,
    sourceByteSize: Number(source.byte_size),
    generatorVersion,
  }, now);
  return derivative ? {
    source: "derivative",
    assetId: derivative.derivedAssetId,
    assetKey: derivative.assetKey,
    mimeType: derivative.mimeType,
    byteSize: derivative.byteSize,
    derivativeId: derivative.id,
    generatorVersion: derivative.generatorVersion,
  } : null;
}

export async function resolveManagedAttachmentBrowserPreview(
  db: D1Database,
  storageObjectId: string,
  now = new Date(),
): Promise<AttachmentBrowserPreview | null> {
  const source = await db.prepare(`
    SELECT mso.original_name, mso.mime_type, mso.byte_size, mso.sha256
    FROM managed_storage_objects mso
    WHERE mso.id = ? AND mso.status = 'ready'
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'managed'
          AND bg.provider = mso.provider
          AND bg.object_key = mso.object_key
          AND bg.state IN ('deleting', 'deleted')
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'managed'
          AND biq.provider = mso.provider
          AND biq.object_key = mso.object_key
      )
    LIMIT 1
  `).bind(storageObjectId).first<{
    original_name: string;
    mime_type: string;
    byte_size: number;
    sha256: string;
  }>();
  if (!source) return null;
  const generatorVersion = attachmentPreviewGeneratorVersion(
    source.original_name,
    source.mime_type,
  );
  if (!generatorVersion) return null;
  const derivative = await resolveAttachmentDerivative(db, {
    sourceSha256: source.sha256,
    sourceByteSize: Number(source.byte_size),
    generatorVersion,
  }, now);
  return derivative ? {
    source: "derivative",
    assetId: derivative.derivedAssetId,
    assetKey: derivative.assetKey,
    mimeType: derivative.mimeType,
    byteSize: derivative.byteSize,
    derivativeId: derivative.id,
    generatorVersion: derivative.generatorVersion,
  } : null;
}
