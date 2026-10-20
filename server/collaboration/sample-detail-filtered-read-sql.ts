import type { SampleDetailProjection } from "../../worker/samples/read-service";
import { sampleVisibilityProjection } from "../../worker/collaboration/sample-visibility";
import type { RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { publishedTemplateVersionSql } from "../../worker/template-publication";
import { canonicalCommentReadCheckSql } from "./canonical-comment-read-roots";

/** Exact current V28 original SQL spellings. Only this private projection module
 * accepts them; request input cannot supply SQL, root tuples or File purpose. */
const ORIGINAL: Readonly<Record<SampleDetailProjection, string>> = Object.freeze({
  "overview": "WITH sample_overview AS (\n  SELECT s.*,\n         COALESCE(ptv.name, r.template_name_snapshot) AS latest_workflow_name,\n         COALESCE(ptv.version, r.template_version_snapshot) AS latest_workflow_version,\n         r.status AS latest_run_status,\n         (\n           SELECT COALESCE(rs.title, sd.name)\n           FROM run_steps rs\n           LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash\n           WHERE rs.run_id = r.id AND rs.plan_status = 'current' AND rs.deleted_at IS NULL\n             AND rs.entry_kind = 'fabrication'\n             AND rs.status NOT IN ('done', 'skipped')\n           ORDER BY rs.position\n           LIMIT 1\n         ) AS current_step_title,\n         (\n           SELECT state_step_title FROM (\n             SELECT COALESCE(rs.title, sd.name) AS state_step_title, 1 AS priority\n             FROM run_steps rs\n             LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash\n             WHERE rs.run_id = r.id AND rs.entry_kind = 'fabrication' AND rs.status = 'done'\n               AND rs.deleted_at IS NULL\n               AND (rs.plan_status = 'current' OR rs.actualized_at IS NOT NULL)\n               AND (rs.expected_state_hash IS NOT NULL OR EXISTS (\n           SELECT 1 FROM run_step_assets rsa\n           WHERE rsa.run_step_id = rs.id AND rsa.role = 'execution' AND rsa.deleted_at IS NULL\n               ))\n             ORDER BY rs.position DESC LIMIT 1\n           )\n         ) AS current_state_step_title,\n         (\n           COALESCE(\n             (\n               SELECT json_object('assetId',a.id,'fileId',rsa.file_id,'key',a.r2_key)\n               FROM run_steps rs\n               JOIN run_step_assets rsa ON rsa.run_step_id = rs.id AND rsa.role = 'execution'\n                 AND rsa.deleted_at IS NULL\n               JOIN assets a ON a.id = rsa.asset_id AND a.status = 'ready'\n               WHERE rs.run_id = r.id AND rs.entry_kind = 'fabrication' AND rs.status = 'done'\n                 AND rs.deleted_at IS NULL\n                 AND (rs.plan_status = 'current' OR rs.actualized_at IS NOT NULL)\n               ORDER BY rs.position DESC, rsa.position, a.id LIMIT 1\n             ),\n             (\n               SELECT json_object('assetId',a.id,'fileId',sra.file_id,'key',a.r2_key)\n               FROM state_representation_assets sra\n               JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'\n               WHERE sra.state_hash = COALESCE(\n                 (\n                   SELECT rs.expected_state_hash\n                   FROM run_steps rs\n                   WHERE rs.run_id = r.id AND rs.entry_kind = 'fabrication' AND rs.deleted_at IS NULL\n                     AND rs.status = 'done' AND rs.expected_state_hash IS NOT NULL\n                     AND (rs.plan_status = 'current' OR rs.actualized_at IS NOT NULL)\n                   ORDER BY rs.position DESC LIMIT 1\n                 ),\n                 r.initial_state_hash,\n                 (\n                   SELECT rs.expected_state_hash\n                   FROM run_steps rs JOIN runs earlier ON earlier.id = rs.run_id\n                   WHERE earlier.sample_id = s.id AND earlier.run_kind = 'process'\n                     AND earlier.deleted_at IS NULL AND rs.deleted_at IS NULL\n                     AND earlier.sequence_no < r.sequence_no\n                     AND rs.entry_kind = 'fabrication'\n                     AND rs.status = 'done' AND rs.expected_state_hash IS NOT NULL\n                     AND (rs.plan_status = 'current' OR rs.actualized_at IS NOT NULL)\n                   ORDER BY earlier.sequence_no DESC, rs.position DESC LIMIT 1\n                 ),\n                 s.inherited_state_hash\n               )\n               ORDER BY sra.position, a.id LIMIT 1\n             )\n           )\n         ) AS current_state_thumbnail_json\n  FROM samples s\n  LEFT JOIN runs r ON r.sample_id = s.id AND r.deleted_at IS NULL\n    AND r.sequence_no = (\n      SELECT MAX(latest.sequence_no)\n      FROM runs latest\n      WHERE latest.sample_id = s.id AND latest.run_kind = 'process' AND latest.deleted_at IS NULL\n    )\n  LEFT JOIN run_plan_revisions rpr ON rpr.id = r.current_plan_revision_id\n  LEFT JOIN template_versions ptv ON ptv.id = rpr.template_version_id\n  WHERE s.deleted_at IS NULL)\n       SELECT s.*, p.id AS p_id, p.code AS p_code, p.title AS p_title\n       FROM sample_overview s\n       LEFT JOIN samples p ON p.id = s.parent_id AND p.deleted_at IS NULL\n       WHERE s.id = ?",
  "children": "SELECT id, code, title FROM samples WHERE parent_id = ? AND deleted_at IS NULL ORDER BY created_at",
  "events": "SELECT * FROM events WHERE sample_id = ? ORDER BY created_at DESC",
  "runs": "SELECT r.id AS run_id, r.recipe_family_id, r.template_version_id, r.run_kind,\n              r.status AS run_status,\n              r.created_at AS run_created_at, r.completed_at,\n              r.current_plan_revision_id, COALESCE(rpr.revision_no, 1) AS plan_revision_no,\n              r.predecessor_run_id, r.anchor_step_id, r.sequence_no, r.run_group_id,\n              r.initial_state_hash,\n              CASE WHEN r.run_kind = 'metrology' THEN r.template_name_snapshot\n                   ELSE COALESCE(ptv.name, r.template_name_snapshot) END AS template_name,\n              COALESCE(ptv.template_type, r.template_type_snapshot) AS template_type,\n              COALESCE(ptv.version, r.template_version_snapshot) AS template_version,\n              COALESCE(ptv.id, r.template_version_id) AS current_template_version_id,\n              rs.id AS step_id, rs.template_step_id, rs.logical_step_key, rs.definition_hash,\n              rs.expected_state_hash, rs.position, current_ts.position AS plan_position,\n              COALESCE(rs.title, sd.name) AS step_title,\n              rs.status AS step_status, rs.notes, rs.updated_at AS step_updated_at,\n              rs.origin, rs.entry_kind, rs.plan_status,\n              COALESCE(rs.tool_name, sd.tool_name) AS tool_name,\n              COALESCE(rs.parameters_text, sd.parameters_text) AS parameters_text,\n              COALESCE(rs.comments_text, sd.comments_text) AS comments_text,\n              rs.deviation_note, rs.actualized_at,\n              CASE WHEN current_link.run_step_id IS NOT NULL\n                   THEN current_ts.section_name\n                   ELSE original_ts.section_name END AS planned_section_name,\n              CASE WHEN current_ts.id IS NOT NULL THEN current_sd.name ELSE sd.name END AS planned_title,\n              CASE WHEN current_ts.id IS NOT NULL THEN current_sd.tool_name ELSE sd.tool_name END AS planned_tool_name,\n              CASE WHEN current_ts.id IS NOT NULL THEN current_sd.parameters_text ELSE sd.parameters_text END AS planned_parameters_text,\n              CASE WHEN current_ts.id IS NOT NULL THEN current_sd.comments_text ELSE sd.comments_text END AS planned_comments_text,\n              rs.created_at AS step_created_at\n       FROM runs r\n       LEFT JOIN run_plan_revisions rpr ON rpr.id = r.current_plan_revision_id\n       LEFT JOIN template_versions ptv ON ptv.id = rpr.template_version_id\n       LEFT JOIN run_steps rs ON rs.run_id = r.id AND rs.deleted_at IS NULL\n       LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash\n       LEFT JOIN template_steps original_ts ON original_ts.id = rs.template_step_id\n       LEFT JOIN run_step_plan_links current_link\n         ON current_link.run_plan_revision_id = r.current_plan_revision_id\n        AND current_link.run_step_id = rs.id\n       LEFT JOIN template_steps current_ts ON current_ts.id = current_link.template_step_id\n       LEFT JOIN step_definitions current_sd ON current_sd.hash = current_ts.definition_hash\n       WHERE r.sample_id = ? AND r.deleted_at IS NULL\n       ORDER BY r.sequence_no DESC, rs.position ASC",
  "step_assets": "SELECT run_step_id, role, r2_key, asset_id, file_id FROM (\n         SELECT rs.id AS run_step_id, 'planned' AS role, a.r2_key, a.id AS asset_id, sra.file_id AS file_id, sra.position, a.created_at\n         FROM run_steps rs\n         JOIN runs r ON r.id = rs.run_id\n         LEFT JOIN run_step_plan_links current_link\n           ON current_link.run_plan_revision_id = r.current_plan_revision_id\n          AND current_link.run_step_id = rs.id\n         LEFT JOIN template_steps current_ts ON current_ts.id = current_link.template_step_id\n         JOIN state_representation_assets sra ON sra.state_hash =\n           CASE WHEN current_ts.id IS NOT NULL THEN current_ts.expected_state_hash ELSE rs.expected_state_hash END\n         JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'\n         WHERE r.sample_id = ? AND r.deleted_at IS NULL AND rs.deleted_at IS NULL\n         UNION ALL\n         SELECT rsa.run_step_id, 'execution' AS role, a.r2_key, a.id AS asset_id, rsa.file_id AS file_id, rsa.position, rsa.created_at\n         FROM run_step_assets rsa\n         JOIN assets a ON a.id = rsa.asset_id AND a.status = 'ready'\n         JOIN run_steps rs ON rs.id = rsa.run_step_id\n         JOIN runs r ON r.id = rs.run_id\n         WHERE r.sample_id = ? AND r.deleted_at IS NULL AND rs.deleted_at IS NULL\n           AND rsa.role = 'execution' AND rsa.deleted_at IS NULL\n       ) ORDER BY run_step_id, role, position, created_at",
  "initial_assets": "SELECT r.id AS run_id, a.r2_key, a.id AS asset_id, sra.file_id AS file_id\n       FROM runs r\n       JOIN state_representation_assets sra ON sra.state_hash = r.initial_state_hash\n       JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'\n       WHERE r.sample_id = ? AND r.deleted_at IS NULL\n       ORDER BY r.sequence_no DESC, sra.position, a.id",
  "step_comments": "SELECT rsc.id, rsc.run_step_id, rsc.scope, rsc.operation_group_id,\n              CASE WHEN rsc.submission_id IS NULL THEN rsc.legacy_body ELSE cs.body END AS body,\n              ca.r2_key AS asset_key, ca.id AS asset_id, rsc.file_id AS file_id, rsc.submission_id, rsc.actor_email, rsc.created_at\n       FROM run_step_comments rsc\n       JOIN run_steps rs ON rs.id = rsc.run_step_id\n       JOIN runs r ON r.id = rs.run_id\n       LEFT JOIN comment_submissions cs ON cs.id = rsc.submission_id\n       LEFT JOIN assets ca ON ca.id = rsc.asset_id AND ca.status = 'ready'\n         AND rsc.asset_deleted_at IS NULL\n       WHERE r.sample_id = ? AND r.deleted_at IS NULL AND rs.deleted_at IS NULL\n         AND rsc.deleted_at IS NULL\n         AND (\n           rsc.submission_id IS NULL\n           OR (cs.status = 'ready' AND cs.deleted_at IS NULL)\n         )\n       ORDER BY rsc.created_at, rsc.id",
  "verifications": "SELECT sv.* FROM state_verifications sv\n       JOIN run_steps endpoint ON endpoint.id = sv.after_run_step_id\n       JOIN runs endpoint_run ON endpoint_run.id = endpoint.run_id\n       WHERE sv.sample_id = ? AND endpoint_run.deleted_at IS NULL\n         AND endpoint.deleted_at IS NULL\n       ORDER BY sv.created_at, sv.id",
  "verification_steps": "SELECT svs.verification_id, svs.run_step_id, svs.ordinal\n       FROM state_verification_steps svs\n       JOIN state_verifications sv ON sv.id = svs.verification_id\n       JOIN run_steps covered_step ON covered_step.id = svs.run_step_id\n       JOIN runs covered_run ON covered_run.id = covered_step.run_id\n       WHERE sv.sample_id = ? AND covered_run.deleted_at IS NULL\n         AND covered_step.deleted_at IS NULL\n       ORDER BY sv.created_at, svs.ordinal",
  "submissions": "SELECT DISTINCT cs.*\n       FROM comment_submissions cs\n       LEFT JOIN comment_submission_targets cst ON cst.submission_id = cs.id\n       WHERE cs.deleted_at IS NULL AND (cs.sample_id = ? OR cst.sample_id = ?)\n       ORDER BY cs.created_at, cs.id",
  "submission_items": "SELECT DISTINCT csi.*, a.r2_key AS asset_key\n       FROM comment_submission_items csi\n       JOIN comment_submissions cs ON cs.id = csi.submission_id\n       LEFT JOIN comment_submission_targets cst ON cst.submission_id = cs.id\n       LEFT JOIN assets a ON a.id = csi.asset_id AND a.status = 'ready'\n       WHERE cs.deleted_at IS NULL AND csi.deleted_at IS NULL\n         AND (cs.sample_id = ? OR cst.sample_id = ?)\n       ORDER BY csi.submission_id, csi.position",
  "submission_targets": "SELECT cst.submission_id, cst.run_step_id\n       FROM comment_submission_targets cst\n       JOIN comment_submissions cs ON cs.id = cst.submission_id\n       JOIN run_steps rs ON rs.id = cst.run_step_id\n       JOIN runs r ON r.id = rs.run_id\n       WHERE cst.sample_id = ? AND cs.status <> 'cancelled'\n         AND cs.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL\n       ORDER BY cs.created_at, cst.run_step_id"
});

function replaceOnce(sql: string, original: string, projection: string): string {
  if (sql.split(original).length !== 2) throw new Error("Unknown original Sample projection spelling");
  return sql.replace(original, projection);
}
function beforeOrder(sql: string, predicate: string): string {
  const at = sql.lastIndexOf("ORDER BY");
  if (at < 0) throw new Error("Original Sample projection order is unavailable");
  return sql.slice(0, at) + predicate + "\n       " + sql.slice(at);
}
function currentProjectionCte(facts: Readonly<RequestSubjectFacts>): string {
  const visibility = sampleVisibilityProjection(facts, 2);
  return `${visibility.cte}, member AS (SELECT member_id FROM current_sample_member),
    visible_sample_projects AS MATERIALIZED (
      SELECT p.id FROM projects p JOIN collaboration_resources root ON root.root_kind='project' AND root.root_id=p.id
      CROSS JOIN member m LEFT JOIN collaboration_grants grant
        ON grant.root_kind=root.root_kind AND grant.root_id=root.root_id AND grant.member_id=m.member_id
      WHERE p.deleted_at IS NULL AND (root.visibility='workspace' OR (grant.enabled=1 AND grant.capability IN('read','edit','manage')))
    )`;
}
function prepend(sql: string, facts: Readonly<RequestSubjectFacts>): string {
  const cte = currentProjectionCte(facts), match = sql.match(/^\s*WITH\s+/);
  return match ? `WITH ${cte}, ${sql.slice(match[0].length)}` : `WITH ${cte} ${sql}`;
}
function readableVersion(alias: "ptv" | "original_version"): string {
  return `${alias}.recipe_family_id IN(SELECT id FROM visible_sample_templates)
    AND ${alias}.deleted_at IS NULL AND ${publishedTemplateVersionSql(alias)}`;
}
const wholeSubmission = `cs.id IN(SELECT candidate.id FROM comment_submissions candidate
  WHERE ${canonicalCommentReadCheckSql("comment", "candidate.id")} IS 1)`;
const LEGACY_OPERATION_GROUP_AUDIT_ACTIONS_SQL = "'step_comment','step_comment_deleted','step_comment_restored','comment_attachment_deleted'";
/** Original legacy operation-group audits can repeat a shared body without a
 * scope field. All actual legacy occurrences and every recognized audit root
 * must be readable before any body, including retained trash/restore history.
 * The audit policy also conservatively protects multi-root individual groups;
 * selected individual occurrence rows keep their original local semantics. */
function legacyOperationGroupRead(group: "rsc.operation_group_id" | "json_extract(events.metadata_json,'$.operationGroupId')"): string {
  return `(WITH original_occurrences AS (
    SELECT occurrence.id,owner.sample_id,s.id root_id FROM run_step_comments occurrence
    LEFT JOIN run_steps step ON step.id=occurrence.run_step_id LEFT JOIN runs owner ON owner.id=step.run_id
    LEFT JOIN samples s ON s.id=owner.sample_id
    WHERE occurrence.operation_group_id=${group} AND occurrence.submission_id IS NULL
  ), full_paths AS (
    SELECT root_id FROM original_occurrences
    UNION ALL SELECT source.id FROM events audit LEFT JOIN samples source ON source.id=audit.sample_id
      WHERE audit.kind='step' AND json_valid(audit.metadata_json)
        AND json_extract(audit.metadata_json,'$.action') IN(${LEGACY_OPERATION_GROUP_AUDIT_ACTIONS_SQL})
        AND json_extract(audit.metadata_json,'$.operationGroupId')=${group}
  ) SELECT (SELECT count(*) FROM original_occurrences) BETWEEN 1 AND 12
    AND NOT EXISTS(SELECT 1 FROM full_paths path WHERE path.root_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM member m JOIN collaboration_resources resource ON resource.root_kind='sample' AND resource.root_id=path.root_id
      LEFT JOIN collaboration_grants binding ON binding.root_kind=resource.root_kind AND binding.root_id=resource.root_id AND binding.member_id=m.member_id
      WHERE resource.visibility='workspace' OR(binding.enabled=1 AND binding.capability IN('read','operate','edit','manage')))))`;
}
const wholeOccurrence = `rsc.id IN(SELECT candidate.id FROM run_step_comments candidate
  WHERE ${canonicalCommentReadCheckSql("comment_occurrence", "candidate.id")} IS 1)
  AND (rsc.submission_id IS NOT NULL OR rsc.scope='individual'
    OR (rsc.scope='common' AND rsc.operation_group_id IS NOT NULL AND ${legacyOperationGroupRead("rsc.operation_group_id")} IS 1))`;

const safeVerification = `NOT EXISTS(SELECT 1 FROM state_verification_steps covered
  LEFT JOIN run_steps actual ON actual.id=covered.run_step_id LEFT JOIN runs owner ON owner.id=actual.run_id
  WHERE covered.verification_id=sv.id AND (actual.id IS NULL OR owner.id IS NULL
    OR actual.deleted_at IS NOT NULL OR owner.deleted_at IS NOT NULL
    OR owner.sample_id NOT IN(SELECT id FROM visible_samples)))`;

/** All private row filters precede original DISTINCT/order/LIMIT/count. SQL
 * metadata projection is not a File-purpose receipt. Without a genuine issued
 * consumer/read hook no byte, raw key, File ID or media descriptor is selected.
 * Original complete source algorithms and default Worker spellings are kept. */
export function sampleDetailFilteredSql(projection: SampleDetailProjection, originalSql: string,
  facts: Readonly<RequestSubjectFacts>, empty = false, canonicalAttachments = false): string {
  if (!Object.hasOwn(ORIGINAL, projection) || originalSql !== ORIGINAL[projection])
    throw new Error("Foreign original Sample detail projection");
  let sql = originalSql;
  switch (projection) {
    case "overview": {
      sql = replaceOnce(sql, "SELECT s.*,\n", `SELECT s.id,s.code,s.title,s.status,s.location,s.description,s.pinned,
        CASE WHEN s.parent_id IN(SELECT id FROM visible_samples) THEN s.parent_id END AS parent_id,
        s.inherited_state_hash,s.created_at,s.updated_at,\n`);
      sql = replaceOnce(sql, "COALESCE(ptv.name, r.template_name_snapshot)",
        `COALESCE(CASE WHEN ${readableVersion("ptv")} THEN ptv.name END,r.template_name_snapshot)`);
      sql = replaceOnce(sql, "COALESCE(ptv.version, r.template_version_snapshot)",
        `COALESCE(CASE WHEN ${readableVersion("ptv")} THEN ptv.version END,r.template_version_snapshot)`);
      const begin = sql.indexOf("         (\n           COALESCE("), end = sql.indexOf(" AS current_state_thumbnail_json", begin);
      if (begin < 0 || end < 0) throw new Error("Original Sample overview media projection is unavailable");
      sql = sql.slice(0,begin) + "         NULL" + sql.slice(end);
      sql = replaceOnce(sql,"WHERE s.deleted_at IS NULL", "WHERE s.deleted_at IS NULL AND s.id IN(SELECT id FROM visible_samples)");
      sql = replaceOnce(sql,"p.id = s.parent_id AND p.deleted_at IS NULL", "p.id = s.parent_id AND p.deleted_at IS NULL AND p.id IN(SELECT id FROM visible_samples)");
      break;
    }
    case "children":
      sql = beforeOrder(sql," AND id IN(SELECT id FROM visible_samples)" + (empty ? " AND 0" : "")); break;
    case "events": {
      sql = replaceOnce(sql, "SELECT * FROM events", `SELECT id,sample_id,kind,body,NULL asset_key,NULL asset_file_id,NULL thumbnail_file_id,
        metadata_json,actor_email,created_at FROM events`);
      const metadata = "CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END";
      const comment = `json_extract(${metadata},'$.submissionId') IN(SELECT candidate.id FROM comment_submissions candidate
        WHERE ${canonicalCommentReadCheckSql("comment", "candidate.id")} IS 1)`;
      sql = beforeOrder(sql, ` AND sample_id IN(SELECT id FROM visible_samples)
        AND json_valid(metadata_json) AND asset_key IS NULL AND asset_file_id IS NULL AND thumbnail_file_id IS NULL
        AND json_extract(${metadata},'$.thumbnailKey') IS NULL
        AND json_extract(${metadata},'$.assetId') IS NULL AND json_extract(${metadata},'$.thumbnailAssetId') IS NULL
        AND (json_extract(${metadata},'$.parentId') IS NULL OR json_extract(${metadata},'$.parentId') IN(SELECT id FROM visible_samples))
        AND (json_extract(${metadata},'$.childIds') IS NULL OR (json_type(${metadata},'$.childIds')='array'
          AND NOT EXISTS(SELECT 1 FROM json_each(${metadata},'$.childIds') child WHERE child.type<>'text' OR child.value NOT IN(SELECT id FROM visible_samples))))
        AND (json_extract(${metadata},'$.projectId') IS NULL OR json_extract(${metadata},'$.projectId') IN(SELECT id FROM visible_sample_projects))
        AND (kind<>'step' OR COALESCE(json_extract(${metadata},'$.action'),'') NOT IN(${LEGACY_OPERATION_GROUP_AUDIT_ACTIONS_SQL})
          OR (json_type(${metadata},'$.operationGroupId')='text'
            AND ${legacyOperationGroupRead("json_extract(events.metadata_json,'$.operationGroupId')")} IS 1))
        AND (kind<>'comment' OR (json_extract(${metadata},'$.submissionId') IS NOT NULL AND ${comment})
          OR (json_extract(${metadata},'$.submissionId') IS NULL AND json_extract(${metadata},'$.action') IN('sample_record','sample_record_deleted')))
        ${empty ? "AND 0" : ""}`); break;
    }
    case "runs": {
      const allowed = readableVersion("ptv");
      for (const [cell,snapshot] of [["name","name"],["template_type","type"],["version","version"],["id","id"]] as const) {
        const fallback = snapshot === "id" ? "r.template_version_id" : `r.template_${snapshot}_snapshot`;
        const original = `COALESCE(ptv.${cell}, ${fallback})`;
        sql = replaceOnce(sql,original,`COALESCE(CASE WHEN ${allowed} THEN ptv.${cell} END,${fallback})`);
      }
      sql = replaceOnce(sql,"current_ts.position AS plan_position",`CASE WHEN ${allowed} THEN current_ts.position END AS plan_position`);
      sql = replaceOnce(sql,`CASE WHEN current_link.run_step_id IS NOT NULL
                   THEN current_ts.section_name
                   ELSE original_ts.section_name END`, `CASE WHEN ${allowed} AND current_link.run_step_id IS NOT NULL THEN current_ts.section_name
        WHEN EXISTS(SELECT 1 FROM template_versions original_version WHERE original_version.id=original_ts.template_version_id
          AND ${readableVersion("original_version")}) THEN original_ts.section_name END`);
      for (const [column,fallback] of [["name","name"],["tool_name","tool_name"],["parameters_text","parameters_text"],["comments_text","comments_text"]] as const) {
        sql = replaceOnce(sql,`CASE WHEN current_ts.id IS NOT NULL THEN current_sd.${column} ELSE sd.${fallback} END`,
          `CASE WHEN ${allowed} AND current_ts.id IS NOT NULL THEN current_sd.${column} ELSE sd.${fallback} END`);
      }
      sql = beforeOrder(sql," AND r.sample_id IN(SELECT id FROM visible_samples)"); break;
    }
    case "step_assets": case "initial_assets":
      // Exact original shapes are retained as native empty projections. No
      // profile/consumer from V26 or structural Sample grant opens V28 media.
      sql = `SELECT * FROM (${sql}) WHERE 0`; break;
    case "step_comments":
      sql = replaceOnce(sql,"ca.r2_key AS asset_key, ca.id AS asset_id, rsc.file_id AS file_id",
        "NULL AS asset_key, NULL AS asset_id, NULL AS file_id");
      sql = beforeOrder(sql,` AND r.sample_id IN(SELECT id FROM visible_samples) AND ${wholeOccurrence}`); break;
    case "verifications":
      sql = beforeOrder(sql,` AND endpoint_run.sample_id IN(SELECT id FROM visible_samples) AND ${safeVerification}`); break;
    case "verification_steps":
      sql = beforeOrder(sql,` AND covered_run.sample_id IN(SELECT id FROM visible_samples) AND ${safeVerification}`); break;
    case "submissions":
      sql = beforeOrder(sql,` AND ${wholeSubmission}`); break;
    case "submission_items":
      if (canonicalAttachments) {
        // This only admits internal native candidate rows. The enclosing genuine
        // Sample owner must hold the actual File facade's opaque projection port
        // and perform that exact original Request's typed purpose read before
        // delivering any attachment metadata/download URL to the serializer.
        sql = beforeOrder(sql,` AND ${wholeSubmission} AND (
          (csi.kind='link' AND csi.asset_id IS NULL AND csi.file_id IS NULL AND csi.storage_object_id IS NULL)
          OR (cs.status='ready' AND csi.status='ready' AND csi.kind='attachment'
            AND csi.file_id IS NOT NULL AND csi.asset_id IS NOT NULL AND csi.storage_object_id IS NULL))`);
      } else sql = beforeOrder(sql,` AND ${wholeSubmission} AND csi.kind='link' AND csi.asset_id IS NULL
        AND csi.file_id IS NULL AND csi.storage_object_id IS NULL`); break;
    case "submission_targets":
      sql = beforeOrder(sql,` AND r.sample_id IN(SELECT id FROM visible_samples) AND ${wholeSubmission}`); break;
  }
  return prepend(sql,facts);
}
export function originalSampleDetailSql(projection: "children" | "events"): string { return ORIGINAL[projection]; }

/** Processing Sample visibility, live Template metadata, ordering, pagination,
 * facets and counts remain in the mature algorithm. Its native page/count are
 * one owned snapshot; omitted media is neither a zero-test PASS nor File grant. */
export function sampleProcessingMetadataSql(projection: "page" | "count", originalSql: string,
  facts: Readonly<RequestSubjectFacts>): string {
  const expected = sampleVisibilityProjection(facts,2).cte;
  if (!/^\s*WITH\s+/.test(originalSql) || !originalSql.includes(expected)
    || !originalSql.includes("sample_base AS (") || /;/.test(originalSql)) throw new Error("Foreign original processing projection");
  if (projection === "count") {
    if (!originalSql.includes("COUNT(*) AS all_count") || !originalSql.includes("active_count")) throw new Error("Original processing facets are unavailable");
    return originalSql;
  }
  const begin = originalSql.indexOf("         COALESCE(\n           (\n             SELECT json_object("), end = originalSql.indexOf(" AS current_state_thumbnail_json",begin);
  if (begin < 0 || end < 0 || !originalSql.includes("LIMIT ? OFFSET ?")) throw new Error("Original processing media projection is unavailable");
  return originalSql.slice(0,begin) + "         NULL" + originalSql.slice(end);
}
