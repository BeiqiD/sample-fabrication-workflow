import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { isCreateProjectInput, isRenameProjectInput, type ProjectListResponse } from "../../shared/project-api";
import { PROJECT_CREATION_SUBJECT_HEADER, projectCreationSubject } from "../../shared/project-creation-subject";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { createProjectCreationService } from "../../worker/projects/create-service";
import { createProjectRenameService } from "../../worker/projects/rename-service";
import { projectCreateSql, type ProjectCreateDatabase, type ProjectCreateStatement } from "../../worker/projects/create-sql";
import { projectReadProjectRow } from "../../worker/projects/read-decoding";
import { serializeProject } from "../../worker/projects/serializers";
import { configurationSqlRow } from "../../worker/runtime/configuration-sql";
import type { ReadSqlCell } from "../../worker/runtime/read-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { asProjectRenameDatabase } from "../project-rename-sql";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteRow, type SqliteStatement } from "../sqlite";

declare const projectPermissionBrand: unique symbol;
export interface ProjectPermissionRequest {
  readonly kind: "unmounted-current-project-permission-v28/1";
  readonly [projectPermissionBrand]: true;
}
export type ProjectPermissionScope = Readonly<
  { operation: "directory" | "create"; id?: never } | { operation: "rename"; id: string }
>;
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  operation: ProjectPermissionScope["operation"]; id?: string; actor: string;
  tokenHash: string; credentialRevision: bigint; createdAt: bigint;
}>;
const unavailable = () => new HTTPException(503, { message: "Current Project collaboration permissions are unavailable" });
const denied = () => new HTTPException(403, { message: "Current explicit Project permission is required" });
const changed = () => new HTTPException(409, { message: "This Project changed. Reload before continuing." });
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

/** Unmounted Project-only successor. This does not grant from Sample policies,
 * actor/creator IDs, system administration or serialized QA manifests. Genuine
 * V28 schema2 and enabled control are required inside every admitted transaction.
 * The composer owns each ORIGINAL promise in the authentic physical lease and
 * discards this owner before connection closure, upgrade or recovery. Full
 * snapshots/references/Files and all remaining operations stay separate owners. */
export function createLocalProjectPermissionV28Candidate(options: {
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
  const requests = new WeakMap<ProjectPermissionRequest, Captured>(); let active = true;
  function selected(request: Request, token: ProjectPermissionRequest, operation: Captured["operation"]): Captured {
    const owner = requests.get(token);
    if (!active || !owner || owner.request !== request || owner.operation !== operation || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
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
      { statement: database.prepare(`SELECT 1 admitted FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id WHERE ${memberWhere} LIMIT 1`)
        .bind(owner.facts.provider, owner.facts.issuer, owner.facts.subject), rejection: denied() },
      ...(write ? [{ statement: database.prepare(`SELECT 1 admitted FROM system_recovery_maintenance WHERE singleton=1 AND state='open'
        AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
        AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='legacy')`), rejection: unavailable() }] : []),
    ];
  }
  function editCheck(owner: Captured, id: string) {
    return { statement: database.prepare(`SELECT 1 admitted FROM projects p JOIN collaboration_resources r ON r.root_kind='project' AND r.root_id=p.id
      JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id
      JOIN collaboration_identities i ON i.member_id=g.member_id JOIN collaboration_members m ON m.member_id=i.member_id
      WHERE p.id=? AND p.deleted_at IS NULL AND ${memberWhere} AND g.enabled=1 AND g.capability IN('edit','manage') LIMIT 1`)
      .bind(id, owner.facts.provider, owner.facts.issuer, owner.facts.subject), rejection: denied() };
  }
  async function capture(request: Request, scope: ProjectPermissionScope): Promise<ProjectPermissionRequest> {
    const { operation, id } = scope;
    const method = operation === "directory" ? "GET" : operation === "create" ? "POST" : operation === "rename" ? "PATCH" : undefined;
    if (!active || !method || request.method !== method || request.bodyUsed
      || (operation === "rename" ? !canonicalIdentityText(id, 256) : id !== undefined)) throw denied();
    const path = operation === "rename" ? `/api/projects/${encodeURIComponent(id!)}` : "/api/projects";
    const url = new URL(request.url); if (url.pathname !== path) throw denied();
    if (operation === "directory" && [...url.searchParams.keys()].length) throw new HTTPException(400, { message: "Deleted and filtered Project directories are unavailable in this candidate" });
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request, subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (operation === "create") {
      // Consistency witness only; check before JSON or Project-domain SQL.
      if (request.headers.get(PROJECT_CREATION_SUBJECT_HEADER) !== await projectCreationSubject(actor, realm))
        throw new HTTPException(409, { message: "Sign-in identity changed. Refresh Projects before retrying." });
      issuer.read(request, subject);
    }
    if (auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash, facts.subject); issuer.read(request, subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({ kind: "unmounted-current-project-permission-v28/1" as const }) as ProjectPermissionRequest;
    requests.set(token, Object.freeze({ request, subject, facts, operation, id, actor, tokenHash,
      credentialRevision: row.credential_revision, createdAt: row.created_at })); return token;
  }
  async function directory(request: Request, token: ProjectPermissionRequest): Promise<{ value: ProjectListResponse; creationSubject: string }> {
    const owner = selected(request, token, "directory");
    const sql = database.prepare(`SELECT p.* FROM projects p WHERE p.deleted_at IS NULL AND EXISTS(
      SELECT 1 FROM collaboration_resources r JOIN collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
      WHERE r.root_kind='project' AND r.root_id=p.id AND ${memberWhere} AND (r.visibility='workspace'
        OR EXISTS(SELECT 1 FROM collaboration_grants g WHERE g.root_kind=r.root_kind AND g.root_id=r.root_id
          AND g.member_id=m.member_id AND g.enabled=1 AND g.capability IN('read','edit','manage'))))
      ORDER BY (p.deleted_at IS NOT NULL),p.updated_at DESC,p.id`).bind(owner.facts.provider, owner.facts.issuer, owner.facts.subject);
    const read = async () => { selected(request, token, "directory");
      return (await runSqliteAdmittedBatch(database, [sql], createSqliteBatchAdmission(database, checks(owner, false))))[0]!.results; };
    const rows = await read(), witness = await projectCreationSubject(owner.actor, realm);
    if (!sameRows(rows, await read())) throw unavailable(); selected(request, token, "directory");
    return { value: { projects: rows.map(row => serializeProject(projectReadProjectRow(configurationSqlRow(row)))) }, creationSubject: witness };
  }
  async function create(request: Request, token: ProjectPermissionRequest, value: unknown) {
    const owner = selected(request, token, "create");
    if (!isCreateProjectInput(value)) throw new HTTPException(400, { message: "Invalid Project creation request" });
    const input = Object.freeze({ id: value.id, title: value.title, operationId: value.operationId });
    if (!isCreateProjectInput(input)) throw new HTTPException(400, { message: "Invalid Project creation request" });
    const id = input.id, lookup = await runSqliteAdmittedBatch(database, [database.prepare("SELECT id FROM projects WHERE id=? LIMIT 1").bind(id)],
      createSqliteBatchAdmission(database, checks(owner, true)));
    let mode: "new" | "existing" = lookup[0]!.results.length ? "existing" : "new";
    const guard = () => {
      selected(request, token, "create");
      const selectedChecks = checks(owner, true);
      if (mode === "existing") selectedChecks.push(editCheck(owner, id));
      else {
        selectedChecks.push({ statement: database.prepare(`SELECT 1 admitted FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
          WHERE ${memberWhere} AND m.can_create_projects=1 LIMIT 1`).bind(owner.facts.provider, owner.facts.issuer, owner.facts.subject), rejection: denied() });
        selectedChecks.push({ statement: database.prepare(`SELECT 1 admitted WHERE NOT EXISTS(SELECT 1 FROM projects WHERE id=?)
          AND NOT EXISTS(SELECT 1 FROM collaboration_resources WHERE root_kind='project' AND root_id=?)`).bind(id, id), rejection: changed() });
      }
      return createSqliteBatchAdmission(database, selectedChecks); // At most SIX genuine owned guards.
    };
    const issued = new WeakMap<ProjectCreateStatement, SqliteStatement>();
    const wrap = (native: SqliteStatement): ProjectCreateStatement => {
      const statement: ProjectCreateStatement = Object.freeze({ bind(...values: ReadSqlCell[]) { return wrap(native.bind(...values)); } });
      issued.set(statement, native); return statement;
    };
    const db: ProjectCreateDatabase = Object.freeze({
      prepare(sql: string) { return wrap(database.prepare(projectCreateSql(sql))); },
      async atomicBatch(items: readonly ProjectCreateStatement[]) {
        if (items.length !== 3) throw denied();
        const originalStatements = items.map(item => { const native = issued.get(item); if (!native) throw denied(); return native; });
        const creating = mode === "new", statements = [...originalStatements];
        if (creating) {
          statements.push(database.prepare("INSERT INTO collaboration_resources(root_kind,root_id,visibility,revision) VALUES('project',?,'restricted',1)").bind(id),
            database.prepare(`INSERT INTO collaboration_grants(root_kind,root_id,member_id,capability,enabled,revision)
              VALUES('project',?,(SELECT m.member_id FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
                WHERE ${memberWhere} AND m.can_create_projects=1),'manage',1,1)`).bind(id, owner.facts.provider, owner.facts.issuer, owner.facts.subject));
        }
        const results = await runSqliteAdmittedBatch(database, statements, guard());
        if (results.length !== statements.length || creating && results.slice(3).some(row => row.meta.directChanges !== 1)) throw unavailable();
        // Destination rights, not the now-used creation flag, govern current ACK.
        mode = "existing"; return results.slice(0, 3).map(result => ({ results: result.results.map(configurationSqlRow) }));
      },
    });
    const service = createProjectCreationService({ database: () => db, now: Date.now,
      async admit(actor) { if (actor !== owner.actor) throw denied(); await runSqliteAdmittedBatch(database, [], guard()); selected(request, token, "create"); } });
    return service.create(input, owner.actor);
  }
  async function rename(request: Request, token: ProjectPermissionRequest, value: unknown) {
    const owner = selected(request, token, "rename"), id = owner.id!;
    if (!isRenameProjectInput(value)) throw new HTTPException(400, { message: "Invalid Project update request" });
    const input = Object.freeze({ title: value.title, operationId: value.operationId, expectedRevision: value.expectedRevision });
    if (!isRenameProjectInput(input)) throw new HTTPException(400, { message: "Invalid Project update request" });
    const guard = () => { selected(request, token, "rename"); return createSqliteBatchAdmission(database, [...checks(owner, true), editCheck(owner, id)]); };
    const service = createProjectRenameService({ database: () => asProjectRenameDatabase(database, guard), now: Date.now,
      async admit(actor) { if (actor !== owner.actor) throw denied(); await runSqliteAdmittedBatch(database, [], guard()); selected(request, token, "rename"); } });
    return service.rename(id, input, owner.actor);
  }
  return Object.freeze({ scope: "unmounted-project-directory-create-rename-only-v28" as const, capture, directory, create, rename, discard() { active = false; } });
}
