import { publishedTemplateVersionSql } from "../../worker/template-publication";
import { sampleRecordHistoryCommentEligibilitySql } from "./sample-record-history-source-sql";

const own = `owned_sample AS MATERIALIZED (SELECT ? sample_id),
  owned_runs AS MATERIALIZED (SELECT r.* FROM runs r JOIN owned_sample own ON own.sample_id=r.sample_id WHERE r.deleted_at IS NULL),
  owned_steps AS MATERIALIZED (SELECT step.* FROM run_steps step JOIN owned_runs run ON run.id=step.run_id WHERE step.deleted_at IS NULL),
  owned_groups AS MATERIALIZED (
    SELECT DISTINCT c.operation_group_id FROM run_step_comments c JOIN owned_steps step ON step.id=c.run_step_id
    WHERE c.operation_group_id IS NOT NULL
    UNION SELECT json_extract(e.metadata_json,'$.operationGroupId') FROM events e JOIN owned_sample own ON own.sample_id=e.sample_id
      WHERE json_valid(e.metadata_json) AND json_extract(e.metadata_json,'$.action')
        IN('step_comment','step_comment_deleted','step_comment_restored')
        AND json_type(e.metadata_json,'$.operationGroupId')='text'
  ), relevant_comments AS MATERIALIZED (
    SELECT c.* FROM run_step_comments c WHERE c.run_step_id IN(SELECT id FROM owned_steps)
      OR c.operation_group_id IN(SELECT operation_group_id FROM owned_groups)
  ), owned_states AS MATERIALIZED (
    SELECT s.inherited_state_hash hash FROM samples s JOIN owned_sample own ON own.sample_id=s.id WHERE s.inherited_state_hash IS NOT NULL
    UNION SELECT initial_state_hash FROM owned_runs WHERE initial_state_hash IS NOT NULL
    UNION SELECT expected_state_hash FROM owned_steps WHERE expected_state_hash IS NOT NULL
    UNION SELECT ts.expected_state_hash FROM owned_runs run JOIN run_step_plan_links link ON link.run_plan_revision_id=run.current_plan_revision_id
      JOIN template_steps ts ON ts.id=link.template_step_id WHERE ts.expected_state_hash IS NOT NULL
  )`;

/** Same-BEGIN domain eligibility for this expressly media-free first slice.
 * Existing SQL/serializer still reads its original twelve projections; no fake
 * empty media DTO or provider callback replaces a genuine source observation.
 * Published immutable accepted versions are Sample history, even when live
 * family access is revoked. No live Template grant is inferred from them.
 * Canonical sources intentionally have no status/deleted/lifecycle filters:
 * cancelled items and retained occurrences/audits can still carry private keys
 * or bodies in the original projections. Legacy Step events use kind 'step'.
 * A media-free legacy sample_record text event has one exact action key; it
 * grants no read. Immutable canonical publication/accepted event IDs and every
 * submissionId audit remain denied even if mutable audit metadata is relabeled. */
export const SAMPLE_DETAIL_TEXT_ELIGIBILITY_SQL = `SELECT 1 admitted WHERE EXISTS (
  WITH ${own} SELECT 1 FROM owned_sample own
  WHERE NOT EXISTS (
    SELECT 1 FROM owned_runs r LEFT JOIN run_plan_revisions revision ON revision.id=r.current_plan_revision_id
      LEFT JOIN template_versions version ON version.id=r.template_version_id
    WHERE r.run_kind<>'process' OR r.current_plan_revision_id IS NULL
      OR revision.id IS NULL OR revision.run_id<>r.id OR revision.template_version_id<>r.template_version_id
      OR version.id IS NULL OR version.recipe_family_id<>r.recipe_family_id
      OR version.name<>r.template_name_snapshot OR version.template_type<>r.template_type_snapshot
      OR version.version<>r.template_version_snapshot OR NOT (${publishedTemplateVersionSql("version")})
      OR r.predecessor_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runs predecessor WHERE predecessor.id=r.predecessor_run_id AND predecessor.sample_id=own.sample_id)
      OR r.anchor_step_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM run_steps anchor JOIN runs anchor_run ON anchor_run.id=anchor.run_id WHERE anchor.id=r.anchor_step_id AND anchor_run.sample_id=own.sample_id)
      OR revision.effective_after_step_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM run_steps boundary WHERE boundary.id=revision.effective_after_step_id AND boundary.run_id=r.id)
  ) AND NOT EXISTS (
    SELECT 1 FROM owned_runs run JOIN run_step_plan_links link ON link.run_plan_revision_id=run.current_plan_revision_id
      LEFT JOIN run_steps step ON step.id=link.run_step_id LEFT JOIN template_steps ts ON ts.id=link.template_step_id
    WHERE step.id IS NULL OR step.run_id<>run.id OR ts.id IS NULL OR ts.template_version_id<>run.template_version_id
  ) AND NOT EXISTS (
    SELECT 1 FROM owned_steps step LEFT JOIN step_definitions definition ON definition.hash=step.definition_hash
      LEFT JOIN template_steps original ON original.id=step.template_step_id
      LEFT JOIN template_versions version ON version.id=original.template_version_id
      JOIN owned_runs run ON run.id=step.run_id
    WHERE step.entry_kind<>'fabrication' OR step.definition_hash IS NULL OR definition.hash IS NULL
      OR step.template_step_id IS NOT NULL AND (original.id IS NULL OR version.id IS NULL OR version.recipe_family_id<>run.recipe_family_id)
  ) AND NOT EXISTS (
    SELECT 1 FROM state_verifications verification JOIN owned_sample own ON own.sample_id=verification.sample_id
      LEFT JOIN run_steps endpoint ON endpoint.id=verification.after_run_step_id
      LEFT JOIN runs endpoint_run ON endpoint_run.id=endpoint.run_id
      LEFT JOIN run_plan_revisions revision ON revision.id=verification.run_plan_revision_id
    WHERE endpoint.id IS NULL OR endpoint_run.sample_id<>own.sample_id OR endpoint_run.id IS NULL
      OR verification.run_plan_revision_id IS NOT NULL AND (revision.id IS NULL OR revision.run_id<>endpoint_run.id)
      OR verification.previous_verification_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM state_verifications previous WHERE previous.id=verification.previous_verification_id AND previous.sample_id=own.sample_id)
  ) AND NOT EXISTS (
    SELECT 1 FROM state_verification_steps coverage JOIN state_verifications verification ON verification.id=coverage.verification_id
      JOIN owned_sample own ON own.sample_id=verification.sample_id LEFT JOIN run_steps step ON step.id=coverage.run_step_id
      LEFT JOIN runs run ON run.id=step.run_id
    WHERE step.id IS NULL OR run.id IS NULL OR run.sample_id<>own.sample_id
  ) AND NOT EXISTS (
    SELECT 1 FROM events e JOIN owned_sample own ON own.sample_id=e.sample_id
    WHERE NOT json_valid(e.metadata_json) OR e.asset_key IS NOT NULL OR e.asset_file_id IS NOT NULL
      OR e.thumbnail_file_id IS NOT NULL OR COALESCE(json_type(e.metadata_json,'$.thumbnailKey'),'null')<>'null'
      OR COALESCE(json_type(e.metadata_json,'$.assetKey'),'null')<>'null'
  ) AND NOT EXISTS (
    SELECT 1 FROM relevant_comments c WHERE c.asset_id IS NOT NULL OR c.file_id IS NOT NULL OR c.submission_id IS NOT NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM events audit WHERE json_valid(audit.metadata_json)
      AND json_extract(audit.metadata_json,'$.action') IN('step_comment','step_comment_deleted','step_comment_restored')
      AND json_extract(audit.metadata_json,'$.operationGroupId') IN(SELECT operation_group_id FROM owned_groups)
      AND (audit.asset_key IS NOT NULL OR audit.asset_file_id IS NOT NULL OR audit.thumbnail_file_id IS NOT NULL
        OR COALESCE(json_type(audit.metadata_json,'$.thumbnailKey'),'null')<>'null'
        OR COALESCE(json_type(audit.metadata_json,'$.assetKey'),'null')<>'null')
  ) AND NOT EXISTS (
    SELECT 1 FROM comment_submissions submission LEFT JOIN comment_submission_targets target ON target.submission_id=submission.id
      LEFT JOIN run_steps step ON step.id=target.run_step_id LEFT JOIN runs run ON run.id=step.run_id
      LEFT JOIN runs target_run ON target_run.id=target.run_id
    WHERE submission.sample_id=own.sample_id OR target.sample_id=own.sample_id
      OR run.sample_id=own.sample_id OR target_run.sample_id=own.sample_id
  ) AND NOT EXISTS (
    SELECT 1 FROM run_step_comments occurrence LEFT JOIN run_steps step ON step.id=occurrence.run_step_id
      LEFT JOIN runs run ON run.id=step.run_id
    WHERE occurrence.submission_id IS NOT NULL AND run.sample_id=own.sample_id
  ) AND NOT EXISTS (
    SELECT 1 FROM events audit WHERE audit.sample_id=own.sample_id
      AND (audit.kind='comment' AND CASE WHEN json_valid(audit.metadata_json) THEN
        CASE WHEN ${sampleRecordHistoryCommentEligibilitySql("audit")}
          THEN 0 ELSE 1 END ELSE 1 END
        OR CASE WHEN json_valid(audit.metadata_json)
          THEN COALESCE(json_type(audit.metadata_json,'$.submissionId'),'null')<>'null' ELSE 0 END)
  ) AND NOT EXISTS (
    SELECT 1 FROM events audit JOIN owned_sample own ON own.sample_id=audit.sample_id
    WHERE EXISTS (
      SELECT 1 FROM comment_submission_acceptances acceptance,
        json_each(CASE WHEN json_valid(acceptance.publication_plan_json)
          THEN acceptance.publication_plan_json ELSE '{}' END,'$.events') planned
      WHERE CASE WHEN planned.type='object' THEN json_extract(planned.value,'$.id') ELSE NULL END=audit.id
    ) OR EXISTS (
      SELECT 1 FROM comment_submission_acceptances acceptance,
        json_each(CASE WHEN json_valid(acceptance.accepted_result_json)
          THEN acceptance.accepted_result_json ELSE '{}' END,'$.eventIds') accepted
      WHERE accepted.type='text' AND accepted.value=audit.id
    )
  ) AND NOT EXISTS (
    SELECT 1 FROM run_step_assets occurrence JOIN owned_steps step ON step.id=occurrence.run_step_id WHERE occurrence.deleted_at IS NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM state_representation_assets occurrence WHERE occurrence.state_hash IN(SELECT hash FROM owned_states)
  ) AND NOT EXISTS (
    SELECT 1 FROM state_verifications verification WHERE verification.sample_id=own.sample_id
      AND (verification.evidence_asset_id IS NOT NULL OR verification.evidence_file_id IS NOT NULL)
  )
)`;

/** DATA fingerprint, never an admitted installation or cached grant. Includes
 * each actual shared Comment/audit source root, parent/child provenance and
 * accepted Run/plan link origins before projection. A different newly-readable
 * root cannot validate an older cached source context. */
const dependencies = `WITH ${own}, dependencies(kind,id,state) AS (
  SELECT 'sample',s.id,json_array(s.parent_id,s.deleted_at,s.inherited_state_hash) FROM samples s JOIN owned_sample own ON own.sample_id=s.id
  UNION ALL SELECT 'sample_event',event.id,json_array(event.sample_id,event.kind,event.body,event.asset_key,
    event.asset_file_id,event.thumbnail_file_id,event.metadata_json,event.actor_email,event.created_at)
    FROM events event JOIN owned_sample own ON own.sample_id=event.sample_id
  UNION ALL SELECT 'relative',s.id,json_array(s.parent_id,s.deleted_at) FROM samples s CROSS JOIN owned_sample own
    WHERE s.parent_id=own.sample_id OR s.id=(SELECT parent_id FROM samples WHERE id=own.sample_id)
  UNION ALL SELECT 'run',r.id,json_array(r.sample_id,r.recipe_family_id,r.template_version_id,r.current_plan_revision_id,
    r.deleted_at,r.predecessor_run_id,r.anchor_step_id,r.template_name_snapshot,r.template_type_snapshot,r.template_version_snapshot) FROM owned_runs r
  UNION ALL SELECT 'step',step.id,json_array(step.run_id,step.template_step_id,step.definition_hash,step.expected_state_hash,
    step.deleted_at,step.plan_status,step.logical_step_key) FROM owned_steps step
  UNION ALL SELECT 'revision',revision.id,json_array(revision.run_id,revision.template_version_id,revision.revision_no,revision.effective_after_step_id)
    FROM run_plan_revisions revision JOIN owned_runs run ON run.id=revision.run_id
  UNION ALL SELECT 'link',link.run_plan_revision_id||':'||link.run_step_id,json_array(link.template_step_id,link.relation)
    FROM run_step_plan_links link JOIN owned_runs run ON run.id=(SELECT run_id FROM run_plan_revisions WHERE id=link.run_plan_revision_id)
  UNION ALL SELECT 'comment',c.id,json_array(c.run_step_id,c.operation_group_id,c.scope,c.submission_id,c.asset_id,c.file_id,
    step.run_id,step.deleted_at,run.sample_id,run.deleted_at,c.deleted_at)
    FROM relevant_comments c LEFT JOIN run_steps step ON step.id=c.run_step_id LEFT JOIN runs run ON run.id=step.run_id
  UNION ALL SELECT 'audit',e.id,json_array(e.sample_id,e.metadata_json) FROM events e WHERE json_valid(e.metadata_json)
    AND json_extract(e.metadata_json,'$.action') IN('step_comment','step_comment_deleted','step_comment_restored')
    AND json_extract(e.metadata_json,'$.operationGroupId') IN(SELECT operation_group_id FROM owned_groups)
)
SELECT json_group_array(json_array(kind,id,state)) state FROM (SELECT kind,id,state FROM dependencies ORDER BY kind,id,state)`;
export const SAMPLE_DETAIL_SOURCE_CAPTURE_SQL = dependencies;
export const SAMPLE_DETAIL_SOURCE_CHECK_SQL = `SELECT 1 admitted WHERE ? IS (${dependencies})`;
