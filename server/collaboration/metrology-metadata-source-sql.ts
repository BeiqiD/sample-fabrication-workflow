/** Operation-local DATA observations only. No account, grant, installation or
 * physical capability is cached by these expressions. */
export const METROLOGY_SAMPLE_STATE_SQL = `SELECT json_array(s.id,s.updated_at,s.deleted_at,
  (SELECT json_group_array(json_array(r.id,r.sample_id,r.run_kind,r.status,r.anchor_step_id,
      r.sequence_no,r.deleted_at,r.last_mutation_id))
    FROM (SELECT * FROM runs WHERE sample_id=s.id ORDER BY id) r),
  (SELECT json_group_array(json_array(step.id,step.run_id,step.position,step.updated_at,
      step.deleted_at,step.previous_step_id))
    FROM (SELECT rs.* FROM run_steps rs JOIN runs run ON run.id=rs.run_id
      WHERE run.sample_id=s.id ORDER BY rs.id) step)) state
  FROM samples s WHERE s.id=?`;

export const METROLOGY_TEMPLATE_STATE_SQL = `SELECT json_array(tv.id,tv.recipe_family_id,
  tv.name,tv.template_kind,tv.template_type,tv.version,tv.archived_at,tv.deleted_at,
  tv.initial_state_hash,tv.content_json,tv.source_asset_key,rf.archived_at,
  (SELECT json_group_array(json_array(step.id,step.logical_step_key,step.definition_hash,
      step.expected_state_hash,step.position,step.raw_json,definition.canonical_json))
    FROM (SELECT * FROM template_steps WHERE template_version_id=tv.id ORDER BY position,id) step
      LEFT JOIN step_definitions definition ON definition.hash=step.definition_hash),
  (SELECT json_group_array(json_array(id,status))
    FROM (SELECT id,status FROM imports WHERE template_version_id=tv.id ORDER BY id))) state
  FROM template_versions tv JOIN recipe_families rf ON rf.id=tv.recipe_family_id WHERE tv.id=?`;

/** These two methods create metadata only. The bounded owner does not admit a
 * reference upload, File occurrence, provider, canonical Comment or asset key.
 * Existing accepted Sample history supplies no current live family right. */
export const METROLOGY_TEMPLATE_MEDIA_FREE_SQL = `SELECT 1 admitted WHERE
  EXISTS(SELECT 1 FROM template_versions tv WHERE tv.id=? AND tv.source_asset_key IS NULL)
  AND NOT EXISTS(SELECT 1 FROM metrology_template_references occurrence WHERE occurrence.template_version_id=?)
  AND NOT EXISTS(SELECT 1 FROM state_representation_assets asset WHERE asset.state_hash IN(
    SELECT initial_state_hash FROM template_versions WHERE id=?
    UNION SELECT expected_state_hash FROM template_steps WHERE template_version_id=?))
  AND NOT EXISTS(SELECT 1 FROM template_steps step LEFT JOIN step_definitions definition ON definition.hash=step.definition_hash
    WHERE step.template_version_id=? AND definition.hash IS NULL)`;

/** addEntry consumes the exact existing Run and adjacent Step set. Anchor and
 * predecessor pointers must retain their actual Sample owner; a malformed or
 * foreign pointer is unavailable, rather than issuing a second root grant. */
export const METROLOGY_ENTRY_SOURCE_SQL = `SELECT 1 admitted WHERE EXISTS(
  SELECT 1 FROM runs run WHERE run.id=? AND run.sample_id=?
    AND (run.anchor_step_id IS NULL OR EXISTS(
      SELECT 1 FROM run_steps anchor JOIN runs anchor_run ON anchor_run.id=anchor.run_id
      WHERE anchor.id=run.anchor_step_id AND anchor_run.sample_id=run.sample_id))
    AND NOT EXISTS(SELECT 1 FROM run_steps step LEFT JOIN run_steps previous ON previous.id=step.previous_step_id
      LEFT JOIN runs previous_run ON previous_run.id=previous.run_id
      WHERE step.run_id=run.id AND step.deleted_at IS NULL AND step.previous_step_id IS NOT NULL
        AND (previous.id IS NULL OR previous_run.id IS NULL OR previous_run.sample_id<>run.sample_id))
)`;
