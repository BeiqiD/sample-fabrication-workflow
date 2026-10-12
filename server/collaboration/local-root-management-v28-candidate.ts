import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import type { CollaborationCapability, CollaborationRoot } from "../../worker/collaboration/policy";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability } from "../sqlite";

declare const rootManagementBrand: unique symbol;
export interface RootManagementRequest {
  readonly kind: "unmounted-current-root-management-v28/1";
  readonly [rootManagementBrand]: true;
}
export type RootManagementScope = Readonly<
  { root: CollaborationRoot; operation: "visibility" }
  | { root: CollaborationRoot; operation: "grant"; memberId: string }
>;
export type RootManagementChange = Readonly<
  { operation: "visibility"; expectedResourceRevision: number; visibility: "workspace" | "restricted" }
  | { operation: "grant"; expectedResourceRevision: number; expectedGrantRevision: number | null; capability: CollaborationCapability; enabled: boolean }
>;
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  root: Readonly<CollaborationRoot>; operation: "visibility" | "grant"; memberId?: string;
  actor: string; tokenHash: string; credentialRevision: bigint; createdAt: bigint;
}>;
const maxRevision = 9007199254740991;
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value < maxRevision;
const unavailable = () => new HTTPException(503, { message: "Current collaboration root management is unavailable" });
const denied = () => new HTTPException(403, { message: "Current explicit root manager permission is required" });
const changed = () => new HTTPException(409, { message: "This collaboration policy changed. Reload before continuing." });
const currentMember = "i.provider=? AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";
// Fixed canonical roots, never caller-provided SQL, reference metadata or an
// actor/creator-derived grant. Business lifecycle/restore owners remain separate.
const liveRoot = `(r.root_kind='sample' AND EXISTS(SELECT 1 FROM samples s WHERE s.id=r.root_id AND s.deleted_at IS NULL))
  OR(r.root_kind='project' AND EXISTS(SELECT 1 FROM projects p WHERE p.id=r.root_id AND p.deleted_at IS NULL))
  OR(r.root_kind='template' AND EXISTS(SELECT 1 FROM recipe_families f WHERE f.id=r.root_id AND f.archived_at IS NULL))`;

/** Unmounted metadata-only owner. This does not authorize Project, Definition,
 * Execution, Comment, File bytes or global export algorithms. Current operational
 * V26 and inactive V27 cannot construct it. V28 migration/recovery remain disabled
 * until an explicit stopped activation; every actual batch rechecks that control.
 * The composer owns each ORIGINAL capture/change promise in lease.withWriter and
 * must discard this owner before connection close, recovery or metadata upgrade. */
export function createLocalRootManagementV28Candidate(options: {
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
  const requests = new WeakMap<RootManagementRequest, Captured>();
  let active = true;
  function selected(request: Request, token: RootManagementRequest): Captured {
    const owner = requests.get(token);
    if (!active || !owner || owner.request !== request || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    const facts = issuer.read(request, owner.subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || facts.subject !== owner.facts.subject
      || auth.currentSessionPredicate(request, owner.actor).tokenHash !== owner.tokenHash) throw denied();
    return owner;
  }
  function checks(owner: Captured, expectedRevision?: number) {
    // Host wall clock is sampled AFTER the real BEGIN acquired its native writer
    // lock, so blocking busy_timeout cannot extend a previously captured session.
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
      { statement: database.prepare(`SELECT 1 admitted FROM collaboration_resources r
        JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id
        JOIN collaboration_identities i ON i.member_id=g.member_id JOIN collaboration_members m ON m.member_id=i.member_id
        WHERE r.root_kind=? AND r.root_id=? AND (${liveRoot}) AND ${currentMember} AND g.enabled=1 AND g.capability='manage' LIMIT 1`)
        .bind(owner.root.kind, owner.root.id, owner.facts.provider, owner.facts.issuer, owner.facts.subject), rejection: denied() },
      { statement: database.prepare(`SELECT 1 admitted FROM system_recovery_maintenance m WHERE m.singleton=1 AND m.state='open'
        AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)`), rejection: unavailable() },
      ...(expectedRevision === undefined ? [] : [{ statement: database.prepare("SELECT 1 admitted FROM collaboration_resources WHERE root_kind=? AND root_id=? AND revision=? AND revision<9007199254740991")
        .bind(owner.root.kind, owner.root.id, expectedRevision), rejection: changed() }]),
    ];
  }
  async function capture(request: Request, scope: RootManagementScope): Promise<RootManagementRequest> {
    const { root: input, operation } = scope, { kind, id } = input;
    const memberId = operation === "grant" ? scope.memberId : undefined;
    if (!active || !["sample", "project", "template"].includes(kind) || !canonicalIdentityText(id, 256)
      || operation !== "grant" && operation !== "visibility" || operation === "grant" && !canonicalIdentityText(memberId, 256)
      || request.method !== "PUT" || request.bodyUsed) throw denied();
    const path = `/api/collaboration/resources/${kind}/${encodeURIComponent(id)}/${operation === "grant" ? `grants/${encodeURIComponent(memberId!)}` : "visibility"}`;
    if (new URL(request.url).pathname !== path) throw denied();
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request, subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash, facts.subject); issuer.read(request, subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({ kind: "unmounted-current-root-management-v28/1" as const }) as RootManagementRequest;
    requests.set(token, Object.freeze({ request, subject, facts, root: Object.freeze({ kind, id }), operation, memberId, actor, tokenHash,
      credentialRevision: row.credential_revision, createdAt: row.created_at }));
    return token;
  }
  async function change(request: Request, token: RootManagementRequest, input: RootManagementChange) {
    const owner = selected(request, token), { operation, expectedResourceRevision } = input;
    if (operation !== owner.operation || !revision(expectedResourceRevision)) throw changed();
    const admissionChecks = checks(owner, expectedResourceRevision);
    const statements = [];
    let acknowledgedGrantRevision: number | undefined;
    if (operation === "visibility") {
      const { visibility } = input;
      if (visibility !== "workspace" && visibility !== "restricted") throw denied();
      statements.push(database.prepare("UPDATE collaboration_resources SET visibility=?,revision=revision+1 WHERE root_kind=? AND root_id=? AND revision=?")
        .bind(visibility, owner.root.kind, owner.root.id, expectedResourceRevision));
    } else {
      const { expectedGrantRevision, capability, enabled } = input;
      acknowledgedGrantRevision = expectedGrantRevision === null ? 1 : expectedGrantRevision + 1;
      if (expectedGrantRevision !== null && !revision(expectedGrantRevision) || typeof enabled !== "boolean"
        || !["read", "operate", "edit", "manage"].includes(capability) || owner.root.kind !== "sample" && capability === "operate") throw denied();
      // A named target must be a currently mapped, enabled ordinary principal in
      // this actual installation. Provider/issuer/subject are never supplied by
      // JSON. Future Access enrollment needs its separately reviewed owner.
      admissionChecks.push({ statement: database.prepare(`SELECT 1 admitted FROM collaboration_members m
        JOIN collaboration_identities i ON i.member_id=m.member_id JOIN local_accounts a ON a.principal_id=i.subject
        WHERE m.member_id=? AND m.state='active' AND i.enabled=1 AND i.provider='local' AND i.issuer=? AND a.enabled=1 LIMIT 1`)
        .bind(owner.memberId!, localIssuer), rejection: denied() });
      admissionChecks.push({ statement: expectedGrantRevision === null
        ? database.prepare("SELECT 1 admitted WHERE NOT EXISTS(SELECT 1 FROM collaboration_grants WHERE root_kind=? AND root_id=? AND member_id=?)")
          .bind(owner.root.kind, owner.root.id, owner.memberId!)
        : database.prepare("SELECT 1 admitted FROM collaboration_grants WHERE root_kind=? AND root_id=? AND member_id=? AND revision=? AND revision<9007199254740991")
          .bind(owner.root.kind, owner.root.id, owner.memberId!, expectedGrantRevision), rejection: changed() });
      // Removing/demoting the last current manager is refused. An explicit
      // transfer first grants manage to a named active mapped successor, then
      // performs a separate CAS removal; no default/admin/creator successor.
      if (capability !== "manage" || !enabled) admissionChecks.push({ statement: database.prepare(`SELECT 1 admitted WHERE
        NOT EXISTS(SELECT 1 FROM collaboration_grants WHERE root_kind=? AND root_id=? AND member_id=? AND enabled=1 AND capability='manage')
        OR EXISTS(SELECT 1 FROM collaboration_grants g JOIN collaboration_members m ON m.member_id=g.member_id
          JOIN collaboration_identities i ON i.member_id=m.member_id JOIN local_accounts a ON a.principal_id=i.subject
          WHERE g.root_kind=? AND g.root_id=? AND g.member_id<>? AND g.enabled=1 AND g.capability='manage'
            AND m.state='active' AND i.enabled=1 AND i.provider='local' AND i.issuer=? AND a.enabled=1)`)
        .bind(owner.root.kind, owner.root.id, owner.memberId!, owner.root.kind, owner.root.id, owner.memberId!, localIssuer), rejection: denied() });
      statements.push(expectedGrantRevision === null
        ? database.prepare("INSERT INTO collaboration_grants(root_kind,root_id,member_id,capability,enabled,revision) VALUES(?,?,?,?,?,1)")
          .bind(owner.root.kind, owner.root.id, owner.memberId!, capability, enabled ? 1 : 0)
        : database.prepare("UPDATE collaboration_grants SET capability=?,enabled=?,revision=revision+1 WHERE root_kind=? AND root_id=? AND member_id=? AND revision=?")
          .bind(capability, enabled ? 1 : 0, owner.root.kind, owner.root.id, owner.memberId!, expectedGrantRevision));
      statements.push(database.prepare("UPDATE collaboration_resources SET revision=revision+1 WHERE root_kind=? AND root_id=? AND revision=?")
        .bind(owner.root.kind, owner.root.id, expectedResourceRevision));
    }
    selected(request, token);
    const results = await runSqliteAdmittedBatch(database, statements, createSqliteBatchAdmission(database, admissionChecks));
    if (results.some(result => result.meta.directChanges !== 1)) throw new Error("Original root policy commit acknowledgement is unavailable");
    // Recheck current rights for the ACK; never undo an accepted transaction on
    // late departure/revocation or pretend a lost ACK erased committed rows.
    selected(request, token);
    await runSqliteAdmittedBatch(database, [], createSqliteBatchAdmission(database, checks(owner)));
    return Object.freeze({ root: owner.root, resourceRevision: expectedResourceRevision + 1,
      ...(operation === "grant" ? { memberId: owner.memberId!, grantRevision: acknowledgedGrantRevision! } : {}) });
  }
  return Object.freeze({ scope: "unmounted-root-management-only-v28" as const, capture, change, discard() { active = false; } });
}
