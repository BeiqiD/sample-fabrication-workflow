import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { isProjectApiId, isCreateMarkdownProjectItemInput, isUpdateProjectMarkdownInput } from "../../shared/project-api";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { createProjectWorkspaceService } from "../../worker/projects/workspace-service";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { asProjectWorkspaceDatabase } from "../project-workspace-sql";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability } from "../sqlite";

declare const projectMarkdownBrand: unique symbol;
export interface ProjectMarkdownV28Request {
  readonly kind: "unmounted-project-markdown-mutation-v28/1";
  readonly [projectMarkdownBrand]: true;
}
export type ProjectMarkdownV28Scope = Readonly<
  { operation: "create-markdown"; projectId: string; contentId?: never }
  | { operation: "update-markdown"; projectId: string; contentId: string }
>;
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  operation: ProjectMarkdownV28Scope["operation"]; projectId: string; contentId?: string; actor: string;
  tokenHash: string; credentialRevision: bigint; createdAt: bigint;
}>;
const unavailable = () => new HTTPException(503, { message: "Current Project Markdown mutations are unavailable" });
const denied = () => new HTTPException(403, { message: "Current explicit Project edit permission is required" });
const changed = () => new HTTPException(409, { message: "Project Markdown identity or lifecycle changed. Reload before continuing." });
const memberWhere = "i.provider=? AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";

/** Private original-Request destination Project edit owner only. Complete mature
 * Markdown algorithms and closed SQL run on their existing same-core native
 * adapter. Every original read, replay, mutation and final ACK performs fresh
 * identity/control/member/maintenance/destination/lifecycle guards in BEGIN.
 * Neither Sample rights, creation flags, actor/creator, administrator or File
 * grants provide authority. The enclosing composer retains each ORIGINAL work
 * promise and discards this issuer before native/physical parent closure. */
export function createLocalProjectMarkdownPermissionV28Candidate(options: {
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
  const requests = new WeakMap<ProjectMarkdownV28Request, Captured>(); let active = true;
  function selected(request: Request, token: ProjectMarkdownV28Request, operation: Captured["operation"]): Captured {
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
  async function capture(request: Request, scope: ProjectMarkdownV28Scope): Promise<ProjectMarkdownV28Request> {
    const { operation, projectId, contentId } = scope;
    if (!active || !isProjectApiId(projectId) || !canonicalIdentityText(projectId, 256) || request.bodyUsed
      || (operation !== "create-markdown" && operation !== "update-markdown")) throw denied();
    const method = operation === "create-markdown" ? "POST" : "PATCH";
    if (request.method !== method || (operation === "create-markdown" ? contentId !== undefined
      : !isProjectApiId(contentId) || !canonicalIdentityText(contentId, 256))) throw denied();
    const path = operation === "create-markdown" ? `/api/projects/${encodeURIComponent(projectId)}/items/markdown`
      : `/api/projects/${encodeURIComponent(projectId)}/contents/${encodeURIComponent(contentId!)}/markdown`;
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
    const token = Object.freeze({ kind: "unmounted-project-markdown-mutation-v28/1" as const }) as ProjectMarkdownV28Request;
    requests.set(token, Object.freeze({ request, subject, facts, operation, projectId, contentId, actor, tokenHash,
      credentialRevision: row.credential_revision, createdAt: row.created_at }));
    selected(request, token, operation); return token;
  }
  function service(request: Request, token: ProjectMarkdownV28Request, operation: Captured["operation"], lifecycle: () => {
    statement: ReturnType<SqliteCapability["prepare"]>; rejection: HTTPException;
  }) {
    const owner = selected(request, token, operation);
    const guard = () => {
      selected(request, token, operation);
      return createSqliteBatchAdmission(database, [...checks(owner), editCheck(owner, owner.projectId), lifecycle()]);
    }; // SIX original core-owned guards; no cached permission or fake database.
    return createProjectWorkspaceService({ database: () => asProjectWorkspaceDatabase(database, guard), now: Date.now,
      async admit(actor) {
        if (actor !== owner.actor) throw denied();
        await runSqliteAdmittedBatch(database, [], guard()); selected(request, token, operation);
      } });
  }
  function createInput(value: unknown) {
    if (!isCreateMarkdownProjectItemInput(value)) throw new HTTPException(400, { message: "Invalid Project Markdown creation request" });
    const input = Object.freeze({ contentId: value.contentId, itemId: value.itemId, placementId: value.placementId,
      markdownSource: value.markdownSource, expectedProjectRevision: value.expectedProjectRevision, operationId: value.operationId,
      geometry: Object.freeze({ x: value.geometry.x, y: value.geometry.y, width: value.geometry.width,
        height: value.geometry.height, zIndex: value.geometry.zIndex }) });
    if (!isCreateMarkdownProjectItemInput(input)) throw new HTTPException(400, { message: "Invalid Project Markdown creation request" });
    return input;
  }
  function createLifecycle(owner: Captured, input: ReturnType<typeof createInput>) {
    return () => ({ statement: database.prepare(`SELECT 1 admitted WHERE
      NOT EXISTS(SELECT 1 FROM project_items WHERE id=?) OR EXISTS(
        SELECT 1 FROM project_items item JOIN project_contents content ON content.id=item.project_content_id
        JOIN project_map_placements placement ON placement.project_item_id=item.id
        WHERE item.id=? AND item.project_id=? AND item.item_type='content' AND item.reference_target_id IS NULL
          AND item.deleted_at IS NULL AND content.id=? AND content.project_id=item.project_id
          AND content.content_type='markdown' AND content.deleted_at IS NULL AND placement.id=?
          AND NOT EXISTS(SELECT 1 FROM project_content_attachments attachment WHERE attachment.project_content_id=content.id))`)
      .bind(input.itemId, input.itemId, owner.projectId, input.contentId, input.placementId), rejection: changed() });
  }
  async function createMarkdown(request: Request, token: ProjectMarkdownV28Request, value: unknown) {
    const owner = selected(request, token, "create-markdown"), input = createInput(value);
    const result = await service(request, token, "create-markdown", createLifecycle(owner, input)).createMarkdown(owner.projectId, input, owner.actor);
    // The mature create/replay result may expose only the actual requested
    // Markdown bundle, never an attachment/reference from an identity collision.
    if (result.project.id !== owner.projectId || result.item.id !== input.itemId || result.item.projectId !== owner.projectId
      || result.item.itemType !== "content" || result.item.projectContentId !== input.contentId || result.item.referenceTargetId !== null
      || result.content?.id !== input.contentId || result.content.projectId !== owner.projectId || result.content.contentType !== "markdown"
      || result.attachment !== null || result.placement.id !== input.placementId || result.placement.projectItemId !== input.itemId) throw changed();
    selected(request, token, "create-markdown"); return result;
  }
  async function creationSettlement(request: Request, token: ProjectMarkdownV28Request, value: unknown) {
    const owner = selected(request, token, "create-markdown"), input = createInput(value);
    return service(request, token, "create-markdown", createLifecycle(owner, input)).creationSettlement(owner.projectId, input, owner.actor);
  }
  async function updateMarkdown(request: Request, token: ProjectMarkdownV28Request, value: unknown) {
    const owner = selected(request, token, "update-markdown");
    if (!isUpdateProjectMarkdownInput(value)) throw new HTTPException(400, { message: "Invalid Project Markdown update request" });
    const input = Object.freeze({ markdownSource: value.markdownSource, expectedRevision: value.expectedRevision, operationId: value.operationId });
    if (!isUpdateProjectMarkdownInput(input)) throw new HTTPException(400, { message: "Invalid Project Markdown update request" });
    const lifecycle = () => ({ statement: database.prepare(`SELECT 1 admitted FROM project_contents content
      JOIN projects project ON project.id=content.project_id WHERE content.id=? AND content.project_id=?
        AND project.deleted_at IS NULL AND content.content_type='markdown' AND content.deleted_at IS NULL LIMIT 1`)
      .bind(owner.contentId!, owner.projectId), rejection: new HTTPException(404, { message: "Project Markdown content not found" }) });
    const result = await service(request, token, "update-markdown", lifecycle).updateMarkdown(owner.projectId, owner.contentId!, input, owner.actor);
    if (result.value.id !== owner.contentId || result.value.projectId !== owner.projectId || result.value.contentType !== "markdown") throw changed();
    selected(request, token, "update-markdown"); return result;
  }
  return Object.freeze({ scope: "unmounted-project-markdown-create-update-only-v28" as const,
    capture, createMarkdown, updateMarkdown, creationSettlement, discard() { active = false; } });
}
