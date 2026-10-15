import type { ProjectSnapshotProjection } from "../../worker/projects/read-sql";
import { contextObject, contextViolations, pathState as originalPathState, readablePaths as originalReadablePaths, referenceKinds, segmentId, segmentKinds, segmentType } from "./project-snapshot-source-guards";
import { canonicalCommentDependencyStateSql, canonicalCommentReadCheckSql } from "./canonical-comment-read-roots";

function readablePaths(kind: typeof referenceKinds[number], id: "rt.target_id") {
  return kind === "comment" || kind === "comment_attachment" || kind === "comment_occurrence"
    ? canonicalCommentReadCheckSql(kind,id) : originalReadablePaths(kind,id);
}
function pathState(kind: typeof referenceKinds[number], id: string) {
  if (kind === "comment" || kind === "comment_attachment" || kind === "comment_occurrence") {
    if (id !== "rt.target_id") throw new Error("Unknown fixed canonical Comment dependency input");
    return canonicalCommentDependencyStateSql(kind,id);
  }
  return originalPathState(kind,id);
}

// Closed native table inventory. Missing physical source and an empty retained
// context can yield the mature neutral Gone shape. Zero root rows by itself
// never proves physical absence or authorizes a malformed existing source.
const sourceTables = {
  sample: "samples", run: "runs", run_step: "run_steps", comment: "comment_submissions",
  comment_occurrence: "run_step_comments", comment_attachment: "comment_submission_items",
  execution_image: "run_step_assets", metrology_reference: "metrology_template_references", recipe_revision: "template_versions",
} as const;

/** Five authentic bound scope cells precede the unchanged original SQL binds.
 * Visibility is evaluated by native SQL before any item/label/edge projection;
 * it is never supplied by a caller, an advisory resolver or a serialized grant. */
export const PROJECT_FILTERED_SCOPE_CTE = `scope(project_id,include_deleted,provider,issuer,subject) AS (VALUES(?,?,?,?,?)),
  refs AS (
    SELECT DISTINCT rt.* FROM project_items item JOIN reference_targets rt ON rt.id=item.reference_target_id
    CROSS JOIN scope WHERE item.project_id=scope.project_id AND item.item_type='reference'
      AND (scope.include_deleted=1 OR item.deleted_at IS NULL)
  ), member AS (
    SELECT m.member_id FROM collaboration_members m JOIN collaboration_identities i ON i.member_id=m.member_id
    CROSS JOIN scope WHERE i.provider=scope.provider AND i.issuer=scope.issuer AND i.subject=scope.subject
      AND i.enabled=1 AND m.state='active'
  ), invalid_contexts AS (
    SELECT rt.id FROM refs rt WHERE json_valid(rt.last_known_contexts_json) IS NOT 1
      OR json_type(CASE WHEN json_valid(rt.last_known_contexts_json) THEN rt.last_known_contexts_json ELSE 'null' END) IS NOT 'array'
    UNION ${contextViolations.replace("SELECT 1 FROM refs rt", "SELECT rt.id FROM refs rt")}
  ), reference_visibility AS (
    SELECT rt.id,rt.target_type,rt.target_id,
      CASE WHEN rt.registry_version<>1 OR rt.id IN(SELECT id FROM invalid_contexts) THEN 'hidden'
        WHEN rt.tombstoned_at IS NOT NULL THEN 'neutral'
        WHEN ${referenceKinds.map(kind => `(rt.target_type='${kind}' AND ${readablePaths(kind, "rt.target_id")} IS 1)`).join(" OR ")}
          THEN 'readable'
        WHEN json_array_length(CASE WHEN json_valid(rt.last_known_contexts_json) THEN rt.last_known_contexts_json ELSE '[null]' END)=0
          AND (${referenceKinds.map(kind => `(rt.target_type='${kind}'
            AND NOT EXISTS(SELECT 1 FROM ${sourceTables[kind]} original_source WHERE original_source.id=rt.target_id))`).join(" OR ")})
          THEN 'neutral'
        ELSE 'hidden' END mode
    FROM refs rt
  ), visible_items AS (
    SELECT item.id FROM project_items item CROSS JOIN scope
    LEFT JOIN reference_visibility reference ON reference.id=item.reference_target_id
    WHERE item.project_id=scope.project_id AND (scope.include_deleted=1 OR item.deleted_at IS NULL)
      AND (item.item_type='content' OR (item.item_type='reference' AND reference.mode IN('readable','neutral')))
  )`;

const filters: Record<ProjectSnapshotProjection, readonly [string, string] | null> = {
  project: null,
  contents: ["WHERE pc.project_id = ?", "WHERE pc.project_id = ? AND pi.id IN(SELECT id FROM visible_items)"],
  attachments: ["WHERE pc.project_id = ?", "WHERE pc.project_id = ? AND pi.id IN(SELECT id FROM visible_items)"],
  items: ["WHERE project_id = ?", "WHERE project_id = ? AND id IN(SELECT id FROM visible_items)"],
  placements: ["WHERE pi.project_id = ?", "WHERE pi.project_id = ? AND pi.id IN(SELECT id FROM visible_items)"],
  edges: ["WHERE pe.project_id = ?", "WHERE pe.project_id = ? AND source.id IN(SELECT id FROM visible_items) AND target.id IN(SELECT id FROM visible_items)"],
  registry: ["WHERE pi.project_id = ?", "WHERE pi.project_id = ? AND pi.id IN(SELECT id FROM visible_items)"],
};
export function projectFilteredSnapshotSql(kind: ProjectSnapshotProjection, originalSql: string): string {
  const filter = filters[kind];
  if (filter && originalSql.split(filter[0]).length !== 2) throw new Error("Original Project projection scope is unavailable");
  return `WITH ${PROJECT_FILTERED_SCOPE_CTE}\n${filter ? originalSql.replace(filter[0],filter[1]) : originalSql}`;
}

/** Complete visible-set/provenance DATA captured beside the original seven
 * projections. Later same-BEGIN policy reads compare this exact set, while
 * authentication, membership and every root decision remain freshly evaluated.
 * Hidden items carry only private dependency fields; they never enter a DTO. */
export const PROJECT_FILTERED_DEPENDENCIES_SQL = `WITH ${PROJECT_FILTERED_SCOPE_CTE},
  visible_refs AS (SELECT rt.* FROM refs rt JOIN reference_visibility v ON v.id=rt.id WHERE v.mode IN('readable','neutral')),
  dependencies AS (
    SELECT 'item-visibility' kind,item.id registry_id,'' ordinal,
      json_array(item.item_type,item.project_content_id,item.reference_target_id,item.deleted_at,v.target_type,v.target_id,v.mode) state
    FROM project_items item CROSS JOIN scope LEFT JOIN reference_visibility v ON v.id=item.reference_target_id
    WHERE item.project_id=scope.project_id AND (scope.include_deleted=1 OR item.deleted_at IS NULL)
    UNION ALL SELECT 'registry-history',rt.id,'',json_array(rt.registry_version,rt.target_type,rt.target_id,
      rt.first_registered_at,rt.last_validated_at,rt.tombstoned_at,rt.last_known_contexts_json) FROM visible_refs rt
    UNION ALL ${referenceKinds.map(kind => `SELECT 'current-root',rt.id,'',${pathState(kind,"rt.target_id")}
      FROM visible_refs rt WHERE rt.target_type='${kind}'`).join("\n    UNION ALL ")}
    UNION ALL ${segmentKinds.map(kind => `SELECT 'historical-root',rt.id,
      CAST(context.key AS TEXT)||':'||CAST(segment.key AS TEXT),${pathState(kind,segmentId)}
      FROM visible_refs rt JOIN json_each(rt.last_known_contexts_json) context
      JOIN json_each(json_extract(${contextObject},'$.segments')) segment WHERE ${segmentType}='${kind}'`).join("\n    UNION ALL ")}
  ) SELECT kind,registry_id,ordinal,state FROM dependencies ORDER BY kind,registry_id,ordinal,state`;

export const PROJECT_FILTERED_DEPENDENCIES_CHECK_SQL = `SELECT 1 admitted WHERE NOT EXISTS(
  WITH actual AS (${PROJECT_FILTERED_DEPENDENCIES_SQL}), captured AS (
    SELECT json_extract(value,'$[0]') kind,json_extract(value,'$[1]') registry_id,
      json_extract(value,'$[2]') ordinal,json_extract(value,'$[3]') state FROM json_each(?)
  ) SELECT * FROM actual EXCEPT SELECT * FROM captured
) AND NOT EXISTS(
  WITH actual AS (${PROJECT_FILTERED_DEPENDENCIES_SQL}), captured AS (
    SELECT json_extract(value,'$[0]') kind,json_extract(value,'$[1]') registry_id,
      json_extract(value,'$[2]') ordinal,json_extract(value,'$[3]') state FROM json_each(?)
  ) SELECT * FROM captured EXCEPT SELECT * FROM actual
)`;

export const PROJECT_FILTERED_REFERENCE_MODES_SQL = `WITH ${PROJECT_FILTERED_SCOPE_CTE}
  SELECT target_type,target_id,mode FROM reference_visibility WHERE mode IN('readable','neutral') ORDER BY target_type,target_id`;
