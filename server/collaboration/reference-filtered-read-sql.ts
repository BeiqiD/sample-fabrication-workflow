import { REFERENCE_TARGET_TYPES, type ReferenceTarget, type ReferenceTargetType } from "../../shared/reference-types";
import { collaborationResourcePathsSql } from "../../worker/collaboration/resource-policy";
import { canonicalCommentDependencyStateSql, canonicalCommentReadCheckSql } from "./canonical-comment-read-roots";

/** Closed native source inventory. Physical absence is independently checked;
 * an empty ownership join never authorizes an existing malformed source. */
const sourceTables: Record<ReferenceTargetType, string> = {
  sample: "samples", run: "runs", run_step: "run_steps", comment: "comment_submissions",
  comment_occurrence: "run_step_comments", comment_attachment: "comment_submission_items",
  execution_image: "run_step_assets", metrology_reference: "metrology_template_references", recipe_revision: "template_versions",
};
const contextKinds = ["sample", "run", "run_step", "recipe_revision"] as const;
const object = "CASE WHEN context.type='object' THEN context.value ELSE '{}' END";
const segment = "CASE WHEN segment.type='object' THEN segment.value ELSE '{}' END";
const segmentType = `json_extract(${segment},'$.type')`, segmentId = `json_extract(${segment},'$.id')`;
const contexts = "CASE WHEN json_valid(rt.last_known_contexts_json) THEN rt.last_known_contexts_json ELSE '[]' END";
const contextSegments = `CASE WHEN json_type(${object},'$.segments')='array' THEN json_extract(${object},'$.segments') ELSE '[]' END`;

function paths(kind: ReferenceTargetType, id: string) {
  return collaborationResourcePathsSql(kind).replaceAll("?", id);
}
function readable(kind: ReferenceTargetType, id: string) {
  if (kind === "comment" || kind === "comment_attachment" || kind === "comment_occurrence") {
    if (id !== "rt.target_id") throw new Error("Unknown code-owned canonical reference identity");
    return canonicalCommentReadCheckSql(kind, id);
  }
  return `(WITH current_paths AS (${paths(kind, id)})
    SELECT (SELECT count(*) FROM current_paths) BETWEEN 1 AND 12
      AND NOT EXISTS(SELECT 1 FROM current_paths WHERE root_id IS NULL OR published IS NOT 1)
      AND NOT EXISTS(SELECT 1 FROM current_paths path WHERE NOT EXISTS(
        SELECT 1 FROM member m JOIN collaboration_resources resource
          ON resource.root_kind=path.root_kind AND resource.root_id=path.root_id
        LEFT JOIN collaboration_grants binding ON binding.root_kind=resource.root_kind
          AND binding.root_id=resource.root_id AND binding.member_id=m.member_id
        WHERE resource.visibility='workspace'
          OR(binding.enabled=1 AND binding.capability IN('read','operate','edit','manage')))))`;
}
/** Fixed ownership tuples, including intermediate native parents. Root IDs
 * alone do not detect a Step moving between Runs in the same Sample, or a
 * successor/revision changing within the same root. This is private DATA;
 * source bodies and labels continue to use their complete original adapters. */
function ownershipState(kind: ReferenceTargetType, id: string) {
  const selected: Partial<Record<ReferenceTargetType, string>> = {
    sample: `SELECT json_array(s.id,s.parent_id,s.deleted_at) FROM samples s WHERE s.id=${id}`,
    run: `SELECT json_array(r.id,r.sample_id,r.recipe_family_id,r.template_version_id,r.deleted_at,s.id,s.deleted_at)
      FROM runs r LEFT JOIN samples s ON s.id=r.sample_id WHERE r.id=${id}`,
    run_step: `SELECT json_array(rs.id,rs.run_id,rs.definition_hash,rs.deleted_at,r.id,r.sample_id,r.deleted_at,s.id,s.deleted_at)
      FROM run_steps rs LEFT JOIN runs r ON r.id=rs.run_id LEFT JOIN samples s ON s.id=r.sample_id WHERE rs.id=${id}`,
    execution_image: `SELECT json_array(occurrence.id,occurrence.run_step_id,occurrence.asset_id,occurrence.role,
        occurrence.deleted_at,occurrence.superseded_by_occurrence_id,successor.id,successor.run_step_id,successor.asset_id,
        successor.role,successor.deleted_at,successor.superseded_by_occurrence_id,rs.id,rs.run_id,r.id,r.sample_id,
        effective.id,effective.status,effective.import_id)
      FROM run_step_assets occurrence LEFT JOIN run_step_assets successor ON successor.id=occurrence.superseded_by_occurrence_id
      LEFT JOIN assets effective ON effective.id=coalesce(successor.asset_id,occurrence.asset_id)
      LEFT JOIN run_steps rs ON rs.id=occurrence.run_step_id LEFT JOIN runs r ON r.id=rs.run_id WHERE occurrence.id=${id}`,
    metrology_reference: `SELECT json_array(occurrence.id,occurrence.template_version_id,occurrence.asset_id,occurrence.deleted_at,
        occurrence.superseded_by_occurrence_id,successor.id,successor.template_version_id,successor.asset_id,
        successor.deleted_at,successor.superseded_by_occurrence_id,tv.id,tv.recipe_family_id,tv.deleted_at,tv.archived_at,
        effective.id,effective.status,effective.import_id)
      FROM metrology_template_references occurrence LEFT JOIN metrology_template_references successor ON successor.id=occurrence.superseded_by_occurrence_id
      LEFT JOIN assets effective ON effective.id=coalesce(successor.asset_id,occurrence.asset_id)
      LEFT JOIN template_versions tv ON tv.id=occurrence.template_version_id WHERE occurrence.id=${id}`,
    recipe_revision: `SELECT json_array(tv.id,tv.recipe_family_id,tv.manifest_hash,tv.source_asset_key,tv.deleted_at,tv.archived_at,rf.id)
      FROM template_versions tv LEFT JOIN recipe_families rf ON rf.id=tv.recipe_family_id WHERE tv.id=${id}`,
  };
  const sql = selected[kind];
  if (!sql) throw new Error("Unknown fixed original Reference ownership tuple");
  return `coalesce((${sql}),'null')`;
}
function pathState(kind: ReferenceTargetType, id: string) {
  if (kind === "comment" || kind === "comment_attachment" || kind === "comment_occurrence") {
    if (id !== "rt.target_id") throw new Error("Unknown code-owned canonical DATA identity");
    return canonicalCommentDependencyStateSql(kind, id);
  }
  return `json_array(${ownershipState(kind,id)},(WITH current_paths AS (${paths(kind, id)})
    SELECT json_group_array(json_array(root_kind,root_id,path_deleted,published))
    FROM (SELECT root_kind,root_id,path_deleted,published FROM current_paths
      ORDER BY root_kind,root_id,path_deleted,published)))`;
}

/** Every retained context segment is checked against actual CURRENT roots.
 * Neither a saved label nor an old ID is authority. Invalid old shapes hide the
 * target instead of passing through the mature registry's permissive parser. */
const invalidContext = `json_valid(rt.last_known_contexts_json) IS NOT 1
  OR json_type(${contexts}) IS NOT 'array'
  OR EXISTS(SELECT 1 FROM json_each(${contexts}) context WHERE context.type IS NOT 'object'
    OR (SELECT count(*) FROM json_each(${object}))<>1
    OR json_type(${object},'$.segments') IS NOT 'array'
    OR json_array_length(${contextSegments}) NOT BETWEEN 1 AND 3
    OR EXISTS(SELECT 1 FROM json_each(${contextSegments}) segment WHERE segment.type IS NOT 'object'
      OR (SELECT count(*) FROM json_each(${segment}))<>5
      OR EXISTS(SELECT 1 FROM json_each(${segment}) field WHERE field.key NOT IN('type','id','label','deletedAt','archivedAt'))
      OR coalesce(${segmentType},'') NOT IN('${contextKinds.join("','")}')
      OR json_type(${segment},'$.id') IS NOT 'text' OR length(${segmentId}) NOT BETWEEN 1 AND 256
      OR instr(${segmentId},char(0))<>0 OR trim(${segmentId}) IS NOT ${segmentId}
      OR json_type(${segment},'$.label') IS NOT 'text'
      OR coalesce(json_type(${segment},'$.deletedAt'),'missing') NOT IN('text','null')
      OR coalesce(json_type(${segment},'$.archivedAt'),'missing') NOT IN('text','null')
      OR (${contextKinds.map(kind => `(${segmentType}='${kind}' AND ${readable(kind, segmentId)} IS NOT 1)`).join(" OR ")})))`;

// Three authentic issuer cells, followed by one privately formed target JSON.
export const REFERENCE_CURRENT_MEMBER_CTE = `member AS (
  SELECT m.member_id FROM collaboration_members m JOIN collaboration_identities i ON i.member_id=m.member_id
  WHERE i.provider=? AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'
)`;
function visibilityCte(requestedSql: string, kinds: readonly ReferenceTargetType[] = REFERENCE_TARGET_TYPES) {
  return `requested AS (${requestedSql}), refs AS (
    SELECT requested.target_type,requested.target_id,rt.id,rt.registry_version,rt.first_registered_at,
      rt.last_validated_at,rt.tombstoned_at,rt.last_known_contexts_json FROM requested
    LEFT JOIN reference_targets rt ON rt.target_type=requested.target_type AND rt.target_id=requested.target_id
  ), reference_visibility AS (
    SELECT rt.*,CASE
      WHEN rt.id IS NOT NULL AND (rt.registry_version<>1 OR (${invalidContext})) THEN 'hidden'
      WHEN rt.tombstoned_at IS NOT NULL THEN 'neutral'
      WHEN ${kinds.map(kind => `(rt.target_type='${kind}' AND ${readable(kind, "rt.target_id")} IS 1)`).join(" OR ")} THEN 'readable'
      WHEN (rt.id IS NULL OR json_array_length(${contexts})=0)
        AND (${kinds.map(kind => `(rt.target_type='${kind}' AND NOT EXISTS(SELECT 1 FROM ${sourceTables[kind]} source WHERE source.id=rt.target_id))`).join(" OR ")}) THEN 'neutral'
      ELSE 'hidden' END mode FROM refs rt
  )`;
}
const requestedJsonSql = "SELECT DISTINCT json_extract(value,'$.type') target_type,json_extract(value,'$.id') target_id FROM json_each(?)";

export const REFERENCE_FILTERED_MODES_SQL = `SELECT target_type,target_id,mode FROM (
  WITH ${REFERENCE_CURRENT_MEMBER_CTE},${visibilityCte(requestedJsonSql)}
  SELECT target_type,target_id,mode FROM reference_visibility ORDER BY target_type,target_id)`;

function dependencies(requestedSql: string, kinds: readonly ReferenceTargetType[] = REFERENCE_TARGET_TYPES) {
  return `SELECT target_type,target_id,kind,ordinal,state FROM (
    WITH ${REFERENCE_CURRENT_MEMBER_CTE},${visibilityCte(requestedSql, kinds)}, dependencies AS (
      SELECT target_type,target_id,'visibility' kind,'' ordinal,mode state FROM reference_visibility
      UNION ALL SELECT target_type,target_id,'registry-history','',
        json_array(id,registry_version,first_registered_at,last_validated_at,tombstoned_at,last_known_contexts_json) FROM refs
      UNION ALL ${kinds.map(kind => `SELECT rt.target_type,rt.target_id,'current-root','',${pathState(kind, "rt.target_id")}
        FROM refs rt WHERE rt.target_type='${kind}'`).join("\n      UNION ALL ")}
      UNION ALL ${contextKinds.map(kind => `SELECT rt.target_type,rt.target_id,'historical-root',
        CAST(context.key AS TEXT)||':'||CAST(segment.key AS TEXT),${pathState(kind, segmentId)} FROM refs rt
        JOIN json_each(${contexts}) context JOIN json_each(${contextSegments}) segment
        WHERE rt.id IS NOT NULL AND ${segmentType}='${kind}'`).join("\n      UNION ALL ")}
    ) SELECT * FROM dependencies ORDER BY target_type,target_id,kind,ordinal,state)`;
}
export const REFERENCE_FILTERED_DEPENDENCIES_SQL = dependencies(requestedJsonSql);

/** Complete captured private provenance, not cached permission. Both set
 * directions are compared under the same native BEGIN as every later read.
 * The owner binds member3/targets/rows once. Materialization lasts only this
 * statement in its fresh BEGIN; both set directions reuse the exact same full
 * projection. Original identity checks stay live in the same admission. */
export const REFERENCE_FILTERED_DEPENDENCIES_CHECK_SQL = `SELECT 1 admitted FROM (
  WITH actual AS MATERIALIZED (${REFERENCE_FILTERED_DEPENDENCIES_SQL}), captured AS MATERIALIZED (
    SELECT json_extract(value,'$[0]') target_type,json_extract(value,'$[1]') target_id,
      json_extract(value,'$[2]') kind,json_extract(value,'$[3]') ordinal,json_extract(value,'$[4]') state FROM json_each(?)
  ) SELECT 1 WHERE NOT EXISTS(SELECT * FROM actual EXCEPT SELECT * FROM captured)
    AND NOT EXISTS(SELECT * FROM captured EXCEPT SELECT * FROM actual)
)`;

const searchIdentities: Record<ReferenceTargetType, string> = {
  sample: "s.id", run: "r.id", run_step: "rs.id", comment: "cs.id", comment_occurrence: "rsc.id",
  comment_attachment: "csi.id", execution_image: "rsa.id", metrology_reference: "mtr.id", recipe_revision: "tv.id",
};
function candidateReadable(typeSql: string, idSql: string, kinds: readonly ReferenceTargetType[] = REFERENCE_TARGET_TYPES) {
  // Fixed expressions from the two inventories below, never caller SQL.
  return `(SELECT mode FROM (WITH ${visibilityCte(`SELECT ${typeSql} target_type,${idSql} target_id`, kinds)}
    SELECT mode FROM reference_visibility))='readable'`;
}
function beforeOrder(original: string, predicate: string) {
  if (!/^\s*SELECT\b/i.test(original) || /;/.test(original)) throw new Error("Original reference candidate SELECT is unavailable");
  const marker = original.match(/\n[ \t]*ORDER BY /g);
  if (!marker || marker.length !== 1) throw new Error("Original reference candidate order is unavailable");
  const at = original.indexOf(marker[0]!);
  return original.slice(0, at) + predicate + original.slice(at);
}

/** Native current-root/context filtering occurs BEFORE the unchanged search
 * type LIMIT and all subsequent pooled/global limits, counts and truncated flags.
 * Original matching/ranking/time/visibility/default bindings stay byte exact. */
export function referenceFilteredSearchSql(type: ReferenceTargetType, idSql: string, original: string) {
  if (!REFERENCE_TARGET_TYPES.includes(type) || searchIdentities[type] !== idSql) throw new Error("Unknown original reference search identity");
  return `SELECT * FROM (WITH ${REFERENCE_CURRENT_MEMBER_CTE}\n${beforeOrder(original, ` AND ${candidateReadable(`'${type}'`, idSql, [type])}`)})`;
}
export function referenceFilteredChildrenSql(parent: ReferenceTarget, original: string) {
  let filter: string;
  switch (parent.type) {
    case "sample": case "run_step": case "comment":
      filter = ` WHERE ${candidateReadable("target_type", "target_id")}`; break;
    case "run": filter = ` AND ${candidateReadable("'run_step'", "rs.id")}`; break;
    case "comment_occurrence": filter = ` AND ${candidateReadable("'comment_attachment'", "csi.id")}`; break;
    case "recipe_revision": filter = ` AND ${candidateReadable("'metrology_reference'", "mtr.id")}`; break;
    default: throw new Error("Original leaf reference has no child query");
  }
  return `SELECT * FROM (WITH ${REFERENCE_CURRENT_MEMBER_CTE}\n${beforeOrder(original, filter)})`;
}

/** Repeats the exact bounded, permission-filtered candidate SELECT as a private
 * identity-only DATA sidecar INSIDE its same BEGIN. All returned overflow IDs
 * are captured before the original library slices or counts them. No body DTO
 * is fabricated, and this SELECT adds no candidates or permission grants. */
export function referenceCandidateDependenciesSql(filteredSql: string, type?: ReferenceTargetType) {
  if (type !== undefined && !REFERENCE_TARGET_TYPES.includes(type)) throw new Error("Unknown original reference candidate kind");
  return dependencies(type === undefined
    ? `SELECT DISTINCT target_type,target_id FROM (${filteredSql})`
    : `SELECT '${type}' target_type,target_id FROM (${filteredSql})`,
    type === undefined ? REFERENCE_TARGET_TYPES : [type]);
}
