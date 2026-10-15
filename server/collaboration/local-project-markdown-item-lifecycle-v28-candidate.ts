import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { isProjectApiId, isProjectItemLifecycleInput } from "../../shared/project-api";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { createProjectItemLifecycleService } from "../../worker/projects/item-lifecycle-service";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { asProjectItemLifecycleDatabase } from "../project-item-lifecycle-sql";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability } from "../sqlite";

declare const projectMarkdownItemLifecycleBrand: unique symbol;
export interface ProjectMarkdownItemLifecycleV28Request {
  readonly kind: "unmounted-project-markdown-item-lifecycle-v28/1";
  readonly [projectMarkdownItemLifecycleBrand]: true;
}
export type ProjectMarkdownItemLifecycleV28Scope = Readonly<{ operation: "remove-item" | "restore-item"; projectId: string; itemId: string }>;
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  operation: ProjectMarkdownItemLifecycleV28Scope["operation"]; projectId: string; itemId: string; actor: string;
  tokenHash: string; credentialRevision: bigint; createdAt: bigint;
}>;
const unavailable = () => new HTTPException(503, { message: "Current metadata item lifecycle operations are unavailable" });
const denied = () => new HTTPException(403, { message: "Current explicit Project edit permission is required" });
const changed = () => new HTTPException(409, { message: "Metadata item identity changed. Reload before continuing." });
const memberWhere = "i.provider=? AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";

/** Private original-Request destination edit for Markdown or Reference item removal/restore.
 * Complete original lifecycle/CAS/replay/trigger ordering remains delegated.
 * Every original read/write and final ACK obtains six fresh same-BEGIN guards.
 * Current Markdown or Reference identity is required for live and retained rows;
 * the mature algorithm owns deletion state and expected revisions. No Sample,
 * creation flag, workspace read, creator, admin or File grant applies. Reference
 * lifecycle returns destination/item/placement metadata only; it never resolves
 * a source body/label or opens bytes, so destination edit remains independent
 * of insertion's every-source-root read. Original readonly source filters remain.
 * The host retains ORIGINAL work and disposes this issuer before its parents. */
export function createLocalProjectMarkdownItemLifecycleV28Candidate(options: {
  database: SqliteCapability; nativeDatabase: DatabaseSync; admission: ReviewedInstallationAdmission;
  writerLease: LinuxWriterLease; authentication: object;
}) {
  const { database, nativeDatabase, admission, writerLease, authentication } = options;
  const auth = localAuthenticationIdentityAuthority(authentication);
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  const policy = assertInstalledLocalIdentityOwner(auth.identity, database, nativeDatabase, admission);
  const installation = Object.freeze({ ...assertInstallationAdmission(nativeDatabase, admission) });
  if (installation.checkpointId !== "portable-runtime/v28") throw unavailable();
  const control = nativeDatabase.prepare("SELECT schema_version,enforcement,revision FROM collaboration_control WHERE singleton=1").get();
  if (control?.schema_version !== 2 || !["disabled", "enabled"].includes(control.enforcement as string)
    || typeof control.revision !== "number" || !Number.isSafeInteger(control.revision) || control.revision < 1) throw unavailable();
  const sentinel = nativeDatabase.prepare("SELECT bootstrap_principal_id,initialized_at FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'").get();
  if (typeof sentinel?.bootstrap_principal_id !== "string" || typeof sentinel.initialized_at !== "number"
    || !Number.isSafeInteger(sentinel.initialized_at) || sentinel.initialized_at < 0) throw unavailable();
  const bootstrapPrincipalId = sentinel.bootstrap_principal_id, initializedAt = sentinel.initialized_at;
  const localIssuer = `node-installation:${installation.installationId}`;
  const issuer = createLocalRequestSubjectIssuer({ database, nativeDatabase, admission, writerLease, authentication });
  const requests = new WeakMap<ProjectMarkdownItemLifecycleV28Request, Captured>(); let active = true;
  function selected(request: Request, token: ProjectMarkdownItemLifecycleV28Request, operation: Captured["operation"]): Captured {
    const owner = requests.get(token);
    if (!active || !owner || owner.request !== request || owner.operation !== operation || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    const facts = issuer.read(request, owner.subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || facts.subject !== owner.facts.subject
      || auth.currentSessionPredicate(request, owner.actor).tokenHash !== owner.tokenHash) throw denied();
    return owner;
  }
  function checks(owner: Captured) {
    return [
      { statement: database.prepare(`SELECT 1 admitted FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
        CROSS JOIN (WITH observed AS MATERIALIZED (SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) now) SELECT now FROM observed) clock
        WHERE s.token_hash=? AND a.principal_id=? AND a.enabled=1 AND s.credential_revision=a.credential_revision
          AND a.credential_revision=? AND s.created_at=? AND s.revoked_at IS NULL
          AND typeof(clock.now)='integer' AND clock.now BETWEEN 0 AND 9007199254740991
          AND clock.now>=s.last_seen_at AND clock.now<s.absolute_expires_at AND clock.now<s.last_seen_at+? LIMIT 1`)
        .bind(owner.tokenHash, owner.facts.subject, owner.credentialRevision, owner.createdAt, policy.idleLifetimeMs),
        rejection: new HTTPException(401, { message: "Current local authentication is required" }) },
      { statement: database.prepare(`SELECT 1 admitted WHERE
        EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=? AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
        AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1' AND bootstrap_principal_id=? AND initialized_at=?)
        AND EXISTS(SELECT 1 FROM collaboration_control WHERE singleton=1 AND schema_version=2 AND enforcement='enabled')`)
        .bind(installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256, installation.createdAt, bootstrapPrincipalId, initializedAt), rejection: unavailable() },
      { statement: database.prepare(`SELECT 1 admitted FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id WHERE ${memberWhere} LIMIT 1`)
        .bind(owner.facts.provider, owner.facts.issuer, owner.facts.subject), rejection: denied() },
      ...([{ statement: database.prepare(`SELECT 1 admitted FROM system_recovery_maintenance WHERE singleton=1 AND state='open'
        AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
        AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='legacy')`), rejection: unavailable() }]),
    ];
  }
  function editCheck(owner: Captured, id: string) {
    return { statement: database.prepare(`SELECT 1 admitted FROM projects p JOIN collaboration_resources r ON r.root_kind='project' AND r.root_id=p.id
      JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id
      JOIN collaboration_identities i ON i.member_id=g.member_id JOIN collaboration_members m ON m.member_id=i.member_id
      WHERE p.id=? AND p.deleted_at IS NULL AND ${memberWhere} AND g.enabled=1 AND g.capability IN('edit','manage') LIMIT 1`)
      .bind(id, owner.facts.provider, owner.facts.issuer, owner.facts.subject), rejection: denied() };
  }
  async function capture(request: Request, scope: ProjectMarkdownItemLifecycleV28Scope): Promise<ProjectMarkdownItemLifecycleV28Request> {
    const { operation, projectId, itemId } = scope;
    if (!active || !isProjectApiId(projectId) || !canonicalIdentityText(projectId, 256) || request.bodyUsed
      || operation !== "remove-item" && operation !== "restore-item") throw denied();
    if (request.method !== (operation === "remove-item" ? "DELETE" : "POST") || !isProjectApiId(itemId) || !canonicalIdentityText(itemId, 256)) throw denied();
    const path = `/api/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}${operation === "restore-item" ? "/restore" : ""}`;
    const url = new URL(request.url);
    if (url.pathname !== path || [...url.searchParams.keys()].length) throw denied();
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request, subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
    const rows = (await runSqliteAdmittedBatch(database, [database.prepare(`SELECT a.credential_revision,s.created_at
      FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
      WHERE s.token_hash=? AND a.principal_id=? AND s.credential_revision=a.credential_revision AND s.revoked_at IS NULL`)
      .bind(tokenHash, facts.subject)], createSqliteBatchAdmission(database, [{
        statement: database.prepare("SELECT 1 admitted FROM collaboration_control WHERE singleton=1 AND schema_version=2 AND enforcement='enabled'"), rejection: unavailable(),
      }])))[0]!.results;
    issuer.read(request, subject);
    const row = rows[0];
    if (rows.length !== 1 || typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({ kind: "unmounted-project-markdown-item-lifecycle-v28/1" as const }) as ProjectMarkdownItemLifecycleV28Request;
    requests.set(token, Object.freeze({ request, subject, facts, operation, projectId, itemId, actor, tokenHash,
      credentialRevision: row.credential_revision, createdAt: row.created_at }));
    selected(request, token, operation); return token;
  }
  function service(request: Request, token: ProjectMarkdownItemLifecycleV28Request, operation: Captured["operation"], lifecycle: () => {
    statement: ReturnType<SqliteCapability["prepare"]>; rejection: HTTPException;
  }) {
    const owner = selected(request, token, operation);
    const guard = () => {
      selected(request, token, operation);
      return createSqliteBatchAdmission(database, [...checks(owner), editCheck(owner, owner.projectId), lifecycle()]);
    }; // SIX original core-owned guards; no cached permission or fake database.
    return createProjectItemLifecycleService({ database: () => asProjectItemLifecycleDatabase(database, guard), now: Date.now,
      async admit(actor) {
        if (actor !== owner.actor) throw denied();
        await runSqliteAdmittedBatch(database, [], guard()); selected(request, token, operation);
      } });
  }
  function itemLifecycle(owner: Captured) {
    return () => ({ statement: database.prepare(`SELECT 1 admitted FROM project_items item
      LEFT JOIN project_contents content ON content.id=item.project_content_id
      JOIN projects project ON project.id=item.project_id
      WHERE item.id=? AND item.project_id=? AND project.deleted_at IS NULL
        AND ((item.item_type='content' AND item.reference_target_id IS NULL
          AND content.project_id=item.project_id AND content.content_type='markdown'
          AND NOT EXISTS(SELECT 1 FROM project_content_attachments attachment WHERE attachment.project_content_id=content.id))
        OR (item.item_type='reference' AND item.project_content_id IS NULL AND item.reference_target_id IS NOT NULL
          AND EXISTS(SELECT 1 FROM reference_targets reference WHERE reference.id=item.reference_target_id))) LIMIT 1`)
      .bind(owner.itemId,owner.projectId), rejection: new HTTPException(404,{message:"Current metadata item not found"}) });
  }
  async function mutate(request: Request,token: ProjectMarkdownItemLifecycleV28Request,operation: Captured["operation"],value: unknown) {
    const owner=selected(request,token,operation);
    if(!isProjectItemLifecycleInput(value)) throw new HTTPException(400,{message:operation === "remove-item" ? "Invalid Project item deletion request" : "Invalid Project item restore request"});
    const input=Object.freeze({expectedItemRevision:value.expectedItemRevision,expectedContentRevision:value.expectedContentRevision,operationId:value.operationId});
    if(!isProjectItemLifecycleInput(input)) throw new HTTPException(400,{message:"Invalid Project item lifecycle request"});
    const current=service(request,token,operation,itemLifecycle(owner));
    const result=operation === "remove-item" ? await current.removeItem(owner.projectId,owner.itemId,input,owner.actor)
      : await current.restoreItem(owner.projectId,owner.itemId,input,owner.actor);
    const markdown = result.item.itemType === "content" && result.item.referenceTargetId === null && result.content?.contentType === "markdown";
    const reference = result.item.itemType === "reference" && result.item.projectContentId === null
      && result.item.referenceTargetId !== null && result.content === null;
    if(result.item.id!==owner.itemId || result.item.projectId!==owner.projectId || !markdown && !reference || result.attachment!==null) throw changed();
    selected(request,token,operation);return result;
  }
  return Object.freeze({scope:"unmounted-project-metadata-item-lifecycle-v28" as const,capture,
    removeItem(request: Request,token: ProjectMarkdownItemLifecycleV28Request,value: unknown) { return mutate(request,token,"remove-item",value); },
    restoreItem(request: Request,token: ProjectMarkdownItemLifecycleV28Request,value: unknown) { return mutate(request,token,"restore-item",value); },
    discard() { active=false; } });
}
