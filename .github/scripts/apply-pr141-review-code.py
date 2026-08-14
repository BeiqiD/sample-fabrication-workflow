from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


def replace_count(path: str, old: str, new: str, expected: int) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"{path}: expected {expected} replacements, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new))


# Ordinary live R2 delivery and execution-image delivery must fail closed after
# a definite integrity quarantine. Export delivery remains intentionally
# separate so complete export can still report the byte mismatch.
r2_gc_guard = '''      AND NOT EXISTS (\n        SELECT 1\n        FROM blob_gc_ledger bg\n        WHERE bg.store_kind = 'r2'\n          AND bg.provider = 'r2'\n          AND bg.object_key = a.r2_key\n          AND bg.state IN ('deleting', 'deleted')\n      )'''
r2_live_guard = r2_gc_guard + '''\n      AND NOT EXISTS (\n        SELECT 1\n        FROM blob_integrity_quarantine biq\n        WHERE biq.store_kind = 'r2'\n          AND biq.provider = 'r2'\n          AND biq.object_key = a.r2_key\n      )'''
replace_count("worker/reference-routes.ts", r2_gc_guard, r2_live_guard, 2)

# Managed Comment export intentionally retains access; only the ordinary live
# download route excludes quarantined locators.
replace_once(
    "worker/comment-submission-routes.ts",
    '''     WHERE csi.id = ? AND csi.kind = 'attachment' AND csi.status = 'ready'\n       AND csi.deleted_at IS NULL\n       AND ${readableSubmissionTargetsSql("cs")}`,''',
    '''     WHERE csi.id = ? AND csi.kind = 'attachment' AND csi.status = 'ready'\n       AND csi.deleted_at IS NULL\n       AND NOT EXISTS (\n         SELECT 1 FROM blob_integrity_quarantine biq\n         WHERE biq.store_kind = 'managed' AND biq.provider = mso.provider\n           AND biq.object_key = mso.object_key\n       )\n       AND ${readableSubmissionTargetsSql("cs")}`,''',
)

# FabuBlox assets must be registered before the larger dependent batch. Each
# registration has a bounded winner-recovery loop, so a valid concurrent winner
# inserted after the initial provider verification is reconciled rather than
# turning the whole import into a failed 500.
replace_once(
    "worker/index.ts",
    '''    for (let index = 0; index < newAssets.length; index += 5) {\n      const uploadResults = await Promise.allSettled(newAssets.slice(index, index + 5).map(async (asset) => {\n        await c.env.ASSETS.put(asset.key, asset.buffer, { httpMetadata: { contentType: asset.mimeType } });\n        uploadedKeys.push(asset.key);\n      }));\n      const failedUpload = uploadResults.find((result) => result.status === "rejected");\n      if (failedUpload?.status === "rejected") throw failedUpload.reason;\n    }\n    const workbookAsset = resolved.find((asset) => asset.kind === "workbook")!;''',
    '''    for (let index = 0; index < newAssets.length; index += 5) {\n      const uploadResults = await Promise.allSettled(newAssets.slice(index, index + 5).map(async (asset) => {\n        await c.env.ASSETS.put(asset.key, asset.buffer, { httpMetadata: { contentType: asset.mimeType } });\n        uploadedKeys.push(asset.key);\n      }));\n      const failedUpload = uploadResults.find((result) => result.status === "rejected");\n      if (failedUpload?.status === "rejected") throw failedUpload.reason;\n    }\n\n    for (const asset of newAssets) {\n      let registered = false;\n      for (let attempt = 0; attempt < 2; attempt += 1) {\n        try {\n          await c.env.DB.prepare(\n            `INSERT INTO assets\n             (id, import_id, r2_key, original_name, mime_type, byte_size, status, actor_email, created_at, sha256)\n             VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,\n          ).bind(\n            asset.assetId,\n            importId,\n            asset.key,\n            asset.originalName,\n            asset.mimeType,\n            asset.buffer.byteLength,\n            userEmail,\n            now,\n            asset.sha256,\n          ).run();\n          registered = true;\n          break;\n        } catch (error) {\n          const winner = await reusableR2Asset(c.env, asset.sha256);\n          if (winner) {\n            if (winner.id === asset.assetId && winner.r2_key === asset.key) {\n              registered = true;\n              break;\n            }\n            await c.env.ASSETS.delete(asset.key);\n            for (const candidate of resolved) {\n              if (candidate.sha256 !== asset.sha256) continue;\n              candidate.assetId = winner.id;\n              candidate.key = winner.r2_key;\n              candidate.isNew = false;\n            }\n            registered = true;\n            break;\n          }\n          if (attempt === 1) throw error;\n        }\n      }\n      if (!registered) {\n        throw new HTTPException(409, { message: "Imported asset registration could not be reconciled" });\n      }\n    }\n\n    const workbookAsset = resolved.find((asset) => asset.kind === "workbook")!;''',
)
replace_once(
    "worker/index.ts",
    '''      ...bulkInsertStatements(c.env.DB, "assets",\n        ["id", "import_id", "r2_key", "original_name", "mime_type", "byte_size", "status", "actor_email", "created_at", "sha256"],\n        newAssets.map((asset) => [asset.assetId, importId, asset.key, asset.originalName, asset.mimeType, asset.buffer.byteLength, "ready", userEmail, now, asset.sha256])),\n''',
    "",
)

# Every mutable relationship column receives the same UPDATE guard as INSERT.
# Existing relationships remain visible for audit, but they cannot be rebound to
# a quarantined locator by direct SQL or a future application code path.
migration = Path("migrations/0024_blob_integrity_quarantine.sql")
text = migration.read_text()
text += r'''

CREATE TRIGGER state_representation_assets_guard_integrity_update
BEFORE UPDATE OF asset_id ON state_representation_assets
WHEN OLD.asset_id <> NEW.asset_id
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER run_step_assets_guard_integrity_update
BEFORE UPDATE OF asset_id ON run_step_assets
WHEN OLD.asset_id <> NEW.asset_id
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER run_step_comments_guard_integrity_update
BEFORE UPDATE OF asset_id ON run_step_comments
WHEN NEW.asset_id IS NOT NULL
  AND (OLD.asset_id IS NULL OR OLD.asset_id <> NEW.asset_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER state_verifications_guard_integrity_update
BEFORE UPDATE OF evidence_asset_id ON state_verifications
WHEN NEW.evidence_asset_id IS NOT NULL
  AND (OLD.evidence_asset_id IS NULL OR OLD.evidence_asset_id <> NEW.evidence_asset_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.evidence_asset_id
  );
END;

CREATE TRIGGER project_content_attachments_guard_asset_integrity_update
BEFORE UPDATE OF asset_id ON project_content_attachments
WHEN NEW.asset_id IS NOT NULL
  AND (OLD.asset_id IS NULL OR OLD.asset_id <> NEW.asset_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER project_content_attachments_guard_managed_integrity_update
BEFORE UPDATE OF storage_object_id ON project_content_attachments
WHEN NEW.storage_object_id IS NOT NULL
  AND (OLD.storage_object_id IS NULL OR OLD.storage_object_id <> NEW.storage_object_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM managed_storage_objects mso JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'managed' AND biq.provider = mso.provider
        AND biq.object_key = mso.object_key
    WHERE mso.id = NEW.storage_object_id
  );
END;
'''
migration.write_text(text)
