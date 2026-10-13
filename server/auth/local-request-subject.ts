import type { DatabaseSync } from "node:sqlite";
import type { RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { assertInstalledLocalIdentityOwner } from "./identity";
import { captureInstalledIdentityExecutionOwnerV28Candidate } from "./installed-identity-execution-owner-v28-candidate.ts";
import { localAuthenticationIdentityAuthority } from "./local-auth-http";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import type { SqliteCapability } from "../sqlite";

declare const localRequestSubjectBrand: unique symbol;
export interface LocalRequestSubject {
  readonly kind: "verified-local-request-subject/1";
  readonly [localRequestSubjectBrand]: true;
}
export class LocalRequestSubjectError extends Error {
  readonly code: "not_issued" | "authentication_required" | "unavailable";
  constructor(code: LocalRequestSubjectError["code"]) {
    super("Verified local request identity is unavailable"); this.name = "LocalRequestSubjectError"; this.code = code;
  }
}
const LOCAL_ID = /^local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
interface SessionOwner {
  readonly request: Request; readonly tokenHash: string; readonly actor: string;
  readonly credentialRevision: bigint; readonly createdAt: bigint; readonly facts: Readonly<RequestSubjectFacts>;
}

/** Identity facts only: no member, admin/resource grant, mutation token, or route
 * is supplied. The trusted composer tracks issue/read in the ORIGINAL physical
 * writer-owned operation and discards this issuer before closing/recovery/upgrade.
 * Every read checks the actual enabled account/session and actual host clock;
 * these facts cannot be cached across business/provider boundaries as rights. */
export function createLocalRequestSubjectIssuer(options: {
  database: SqliteCapability; nativeDatabase: DatabaseSync; admission: ReviewedInstallationAdmission;
  writerLease: LinuxWriterLease; authentication: object;
}) {
  const { database, nativeDatabase, admission, writerLease, authentication } = options;
  const auth = localAuthenticationIdentityAuthority(authentication);
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  // Only the actual reviewed V28 installation selects this existing privately
  // issued Native execution owner. Construction fully checks the registered
  // identity/core/native/admission tuple; no caller owner or callback is accepted.
  // Its live schema/ledger/identity guards do not cache session/member rights.
  const v28 = admission.receipt.checkpointId === "portable-runtime/v28"
    ? captureInstalledIdentityExecutionOwnerV28Candidate(auth.identity, database, nativeDatabase, admission) : undefined;
  const policy = v28 ? v28.policy : assertInstalledLocalIdentityOwner(auth.identity, database, nativeDatabase, admission);
  const installation = Object.freeze({ ...(v28 ? v28.installation : assertInstallationAdmission(nativeDatabase, admission)) });
  const initial = nativeDatabase.prepare("SELECT bootstrap_principal_id,initialized_at FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'").get();
  if (typeof initial?.bootstrap_principal_id !== "string" || !LOCAL_ID.test(initial.bootstrap_principal_id)
    || typeof initial.initialized_at !== "number" || !Number.isSafeInteger(initial.initialized_at) || initial.initialized_at < 0) {
    throw new LocalRequestSubjectError("unavailable");
  }
  const bootstrapPrincipalId = initial.bootstrap_principal_id, initializedAt = initial.initialized_at;
  const issued = new WeakMap<LocalRequestSubject, SessionOwner>(), currentRequests = new WeakMap<Request, object>();
  function validate(): void {
    try {
      assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
      if (v28) v28.assertCurrent();
      else assertInstalledLocalIdentityOwner(auth.identity, database, nativeDatabase, admission);
    } catch { throw new LocalRequestSubjectError("unavailable"); }
  }
  function persisted(tokenHash: string, actor: string) {
    // One actual SQLite wall-clock observation, within the same read snapshot as
    // every session/account/installation/sentinel predicate; no supplied clock.
    const statement = nativeDatabase.prepare(`SELECT a.principal_id,a.credential_revision,s.created_at
      FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
      CROSS JOIN (WITH observed AS MATERIALIZED (SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS now)
        SELECT now FROM observed) clock
      WHERE s.token_hash=? AND ('local-account:' || a.principal_id)=? AND a.enabled=1
        AND a.credential_revision=s.credential_revision AND s.revoked_at IS NULL
        AND typeof(clock.now)='integer' AND clock.now BETWEEN 0 AND 9007199254740991
        AND clock.now>=s.last_seen_at AND clock.now<s.absolute_expires_at AND clock.now<s.last_seen_at+?
        AND EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=?
          AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
        AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'
          AND bootstrap_principal_id=? AND initialized_at=?) LIMIT 1`);
    statement.setReadBigInts(true);
    return statement.get(tokenHash, actor, policy.idleLifetimeMs, installation.installationId, installation.catalogId,
      installation.checkpointId, installation.schemaSha256, installation.createdAt, bootstrapPrincipalId, initializedAt);
  }
  function session(request: Request, actor: string, tokenHash: string) {
    validate();
    const predicate = auth.currentSessionPredicate(request, actor);
    if (predicate.actor !== actor || predicate.tokenHash !== tokenHash) throw new LocalRequestSubjectError("authentication_required");
    const row = persisted(tokenHash, actor);
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    if (!row || typeof row.principal_id !== "string" || !LOCAL_ID.test(row.principal_id)
      || typeof row.credential_revision !== "bigint" || row.credential_revision < 1n
      || typeof row.created_at !== "bigint" || row.created_at < 0n) throw new LocalRequestSubjectError("authentication_required");
    return Object.freeze({ principalId: row.principal_id, credentialRevision: row.credential_revision, createdAt: row.created_at });
  }
  return Object.freeze({
    async issue(request: Request): Promise<LocalRequestSubject> {
      const generation = Object.freeze({}); currentRequests.set(request, generation);
      validate();
      const tokenHash = auth.captureSessionDigest(request);
      const principal = await auth.authenticateRequest(request);
      if (currentRequests.get(request) !== generation) throw new LocalRequestSubjectError("not_issued");
      const row = session(request, principal.actor, tokenHash);
      if (row.principalId !== principal.id || principal.actor !== `local-account:${row.principalId}`) {
        throw new LocalRequestSubjectError("authentication_required");
      }
      const token = Object.freeze({ kind: "verified-local-request-subject/1" as const }) as LocalRequestSubject;
      const facts = Object.freeze({ provider: "local" as const, issuer: `node-installation:${installation.installationId}`, subject: row.principalId });
      issued.set(token, Object.freeze({ request, tokenHash, actor: principal.actor,
        credentialRevision: row.credentialRevision, createdAt: row.createdAt, facts }));
      currentRequests.set(request, token);
      return token;
    },
    read(request: Request, token: LocalRequestSubject): Readonly<RequestSubjectFacts> {
      const owner = issued.get(token);
      if (!owner || owner.request !== request || currentRequests.get(request) !== token) throw new LocalRequestSubjectError("not_issued");
      const row = session(request, owner.actor, owner.tokenHash);
      if (row.principalId !== owner.facts.subject || row.credentialRevision !== owner.credentialRevision || row.createdAt !== owner.createdAt) {
        throw new LocalRequestSubjectError("authentication_required");
      }
      return owner.facts;
    },
  });
}
