import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { normalizeFabubloxImportRequestId } from "../../shared/contracts/fabublox-import";
import type { RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { acceptedImportState, FabubloxImportAcceptanceUnavailableError,
  type AcceptedFabubloxImportRow } from "../../worker/imports/fabublox-acceptance-core";
import { configurationSqlInteger } from "../../worker/runtime/configuration-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, LocalRequestSubjectError,
  type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability,
  type SqliteResult, type SqliteRow } from "../sqlite";

type Scope = Readonly<{ request: Request; url: string; requestId: string; tokenHash: string }>;
type Captured = Scope & Readonly<{
  subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>; actor: string;
  credentialRevision: bigint; sessionCreatedAt: bigint;
}>;
const unavailable = () => new HTTPException(503, { message: "Current FabuBlox request status is unavailable" });
const denied = () => new HTTPException(403, { message: "Current workspace membership and live recipe-family read permission are required" });
const memberWhere = "i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";
const acceptedReceiptSql = `
      SELECT * FROM imports WHERE actor_email = ? AND client_request_id = ?
    `;

function scopeFor(request: Request): Readonly<{ url: string; requestId: string }> {
  if (!(request instanceof Request) || request.method !== "GET" || request.bodyUsed || request.body !== null) throw denied();
  const url = new URL(request.url);
  const raw = /^\/api\/imports\/fabublox\/requests\/([^/]+)$/.exec(url.pathname)?.[1];
  const requestId = raw === undefined ? null : normalizeFabubloxImportRequestId(raw);
  if (!requestId) throw new HTTPException(400, { message: "Invalid import request identity" });
  if (url.search || url.hash) throw denied();
  return Object.freeze({ url: request.url, requestId });
}

/** Only adapt exact native SQL cells to the original accepted scalar codec.
 * No property supplies File, profile, family or session authority. */
function acceptedRow(row: SqliteRow, owner: Captured): AcceptedFabubloxImportRow {
  const text = (name: string): string => {
    const value = row[name]; if (typeof value !== "string") throw new FabubloxImportAcceptanceUnavailableError();
    return value;
  };
  const nullableText = (name: string): string | null => {
    const value = row[name]; if (value !== null && typeof value !== "string") throw new FabubloxImportAcceptanceUnavailableError();
    return value;
  };
  const integer = (name: string, minimum = 0): number => {
    try { return configurationSqlInteger(row[name], name, minimum); }
    catch { throw new FabubloxImportAcceptanceUnavailableError(); }
  };
  const oneOrNull = (name: string): 1 | null => {
    const value = row[name]; if (value === null) return null;
    if (integer(name, 1) !== 1) throw new FabubloxImportAcceptanceUnavailableError();
    return 1;
  };
  const status = row.status, requestScope = row.request_scope;
  if ((status !== "pending" && status !== "failed" && status !== "ready") || requestScope !== "system"
    || row.actor_email !== owner.actor || row.client_request_id !== owner.requestId) throw new FabubloxImportAcceptanceUnavailableError();
  return {
    id: text("id"), actor_email: owner.actor, operation_id: text("operation_id"), client_request_id: owner.requestId,
    request_sha256: text("request_sha256"), request_input_json: text("request_input_json"), request_scope: requestScope,
    storage_profile_id: nullableText("storage_profile_id"), storage_profile_revision: oneOrNull("storage_profile_revision"),
    storage_policy_revision: oneOrNull("storage_policy_revision"),
    ...(row.file_targets_protocol === undefined ? {} : { file_targets_protocol: oneOrNull("file_targets_protocol") }),
    ...(row.role_policy_revision === undefined ? {} : { role_policy_revision: row.role_policy_revision === null
      ? null : integer("role_policy_revision") }),
    status, lease_expires_at: nullableText("lease_expires_at"), accepted_result_json: nullableText("accepted_result_json"),
  };
}

/** Explicit opt-in Node scalar status only. Unlike the historical Worker GET,
 * an existing own receipt requires its CURRENT live unarchived family read
 * right. This narrows historical ready reads; it does not issue a provider,
 * File body, profile, mutation, source lease or Project-derived grant.
 * Pending status remains readable while an original POST source lease is held.
 * The host owns private/no-store/nosniff response delivery and drains these
 * original public reads before Native/core/physical-lease closure. */
export function createLocalFabubloxRequestStateV28Candidate(options: {
  database: SqliteCapability; nativeDatabase: DatabaseSync; writerLease: LinuxWriterLease;
  authentication: object; admission: ReviewedInstallationAdmission;
}) {
  if (Object.keys(options).sort().join(",") !== "admission,authentication,database,nativeDatabase,writerLease") throw unavailable();
  const { database, nativeDatabase, writerLease, authentication, admission } = options;
  const auth = localAuthenticationIdentityAuthority(authentication);
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  const policy = assertInstalledLocalIdentityOwner(auth.identity, database, nativeDatabase, admission);
  const installation = Object.freeze({ ...assertInstallationAdmission(nativeDatabase, admission) });
  if (installation.checkpointId !== "portable-runtime/v28") throw unavailable();
  const runtime = nativeDatabase.prepare(`SELECT g.incarnation FROM file_authority_control a JOIN file_authority_runtime_guard g
    ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active'`).get();
  if (typeof runtime?.incarnation !== "string" || !runtime.incarnation) throw unavailable();
  const incarnation = runtime.incarnation;
  const control = nativeDatabase.prepare("SELECT schema_version,enforcement,revision FROM collaboration_control WHERE singleton=1").get();
  if (control?.schema_version !== 2 || (control.enforcement !== "disabled" && control.enforcement !== "enabled")
    || typeof control.revision !== "number" || !Number.isSafeInteger(control.revision) || control.revision < 1) throw unavailable();
  const sentinel = nativeDatabase.prepare("SELECT bootstrap_principal_id,initialized_at FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'").get();
  if (typeof sentinel?.bootstrap_principal_id !== "string" || typeof sentinel.initialized_at !== "number"
    || !Number.isSafeInteger(sentinel.initialized_at) || sentinel.initialized_at < 0) throw unavailable();
  const bootstrapPrincipalId = sentinel.bootstrap_principal_id, initializedAt = sentinel.initialized_at;
  const localIssuer = `node-installation:${installation.installationId}`;
  const issuer = createLocalRequestSubjectIssuer({ database, nativeDatabase, admission, writerLease, authentication });
  const consumed = new WeakSet<Request>(), pending = new Set<Promise<{ status: number; body: unknown }>>();
  let accepting = true, active = true, closing: Promise<void> | undefined;
  const subjectFailure = (error: unknown): never => {
    if (error instanceof LocalRequestSubjectError) {
      if (error.code === "authentication_required") throw new HTTPException(401, { message: "Current local authentication is required" });
      if (error.code === "not_issued") throw denied();
      throw unavailable();
    }
    throw error;
  };
  function selected(owner: Captured) {
    if (!active || owner.request.url !== owner.url || owner.request.method !== "GET"
      || owner.request.bodyUsed || owner.request.body !== null || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    let facts: Readonly<RequestSubjectFacts>;
    try { facts = issuer.read(owner.request, owner.subject); } catch (error) { return subjectFailure(error); }
    if (facts.provider !== "local" || facts.issuer !== localIssuer || facts.subject !== owner.facts.subject
      || auth.currentSessionPredicate(owner.request, owner.actor).tokenHash !== owner.tokenHash) throw denied();
  }
  function checks(owner: Captured) {
    selected(owner);
    return [
      { statement: database.prepare(`SELECT 1 admitted FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
        CROSS JOIN (WITH observed AS MATERIALIZED (SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) now) SELECT now FROM observed) clock
        WHERE s.token_hash=? AND a.principal_id=? AND a.enabled=1 AND s.credential_revision=a.credential_revision
          AND a.credential_revision=? AND s.created_at=? AND s.revoked_at IS NULL
          AND typeof(clock.now)='integer' AND clock.now BETWEEN 0 AND 9007199254740991
          AND clock.now>=s.last_seen_at AND clock.now<s.absolute_expires_at AND clock.now<s.last_seen_at+? LIMIT 1`)
        .bind(owner.tokenHash, owner.facts.subject, owner.credentialRevision, owner.sessionCreatedAt, policy.idleLifetimeMs),
        rejection: new HTTPException(401, { message: "Current local authentication is required" }) },
      { statement: database.prepare(`SELECT 1 admitted WHERE
        EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=? AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
        AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1' AND bootstrap_principal_id=? AND initialized_at=?)
        AND EXISTS(SELECT 1 FROM collaboration_control WHERE singleton=1 AND schema_version=2 AND enforcement='enabled')`)
        .bind(installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256, installation.createdAt, bootstrapPrincipalId, initializedAt), rejection: unavailable() },
      { statement: database.prepare(`SELECT 1 admitted FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id WHERE ${memberWhere} LIMIT 1`)
        .bind(localIssuer, owner.facts.subject), rejection: denied() },
      { statement: database.prepare(`SELECT 1 admitted FROM system_recovery_maintenance WHERE singleton=1 AND state='open'
        AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g
          ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active' AND g.incarnation=?)`)
        .bind(incarnation), rejection: unavailable() },
      { statement: database.prepare(`SELECT 1 admitted WHERE
        NOT EXISTS(SELECT 1 FROM imports own_receipt WHERE own_receipt.actor_email=? AND own_receipt.client_request_id=?)
        OR EXISTS(SELECT 1 FROM imports own_receipt
          JOIN recipe_families rf ON rf.id=own_receipt.recipe_family_id
          JOIN collaboration_resources r ON r.root_kind='template' AND r.root_id=rf.id
          JOIN collaboration_identities i ON i.provider='local' AND i.issuer=? AND i.subject=?
          JOIN collaboration_members m ON m.member_id=i.member_id
          WHERE own_receipt.actor_email=? AND own_receipt.client_request_id=? AND rf.archived_at IS NULL
            AND i.enabled=1 AND m.state='active' AND (r.visibility='workspace' OR EXISTS(SELECT 1 FROM collaboration_grants g
              WHERE g.root_kind=r.root_kind AND g.root_id=r.root_id AND g.member_id=i.member_id
                AND g.enabled=1 AND g.capability IN('read','edit','manage'))))`)
        .bind(owner.actor, owner.requestId, localIssuer, owner.facts.subject, owner.actor, owner.requestId), rejection: denied() },
    ]; // Five current same-BEGIN predicates, within the unchanged core-eight limit.
  }
  async function perform(scope: Scope): Promise<{ status: number; body: unknown }> {
    let subject: LocalRequestSubject;
    try { subject = await issuer.issue(scope.request); } catch (error) { return subjectFailure(error); }
    let facts: Readonly<RequestSubjectFacts>;
    try { facts = issuer.read(scope.request, subject); } catch (error) { return subjectFailure(error); }
    if (facts.provider !== "local" || facts.issuer !== localIssuer) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(scope.request, actor).tokenHash !== scope.tokenHash) throw denied();
    const session = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    session.setReadBigInts(true); const row = session.get(scope.tokenHash, facts.subject);
    try { issuer.read(scope.request, subject); } catch (error) { return subjectFailure(error); }
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const owner: Captured = Object.freeze({ ...scope, subject, facts, actor,
      credentialRevision: row.credential_revision, sessionCreatedAt: row.created_at });
    const guards = checks(owner), admission = createSqliteBatchAdmission(database, guards);
    let results: SqliteResult[];
    try {
      results = await runSqliteAdmittedBatch(database,
        [database.prepare(acceptedReceiptSql).bind(owner.actor, owner.requestId)], admission);
    } catch (error) {
      // The original core retains the exact guard error after confirmed
      // rollback. Preserve those 401/403/503 denials by object identity;
      // unrelated SQL failures retain the original acceptance-unavailable map.
      if (guards.some(guard => guard.rejection === error)) throw error;
      throw new FabubloxImportAcceptanceUnavailableError();
    }
    selected(owner);
    if (results.length !== 1 || results[0]!.results.length > 1) throw new FabubloxImportAcceptanceUnavailableError();
    const accepted = results[0]!.results[0];
    if (accepted === undefined) return { status: 404, body: { error: "Import request not found" } };
    return { status: 200, body: acceptedImportState(acceptedRow(accepted, owner)) };
  }
  function read(request: Request): Promise<{ status: number; body: unknown }> {
    if (!accepting || consumed.has(request)) throw denied();
    const scope = scopeFor(request), tokenHash = auth.captureSessionDigest(request);
    consumed.add(request);
    let resolve!: (value: { status: number; body: unknown }) => void, reject!: (error: unknown) => void;
    const original = new Promise<{ status: number; body: unknown }>((yes, no) => { resolve = yes; reject = no; });
    pending.add(original);
    // Capture original Request/token facts synchronously; register its exact
    // public promise before any original authentication/SQL callback runs.
    void Promise.resolve().then(() => perform(Object.freeze({ request, ...scope, tokenHash }))).then(resolve, reject);
    void original.then(() => { pending.delete(original); }, () => { pending.delete(original); });
    return original;
  }
  function close(): Promise<void> {
    if (closing) return closing;
    accepting = false;
    closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...pending]); active = false;
    });
    return closing;
  }
  return Object.freeze({ read, close });
}
