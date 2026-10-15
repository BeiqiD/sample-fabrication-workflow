import type { Env } from "../types";

const ABANDONED_UPLOAD_MS = 24 * 60 * 60 * 1_000;

export async function closeExpiredRetryWindows(env: Env, now: Date) {
  const timestamp = now.toISOString();
  const abandonedCutoff = new Date(now.getTime() - ABANDONED_UPLOAD_MS).toISOString();
  const abandonedMutationId = crypto.randomUUID();
  const retryClosureMutationId = crypto.randomUUID();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE comment_submissions
       SET status = 'failed', error_message = 'Upload was abandoned before completion',
           last_mutation_id = ?, updated_at = ?
       WHERE status = 'uploading' AND retry_closed_at IS NULL AND updated_at < ?
         AND NOT EXISTS (SELECT 1 FROM comment_submission_acceptances ca WHERE ca.submission_id = comment_submissions.id)
       RETURNING id`,
    ).bind(abandonedMutationId, timestamp, abandonedCutoff),
    env.DB.prepare(
      `UPDATE comment_submission_items
       SET status = 'failed', error_message = 'Upload was abandoned before completion', updated_at = ?
       WHERE status IN ('pending', 'uploading')
         AND EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = comment_submission_items.submission_id
             AND cs.status = 'failed' AND cs.last_mutation_id = ?
         )
       RETURNING id`,
    ).bind(timestamp, abandonedMutationId),
    env.DB.prepare(
      `UPDATE comment_submissions
       SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, ?),
           retry_closed_at = ?, retry_closed_by = 'system:cleanup',
           last_mutation_id = ?, updated_at = ?
       WHERE status IN ('draft', 'uploading', 'failed')
         AND retry_closed_at IS NULL AND retry_until IS NOT NULL AND retry_until <= ?
       RETURNING id`,
    ).bind(timestamp, timestamp, retryClosureMutationId, timestamp, timestamp),
    env.DB.prepare(
      `UPDATE comment_submission_items
       SET status = 'cancelled', updated_at = ?
       WHERE status NOT IN ('ready', 'cancelled')
         AND EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = comment_submission_items.submission_id
             AND cs.status = 'cancelled' AND cs.last_mutation_id = ?
             AND cs.retry_closed_by = 'system:cleanup'
         )
       RETURNING id`,
    ).bind(timestamp, retryClosureMutationId),
  ]);
  return {
    abandonedSubmissions: results[0].results.length,
    abandonedItems: results[1].results.length,
    retryWindowsClosed: results[2].results.length,
    retryItemsClosed: results[3].results.length,
  };
}

