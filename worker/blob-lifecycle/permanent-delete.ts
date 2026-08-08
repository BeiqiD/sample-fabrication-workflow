import type {
  PermanentDeleteBlocker,
  PermanentDeleteTarget,
} from "./types";

interface BlockerRow {
  relation: string;
  blocker_type: string;
  blocker_id: string;
  blocker_state: string;
}

const blockerSql: Record<PermanentDeleteTarget["sourceType"], string> = {
  sample: `
    SELECT 'sample_runs' AS relation, 'run' AS blocker_type, id AS blocker_id,
           CASE WHEN deleted_at IS NULL THEN status ELSE 'deleted' END AS blocker_state
    FROM runs WHERE sample_id = ?
    UNION ALL
    SELECT 'sample_children', 'sample', id,
           CASE WHEN deleted_at IS NULL THEN status ELSE 'deleted' END
    FROM samples WHERE parent_id = ?
    UNION ALL
    SELECT 'sample_events', 'event', id, 'audit'
    FROM events WHERE sample_id = ?
    UNION ALL
    SELECT 'sample_verifications', 'state_verification', id, status
    FROM state_verifications WHERE sample_id = ?
    UNION ALL
    SELECT 'sample_comments', 'comment_submission', id,
           CASE WHEN deleted_at IS NULL THEN status ELSE 'deleted' END
    FROM comment_submissions WHERE sample_id = ?
    UNION ALL
    SELECT 'comment_targets', 'comment_submission_target', submission_id || ':' || run_step_id, 'durable'
    FROM comment_submission_targets WHERE sample_id = ?`,
  run: `
    SELECT 'run_steps' AS relation, 'run_step' AS blocker_type, id AS blocker_id,
           CASE WHEN deleted_at IS NULL THEN status ELSE 'deleted' END AS blocker_state
    FROM run_steps WHERE run_id = ?
    UNION ALL
    SELECT 'run_plan_revisions', 'run_plan_revision', id, 'durable'
    FROM run_plan_revisions WHERE run_id = ?
    UNION ALL
    SELECT 'comment_targets', 'comment_submission_target', submission_id || ':' || run_step_id, 'durable'
    FROM comment_submission_targets WHERE run_id = ?
    UNION ALL
    SELECT 'successor_runs', 'run', id,
           CASE WHEN deleted_at IS NULL THEN status ELSE 'deleted' END
    FROM runs WHERE predecessor_run_id = ?`,
  run_step: `
    SELECT 'step_comments' AS relation, 'run_step_comment' AS blocker_type, id AS blocker_id,
           CASE WHEN deleted_at IS NULL THEN 'active' ELSE 'deleted' END AS blocker_state
    FROM run_step_comments WHERE run_step_id = ?
    UNION ALL
    SELECT 'step_assets', 'run_step_asset', id,
           CASE WHEN deleted_at IS NULL THEN 'active' ELSE 'deleted' END
    FROM run_step_assets WHERE run_step_id = ?
    UNION ALL
    SELECT 'comment_targets', 'comment_submission_target', submission_id || ':' || run_step_id, 'durable'
    FROM comment_submission_targets WHERE run_step_id = ?
    UNION ALL
    SELECT 'verification_endpoint', 'state_verification', id, status
    FROM state_verifications WHERE after_run_step_id = ?
    UNION ALL
    SELECT 'verification_coverage', 'state_verification_step', verification_id || ':' || run_step_id, 'durable'
    FROM state_verification_steps WHERE run_step_id = ?
    UNION ALL
    SELECT 'plan_links', 'run_step_plan_link', run_plan_revision_id || ':' || template_step_id, relation
    FROM run_step_plan_links WHERE run_step_id = ?
    UNION ALL
    SELECT 'next_steps', 'run_step', id,
           CASE WHEN deleted_at IS NULL THEN status ELSE 'deleted' END
    FROM run_steps WHERE previous_step_id = ?
    UNION ALL
    SELECT 'run_anchors', 'run', id,
           CASE WHEN deleted_at IS NULL THEN status ELSE 'deleted' END
    FROM runs WHERE anchor_step_id = ?
    UNION ALL
    SELECT 'revision_boundaries', 'run_plan_revision', id, 'durable'
    FROM run_plan_revisions WHERE effective_after_step_id = ?`,
  comment_submission: `
    SELECT 'comment_items' AS relation, 'comment_submission_item' AS blocker_type, id AS blocker_id,
           CASE WHEN deleted_at IS NULL THEN status ELSE 'deleted' END AS blocker_state
    FROM comment_submission_items WHERE submission_id = ?
    UNION ALL
    SELECT 'comment_occurrences', 'run_step_comment', id,
           CASE WHEN deleted_at IS NULL THEN 'active' ELSE 'deleted' END
    FROM run_step_comments WHERE submission_id = ?
    UNION ALL
    SELECT 'comment_targets', 'comment_submission_target', submission_id || ':' || run_step_id, 'durable'
    FROM comment_submission_targets WHERE submission_id = ?`,
  run_step_comment: `
    SELECT 'owning_step' AS relation, 'run_step' AS blocker_type,
           run_step_id AS blocker_id, 'durable' AS blocker_state
    FROM run_step_comments WHERE id = ?
    UNION ALL
    SELECT 'canonical_comment', 'comment_submission', submission_id, 'durable'
    FROM run_step_comments WHERE id = ? AND submission_id IS NOT NULL`,
  comment_submission_item: `
    SELECT 'canonical_comment' AS relation, 'comment_submission' AS blocker_type,
           submission_id AS blocker_id, 'durable' AS blocker_state
    FROM comment_submission_items WHERE id = ?
    UNION ALL
    SELECT 'related_comment_item', 'comment_submission_item', id,
           CASE WHEN deleted_at IS NULL THEN status ELSE 'deleted' END
    FROM comment_submission_items WHERE related_item_id = ?`,
  run_step_asset: `
    SELECT 'owning_step' AS relation, 'run_step' AS blocker_type,
           run_step_id AS blocker_id, 'durable' AS blocker_state
    FROM run_step_assets WHERE id = ?
    UNION ALL
    SELECT 'timeline_events', 'event', id, 'audit'
    FROM events
    WHERE CASE WHEN json_valid(metadata_json)
      THEN json_extract(metadata_json, '$.runStepAssetId') END = ?`,
  metrology_template_reference: `
    SELECT 'owning_template' AS relation, 'template_version' AS blocker_type,
           template_version_id AS blocker_id, 'durable' AS blocker_state
    FROM metrology_template_references WHERE id = ?`,
  template_version: `
    SELECT 'template_steps' AS relation, 'template_step' AS blocker_type, id AS blocker_id, 'durable' AS blocker_state
    FROM template_steps WHERE template_version_id = ?
    UNION ALL
    SELECT 'historical_runs', 'run', id,
           CASE WHEN deleted_at IS NULL THEN status ELSE 'deleted' END
    FROM runs WHERE template_version_id = ?
    UNION ALL
    SELECT 'run_plan_revisions', 'run_plan_revision', id, 'durable'
    FROM run_plan_revisions WHERE template_version_id = ?
    UNION ALL
    SELECT 'imports', 'import', id, status
    FROM imports WHERE template_version_id = ?
    UNION ALL
    SELECT 'metrology_references', 'metrology_template_reference', id,
           CASE WHEN deleted_at IS NULL THEN 'active' ELSE 'deleted' END
    FROM metrology_template_references WHERE template_version_id = ?
    UNION ALL
    SELECT 'recipe_change_proposals', 'recipe_change_proposal', id, status
    FROM recipe_change_proposals WHERE source_template_version_id = ?`,
};

export const PERMANENT_DELETE_BLOCKER_SOURCE_TYPES = Object.freeze(
  Object.keys(blockerSql) as PermanentDeleteTarget["sourceType"][],
);

function bindingCount(sql: string) {
  return [...sql].filter((character) => character === "?").length;
}

export async function listPermanentDeleteBlockers(
  db: D1Database,
  target: PermanentDeleteTarget,
): Promise<PermanentDeleteBlocker[]> {
  const sql = blockerSql[target.sourceType];
  if (!sql) {
    throw new Error(`Permanent-delete blocker planning is not implemented for ${String(target.sourceType)}`);
  }
  const rows = await db.prepare(sql).bind(...Array(bindingCount(sql)).fill(target.sourceId)).all<BlockerRow>();
  return rows.results.map((row) => ({
    sourceType: target.sourceType,
    sourceId: target.sourceId,
    relation: row.relation,
    blockerType: row.blocker_type,
    blockerId: row.blocker_id,
    blockerState: row.blocker_state,
  })).sort((left, right) =>
    `${left.relation}:${left.blockerType}:${left.blockerId}`
      .localeCompare(`${right.relation}:${right.blockerType}:${right.blockerId}`));
}
