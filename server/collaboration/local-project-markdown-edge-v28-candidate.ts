import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { isProjectApiId, isCreateProjectEdgeInput, isUpdateProjectEdgeInput, isProjectEdgeLifecycleInput } from "../../shared/project-api";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { createProjectEdgeService } from "../../worker/projects/edge-service";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { asProjectEdgeDatabase } from "../project-edge-sql";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability } from "../sqlite";

declare const projectMarkdownEdgeBrand: unique symbol;
export interface ProjectMarkdownEdgeV28Request {
  readonly kind: "unmounted-project-markdown-edge-v28/1";
  readonly [projectMarkdownEdgeBrand]: true;
}
export type ProjectMarkdownEdgeV28Scope = Readonly<{ operation: "create-edge" | "update-edge" | "remove-edge" | "restore-edge"; projectId: string; edgeId?: string }>;
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  operation: ProjectMarkdownEdgeV28Scope["operation"]; projectId: string; edgeId?: string; actor: string;
  tokenHash: string; credentialRevision: bigint; createdAt: bigint;
}>;
const unavailable = () => new HTTPException(503, { message: "Current Markdown edge operations are unavailable" });
const denied = () => new HTTPException(403, { message: "Current explicit Project edit permission is required" });
const changed = () => new HTTPException(409, { message: "Markdown edge identity changed. Reload before continuing." });
const memberWhere = "i.provider=? AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";

/** Bounded same-Project Markdown endpoints only; exact original edge algorithms.
 * Every original read/mutation/replay/settlement/final ACK consumes current
 * genuine Request/session/member, destination edit and actual endpoint subtype
 * checks in that same BEGIN. Reference/attachment edges remain unavailable.
 * The original SQL/triggers own active endpoint rules, revisions and deletion.
 * The host retains original work and discards this issuer before its parents. */
export function createLocalProjectMarkdownEdgeV28Candidate(options: {
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
  const requests = new WeakMap<ProjectMarkdownEdgeV28Request, Captured>(); let active = true;
  function selected(request: Request, token: ProjectMarkdownEdgeV28Request, operation: Captured["operation"]): Captured {
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
  async function capture(request: Request, scope: ProjectMarkdownEdgeV28Scope): Promise<ProjectMarkdownEdgeV28Request> {
    const { operation, projectId, edgeId } = scope;
    if (!active || !isProjectApiId(projectId) || !canonicalIdentityText(projectId,256) || request.bodyUsed
      || !["create-edge","update-edge","remove-edge","restore-edge"].includes(operation)) throw denied();
    const method=operation === "create-edge" || operation === "restore-edge" ? "POST" : operation === "update-edge" ? "PATCH" : "DELETE";
    if(request.method !== method || (operation === "create-edge" ? edgeId !== undefined
      : !isProjectApiId(edgeId) || !canonicalIdentityText(edgeId,256))) throw denied();
    const path=`/api/projects/${encodeURIComponent(projectId)}/edges${operation === "create-edge" ? "" : `/${encodeURIComponent(edgeId!)}`}${operation === "restore-edge" ? "/restore" : ""}`;
    const url=new URL(request.url);
    if(url.pathname !== path || [...url.searchParams.keys()].length) throw denied();
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
    const token = Object.freeze({ kind: "unmounted-project-markdown-edge-v28/1" as const }) as ProjectMarkdownEdgeV28Request;
    requests.set(token, Object.freeze({ request, subject, facts, operation, projectId, edgeId, actor, tokenHash,
      credentialRevision: row.credential_revision, createdAt: row.created_at }));
    selected(request, token, operation); return token;
  }
  function service(request: Request, token: ProjectMarkdownEdgeV28Request, operation: Captured["operation"], lifecycle: () => {
    statement: ReturnType<SqliteCapability["prepare"]>; rejection: HTTPException;
  }) {
    const owner = selected(request, token, operation);
    const guard = () => {
      selected(request, token, operation);
      return createSqliteBatchAdmission(database, [...checks(owner), editCheck(owner, owner.projectId), lifecycle()]);
    }; // SIX original core-owned guards; no cached permission or fake database.
    return createProjectEdgeService({ database: () => asProjectEdgeDatabase(database, guard), now: Date.now,
      async admit(actor) {
        if (actor !== owner.actor) throw denied();
        await runSqliteAdmittedBatch(database, [], guard()); selected(request, token, operation);
      } });
  }
  function endpointCheck(owner: Captured, sourceId?: string, targetId?: string) {
    // Current existing edge and an optional reconnect/create pair are checked
    // together, before any original read/result. IDs never supply authority.
    const markdownPair=`source.project_id=? AND target.project_id=source.project_id
      AND source.item_type='content' AND target.item_type='content'
      AND source.reference_target_id IS NULL AND target.reference_target_id IS NULL
      AND sc.project_id=source.project_id AND tc.project_id=target.project_id
      AND sc.content_type='markdown' AND tc.content_type='markdown'
      AND NOT EXISTS(SELECT 1 FROM project_content_attachments a WHERE a.project_content_id IN(sc.id,tc.id))`;
    const pairs=`SELECT 1 FROM project_items source JOIN project_items target ON target.id=?
      JOIN project_contents sc ON sc.id=source.project_content_id JOIN project_contents tc ON tc.id=target.project_content_id
      WHERE source.id=? AND ${markdownPair}`;
    const hasDesired=sourceId !== undefined && targetId !== undefined;
    const statement=owner.operation === "create-edge"
      ? database.prepare(`SELECT 1 admitted WHERE EXISTS(${pairs})`).bind(targetId!,sourceId!,owner.projectId)
      : database.prepare(`SELECT 1 admitted WHERE EXISTS(SELECT 1 FROM project_edges edge
          JOIN project_items source ON source.id=edge.source_item_id JOIN project_items target ON target.id=edge.target_item_id
          JOIN project_contents sc ON sc.id=source.project_content_id JOIN project_contents tc ON tc.id=target.project_content_id
          WHERE edge.id=? AND edge.project_id=? AND ${markdownPair}) AND (?=0 OR EXISTS(${pairs}))`)
        .bind(owner.edgeId!,owner.projectId,owner.projectId,hasDesired?1:0,targetId??"",sourceId??"",owner.projectId);
    return () => ({statement,rejection:new HTTPException(404,{message:"Current same-Project Markdown edge endpoints not found"})});
  }
  function snapshot(value: unknown,operation: Captured["operation"]) {
    if(operation === "create-edge") {
      if(!isCreateProjectEdgeInput(value)) throw new HTTPException(400,{message:"Invalid Project edge creation request"});
      const input=Object.freeze({edgeId:value.edgeId,sourceItemId:value.sourceItemId,targetItemId:value.targetItemId,
        sourceHandle:value.sourceHandle,targetHandle:value.targetHandle,markerStart:value.markerStart,markerEnd:value.markerEnd,
        label:value.label,expectedSourceItemRevision:value.expectedSourceItemRevision,expectedTargetItemRevision:value.expectedTargetItemRevision,operationId:value.operationId});
      if(!isCreateProjectEdgeInput(input)) throw new HTTPException(400,{message:"Invalid Project edge creation request"});return input;
    }
    if(operation === "update-edge") {
      if(!isUpdateProjectEdgeInput(value)) throw new HTTPException(400,{message:"Invalid Project edge update request"});
      const input=Object.freeze({sourceItemId:value.sourceItemId,targetItemId:value.targetItemId,sourceHandle:value.sourceHandle,targetHandle:value.targetHandle,
        markerStart:value.markerStart,markerEnd:value.markerEnd,label:value.label,expectedRevision:value.expectedRevision,
        expectedSourceItemRevision:value.expectedSourceItemRevision,expectedTargetItemRevision:value.expectedTargetItemRevision,operationId:value.operationId});
      if(!isUpdateProjectEdgeInput(input)) throw new HTTPException(400,{message:"Invalid Project edge update request"});return input;
    }
    if(!isProjectEdgeLifecycleInput(value)) throw new HTTPException(400,{message:"Invalid Project edge lifecycle request"});
    const input=Object.freeze({expectedRevision:value.expectedRevision,operationId:value.operationId});
    if(!isProjectEdgeLifecycleInput(input)) throw new HTTPException(400,{message:"Invalid Project edge lifecycle request"});return input;
  }
  function prepared(request:Request,token:ProjectMarkdownEdgeV28Request,operation:Captured["operation"],value:unknown) {
    const owner=selected(request,token,operation),input=snapshot(value,operation);
    const desired="sourceItemId" in input ? input : undefined;
    return {owner,input,current:service(request,token,operation,endpointCheck(owner,desired?.sourceItemId,desired?.targetItemId))};
  }
  async function mutate(request:Request,token:ProjectMarkdownEdgeV28Request,operation:Captured["operation"],value:unknown) {
    const {owner,input,current}=prepared(request,token,operation,value);
    const result=operation === "create-edge" ? await current.create(owner.projectId,input,owner.actor)
      : operation === "update-edge" ? await current.update(owner.projectId,owner.edgeId!,input,owner.actor)
      : operation === "remove-edge" ? await current.remove(owner.projectId,owner.edgeId!,input,owner.actor)
      : await current.restore(owner.projectId,owner.edgeId!,input,owner.actor);
    if(result.value.projectId !== owner.projectId || result.value.id !== (owner.edgeId ?? ("edgeId" in input ? input.edgeId : undefined))) throw changed();
    selected(request,token,operation);return result;
  }

  return Object.freeze({scope:"unmounted-project-markdown-edges-only-v28" as const,capture,
    create(request:Request,token:ProjectMarkdownEdgeV28Request,value:unknown){return mutate(request,token,"create-edge",value);},
    update(request:Request,token:ProjectMarkdownEdgeV28Request,value:unknown){return mutate(request,token,"update-edge",value);},
    remove(request:Request,token:ProjectMarkdownEdgeV28Request,value:unknown){return mutate(request,token,"remove-edge",value);},
    restore(request:Request,token:ProjectMarkdownEdgeV28Request,value:unknown){return mutate(request,token,"restore-edge",value);},
    creationSettlement(request:Request,token:ProjectMarkdownEdgeV28Request,value:unknown){
      const {owner,input,current}=prepared(request,token,"create-edge",value);
      return current.creationSettlement(owner.projectId,input,owner.actor);
    },
    discard(){active=false;}});
}
