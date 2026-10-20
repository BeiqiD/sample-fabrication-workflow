// Shared by the structure read and the split transaction precondition.
export const CURRENT_SAMPLE_STRUCTURE_SQL = `WITH latest_run AS (
       SELECT id, sequence_no, initial_state_hash
       FROM runs
       WHERE sample_id = ? AND run_kind = 'process' AND deleted_at IS NULL
       ORDER BY sequence_no DESC LIMIT 1
     ),
     candidates AS (
       SELECT rs.id AS step_id, rs.expected_state_hash AS state_hash,
              COALESCE(rs.title, sd.name) AS step_title, 1 AS priority
       FROM run_steps rs
       JOIN latest_run lr ON lr.id = rs.run_id
       LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
       WHERE rs.status = 'done' AND rs.deleted_at IS NULL
         AND rs.entry_kind = 'fabrication'
         AND (rs.plan_status = 'current' OR rs.actualized_at IS NOT NULL)
         AND (rs.expected_state_hash IS NOT NULL OR EXISTS (
           SELECT 1 FROM run_step_assets rsa
           WHERE rsa.run_step_id = rs.id AND rsa.role = 'execution' AND rsa.deleted_at IS NULL
         ))
       ORDER BY rs.position DESC LIMIT 1
     ),
     latest_initial AS (
       SELECT NULL AS step_id, initial_state_hash AS state_hash, NULL AS step_title, 2 AS priority
       FROM latest_run WHERE initial_state_hash IS NOT NULL
     ),
     historical_step AS (
       SELECT rs.id AS step_id, rs.expected_state_hash AS state_hash,
              COALESCE(rs.title, sd.name) AS step_title, 3 AS priority
       FROM run_steps rs
       JOIN runs r ON r.id = rs.run_id
       LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
       WHERE r.sample_id = ? AND r.run_kind = 'process' AND r.deleted_at IS NULL
         AND rs.entry_kind = 'fabrication' AND rs.status = 'done' AND rs.deleted_at IS NULL
         AND (rs.plan_status = 'current' OR rs.actualized_at IS NOT NULL)
         AND (rs.expected_state_hash IS NOT NULL OR EXISTS (
           SELECT 1 FROM run_step_assets rsa
           WHERE rsa.run_step_id = rs.id AND rsa.role = 'execution' AND rsa.deleted_at IS NULL
         ))
       ORDER BY r.sequence_no DESC, rs.position DESC LIMIT 1
     ),
     inherited_sample AS (
       SELECT NULL AS step_id, inherited_state_hash AS state_hash, NULL AS step_title, 4 AS priority
       FROM samples WHERE id = ? AND inherited_state_hash IS NOT NULL AND deleted_at IS NULL
     )
     SELECT step_id, state_hash, step_title FROM (
       SELECT * FROM candidates
       UNION ALL SELECT * FROM latest_initial
       UNION ALL SELECT * FROM historical_step
       UNION ALL SELECT * FROM inherited_sample
     ) ORDER BY priority LIMIT 1`;
