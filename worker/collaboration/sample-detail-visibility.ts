import type { RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { sampleVisibilityProjection } from "./sample-visibility";

/** Fixed query projection only. The privately issued original Request and live
 * native admission remain the owning adapter's responsibility. These facts or
 * SQL fragments never constitute a permission token. Canonical/media history
 * is unavailable until its separate occurrence/protocol owner is installed. */
export function sampleDetailVisibilityProjection(facts: Readonly<RequestSubjectFacts>) {
  const visible = sampleVisibilityProjection(facts, 2);
  return Object.freeze({
    bindings: visible.bindings,
    cte: `${visible.cte}, readable_detail_comment_groups AS MATERIALIZED (
      SELECT DISTINCT c.operation_group_id FROM run_step_comments c
      WHERE c.operation_group_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM run_step_comments target
          LEFT JOIN run_steps step ON step.id=target.run_step_id
          LEFT JOIN runs run ON run.id=step.run_id
          WHERE target.operation_group_id=c.operation_group_id
            AND (step.id IS NULL OR run.id IS NULL OR step.deleted_at IS NOT NULL
              OR run.deleted_at IS NOT NULL OR run.sample_id NOT IN(SELECT id FROM visible_samples))
        )
        AND NOT EXISTS (
          SELECT 1 FROM events audit WHERE json_valid(audit.metadata_json)
            AND json_extract(audit.metadata_json,'$.action') IN('step_comment','step_comment_deleted','step_comment_restored')
            AND json_extract(audit.metadata_json,'$.operationGroupId')=c.operation_group_id
            AND audit.sample_id NOT IN(SELECT id FROM visible_samples)
        )
    ), visible_detail_comments AS MATERIALIZED (
      SELECT c.* FROM run_step_comments c
      JOIN run_steps step ON step.id=c.run_step_id JOIN runs run ON run.id=step.run_id
      WHERE c.submission_id IS NULL AND step.deleted_at IS NULL AND run.deleted_at IS NULL
        AND run.sample_id IN(SELECT id FROM visible_samples)
        AND (c.operation_group_id IN(SELECT operation_group_id FROM readable_detail_comment_groups)
          OR c.operation_group_id IS NULL AND c.scope='individual')
    ), visible_detail_events AS MATERIALIZED (
      SELECT audit.* FROM events audit WHERE audit.sample_id IN(SELECT id FROM visible_samples)
        AND json_valid(audit.metadata_json)
        AND (COALESCE(json_extract(audit.metadata_json,'$.action'),'')
            NOT IN('step_comment','step_comment_deleted','step_comment_restored')
          OR json_extract(audit.metadata_json,'$.operationGroupId')
            IN(SELECT operation_group_id FROM readable_detail_comment_groups))
    )`,
  });
}
