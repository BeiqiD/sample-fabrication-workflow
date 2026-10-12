import type { ReferenceTargetType } from "../../shared/reference-types";
import { collaborationResourcePathsSql } from "../../worker/collaboration/resource-policy";

/** Fixed domain SQL, not a policy verdict or a capability. The authentic
 * Request owner binds its current identity and executes this check INSIDE the
 * same native BEGIN, before any original Project/reference SELECT.
 * All-source admission deliberately rejects a whole snapshot with an unreadable
 * source; it does not redact arrays or invent a reference resolution state. */
export const referenceKinds = ["sample", "run", "run_step", "comment", "comment_occurrence", "comment_attachment",
  "execution_image", "metrology_reference", "recipe_revision"] as const satisfies readonly ReferenceTargetType[];
export const segmentKinds = ["sample", "run", "run_step", "recipe_revision"] as const;

export function readablePaths(kind: typeof referenceKinds[number], idExpression: string) {
  // The only expressions passed here are the two fixed identifiers below.
  // No caller SQL, root, context label or serialized permission is accepted.
  const original = collaborationResourcePathsSql(kind).replaceAll("?", idExpression);
  // An occurrence adapter can expose the canonical shared Comment body. Its
  // local execution context alone does not authorize that canonical object;
  // require every current canonical target as well. Legacy occurrences have
  // no canonical submission and retain their original local Sample ownership.
  const canonical = kind === "comment_occurrence" ? collaborationResourcePathsSql("comment")
    .replaceAll("?", `(SELECT submission_id FROM run_step_comments WHERE id=${idExpression})`) : undefined;
  const paths = canonical === undefined ? original : `${original} UNION ALL ${canonical}`;
  const canonicalNonempty = canonical === undefined ? "" : `AND (SELECT CASE WHEN occurrence.submission_id IS NULL THEN 1
    ELSE (WITH canonical_paths AS (${canonical}) SELECT count(*) BETWEEN 1 AND 12 FROM canonical_paths) END
    FROM run_step_comments occurrence WHERE occurrence.id=${idExpression}) IS 1`;
  return `(WITH target_paths AS (${paths})
    SELECT (SELECT count(*) FROM target_paths) BETWEEN 1 AND ${canonical === undefined ? 12 : 13}
      ${canonicalNonempty}
      AND NOT EXISTS(SELECT 1 FROM target_paths WHERE root_id IS NULL OR published IS NOT 1)
      AND NOT EXISTS(SELECT 1 FROM target_paths path WHERE NOT EXISTS(
        SELECT 1 FROM member m JOIN collaboration_resources resource
          ON resource.root_kind=path.root_kind AND resource.root_id=path.root_id
        LEFT JOIN collaboration_grants binding ON binding.root_kind=resource.root_kind
          AND binding.root_id=resource.root_id AND binding.member_id=m.member_id
        WHERE resource.visibility='workspace'
          OR (binding.enabled=1 AND binding.capability IN('read','operate','edit','manage')))))`;
}
export const segmentObject = "CASE WHEN segment.type='object' THEN segment.value ELSE '{}' END";
export const contextObject = "CASE WHEN context.type='object' THEN context.value ELSE '{}' END";
export const segmentId = `json_extract(${segmentObject},'$.id')`;
export const segmentType = `json_extract(${segmentObject},'$.type')`;

const sourceViolations = referenceKinds.map(kind => `SELECT 1 FROM refs rt
  WHERE rt.target_type='${kind}' AND ${readablePaths(kind, "rt.target_id")} IS NOT 1`);
export const contextViolations = `SELECT 1 FROM refs rt
  JOIN json_each(CASE WHEN json_valid(rt.last_known_contexts_json) THEN rt.last_known_contexts_json ELSE '[]' END) context
  WHERE context.type IS NOT 'object'
    OR json_type(${contextObject},'$.segments') IS NOT 'array'
    OR (SELECT count(*) FROM json_each(${contextObject}))<>1
    OR json_array_length(CASE WHEN json_type(${contextObject},'$.segments')='array'
      THEN json_extract(${contextObject},'$.segments') ELSE '[]' END) NOT BETWEEN 1 AND 3
    OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_type(${contextObject},'$.segments')='array'
      THEN json_extract(${contextObject},'$.segments') ELSE '[]' END) segment
      WHERE segment.type IS NOT 'object'
        OR (SELECT count(*) FROM json_each(${segmentObject}))<>5
        OR EXISTS(SELECT 1 FROM json_each(${segmentObject}) field
          WHERE field.key NOT IN('type','id','label','deletedAt','archivedAt'))
        OR coalesce(${segmentType},'') NOT IN('sample','run','run_step','recipe_revision')
        OR json_type(${segmentObject},'$.id') IS NOT 'text'
        OR length(${segmentId}) NOT BETWEEN 1 AND 256 OR instr(${segmentId},char(0))<>0
        OR trim(${segmentId}) IS NOT ${segmentId}
        OR json_type(${segmentObject},'$.label') IS NOT 'text'
        OR coalesce(json_type(${segmentObject},'$.deletedAt'),'missing') NOT IN('text','null')
        OR coalesce(json_type(${segmentObject},'$.archivedAt'),'missing') NOT IN('text','null')
        OR (${segmentKinds.map(kind => `(${segmentType}='${kind}' AND ${readablePaths(kind, segmentId)} IS NOT 1)`).join(" OR ")}))`;

// Deleted source state is retained intentionally: the original resolver exposes
// retained/deleted states, but only after actual current roots, publication and
// grants are proven. Missing paths or malformed old contexts deny the snapshot.
// Bindings: original Project id, original includeDeleted, provider, issuer, sub.
export const PROJECT_SNAPSHOT_ALL_SOURCE_READ_CHECK_SQL = `SELECT 1 admitted WHERE NOT EXISTS(
  WITH refs AS (
    SELECT DISTINCT rt.id,rt.target_type,rt.target_id,rt.last_known_contexts_json
    FROM project_items item LEFT JOIN reference_targets rt ON rt.id=item.reference_target_id
    WHERE item.project_id=? AND item.item_type='reference' AND (?=1 OR item.deleted_at IS NULL)
  ), member AS (
    SELECT m.member_id FROM collaboration_members m JOIN collaboration_identities i ON i.member_id=m.member_id
    WHERE i.provider=? AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'
  )
  SELECT 1 FROM refs WHERE id IS NULL OR target_type NOT IN('${referenceKinds.join("','")}')
    OR json_valid(last_known_contexts_json) IS NOT 1 OR json_type(last_known_contexts_json) IS NOT 'array'
  UNION ALL ${sourceViolations.join("\n  UNION ALL ")}
  UNION ALL ${contextViolations}
)`;

/** Captured registry IDs are data dependencies, never cached authorization.
 * Before each later resolver query, the actual current Project registry set
 * must still equal that from the original seven-SELECT snapshot transaction.
 * Otherwise a removed/replaced reference could expose an old source that is
 * absent from the current all-root admission set. Bind current id/deleted/JSON. */
export const PROJECT_SNAPSHOT_REFERENCE_SET_CHECK_SQL = `SELECT 1 admitted WHERE NOT EXISTS(
  WITH actual AS (
    SELECT DISTINCT rt.id,rt.target_type,rt.target_id FROM project_items item
    JOIN reference_targets rt ON rt.id=item.reference_target_id
    WHERE item.project_id=? AND (?=1 OR item.deleted_at IS NULL)
  ), captured AS (
    SELECT json_extract(value,'$.id') id,json_extract(value,'$.target_type') target_type,
      json_extract(value,'$.target_id') target_id FROM json_each(?)
  )
  SELECT * FROM actual EXCEPT SELECT * FROM captured
) AND NOT EXISTS(
  WITH actual AS (
    SELECT DISTINCT rt.id,rt.target_type,rt.target_id FROM project_items item
    JOIN reference_targets rt ON rt.id=item.reference_target_id
    WHERE item.project_id=? AND (?=1 OR item.deleted_at IS NULL)
  ), captured AS (
    SELECT json_extract(value,'$.id') id,json_extract(value,'$.target_type') target_type,
      json_extract(value,'$.target_id') target_id FROM json_each(?)
  )
  SELECT * FROM captured EXCEPT SELECT * FROM actual
)`;

// DATA provenance captured under the original snapshot BEGIN, not an authority
// verdict. Preserve the exact registry history and actual mapped root/target
// projection that can produce later retained contexts. If a later writer clears
// old contexts or reparents a source, current-only permission checks cannot
// authorize already captured labels from the previous provenance.
export function pathState(kind: typeof referenceKinds[number], idExpression: string) {
  const original = collaborationResourcePathsSql(kind).replaceAll("?", idExpression);
  const canonical = kind === "comment_occurrence" ? collaborationResourcePathsSql("comment")
    .replaceAll("?", `(SELECT submission_id FROM run_step_comments WHERE id=${idExpression})`) : undefined;
  const paths = canonical === undefined ? original : `${original} UNION ALL ${canonical}`;
  return `(WITH dependency_paths AS (${paths})
    SELECT json_group_array(json_array(root_kind,root_id,path_deleted,published))
    FROM (SELECT root_kind,root_id,path_deleted,published FROM dependency_paths
      ORDER BY root_kind,root_id,path_deleted,published))`;
}
export const PROJECT_SNAPSHOT_READ_DEPENDENCIES_SQL = `WITH refs AS (
  SELECT DISTINCT rt.* FROM project_items item JOIN reference_targets rt ON rt.id=item.reference_target_id
  WHERE item.project_id=? AND item.item_type='reference' AND (?=1 OR item.deleted_at IS NULL)
), dependencies AS (
  SELECT 'registry-history' kind,rt.id registry_id,'' ordinal,
    json_array(rt.registry_version,rt.target_type,rt.target_id,rt.first_registered_at,
      rt.last_validated_at,rt.tombstoned_at,rt.last_known_contexts_json) state FROM refs rt
  UNION ALL ${referenceKinds.map(kind => `SELECT 'current-root' kind,rt.id registry_id,'' ordinal,
    ${pathState(kind, "rt.target_id")} state FROM refs rt WHERE rt.target_type='${kind}'`).join("\n  UNION ALL ")}
  UNION ALL ${segmentKinds.map(kind => `SELECT 'historical-root' kind,rt.id registry_id,
    CAST(context.key AS TEXT)||':'||CAST(segment.key AS TEXT) ordinal,
    ${pathState(kind, segmentId)} state FROM refs rt
    JOIN json_each(rt.last_known_contexts_json) context
    JOIN json_each(json_extract(${contextObject},'$.segments')) segment
    WHERE ${segmentType}='${kind}'`).join("\n  UNION ALL ")}
)
SELECT kind,registry_id,ordinal,state FROM dependencies ORDER BY kind,registry_id,ordinal,state`;

/** All current DATA dependencies must still equal the original captured set.
 * Permission/session/control checks are independently live in this SAME BEGIN.
 * No registry history, old label, target ID or serialized root is a grant.
 * Bind original id/deleted/captured JSON twice; SQL/table/keys are code-owned. */
export const PROJECT_SNAPSHOT_READ_DEPENDENCIES_CHECK_SQL = `SELECT 1 admitted WHERE NOT EXISTS(
  WITH actual AS (${PROJECT_SNAPSHOT_READ_DEPENDENCIES_SQL}), captured AS (
    SELECT json_extract(value,'$[0]') kind,json_extract(value,'$[1]') registry_id,
      json_extract(value,'$[2]') ordinal,json_extract(value,'$[3]') state FROM json_each(?)
  ) SELECT * FROM actual EXCEPT SELECT * FROM captured
) AND NOT EXISTS(
  WITH actual AS (${PROJECT_SNAPSHOT_READ_DEPENDENCIES_SQL}), captured AS (
    SELECT json_extract(value,'$[0]') kind,json_extract(value,'$[1]') registry_id,
      json_extract(value,'$[2]') ordinal,json_extract(value,'$[3]') state FROM json_each(?)
  ) SELECT * FROM captured EXCEPT SELECT * FROM actual
)`;
