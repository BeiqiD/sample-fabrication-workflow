import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { configurationSqlInteger } from "../../worker/runtime/configuration-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteRow } from "../sqlite";

declare const membershipRequestBrand: unique symbol;
export interface MembershipManagementRequest {
  readonly kind: "unmounted-current-membership-management-v28/1";
  readonly [membershipRequestBrand]: true;
}
export type MembershipState = "active" | "suspended" | "left";
export type MembershipManagementScope = Readonly<
  { operation: "roster"; memberId?: never } | { operation: "state"; memberId: string }
>;
export interface MembershipStateChange {
  readonly expectedRevision: number;
  readonly expectedState: MembershipState;
  readonly state: MembershipState;
}
export interface ManagedMembership {
  readonly memberId: string; readonly displayName: string; readonly state: MembershipState;
  readonly workspaceRole: "member" | "membershipAdministrator"; readonly revision: number;
  readonly canCreateSamples: boolean; readonly canCreateProjects: boolean; readonly canCreateTemplates: boolean;
}
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  operation: "roster" | "state"; memberId?: string; actor: string;
  tokenHash: string; credentialRevision: bigint; createdAt: bigint;
}>;
const unavailable = () => new HTTPException(503, { message: "Current membership management is unavailable" });
const denied = () => new HTTPException(403, { message: "Current explicit membership administrator permission is required" });
const changed = () => new HTTPException(409, { message: "This membership changed. Reload before continuing." });
const mapped = "i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";
const columns = "member_id,display_name,state,workspace_role,can_create_samples,can_create_projects,can_create_templates,revision";
function metadata(row: SqliteRow): Readonly<ManagedMembership> {
  if (!canonicalIdentityText(row.member_id, 36) || typeof row.member_id !== "string" || row.member_id.length !== 36
    || !canonicalIdentityText(row.display_name, 200) || typeof row.display_name !== "string"
    || row.state !== "active" && row.state !== "suspended" && row.state !== "left"
    || row.workspace_role !== "member" && row.workspace_role !== "membershipAdministrator") throw unavailable();
  const flag = (value: unknown) => {
    const number = configurationSqlInteger(value, "membership.creationFlag"); if (number > 1) throw unavailable(); return number === 1;
  };
  return Object.freeze({ memberId: row.member_id, displayName: row.display_name, state: row.state, workspaceRole: row.workspace_role,
    canCreateSamples: flag(row.can_create_samples), canCreateProjects: flag(row.can_create_projects),
    canCreateTemplates: flag(row.can_create_templates), revision: configurationSqlInteger(row.revision, "membership.revision", 1) });
}
function sameRows(a: readonly SqliteRow[], b: readonly SqliteRow[]) {
  return a.length === b.length && a.every((row, index) => {
    const other = b[index]!, keys = Object.keys(row).sort();
    return keys.join("\0") === Object.keys(other).sort().join("\0") && keys.every(key => Object.is(row[key], other[key]));
  });
}

/** Unmounted roster/state owner only. The genuine membershipAdministrator role
 * authorizes this metadata; system administration and resource/Sample grants do
 * not. Local mapping reconciliation, roles, create flags and first enrollment
 * remain separate stopped owners. The composer retains each ORIGINAL operation
 * in the physical lease and discards this owner only after original work drains. */
export function createLocalMembershipManagementV28Candidate(options: {
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
  if (control?.schema_version !== 2 || control.enforcement !== "disabled" && control.enforcement !== "enabled"
    || typeof control.revision !== "number" || !Number.isSafeInteger(control.revision) || control.revision < 1) throw unavailable();
  const sentinel = nativeDatabase.prepare("SELECT bootstrap_principal_id,initialized_at FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'").get();
  if (typeof sentinel?.bootstrap_principal_id !== "string" || typeof sentinel.initialized_at !== "number"
    || !Number.isSafeInteger(sentinel.initialized_at) || sentinel.initialized_at < 0) throw unavailable();
  const bootstrapPrincipalId = sentinel.bootstrap_principal_id, initializedAt = sentinel.initialized_at;
  const localIssuer = `node-installation:${installation.installationId}`;
  const issuer = createLocalRequestSubjectIssuer({ database, nativeDatabase, admission, writerLease, authentication });
  const requests = new WeakMap<MembershipManagementRequest, Captured>(); let active = true;
  function selected(request: Request, token: MembershipManagementRequest, operation: Captured["operation"]): Captured {
    const owner = requests.get(token);
    if (!active || !owner || owner.request !== request || owner.operation !== operation
      || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    const facts = issuer.read(request, owner.subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || facts.subject !== owner.facts.subject
      || auth.currentSessionPredicate(request, owner.actor).tokenHash !== owner.tokenHash) throw denied();
    return owner;
  }
  function checks(owner: Captured, write: boolean) {
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
      { statement: database.prepare(`SELECT 1 admitted FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
        WHERE ${mapped} AND m.workspace_role='membershipAdministrator' LIMIT 1`).bind(localIssuer, owner.facts.subject), rejection: denied() },
      ...(write ? [{ statement: database.prepare(`SELECT 1 admitted FROM system_recovery_maintenance WHERE singleton=1 AND state='open'
        AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)`), rejection: unavailable() }] : []),
    ];
  }
  async function capture(request: Request, scope: MembershipManagementScope): Promise<MembershipManagementRequest> {
    const { operation, memberId } = scope;
    if (!active || request.bodyUsed || operation !== "roster" && operation !== "state"
      || request.method !== (operation === "roster" ? "GET" : "PUT")
      || (operation === "state" ? !canonicalIdentityText(memberId, 36) || memberId.length !== 36 : memberId !== undefined)) throw denied();
    const url = new URL(request.url), path = operation === "roster" ? "/api/collaboration/members"
      : `/api/collaboration/members/${encodeURIComponent(memberId!)}/state`;
    if (url.pathname !== path || [...url.searchParams.keys()].length) throw denied();
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request, subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash, facts.subject); issuer.read(request, subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({ kind: "unmounted-current-membership-management-v28/1" as const }) as MembershipManagementRequest;
    requests.set(token, Object.freeze({ request, subject, facts, operation, memberId, actor, tokenHash,
      credentialRevision: row.credential_revision, createdAt: row.created_at })); return token;
  }
  async function roster(request: Request, token: MembershipManagementRequest): Promise<readonly Readonly<ManagedMembership>[]> {
    const owner = selected(request, token, "roster"), statement = database.prepare(`SELECT ${columns} FROM collaboration_members ORDER BY display_name,member_id LIMIT 257`);
    const read = async () => { selected(request, token, "roster");
      return (await runSqliteAdmittedBatch(database, [statement], createSqliteBatchAdmission(database, checks(owner, false))))[0]!.results; };
    const rows = await read(); if (rows.length > 256) throw unavailable();
    if (!sameRows(rows, await read())) throw changed(); selected(request, token, "roster");
    return Object.freeze(rows.map(metadata)); // No subject/email/session/provider secrets.
  }
  async function changeState(request: Request, token: MembershipManagementRequest, input: MembershipStateChange): Promise<Readonly<ManagedMembership>> {
    const owner = selected(request, token, "state"), { expectedRevision, expectedState, state } = input;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER
      || !["active", "suspended", "left"].includes(expectedState) || !["active", "suspended", "left"].includes(state)
      || expectedState === state || expectedState === "left" && state !== "active")
      throw new HTTPException(400, { message: "An explicit member-state transition and current revision are required" });
    const memberId = owner.memberId!, admissionChecks = checks(owner, true);
    admissionChecks.push({ statement: database.prepare(`SELECT 1 admitted FROM collaboration_members m
      JOIN collaboration_identities i ON i.member_id=m.member_id JOIN local_accounts a ON a.principal_id=i.subject
      WHERE m.member_id=? AND i.provider='local' AND i.issuer=? AND i.enabled=1 AND a.enabled=1 LIMIT 1`)
      .bind(memberId, localIssuer), rejection: denied() });
    admissionChecks.push({ statement: database.prepare("SELECT 1 admitted FROM collaboration_members WHERE member_id=? AND revision=? AND state=? AND revision<9007199254740991")
      .bind(memberId, expectedRevision, expectedState), rejection: changed() });
    if (state !== "active") admissionChecks.push({ statement: database.prepare(`SELECT 1 admitted WHERE
      (NOT EXISTS(SELECT 1 FROM collaboration_members WHERE member_id=? AND state='active' AND workspace_role='membershipAdministrator')
        OR EXISTS(SELECT 1 FROM collaboration_members successor JOIN collaboration_identities i ON i.member_id=successor.member_id
          JOIN local_accounts a ON a.principal_id=i.subject WHERE successor.member_id<>? AND successor.state='active'
            AND successor.workspace_role='membershipAdministrator' AND i.provider='local' AND i.issuer=? AND i.enabled=1 AND a.enabled=1))
      AND NOT EXISTS(SELECT 1 FROM collaboration_grants owned WHERE owned.member_id=? AND owned.enabled=1 AND owned.capability='manage'
        AND NOT EXISTS(SELECT 1 FROM collaboration_grants successor JOIN collaboration_members m ON m.member_id=successor.member_id
          JOIN collaboration_identities i ON i.member_id=m.member_id JOIN local_accounts a ON a.principal_id=i.subject
          WHERE successor.root_kind=owned.root_kind AND successor.root_id=owned.root_id AND successor.member_id<>?
            AND successor.enabled=1 AND successor.capability='manage' AND m.state='active' AND i.provider='local'
            AND i.issuer=? AND i.enabled=1 AND a.enabled=1))
      ${state === "left" ? "AND NOT EXISTS(SELECT 1 FROM collaboration_grants WHERE member_id=? AND enabled=1 AND revision=9007199254740991)" : ""}`)
      .bind(memberId, memberId, localIssuer, memberId, memberId, localIssuer, ...(state === "left" ? [memberId] : [])), rejection: denied() });
    // At most SEVEN same-core checks; the actual bounded core maximum stays8.
    selected(request, token, "state");
    const result = await runSqliteAdmittedBatch(database, [database.prepare("UPDATE collaboration_members SET state=?,revision=revision+1 WHERE member_id=? AND revision=? AND state=?")
      .bind(state, memberId, expectedRevision, expectedState)], createSqliteBatchAdmission(database, admissionChecks));
    if (result.length !== 1 || result[0]!.meta.directChanges !== 1) throw unavailable();
    // Frozen departure trigger disables all positive grants on left; rejoin
    // changes no grant/map/resource key or revision. Accepted history remains if
    // the original actor loses rights before this separate current ACK boundary.
    selected(request, token, "state");
    const rows = (await runSqliteAdmittedBatch(database, [database.prepare(`SELECT ${columns} FROM collaboration_members WHERE member_id=?`).bind(memberId)],
      createSqliteBatchAdmission(database, checks(owner, false))))[0]!.results;
    selected(request, token, "state");
    if (rows.length !== 1 || rows[0]!.state !== state || rows[0]!.revision !== BigInt(expectedRevision + 1)) throw changed();
    return metadata(rows[0]!);
  }
  return Object.freeze({ scope: "unmounted-roster-member-state-only-v28" as const, capture, roster, changeState, discard() { active = false; } });
}
