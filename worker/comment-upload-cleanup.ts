import { managedStorage } from "./managed-storage";
import type { Env } from "./types";

const DAY_MS = 24 * 60 * 60 * 1_000;

export async function cleanupCommentUploads(env: Env, now = new Date()) {
  const abandonedCutoff = new Date(now.getTime() - DAY_MS).toISOString();
  const orphanCutoff = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE comment_submissions
       SET status = 'failed', error_message = 'Upload was abandoned before completion', updated_at = ?
       WHERE status = 'uploading' AND updated_at < ?`,
    ).bind(now.toISOString(), abandonedCutoff),
    env.DB.prepare(
      `UPDATE comment_submission_items
       SET status = 'failed', error_message = 'Upload was abandoned before completion', updated_at = ?
       WHERE status IN ('pending', 'uploading')
         AND submission_id IN (
           SELECT id FROM comment_submissions
           WHERE status = 'failed' AND updated_at = ?
         )`,
    ).bind(now.toISOString(), now.toISOString()),
    env.DB.prepare(
      `UPDATE managed_storage_objects
       SET status = 'orphaned', orphaned_at = COALESCE(orphaned_at, ?)
       WHERE status = 'ready'
         AND EXISTS (
           SELECT 1 FROM comment_submission_items csi
           JOIN comment_submissions cs ON cs.id = csi.submission_id
           WHERE csi.storage_object_id = managed_storage_objects.id
             AND cs.status IN ('failed', 'cancelled') AND cs.updated_at < ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM comment_submission_items csi
           JOIN comment_submissions cs ON cs.id = csi.submission_id
           WHERE csi.storage_object_id = managed_storage_objects.id
             AND cs.status = 'ready' AND csi.status = 'ready'
         )`,
    ).bind(now.toISOString(), orphanCutoff),
  ]);

  const storage = managedStorage(env);
  let managedDeleted = 0;
  if (storage) {
    const objects = await env.DB.prepare(
      `SELECT id, object_key FROM managed_storage_objects mso
       WHERE provider = ? AND status = 'orphaned' AND orphaned_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM comment_submission_items csi
           JOIN comment_submissions cs ON cs.id = csi.submission_id
           WHERE csi.storage_object_id = mso.id AND cs.status = 'ready' AND csi.status = 'ready'
         )
       LIMIT 100`,
    ).bind(storage.provider, orphanCutoff).all<{ id: string; object_key: string }>();
    for (const object of objects.results) {
      await storage.delete(object.object_key);
      await env.DB.prepare(
        "UPDATE managed_storage_objects SET status = 'deleted' WHERE id = ? AND status = 'orphaned'",
      ).bind(object.id).run();
      managedDeleted += 1;
    }
  }

  const assets = await env.DB.prepare(
    `SELECT a.id, a.r2_key
     FROM assets a
     WHERE a.status = 'ready'
       AND EXISTS (
         SELECT 1 FROM comment_submission_items csi
         JOIN comment_submissions cs ON cs.id = csi.submission_id
         WHERE csi.asset_id = a.id AND cs.status IN ('failed', 'cancelled') AND cs.updated_at < ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM comment_submission_items csi
         JOIN comment_submissions cs ON cs.id = csi.submission_id
         WHERE csi.asset_id = a.id AND cs.status = 'ready' AND csi.status = 'ready'
       )
       AND NOT EXISTS (SELECT 1 FROM state_representation_assets WHERE asset_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM run_step_assets WHERE asset_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM run_step_comments WHERE asset_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM state_verifications WHERE evidence_asset_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM events WHERE asset_key = a.r2_key)
     LIMIT 100`,
  ).bind(orphanCutoff).all<{ id: string; r2_key: string }>();
  let imageDeleted = 0;
  for (const asset of assets.results) {
    await env.ASSETS.delete(asset.r2_key);
    await env.DB.prepare(
      "UPDATE assets SET status = 'failed' WHERE id = ? AND status = 'ready'",
    ).bind(asset.id).run();
    imageDeleted += 1;
  }
  return { managedDeleted, imageDeleted };
}
