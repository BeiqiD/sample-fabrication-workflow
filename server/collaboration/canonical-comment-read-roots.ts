/** Fixed DATA/root projection for new native Request-owned readers only.
 * No caller root, cached permission or default Worker policy is changed.
 * Matching audit means every actual kind=comment/submissionId row, including
 * creation, deletion and restoration; historical audits are not truncated.
 */
export type CanonicalCommentReadKind = "comment" | "comment_attachment" | "comment_occurrence";
export type CanonicalCommentIdExpression = "rt.target_id" | "candidate.id" | "source.id" | "target.id";
const identifiers: readonly string[] = ["rt.target_id", "candidate.id", "source.id", "target.id"];

export function canonicalCommentReadPathsSql(kind: CanonicalCommentReadKind, id: CanonicalCommentIdExpression): string {
  if (!identifiers.includes(id) || !["comment", "comment_attachment", "comment_occurrence"].includes(kind))
    throw new TypeError("Unknown fixed canonical Comment projection");
  const canonicalId = kind === "comment" ? id : kind === "comment_attachment"
    ? `(SELECT submission_id FROM comment_submission_items WHERE id=${id})`
    : `(SELECT submission_id FROM run_step_comments WHERE id=${id})`;
  const from = kind === "comment_attachment"
    ? "comment_submission_items item JOIN comment_submissions cs ON cs.id=item.submission_id" : "comment_submissions cs";
  const selected = kind === "comment_attachment" ? `item.id=${id}` : `cs.id=${canonicalId}`;
  const ready = kind === "comment_attachment" ? "cs.status='ready' AND item.status='ready'" : "cs.status='ready'";
  const itemDeleted = kind === "comment_attachment" ? " OR item.deleted_at IS NOT NULL" : "";
  const canonicalState = kind === "comment_attachment"
    ? "json_array(cs.id,cs.context_kind,cs.sample_id,cs.status,item.id,item.submission_id,item.status,item.deleted_at)"
    : "json_array(cs.id,cs.context_kind,cs.sample_id,cs.status)";
  const auditJson = "CASE WHEN json_valid(audit.metadata_json) THEN audit.metadata_json ELSE '{}' END";
  const canonical = `SELECT 'declared-sample' origin,cs.id source_id,NULL step_id,NULL run_id,cs.sample_id declared_sample_id,
      'sample' root_kind,s.id root_id,(cs.deleted_at IS NOT NULL OR s.deleted_at IS NOT NULL${itemDeleted}) path_deleted,
      (${ready}) published,${canonicalState} source_state
    FROM ${from} LEFT JOIN samples s ON s.id=cs.sample_id WHERE ${selected} AND cs.context_kind='sample'
    UNION ALL SELECT 'declared-step',target.run_step_id,target.run_step_id,target.run_id,target.sample_id,
      'sample',s.id,(cs.deleted_at IS NOT NULL OR s.deleted_at IS NOT NULL OR r.deleted_at IS NOT NULL OR rs.deleted_at IS NOT NULL${itemDeleted}),
      (${ready}),json_array(${canonicalState},rs.id,rs.run_id,r.id,r.sample_id)
    FROM ${from} LEFT JOIN comment_submission_targets target ON target.submission_id=cs.id
    LEFT JOIN runs r ON r.id=target.run_id AND r.sample_id=target.sample_id
    LEFT JOIN run_steps rs ON rs.id=target.run_step_id AND rs.run_id=r.id
    LEFT JOIN samples s ON s.id=CASE WHEN rs.id IS NOT NULL THEN r.sample_id END
    WHERE ${selected} AND cs.context_kind='run_steps'
    UNION ALL SELECT 'actual-occurrence',occurrence.id,occurrence.run_step_id,rs.run_id,r.sample_id,
      'sample',s.id,(cs.deleted_at IS NOT NULL OR occurrence.deleted_at IS NOT NULL OR rs.deleted_at IS NOT NULL
        OR r.deleted_at IS NOT NULL OR s.deleted_at IS NOT NULL${itemDeleted}),(${ready}),
      json_array(${canonicalState},occurrence.submission_id,rs.id,r.id)
    FROM ${from} JOIN run_step_comments occurrence ON occurrence.submission_id=cs.id
    LEFT JOIN run_steps rs ON rs.id=occurrence.run_step_id LEFT JOIN runs r ON r.id=rs.run_id
    LEFT JOIN samples s ON s.id=r.sample_id WHERE ${selected}
    UNION ALL SELECT 'actual-audit',audit.id,NULL,NULL,audit.sample_id,'sample',s.id,
      (cs.deleted_at IS NOT NULL OR s.deleted_at IS NOT NULL${itemDeleted}),(${ready}),
      json_array(${canonicalState},audit.kind,json_extract(${auditJson},'$.submissionId'),json_extract(${auditJson},'$.action'))
    FROM ${from} JOIN events audit ON audit.kind='comment'
      AND json_extract(${auditJson},'$.submissionId')=cs.id
    LEFT JOIN samples s ON s.id=audit.sample_id WHERE ${selected}`;
  // A legacy occurrence without canonical ownership keeps its actual local
  // Step/Run/Sample. A canonical occurrence additionally requires ALL paths.
  if (kind !== "comment_occurrence") return canonical;
  return `SELECT 'selected-occurrence' origin,occurrence.id source_id,occurrence.run_step_id step_id,
      rs.run_id run_id,r.sample_id declared_sample_id,'sample' root_kind,s.id root_id,
      (s.deleted_at IS NOT NULL OR r.deleted_at IS NOT NULL OR rs.deleted_at IS NOT NULL
        OR occurrence.deleted_at IS NOT NULL OR cs.deleted_at IS NOT NULL) path_deleted,1 published,
      json_array(occurrence.submission_id,rs.id,r.id,cs.status) source_state
    FROM run_step_comments occurrence LEFT JOIN comment_submissions cs ON cs.id=occurrence.submission_id
    LEFT JOIN run_steps rs ON rs.id=occurrence.run_step_id LEFT JOIN runs r ON r.id=rs.run_id
    LEFT JOIN samples s ON s.id=r.sample_id AND (occurrence.submission_id IS NULL OR cs.status='ready')
    WHERE occurrence.id=${id}
    UNION ALL ${canonical}`;
}

/** Caller supplies its authentic live member CTE inside the same native BEGIN.
 * Declaration cardinality remains the original 1..12 contract. All actual
 * occurrence/audit roots are checked without a per-row LIMIT or count cap.
 * Repeated audit history does not manufacture new grants or omit any root.
 */
export function canonicalCommentReadCheckSql(kind: CanonicalCommentReadKind, id: CanonicalCommentIdExpression): string {
  const paths = canonicalCommentReadPathsSql(kind, id);
  const declaration = kind === "comment_occurrence"
    ? `(SELECT CASE WHEN occurrence.submission_id IS NULL THEN 1 ELSE
        (SELECT count(*) BETWEEN 1 AND 12 FROM complete_paths WHERE origin IN('declared-sample','declared-step')) END
      FROM run_step_comments occurrence WHERE occurrence.id=${id}) IS 1`
    : "(SELECT count(*) FROM complete_paths WHERE origin IN('declared-sample','declared-step')) BETWEEN 1 AND 12";
  return `(WITH complete_paths AS (${paths}),
    roots AS (SELECT DISTINCT root_kind,root_id FROM complete_paths)
    SELECT (SELECT count(*) FROM complete_paths)>0 AND ${declaration}
      AND NOT EXISTS(SELECT 1 FROM complete_paths WHERE root_id IS NULL OR published IS NOT 1)
      AND NOT EXISTS(SELECT 1 FROM roots path WHERE NOT EXISTS(
        SELECT 1 FROM member m JOIN collaboration_resources resource
          ON resource.root_kind=path.root_kind AND resource.root_id=path.root_id
        LEFT JOIN collaboration_grants binding ON binding.root_kind=resource.root_kind
          AND binding.root_id=resource.root_id AND binding.member_id=m.member_id
        WHERE resource.visibility='workspace'
          OR(binding.enabled=1 AND binding.capability IN('read','operate','edit','manage')))))`;
}

/** Same full projection as readability, including native tuple/row identities.
 * This is private captured DATA; authorization is evaluated freshly each time.
 */
export function canonicalCommentDependencyStateSql(kind: CanonicalCommentReadKind, id: CanonicalCommentIdExpression): string {
  return `(WITH complete_paths AS (${canonicalCommentReadPathsSql(kind,id)})
    SELECT json_group_array(json_array(origin,source_id,step_id,run_id,declared_sample_id,
      root_kind,root_id,path_deleted,published,source_state))
    FROM (SELECT * FROM complete_paths ORDER BY origin,source_id,step_id,run_id,declared_sample_id,
      root_kind,root_id,path_deleted,published,source_state))`;
}
