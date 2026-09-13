import { HTTPException } from "hono/http-exception";

export async function requireVisibleCommentOperationGroup(db: D1Database, operationGroupId: string) {
  const counts = await db.prepare(
    `SELECT COUNT(*) AS target_count,
            COALESCE(SUM(CASE
              WHEN s.id IS NOT NULL AND s.deleted_at IS NULL
                AND r.id IS NOT NULL AND r.deleted_at IS NULL
                AND rs.id IS NOT NULL AND rs.deleted_at IS NULL
                AND (
                  rsc.submission_id IS NULL
                  OR EXISTS (
                    SELECT 1
                    FROM comment_submissions cs
                    WHERE cs.id = rsc.submission_id
                      AND cs.status = 'ready'
                      AND cs.deleted_at IS NULL
                  )
                )
              THEN 1 ELSE 0 END), 0) AS visible_count
     FROM run_step_comments rsc
     LEFT JOIN run_steps rs ON rs.id = rsc.run_step_id
     LEFT JOIN runs r ON r.id = rs.run_id
     LEFT JOIN samples s ON s.id = r.sample_id
     WHERE rsc.operation_group_id = ?`,
  ).bind(operationGroupId).first<{ target_count: number; visible_count: number }>();
  if (!counts || Number(counts.target_count) < 1
    || Number(counts.visible_count) !== Number(counts.target_count)) {
    throw new HTTPException(409, {
      message: "A common comment target is no longer available. Restore every target before changing the group.",
    });
  }
}
