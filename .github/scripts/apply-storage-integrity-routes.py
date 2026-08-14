from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}")
    file.write_text(text.replace(old, new, 1))


def sub_once(path: str, pattern: str, replacement: str) -> None:
    file = Path(path)
    text = file.read_text()
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{path}: expected one regex replacement, found {count}")
    file.write_text(updated)


def sub_count(path: str, pattern: str, replacement: str, expected: int) -> None:
    file = Path(path)
    text = file.read_text()
    updated, count = re.subn(pattern, replacement, text, flags=re.S)
    if count != expected:
        raise SystemExit(f"{path}: expected {expected} regex replacements, found {count}")
    file.write_text(updated)


# Route all R2 content-addressed reuse through provider verification.
replace_once(
    "worker/index.ts",
    'import { refreshOrphanGrace } from "./blob-lifecycle/reachability";\nimport { getBlob } from "./blob-lifecycle/storage";',
    'import {\n  BlobReuseProviderUnavailableError,\n  findReusableR2Asset,\n} from "./blob-lifecycle/reuse";\nimport { getBlob } from "./blob-lifecycle/storage";',
)
replace_once(
    "worker/index.ts",
    '''async function digestSha256(buffer: ArrayBuffer) {\n  return sha256Hex(buffer);\n}\n''',
    '''async function digestSha256(buffer: ArrayBuffer) {\n  return sha256Hex(buffer);\n}\n\nasync function reusableR2Asset(env: Env, sha256: string) {\n  try {\n    return await findReusableR2Asset(env, sha256);\n  } catch (error) {\n    if (error instanceof BlobReuseProviderUnavailableError) {\n      throw new HTTPException(503, { message: error.message });\n    }\n    throw error;\n  }\n}\n''',
)

asset_route = r'''app.post("/assets", async (c) => {
  if (!contentLengthWithin(c.req.raw, 10 * 1024 * 1024)) throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
  const contentType = c.req.header("content-type") || "application/octet-stream";
  if (!contentType.toLowerCase().startsWith("image/")) throw new HTTPException(415, { message: "Ordinary asset uploads must be images" });
  const filename = c.req.header("x-filename") || "upload";
  if (filename.length > 255 || contentType.length > 200) throw new HTTPException(400, { message: "Asset metadata is too long" });
  const buffer = await c.req.arrayBuffer();
  if (buffer.byteLength > 10 * 1024 * 1024) throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
  const sha256 = await digestSha256(buffer);
  const existing = await reusableR2Asset(c.env, sha256);
  if (existing) {
    return c.json({ id: existing.id, key: existing.r2_key, deduplicated: true });
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await c.env.ASSETS.put(key, buffer, { httpMetadata: { contentType } });
    try {
      await c.env.DB.prepare(
        `INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, actor_email, created_at, sha256)
         VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
      ).bind(id, key, filename, contentType, buffer.byteLength, c.get("userEmail"), now, sha256).run();
      return c.json({ id, key, deduplicated: false }, 201);
    } catch (error) {
      let winner;
      try {
        winner = await reusableR2Asset(c.env, sha256);
      } catch (verificationError) {
        await c.env.ASSETS.delete(key);
        throw verificationError;
      }
      if (winner) {
        await c.env.ASSETS.delete(key);
        return c.json({ id: winner.id, key: winner.r2_key, deduplicated: true });
      }
      await c.env.ASSETS.delete(key);
      if (attempt === 1) throw error;
    }
  }
  throw new HTTPException(409, { message: "Asset registration could not be reconciled" });
});

app.get("/exports/r2/:key{.+}"'''
sub_once(
    "worker/index.ts",
    r'app\.post\("/assets", async \(c\) => \{.*?\n\}\);\n\napp\.get\("/exports/r2/:key\{\.\+\}"',
    asset_route,
)

replace_once(
    "worker/index.ts",
    '''    const hashes = [...new Set(candidates.map((candidate) => candidate.sha256))];\n    const existingRows = await c.env.DB.prepare(\n      `SELECT id, r2_key, sha256 FROM assets a\n       WHERE status = 'ready' AND sha256 IN (SELECT value FROM json_each(?))\n         AND NOT EXISTS (\n           SELECT 1 FROM blob_gc_ledger bg\n           WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'\n             AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')\n         )`,\n    ).bind(JSON.stringify(hashes)).all<{ id: string; r2_key: string; sha256: string }>();\n    const existingByHash = new Map<string, { assetId: string; key: string }>(\n      existingRows.results.map((asset) => [asset.sha256, { assetId: asset.id, key: asset.r2_key }]),\n    );''',
    '''    const hashes = [...new Set(candidates.map((candidate) => candidate.sha256))];\n    const existingByHash = new Map<string, { assetId: string; key: string }>();\n    for (let index = 0; index < hashes.length; index += 5) {\n      const verified = await Promise.all(hashes.slice(index, index + 5).map(async (hash) => ({\n        hash,\n        asset: await reusableR2Asset(c.env, hash),\n      })));\n      for (const candidate of verified) {\n        if (candidate.asset) {\n          existingByHash.set(candidate.hash, {\n            assetId: candidate.asset.id,\n            key: candidate.asset.r2_key,\n          });\n        }\n      }\n    }''',
)

metrology_route = r'''app.post("/metrology-templates/:id/references", async (c) => {
  const templateId = c.req.param("id");
  if (!contentLengthWithin(c.req.raw, 25 * 1024 * 1024)) {
    throw new HTTPException(413, { message: "Template reference files are limited to 25 MB" });
  }
  const filename = (c.req.header("x-filename") || "reference").trim();
  const mimeType = (c.req.header("content-type") || "application/octet-stream").trim();
  if (!filename || filename.length > 255 || mimeType.length > 200) {
    throw new HTTPException(400, { message: "Reference-file metadata is invalid" });
  }
  const template = await c.env.DB.prepare(
    `SELECT id FROM template_versions
     WHERE id = ? AND template_kind = 'metrology'
       AND archived_at IS NULL AND deleted_at IS NULL`,
  ).bind(templateId).first<{ id: string }>();
  if (!template) throw new HTTPException(404, { message: "Metrology template not found" });
  const buffer = await c.req.arrayBuffer();
  if (!buffer.byteLength || buffer.byteLength > 25 * 1024 * 1024) {
    throw new HTTPException(413, { message: "Template reference files must be between 1 byte and 25 MB" });
  }
  const sha256 = await digestSha256(buffer);
  const existingReference = await c.env.DB.prepare(
    `SELECT mtr.id, mtr.asset_id, mtr.display_name, mtr.created_at, mtr.deleted_at
     FROM metrology_template_references mtr
     JOIN assets a ON a.id = mtr.asset_id AND a.status = 'ready'
     WHERE mtr.template_version_id = ? AND a.sha256 = ?
     ORDER BY mtr.created_at DESC LIMIT 1`,
  ).bind(templateId, sha256).first<{
    id: string; asset_id: string; display_name: string;
    created_at: string; deleted_at: string | null;
  }>();

  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  let asset = await reusableR2Asset(c.env, sha256);
  let uploadedKey: string | null = null;
  let uploadedAssetId: string | null = null;
  if (!asset) {
    const assetId = crypto.randomUUID();
    const key = `metrology/${templateId}/${crypto.randomUUID()}-${safeObjectName(filename)}`;
    await c.env.ASSETS.put(key, buffer, { httpMetadata: { contentType: mimeType } });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await c.env.DB.prepare(
          `INSERT INTO assets
           (id, r2_key, original_name, mime_type, byte_size, status, sha256, actor_email, created_at)
           VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
        ).bind(assetId, key, filename, mimeType, buffer.byteLength, sha256, userEmail, now).run();
        asset = {
          id: assetId,
          r2_key: key,
          original_name: filename,
          mime_type: mimeType,
          byte_size: buffer.byteLength,
          sha256,
        };
        uploadedKey = key;
        uploadedAssetId = assetId;
        break;
      } catch (error) {
        let winner;
        try {
          winner = await reusableR2Asset(c.env, sha256);
        } catch (verificationError) {
          await c.env.ASSETS.delete(key);
          throw verificationError;
        }
        if (winner) {
          await c.env.ASSETS.delete(key);
          asset = winner;
          break;
        }
        if (attempt === 1) {
          await c.env.ASSETS.delete(key);
          throw error;
        }
      }
    }
  }
  if (!asset) throw new HTTPException(409, { message: "Reference-file registration could not be reconciled" });

  const cleanupUploadedAsset = async () => {
    if (!uploadedKey || !uploadedAssetId) return;
    await c.env.ASSETS.delete(uploadedKey);
    await c.env.DB.prepare("DELETE FROM assets WHERE id = ?").bind(uploadedAssetId).run();
  };

  if (existingReference) {
    const displayName = existingReference.deleted_at ? filename : existingReference.display_name;
    if (existingReference.deleted_at || existingReference.asset_id !== asset.id) {
      try {
        const updated = await c.env.DB.prepare(
          `UPDATE metrology_template_references
           SET asset_id = ?, display_name = ?, deleted_at = NULL, deleted_by = NULL
           WHERE id = ? AND template_version_id = ?`,
        ).bind(asset.id, displayName, existingReference.id, templateId).run();
        if (!updated.meta.changes) throw new HTTPException(409, { message: "This reference file changed elsewhere" });
      } catch (error) {
        await cleanupUploadedAsset();
        throw error;
      }
    }
    return c.json({ reference: {
      id: existingReference.id,
      filename: displayName,
      mimeType: asset.mime_type,
      byteSize: Number(asset.byte_size),
      assetKey: asset.r2_key,
      createdAt: existingReference.created_at,
    } });
  }

  const referenceId = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      `INSERT INTO metrology_template_references
       (id, template_version_id, asset_id, display_name, position, actor_email, created_at)
       VALUES (?, ?, ?, ?, COALESCE((
         SELECT MAX(position) + 1 FROM metrology_template_references WHERE template_version_id = ?
       ), 0), ?, ?)`,
    ).bind(referenceId, templateId, asset.id, filename, templateId, userEmail, now).run();
  } catch (error) {
    await cleanupUploadedAsset();
    if (String(error).includes("UNIQUE")) {
      throw new HTTPException(409, { message: "This reference file is already attached" });
    }
    throw error;
  }
  return c.json({ reference: {
    id: referenceId,
    filename,
    mimeType: asset.mime_type,
    byteSize: Number(asset.byte_size),
    assetKey: asset.r2_key,
    createdAt: now,
  } }, 201);
});

app.delete("/metrology-templates/:id/references/:referenceId"'''
sub_once(
    "worker/index.ts",
    r'app\.post\("/metrology-templates/:id/references", async \(c\) => \{.*?\n\}\);\n\napp\.delete\("/metrology-templates/:id/references/:referenceId"',
    metrology_route,
)

# Comment image and managed attachment reuse must make the same physical check.
replace_once(
    "worker/comment-submission-routes.ts",
    '''import {\n  listItemBlobLocators,\n  listSubmissionBlobLocators,\n  markOrphanCandidate,\n  retryUntil,\n} from "./blob-lifecycle/reachability";''',
    '''import {\n  listItemBlobLocators,\n  listSubmissionBlobLocators,\n  markOrphanCandidate,\n  retryUntil,\n} from "./blob-lifecycle/reachability";\nimport {\n  BlobReuseProviderUnavailableError,\n  findReusableManagedObject,\n  findReusableR2Asset,\n} from "./blob-lifecycle/reuse";''',
)
replace_once(
    "worker/comment-submission-routes.ts",
    '''type AppBindings = { Bindings: Env; Variables: { userEmail: string } };\n''',
    '''type AppBindings = { Bindings: Env; Variables: { userEmail: string } };\n\nasync function reusableCommentR2Asset(env: Env, sha256: string) {\n  try {\n    return await findReusableR2Asset(env, sha256);\n  } catch (error) {\n    if (error instanceof BlobReuseProviderUnavailableError) {\n      throw new HTTPException(503, { message: error.message });\n    }\n    throw error;\n  }\n}\n\nasync function reusableCommentManagedObject(\n  env: Env,\n  provider: string,\n  sha256: string,\n  byteSize: number,\n) {\n  try {\n    return await findReusableManagedObject(env, provider, sha256, byteSize);\n  } catch (error) {\n    if (error instanceof BlobReuseProviderUnavailableError) {\n      throw new HTTPException(503, { message: error.message });\n    }\n    throw error;\n  }\n}\n''',
)

comment_image = r'''    if (item.kind === "comment_image") {
      if (!contentType.startsWith("image/") || item.byte_size > MAX_COMMENT_IMAGE_UPLOAD_BYTES) {
        throw new HTTPException(415, { message: "Comment image content is invalid" });
      }
      const buffer = await c.req.arrayBuffer();
      if (buffer.byteLength !== item.byte_size) throw new HTTPException(400, { message: "Comment image size changed during upload" });
      const sha256 = await sha256Hex(buffer);
      let asset = await reusableCommentR2Asset(c.env, sha256);
      let deduplicated = Boolean(asset);
      if (!asset) {
        const key = `comments/${submissionId}/${itemId}-${item.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        const assetId = crypto.randomUUID();
        await c.env.ASSETS.put(key, buffer, { httpMetadata: { contentType } });
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await c.env.DB.prepare(
              `INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, actor_email, created_at, sha256)
               VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
            ).bind(assetId, key, item.filename, contentType, item.byte_size, c.get("userEmail"), now, sha256).run();
            asset = {
              id: assetId,
              r2_key: key,
              original_name: item.filename,
              mime_type: contentType,
              byte_size: item.byte_size,
              sha256,
            };
            break;
          } catch (error) {
            let winner;
            try {
              winner = await reusableCommentR2Asset(c.env, sha256);
            } catch (verificationError) {
              await c.env.ASSETS.delete(key);
              throw verificationError;
            }
            if (winner) {
              await c.env.ASSETS.delete(key);
              asset = winner;
              deduplicated = true;
              break;
            }
            if (attempt === 1) {
              await c.env.ASSETS.delete(key);
              throw error;
            }
          }
        }
      }
      if (!asset) throw new HTTPException(409, { message: "Comment image registration could not be reconciled" });
      await c.env.DB.prepare(
        `UPDATE comment_submission_items
         SET status = CASE
               WHEN EXISTS (
                 SELECT 1 FROM comment_submissions cs
                 WHERE cs.id = comment_submission_items.submission_id AND cs.status = 'cancelled'
               ) THEN 'cancelled' ELSE 'ready' END,
             asset_id = ?, sha256 = ?, error_message = NULL, updated_at = ?
         WHERE id = ? AND submission_id = ? AND deleted_at IS NULL`,
      ).bind(asset.id, sha256, new Date().toISOString(), itemId, submissionId).run();
      const latest = await c.env.DB.prepare(
        "SELECT status FROM comment_submissions WHERE id = ? AND deleted_at IS NULL",
      )
        .bind(submissionId).first<{ status: string }>();
      if (latest?.status === "cancelled") {
        const locators = await listItemBlobLocators(c.env.DB, submissionId, itemId);
        for (const locator of locators) {
          await markOrphanCandidate(c.env.DB, locator, crypto.randomUUID(), new Date());
        }
        throw new HTTPException(409, { message: "This upload was cancelled" });
      }
      return c.json({ ok: true, deduplicated });
    }

    if (item.byte_size > MAX_MANAGED_ATTACHMENT_BYTES)'''
sub_once(
    "worker/comment-submission-routes.ts",
    r'    if \(item\.kind === "comment_image"\) \{.*?\n    \}\n\n    if \(item\.byte_size > MAX_MANAGED_ATTACHMENT_BYTES\)',
    comment_image,
)

managed_resolution = r'''    const storage = managedStorage(c.env);
    if (!storage) throw new HTTPException(503, { message: "Managed attachment storage is not configured" });
    let storageObject = await reusableCommentManagedObject(
      c.env,
      storage.provider,
      sha256,
      item.byte_size,
    );
    let deduplicated = Boolean(storageObject);
    if (!storageObject) {
      const storageObjectId = crypto.randomUUID();
      const key = await managedKeyForSubmission(c.env, submission, submissionId, itemId, item.filename);
      const stored = await storage.put({
        key,
        body: c.req.raw.body,
        contentType,
        filename: item.filename,
        sha256,
        byteSize: item.byte_size,
      });
      if (stored.byteSize !== item.byte_size) {
        await storage.delete(key);
        throw new HTTPException(400, { message: "Attachment size changed during upload" });
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await c.env.DB.prepare(
            `INSERT INTO managed_storage_objects
             (id, provider, object_key, original_name, mime_type, byte_size, sha256, status, actor_email, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
          ).bind(storageObjectId, storage.provider, key, item.filename, contentType, item.byte_size, sha256, c.get("userEmail"), now).run();
          storageObject = {
            id: storageObjectId,
            provider: storage.provider,
            object_key: key,
            original_name: item.filename,
            mime_type: contentType,
            byte_size: item.byte_size,
            sha256,
          };
          break;
        } catch (error) {
          let winner;
          try {
            winner = await reusableCommentManagedObject(
              c.env,
              storage.provider,
              sha256,
              item.byte_size,
            );
          } catch (verificationError) {
            await storage.delete(key);
            throw verificationError;
          }
          if (winner) {
            await storage.delete(key);
            storageObject = winner;
            deduplicated = true;
            break;
          }
          if (attempt === 1) {
            await storage.delete(key);
            throw error;
          }
        }
      }
    }
    if (!storageObject) throw new HTTPException(409, { message: "Managed attachment registration could not be reconciled" });
    await c.env.DB.prepare(
      `UPDATE comment_submission_items'''
sub_once(
    "worker/comment-submission-routes.ts",
    r'    const storage = managedStorage\(c\.env\);.*?    await c\.env\.DB\.prepare\(\n      `UPDATE comment_submission_items',
    managed_resolution,
)
replace_once(
    "worker/comment-submission-routes.ts",
    '''    ).bind(storageObjectId, sha256, new Date().toISOString(), itemId, submissionId).run();''',
    '''    ).bind(storageObject.id, sha256, new Date().toISOString(), itemId, submissionId).run();''',
)

# A quarantined locator remains auditable but is unavailable for new Project
# attachment bindings and for live attachment delivery.
r2_gc_pattern = r'''(AND NOT EXISTS \(
\s+SELECT 1 FROM blob_gc_ledger bg
\s+WHERE bg\.store_kind = 'r2' AND bg\.provider = 'r2'
\s+AND bg\.object_key = a\.r2_key AND bg\.state IN \('deleting', 'deleted'\)
\s+\))'''
r2_gc_replacement = r'''\1
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )'''
sub_count("worker/projects/service.ts", r2_gc_pattern, r2_gc_replacement, 2)

managed_gc_pattern = r'''(AND NOT EXISTS \(
\s+SELECT 1 FROM blob_gc_ledger bg
\s+WHERE bg\.store_kind = 'managed' AND bg\.provider = mso\.provider
\s+AND bg\.object_key = mso\.object_key AND bg\.state IN \('deleting', 'deleted'\)
\s+\))'''
managed_gc_replacement = r'''\1
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'managed' AND biq.provider = mso.provider
          AND biq.object_key = mso.object_key
      )'''
sub_count("worker/projects/service.ts", managed_gc_pattern, managed_gc_replacement, 2)

# Metrology repair can move an existing logical reference to a fresh physical
# asset with identical bytes, so its asset_id update receives the same guard.
with Path("migrations/0024_blob_integrity_quarantine.sql").open("a") as migration:
    migration.write(r'''

CREATE TRIGGER metrology_template_references_guard_integrity_update
BEFORE UPDATE OF asset_id ON metrology_template_references
WHEN OLD.asset_id <> NEW.asset_id
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;
''')
