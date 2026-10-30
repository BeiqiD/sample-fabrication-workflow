import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { type ProjectListResponse } from "../../shared/project-api";
import { projectCreationSubject } from "../../shared/project-creation-subject";
import { type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { projectReadProjectRow } from "../../worker/projects/read-decoding";
import { serializeProject } from "../../worker/projects/serializers";
import { configurationSqlRow } from "../../worker/runtime/configuration-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteRow } from "../sqlite";

declare const projectDirectoryBrand: unique symbol;
export interface ProjectDirectoryV28Request {
  readonly kind: "unmounted-project-visible-directory-v28/1";
  readonly [projectDirectoryBrand]: true;
}
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  operation: "directory"; includeDeleted: boolean; actor: string;
  tokenHash: string; credentialRevision: bigint; createdAt: bigint;
}>;
const unavailable = () => new HTTPException(503, { message: "Current Project collaboration permissions are unavailable" });
const denied = () => new HTTPException(403, { message: "Current explicit Project permission is required" });
const memberWhere = "i.provider=? AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";
function sameRows(left: readonly SqliteRow[], right: readonly SqliteRow[]) {
  return left.length === right.length && left.every((row, index) => {
    const other = right[index]!, keys = Object.keys(row).sort();
    return keys.join("\0") === Object.keys(other).sort().join("\0") && keys.every(key => {
      const a = row[key], b = other[key];
      return a instanceof Uint8Array ? b instanceof Uint8Array && a.length === b.length && a.every((v, i) => v === b[i]) : Object.is(a, b);
    });
  });
}

/** Exact original GET directory, including original includeDeleted query.
 * Actual current root read filtering precedes all row/label/order projection.
 * Same actual rows and current permissions are read again before ACK. This
 * owner grants no snapshot/source, edit/restore, creation or File capability. */
export function createLocalProjectDirectoryV28Candidate(options: {
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
  const realm = Object.freeze({ authenticationFamily: "node-local" as const, installationContext: installation.installationId });
  const localIssuer = `node-installation:${installation.installationId}`;
  const issuer = createLocalRequestSubjectIssuer({ database, nativeDatabase, admission, writerLease, authentication });
  const requests = new WeakMap<ProjectDirectoryV28Request, Captured>(); let active = true;
  function selected(request: Request, token: ProjectDirectoryV28Request, operation: Captured["operation"]): Captured {
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

    ];
  }
  async function capture(request:Request):Promise<ProjectDirectoryV28Request>{
    if(!active || request.method !== "GET" || request.bodyUsed)throw denied();
    const url=new URL(request.url),keys=[...url.searchParams.keys()],query=url.searchParams.get("includeDeleted");
    if(url.pathname!=="/api/projects" || keys.some(key=>key!=="includeDeleted") || keys.length>1
      || query!==null && query!=="0" && query!=="1")throw new HTTPException(400,{message:"Only the original Project includeDeleted query is supported"});
    const operation="directory" as const,includeDeleted=query==="1";
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request, subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash, facts.subject); issuer.read(request, subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({ kind: "unmounted-project-visible-directory-v28/1" as const }) as ProjectDirectoryV28Request;
    requests.set(token, Object.freeze({ request, subject, facts, operation, includeDeleted, actor, tokenHash,
      credentialRevision: row.credential_revision, createdAt: row.created_at })); return token;
  }
  async function directory(request: Request, token: ProjectDirectoryV28Request): Promise<{ value: ProjectListResponse; creationSubject: string }> {
    const owner = selected(request, token, "directory");
    const sql = database.prepare(`SELECT p.* FROM projects p WHERE (?=1 OR p.deleted_at IS NULL) AND EXISTS(
      SELECT 1 FROM collaboration_resources r JOIN collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
      WHERE r.root_kind='project' AND r.root_id=p.id AND ${memberWhere} AND (r.visibility='workspace'
        OR EXISTS(SELECT 1 FROM collaboration_grants g WHERE g.root_kind=r.root_kind AND g.root_id=r.root_id
          AND g.member_id=m.member_id AND g.enabled=1 AND g.capability IN('read','edit','manage'))))
      ORDER BY (p.deleted_at IS NOT NULL),p.updated_at DESC,p.id`).bind(owner.includeDeleted?1:0,owner.facts.provider, owner.facts.issuer, owner.facts.subject);
    const read = async () => { selected(request, token, "directory");
      return (await runSqliteAdmittedBatch(database, [sql], createSqliteBatchAdmission(database, checks(owner))))[0]!.results; };
    const rows = await read(), witness = await projectCreationSubject(owner.actor, realm);
    if (!sameRows(rows, await read())) throw unavailable(); selected(request, token, "directory");
    return { value: { projects: rows.map(row => serializeProject(projectReadProjectRow(configurationSqlRow(row)))) }, creationSubject: witness };
  }
  return Object.freeze({scope:"unmounted-project-visible-directory-including-retained-roots-only-v28" as const,capture,directory,
    discard(){active=false;}});
}
