import type { ReadSqlDatabase } from "../runtime/read-sql";
import { configurationSqlInteger } from "../runtime/configuration-sql";

export type CollaborationRootKind = "sample" | "project" | "template";
export type CollaborationCapability = "read" | "operate" | "edit" | "manage";
export interface CollaborationRoot { readonly kind: CollaborationRootKind; readonly id: string }
/** This is trusted runtime output, never parsed from HTTP actor/email/body.
 * Access requires an actually verified stable sub and issuer; local requires
 * stable account id verified by the current session + the composition-owned
 * current installation issuer (never a rotating session id). */
export interface CollaborationSubject { readonly provider: "access" | "local"; readonly issuer: string; readonly subject: string }
export interface CollaborationAssessment {
  readonly authority: "inert-proposal";
  readonly wouldAllow: boolean;
  readonly memberRevision: number | null;
  readonly identityRevision: number | null;
  readonly resourceRevision: number | null;
  readonly grantRevision: number | null;
}
function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.length || value.length>maximum || value.includes("\0")) throw new TypeError(`Invalid collaboration ${label}`);
  return value;
}
function checkedSubject(input: CollaborationSubject): CollaborationSubject {
  const { provider, issuer, subject } = input;
  if (provider!=="access" && provider!=="local") throw new TypeError("Unsupported collaboration authentication provider");
  return Object.freeze({ provider, issuer: text(issuer,"issuer",2048), subject: text(subject,"subject",256) });
}
function checkedRoot(input: CollaborationRoot): CollaborationRoot {
  const { kind, id } = input;
  if (kind!=="sample" && kind!=="project" && kind!=="template") throw new TypeError("Invalid collaboration root kind");
  return Object.freeze({kind,id:text(id,"root id",256)});
}
function rank(capability: CollaborationCapability): number {
  switch(capability) { case "read":return 1;case "operate":return 2;case "edit":return 3;case "manage":return 4;
    default:throw new TypeError("Invalid collaboration capability"); }
}
const denied = (): CollaborationAssessment => Object.freeze({ authority:"inert-proposal",wouldAllow:false,
  memberRevision:null,identityRevision:null,resourceRevision:null,grantRevision:null });
const currentMember = `i.provider=? AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'`;
// Polymorphic policy rows never make a physically absent root authoritative.
const actualRoot = `(r.root_kind='sample' AND EXISTS(SELECT 1 FROM samples WHERE id=r.root_id))
 OR(r.root_kind='project' AND EXISTS(SELECT 1 FROM projects WHERE id=r.root_id))
 OR(r.root_kind='template' AND EXISTS(SELECT 1 FROM recipe_families WHERE id=r.root_id))`;

/** Candidate policy inspection only. It returns no authorization token, SQL
 * write, row data, stream, actor/admin grant or mounted route capability. Every
 * call re-reads current persisted membership/map/root/grant; no decision cache.
 * A reviewed successor must guard actual mutations in their commit transaction,
 * not reuse this advisory boolean across an await/provider request/publication. */
export async function assessCollaborationCapability(database: ReadSqlDatabase, input: {
  subject: CollaborationSubject; root: CollaborationRoot; capability: CollaborationCapability;
}): Promise<CollaborationAssessment> {
  const subject=checkedSubject(input.subject),root=checkedRoot(input.root),required=rank(input.capability);
  if(root.kind!=="sample" && input.capability==="operate") return denied();
  const row=await database.prepare(`SELECT m.revision member_revision,i.revision identity_revision,r.revision resource_revision,
   CASE WHEN g.enabled=1 THEN g.revision ELSE NULL END grant_revision,
   CASE WHEN (?=1 AND r.visibility='workspace') OR(g.enabled=1 AND
    CASE g.capability WHEN 'read' THEN 1 WHEN 'operate' THEN 2 WHEN 'edit' THEN 3 WHEN 'manage' THEN 4 END>=?)
    THEN 1 ELSE 0 END would_allow
   FROM collaboration_members m JOIN collaboration_identities i ON i.member_id=m.member_id
   JOIN collaboration_resources r ON r.root_kind=? AND r.root_id=?
   LEFT JOIN collaboration_grants g ON g.member_id=m.member_id AND g.root_kind=r.root_kind AND g.root_id=r.root_id
   WHERE ${currentMember} AND(${actualRoot})`)
    .bind(required,required,root.kind,root.id,subject.provider,subject.issuer,subject.subject).first();
  if(!row)return denied();
  const allowed=configurationSqlInteger(row.would_allow,"collaboration.wouldAllow");
  if(allowed!==0&&allowed!==1)throw new RangeError("Invalid collaboration decision flag");
  return Object.freeze({authority:"inert-proposal",wouldAllow:allowed===1,
    memberRevision:configurationSqlInteger(row.member_revision,"collaboration.memberRevision",1),
    identityRevision:configurationSqlInteger(row.identity_revision,"collaboration.identityRevision",1),
    resourceRevision:configurationSqlInteger(row.resource_revision,"collaboration.resourceRevision",1),
    grantRevision:row.grant_revision===null?null:configurationSqlInteger(row.grant_revision,"collaboration.grantRevision",1)});
}
export async function assessCollaborationCreation(database: ReadSqlDatabase, subjectInput: CollaborationSubject, kind: CollaborationRootKind) {
  const subject=checkedSubject(subjectInput);checkedRoot({kind,id:"creation-scope"});
  const row=await database.prepare(`SELECT m.revision member_revision,i.revision identity_revision,
   CASE ? WHEN 'sample' THEN m.can_create_samples WHEN 'project' THEN m.can_create_projects WHEN 'template' THEN m.can_create_templates END would_allow
   FROM collaboration_members m JOIN collaboration_identities i ON i.member_id=m.member_id WHERE ${currentMember}`)
    .bind(kind,subject.provider,subject.issuer,subject.subject).first();
  if(!row)return denied();
  const flag=configurationSqlInteger(row.would_allow,"collaboration.createCapability");
  if(flag!==0&&flag!==1)throw new RangeError("Invalid collaboration creation flag");
  return Object.freeze({authority:"inert-proposal" as const,wouldAllow:flag===1,
    memberRevision:configurationSqlInteger(row.member_revision,"collaboration.memberRevision",1),
    identityRevision:configurationSqlInteger(row.identity_revision,"collaboration.identityRevision",1),resourceRevision:null,grantRevision:null});
}
/** Trusted future runtime must authenticate the exact ingress Request afresh.
 * This library intentionally exposes only policy inspection, never require/allow
 * middleware. Disabled development authentication is not a supported subject. */
export function createCollaborationPolicyInspector(options: {
  database(): ReadSqlDatabase;
  authenticate(request: Request): Promise<CollaborationSubject>;
}) {
  const { database,authenticate }=options;
  return Object.freeze({
    async inspect(request: Request, root: CollaborationRoot, capability: CollaborationCapability) {
      const capturedRoot=checkedRoot(root),capturedCapability=capability;rank(capturedCapability);
      const subject=checkedSubject(await authenticate(request));
      return assessCollaborationCapability(database(),{subject,root:capturedRoot,capability:capturedCapability});
    },
    async inspectCreation(request: Request, kind: CollaborationRootKind) {
      checkedRoot({kind,id:"creation-scope"});const subject=checkedSubject(await authenticate(request));
      return assessCollaborationCreation(database(),subject,kind);
    },
  });
}
