import type { ReadSqlDatabase } from "../runtime/read-sql";
import { configurationSqlInteger } from "../runtime/configuration-sql";
import { canonicalIdentityText } from "../../shared/contracts/request-subject";
import { publishedAssetSql, publishedTemplateVersionSql } from "../template-publication";
import type { CollaborationCapability, CollaborationSubject } from "./policy";

export const COLLABORATION_RESOURCE_TARGET_KINDS = ["sample", "run", "run_step", "event", "project", "project_item",
  "project_content", "project_attachment", "project_placement", "project_edge", "recipe_family", "recipe_revision",
  "template_step", "metrology_reference", "comment", "comment_occurrence", "comment_attachment", "execution_image"] as const;
export type CollaborationResourceTargetKind = typeof COLLABORATION_RESOURCE_TARGET_KINDS[number];
export interface CollaborationResourceTarget { readonly kind: CollaborationResourceTargetKind; readonly id: string }
export type CollaborationResourceVisibility = "visible" | "retained";
export interface ResolvedCollaborationAssessment {
  readonly authority: "inert-proposal";
  readonly wouldAllow: boolean;
  readonly memberRevision: number | null;
  readonly identityRevision: number | null;
  readonly rootRevisions: readonly number[];
  readonly grantRevisions: readonly (number | null)[];
  readonly domainEligibility: "requires-current-owned-business-guards";
}
export function collaborationResourceTarget(input: CollaborationResourceTarget): CollaborationResourceTarget {
  const { kind, id } = input;
  if (!(COLLABORATION_RESOURCE_TARGET_KINDS as readonly string[]).includes(kind) || !canonicalIdentityText(id, 256))
    throw new TypeError("Invalid collaboration domain target");
  return Object.freeze({ kind, id });
}
const denied = (): ResolvedCollaborationAssessment => Object.freeze({ authority: "inert-proposal", wouldAllow: false,
  memberRevision: null, identityRevision: null, rootRevisions: Object.freeze([]), grantRevisions: Object.freeze([]),
  domainEligibility: "requires-current-owned-business-guards" });
// Actual domain joins are fixed code; no caller parent/root, actor, cached
// reference context, File ID, raw key or provider profile selects ownership.
// A missing LEFT JOIN path remains a rejected row rather than disappearing.
export function collaborationResourcePathsSql(kind: CollaborationResourceTargetKind): string {
  const sample = (from: string, where: string, deleted: string) =>
    `SELECT 'sample' root_kind,s.id root_id,(${deleted}) path_deleted,1 published FROM ${from} WHERE ${where}`;
  const project = (from: string, where: string, deleted: string) =>
    `SELECT 'project' root_kind,p.id root_id,(${deleted}) path_deleted,1 published FROM ${from} WHERE ${where}`;
  const template = (from: string, where: string, deleted: string) =>
    `SELECT 'template' root_kind,rf.id root_id,(${deleted}) path_deleted,(${publishedTemplateVersionSql("tv")}) published FROM ${from} WHERE ${where}`;
  switch (kind) {
    case "sample": return sample("samples s", "s.id=?", "s.deleted_at IS NOT NULL");
    case "run": return sample("runs r LEFT JOIN samples s ON s.id=r.sample_id", "r.id=?", "s.deleted_at IS NOT NULL OR r.deleted_at IS NOT NULL");
    case "run_step": return sample("run_steps rs LEFT JOIN runs r ON r.id=rs.run_id LEFT JOIN samples s ON s.id=r.sample_id", "rs.id=?", "s.deleted_at IS NOT NULL OR r.deleted_at IS NOT NULL OR rs.deleted_at IS NOT NULL");
    case "event": return sample("events e LEFT JOIN samples s ON s.id=e.sample_id", "e.id=?", "s.deleted_at IS NOT NULL");
    case "project": return project("projects p", "p.id=?", "p.deleted_at IS NOT NULL");
    case "project_item": return project("project_items pi LEFT JOIN projects p ON p.id=pi.project_id", "pi.id=?", "p.deleted_at IS NOT NULL OR pi.deleted_at IS NOT NULL");
    case "project_content": return project("project_contents pc LEFT JOIN project_items pi ON pi.project_content_id=pc.id AND pi.project_id=pc.project_id LEFT JOIN projects p ON p.id=pi.project_id", "pc.id=?", "p.deleted_at IS NOT NULL OR pi.deleted_at IS NOT NULL OR pc.deleted_at IS NOT NULL");
    case "project_attachment": return project("project_content_attachments pa LEFT JOIN project_contents pc ON pc.id=pa.project_content_id LEFT JOIN project_items pi ON pi.project_content_id=pc.id AND pi.project_id=pc.project_id LEFT JOIN projects p ON p.id=pi.project_id", "pa.project_content_id=?", "p.deleted_at IS NOT NULL OR pi.deleted_at IS NOT NULL OR pc.deleted_at IS NOT NULL");
    case "project_placement": return project("project_map_placements pm LEFT JOIN project_items pi ON pi.id=pm.project_item_id LEFT JOIN projects p ON p.id=pi.project_id", "pm.id=?", "p.deleted_at IS NOT NULL OR pi.deleted_at IS NOT NULL");
    case "project_edge": return project("project_edges pe LEFT JOIN project_items source ON source.id=pe.source_item_id AND source.project_id=pe.project_id LEFT JOIN project_items destination ON destination.id=pe.target_item_id AND destination.project_id=pe.project_id LEFT JOIN projects p ON p.id=CASE WHEN source.id IS NOT NULL AND destination.id IS NOT NULL THEN pe.project_id END", "pe.id=?", "p.deleted_at IS NOT NULL OR pe.deleted_at IS NOT NULL OR source.deleted_at IS NOT NULL OR destination.deleted_at IS NOT NULL");
    case "recipe_family": return "SELECT 'template' root_kind,rf.id root_id,0 path_deleted,1 published FROM recipe_families rf WHERE rf.id=?";
    case "recipe_revision": return template("template_versions tv LEFT JOIN recipe_families rf ON rf.id=tv.recipe_family_id", "tv.id=?", "tv.deleted_at IS NOT NULL");
    case "template_step": return template("template_steps ts LEFT JOIN template_versions tv ON tv.id=ts.template_version_id LEFT JOIN recipe_families rf ON rf.id=tv.recipe_family_id", "ts.id=?", "tv.deleted_at IS NOT NULL");
    case "comment": return commentPaths(false);
    case "comment_attachment": return commentPaths(true);
    case "comment_occurrence": return sample("run_step_comments c LEFT JOIN comment_submissions cs ON cs.id=c.submission_id LEFT JOIN run_steps rs ON rs.id=c.run_step_id LEFT JOIN runs r ON r.id=rs.run_id LEFT JOIN samples s ON s.id=r.sample_id AND (c.submission_id IS NULL OR cs.status='ready')", "c.id=?", "s.deleted_at IS NOT NULL OR r.deleted_at IS NOT NULL OR rs.deleted_at IS NOT NULL OR c.deleted_at IS NOT NULL OR cs.deleted_at IS NOT NULL");
    case "execution_image": return `SELECT 'sample' root_kind,s.id root_id,
      (s.deleted_at IS NOT NULL OR r.deleted_at IS NOT NULL OR rs.deleted_at IS NOT NULL OR occurrence.deleted_at IS NOT NULL) path_deleted,
      (effective.status='ready' AND ${publishedAssetSql("effective")}
       AND (occurrence.superseded_by_occurrence_id IS NULL OR (successor.id IS NOT NULL AND successor.superseded_by_occurrence_id IS NULL))) published
      FROM run_step_assets occurrence LEFT JOIN run_step_assets successor ON successor.id=occurrence.superseded_by_occurrence_id
        AND successor.run_step_id=occurrence.run_step_id AND successor.role=occurrence.role
      LEFT JOIN assets effective ON effective.id=coalesce(successor.asset_id,occurrence.asset_id)
      LEFT JOIN run_steps rs ON rs.id=occurrence.run_step_id LEFT JOIN runs r ON r.id=rs.run_id
      LEFT JOIN samples s ON s.id=r.sample_id WHERE occurrence.id=? AND occurrence.role='execution'`;
    case "metrology_reference": return `SELECT 'template' root_kind,rf.id root_id,
      (tv.deleted_at IS NOT NULL OR occurrence.deleted_at IS NOT NULL) path_deleted,
      (${publishedTemplateVersionSql("tv")} AND effective.status='ready' AND ${publishedAssetSql("effective")}
       AND (occurrence.superseded_by_occurrence_id IS NULL OR (successor.id IS NOT NULL AND successor.superseded_by_occurrence_id IS NULL))) published
      FROM metrology_template_references occurrence LEFT JOIN metrology_template_references successor
        ON successor.id=occurrence.superseded_by_occurrence_id AND successor.template_version_id=occurrence.template_version_id
      LEFT JOIN assets effective ON effective.id=coalesce(successor.asset_id,occurrence.asset_id)
      LEFT JOIN template_versions tv ON tv.id=occurrence.template_version_id LEFT JOIN recipe_families rf ON rf.id=tv.recipe_family_id
      WHERE occurrence.id=?`;
  }
}
function commentPaths(attachment: boolean): string {
  const from = attachment ? "comment_submission_items item JOIN comment_submissions cs ON cs.id=item.submission_id" : "comment_submissions cs";
  const id = attachment ? "item.id" : "cs.id", itemDeleted = attachment ? " OR item.deleted_at IS NOT NULL" : "";
  const ready = attachment ? "cs.status='ready' AND item.status='ready'" : "cs.status='ready'";
  // The entire canonical target set is included before permission decisions;
  // no one-readable-Sample shortcut, projection redaction or post-limit filter.
  return `SELECT 'sample' root_kind,s.id root_id,(cs.deleted_at IS NOT NULL OR s.deleted_at IS NOT NULL${itemDeleted}) path_deleted,
      (${ready}) published FROM ${from} LEFT JOIN samples s ON s.id=cs.sample_id
      WHERE ${id}=? AND cs.context_kind='sample'
    UNION ALL SELECT 'sample',s.id,(cs.deleted_at IS NOT NULL OR s.deleted_at IS NOT NULL OR r.deleted_at IS NOT NULL OR rs.deleted_at IS NOT NULL${itemDeleted}),
      (${ready}) FROM ${from} LEFT JOIN comment_submission_targets target ON target.submission_id=cs.id
      LEFT JOIN runs r ON r.id=target.run_id AND r.sample_id=target.sample_id
      LEFT JOIN run_steps rs ON rs.id=target.run_step_id AND rs.run_id=r.id
      LEFT JOIN samples s ON s.id=CASE WHEN rs.id IS NOT NULL THEN r.sample_id END
      WHERE ${id}=? AND cs.context_kind='run_steps'`;
}
/** Current root/membership policy snapshot only. A structural subject is not
 * authentication and this function issues no permission token or resource row.
 * The native Request owner runs this ONE fixed SELECT inside its admitted BEGIN.
 * Basic visibility never replaces mature CAS, Run/plan eligibility, archive/
 * lock/referenced checks, pending upload ownership or File restoration gates. */
export async function assessResolvedCollaborationResource(database: ReadSqlDatabase, subjectInput: CollaborationSubject,
  input: CollaborationResourceTarget, capability: CollaborationCapability, visibility: CollaborationResourceVisibility): Promise<ResolvedCollaborationAssessment> {
  const target = collaborationResourceTarget(input), subject = Object.freeze({ provider: subjectInput.provider, issuer: subjectInput.issuer, subject: subjectInput.subject });
  if (!["access", "local"].includes(subject.provider) || !canonicalIdentityText(subject.issuer, 2048) || !canonicalIdentityText(subject.subject, 256)) throw new TypeError("Invalid trusted identity facts");
  if (!["read", "operate", "edit", "manage"].includes(capability)) throw new TypeError("Invalid collaboration capability");
  const required = { read: 1, operate: 2, edit: 3, manage: 4 }[capability];
  if (!required || !["visible", "retained"].includes(visibility)) throw new TypeError("Invalid collaboration policy scope");
  if (visibility === "retained" && capability !== "read" && capability !== "manage") return denied();
  const paths = collaborationResourcePathsSql(target.kind), pathIds = target.kind === "comment" || target.kind === "comment_attachment" ? [target.id, target.id] : [target.id];
  const row = await database.prepare(`WITH target_paths AS (${paths}),
    roots AS (SELECT DISTINCT root_kind,root_id FROM target_paths),
    member AS (SELECT m.member_id,m.revision member_revision,i.revision identity_revision FROM collaboration_members m
      JOIN collaboration_identities i ON i.member_id=m.member_id WHERE i.provider=? AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'),
    policies AS (SELECT root.root_kind,root.root_id,r.revision root_revision,
      CASE WHEN g.enabled=1 THEN g.revision ELSE NULL END grant_revision,
      CASE WHEN (?=1 AND r.visibility='workspace') OR(g.enabled=1 AND CASE g.capability WHEN 'read' THEN 1 WHEN 'operate' THEN 2 WHEN 'edit' THEN 3 WHEN 'manage' THEN 4 END>=?) THEN 1 ELSE 0 END allowed
      FROM roots root CROSS JOIN member m JOIN collaboration_resources r ON r.root_kind=root.root_kind AND r.root_id=root.root_id
      LEFT JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id AND g.member_id=m.member_id
      WHERE (?<>2 OR root.root_kind='sample'))
    SELECT CASE WHEN (SELECT count(*) FROM target_paths) BETWEEN 1 AND 12
      AND NOT EXISTS(SELECT 1 FROM target_paths WHERE root_id IS NULL OR published IS NOT 1 OR (?=0 AND path_deleted IS NOT 0))
      AND (SELECT count(*) FROM policies)=(SELECT count(*) FROM roots) AND NOT EXISTS(SELECT 1 FROM policies WHERE allowed IS NOT 1)
      THEN 1 ELSE 0 END would_allow,
      (SELECT member_revision FROM member) member_revision,(SELECT identity_revision FROM member) identity_revision,
      (SELECT json_group_array(root_revision) FROM (SELECT root_revision FROM policies ORDER BY root_kind,root_id)) root_revisions,
      (SELECT json_group_array(grant_revision) FROM (SELECT grant_revision FROM policies ORDER BY root_kind,root_id)) grant_revisions`)
    .bind(...pathIds,subject.provider,subject.issuer,subject.subject,required,required,required,visibility === "retained" ? 1 : 0).first();
  if (!row || configurationSqlInteger(row.would_allow, "collaboration.resourceDecision") !== 1) return denied();
  const revisions = (value: unknown, nullable: boolean): readonly (number | null)[] => {
    if (typeof value !== "string") throw new TypeError("Missing exact root revisions");
    const parsed: unknown = JSON.parse(value); if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 12) throw new TypeError("Invalid root revision set");
    return Object.freeze(parsed.map(cell => nullable && cell === null ? null : configurationSqlInteger(cell, "collaboration.rootRevision", 1)));
  };
  return Object.freeze({ authority: "inert-proposal", wouldAllow: true,
    memberRevision: configurationSqlInteger(row.member_revision, "collaboration.memberRevision", 1),
    identityRevision: configurationSqlInteger(row.identity_revision, "collaboration.identityRevision", 1),
    rootRevisions: revisions(row.root_revisions, false) as readonly number[], grantRevisions: revisions(row.grant_revisions, true),
    domainEligibility: "requires-current-owned-business-guards" });
}
