import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { isProjectApiId, type ProjectSnapshot } from "../../shared/project-api";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { readProjectSnapshot } from "../../worker/projects/read-service";
import { projectReadSql, type ProjectReadDatabase, type ProjectSnapshotProjection } from "../../worker/projects/read-sql";
import type { ReadSqlCell, ReadSqlDatabase, ReadSqlStatement } from "../../worker/runtime/read-sql";
import { configurationSqlRow } from "../../worker/runtime/configuration-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";
import { isReferenceTargetType, type ReferenceTargetType } from "../../shared/reference-types";
import { PROJECT_FILTERED_DEPENDENCIES_SQL, PROJECT_FILTERED_DEPENDENCIES_CHECK_SQL,
  PROJECT_FILTERED_REFERENCE_MODES_SQL, projectFilteredSnapshotSql } from "./project-filtered-snapshot-sql";

declare const projectFilteredReadV28Brand: unique symbol;
export interface ProjectFilteredReadV28Request {
  readonly kind: "unmounted-project-filtered-read-v28/1";
  readonly [projectFilteredReadV28Brand]: true;
}
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  id: string; includeDeleted: boolean; actor: string;
  tokenHash: string; credentialRevision: bigint; createdAt: bigint;
}>;
const unavailable = () => new HTTPException(503, { message: "Current Project collaboration reads are unavailable" });
const denied = () => new HTTPException(403, { message: "Current permission for the Project is required" });
const changed = () => new HTTPException(409, { message: "Project references changed. Reload before reading." });
const memberWhere = "i.provider=? AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";

/** Private original-Request owner for per-reference Project Reading and Map.
 * SQL selects visible items before labels, placements, edges and resolver IDs.
 * The complete original snapshot/serializers/nine adapters remain delegated;
 * neutral Gone uses their original result with no unreadable source SELECT.
 * Every later native read and final ACK compares captured data dependencies
 * and independently checks live identity/member/Project policy in same BEGIN.
 * No default mount, File byte opening or mutation capability is issued. */
export function createLocalProjectFilteredReadV28Candidate(options: {
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
  const requests = new WeakMap<ProjectFilteredReadV28Request, Captured>(); let active = true;
  function selected(request: Request, token: ProjectFilteredReadV28Request): Captured {
    const owner = requests.get(token);
    if (!active || !owner || owner.request !== request || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    const facts = issuer.read(request, owner.subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || facts.subject !== owner.facts.subject
      || auth.currentSessionPredicate(request, owner.actor).tokenHash !== owner.tokenHash) throw denied();
    return owner;
  }
  function identityChecks(owner: Captured) {
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
  function projectCheck(owner: Captured) {
    return { statement: database.prepare(`SELECT 1 admitted FROM projects p
      JOIN collaboration_resources r ON r.root_kind='project' AND r.root_id=p.id
      CROSS JOIN collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
      LEFT JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id AND g.member_id=m.member_id
      WHERE p.id=? AND (?=1 OR p.deleted_at IS NULL) AND ${memberWhere}
        AND (r.visibility='workspace' OR (g.enabled=1 AND g.capability IN('read','edit','manage'))) LIMIT 1`)
      .bind(owner.id, owner.includeDeleted ? 1 : 0, owner.facts.provider, owner.facts.issuer, owner.facts.subject), rejection: denied() };
  }
  function readAdmission(owner: Captured, capturedDependencies?: string) {
    return createSqliteBatchAdmission(database, [
      ...identityChecks(owner), projectCheck(owner),
      ...(capturedDependencies === undefined ? [] : [{
        statement: database.prepare(PROJECT_FILTERED_DEPENDENCIES_CHECK_SQL)
          .bind(owner.id, owner.includeDeleted ? 1 : 0, owner.facts.provider, owner.facts.issuer, owner.facts.subject, capturedDependencies,
            owner.id, owner.includeDeleted ? 1 : 0, owner.facts.provider, owner.facts.issuer, owner.facts.subject, capturedDependencies), rejection: changed(),
      }]),
    ]);
  }
  async function capture(request: Request): Promise<ProjectFilteredReadV28Request> {
    if (!active || request.method !== "GET" || request.bodyUsed) throw denied();
    const url = new URL(request.url), prefix = "/api/projects/";
    let id: string;
    try { id = decodeURIComponent(url.pathname.slice(prefix.length)); } catch { throw denied(); }
    if (!url.pathname.startsWith(prefix) || !isProjectApiId(id) || !canonicalIdentityText(id, 256)
      || url.pathname !== `${prefix}${encodeURIComponent(id)}`) throw denied();
    const keys = [...url.searchParams.keys()], query = url.searchParams.get("includeDeleted");
    if (keys.some(key => key !== "includeDeleted") || keys.length > 1 || query !== null && query !== "0" && query !== "1")
      throw new HTTPException(400, { message: "Only the original Project includeDeleted scope is supported" });
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
    const row = rows[0];
    if (rows.length !== 1 || typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({ kind: "unmounted-project-filtered-read-v28/1" }) as ProjectFilteredReadV28Request;
    requests.set(token, Object.freeze({ request, subject, facts, id, includeDeleted: query === "1", actor,
      tokenHash, credentialRevision: row.credential_revision, createdAt: row.created_at }));
    selected(request, token); return token;
  }
  async function snapshot(request: Request, token: ProjectFilteredReadV28Request): Promise<ProjectSnapshot> {
    const owner = selected(request, token);
    let capturedDependencies: string | undefined;
    const sourceModes = new Map<string, "readable" | "neutral">();
    const scopeValues: ReadSqlCell[] = [owner.id, owner.includeDeleted ? 1 : 0, owner.facts.provider, owner.facts.issuer, owner.facts.subject];
    const statements = new WeakMap<ReadSqlStatement, SqliteStatement>();
    function wrap(native: SqliteStatement, prefix: readonly ReadSqlCell[] = []): ReadSqlStatement {
      const statement: ReadSqlStatement = Object.freeze({
        bind(...values: ReadSqlCell[]) { return wrap(native.bind(...prefix, ...values)); },
        async first() { return (await read([native]))[0]!.results[0] ?? null; },
        async all() { return (await read([native]))[0]!; },
      });
      statements.set(statement, native); return statement;
    }
    async function read(items: readonly SqliteStatement[], captureDependencies = false) {
      selected(request, token);
      const originalItems = captureDependencies ? [...items,
        database.prepare(PROJECT_FILTERED_DEPENDENCIES_SQL).bind(...scopeValues),
        database.prepare(PROJECT_FILTERED_REFERENCE_MODES_SQL).bind(...scopeValues)] : items;
      const results = await runSqliteAdmittedBatch(database, originalItems, readAdmission(owner, capturedDependencies));
      if (results.length !== originalItems.length) throw new Error("Incomplete original Project read acknowledgement");
      if (captureDependencies) {
        // Two fixed DATA SELECTs beside the seven policy-filtered projections,
        // under their SAME BEGIN. Only original result offsets reach the service.
        if (capturedDependencies !== undefined) throw new Error("Original Project data dependencies already captured");
        capturedDependencies = JSON.stringify(results[items.length]!.results.map(row => {
          const values = [row.kind, row.registry_id, row.ordinal, row.state];
          if (!values.every(value => typeof value === "string")) throw new Error("Incomplete Project data dependency projection");
          return values;
        }));
        for (const row of results[items.length + 1]!.results) {
          if (!isReferenceTargetType(row.target_type) || typeof row.target_id !== "string"
            || row.mode !== "readable" && row.mode !== "neutral") throw new Error("Invalid original Project reference mode");
          const key = `${row.target_type}\0${row.target_id}`;
          if (sourceModes.has(key)) throw new Error("Duplicate original Project reference mode");
          sourceModes.set(key, row.mode);
        }
      }
      selected(request, token);
      return results.slice(0, items.length).map(result => ({ results: result.results.map(configurationSqlRow) }));
    }
    const db: ProjectReadDatabase = Object.freeze({
      prepare(sql: string) { return wrap(database.prepare(projectReadSql(sql))); },
      projectSnapshotStatement(projection: ProjectSnapshotProjection, sql: string) {
        projectReadSql(sql);
        return wrap(database.prepare(projectFilteredSnapshotSql(projection, sql)), scopeValues);
      },
      referenceSourceDatabase(type: ReferenceTargetType): ReadSqlDatabase {
        return Object.freeze({ prepare(sql: string): ReadSqlStatement {
          projectReadSql(sql);
          return Object.freeze({
            bind(...values: ReadSqlCell[]) {
              if (capturedDependencies === undefined || values.length !== 1 || typeof values[0] !== "string")
                throw new Error("Original scoped Project reference input is unavailable");
              const ids: unknown = JSON.parse(values[0]);
              if (!Array.isArray(ids) || !ids.every(id => typeof id === "string")) throw new Error("Invalid original scoped reference IDs");
              const visible = ids.filter(id => {
                const mode = sourceModes.get(`${type}\0${id}`);
                if (mode === undefined) throw new Error("Foreign original scoped reference target");
                return mode === "readable";
              });
              // Exact original adapter SQL, genuine native empty input for a
              // neutral Gone pointer. Never fabricate rows or project its body.
              return wrap(database.prepare(sql).bind(JSON.stringify(visible)));
            },
            async first() { throw new Error("Original reference IDs must be bound before reading"); },
            async all() { throw new Error("Original reference IDs must be bound before reading"); },
          });
        } });
      },
      async readBatch(items: readonly ReadSqlStatement[]) {
        // Private owned projection port; exactly seven original statement kinds
        // define the snapshot before any complete mature resolver adapter runs.
        if (capturedDependencies !== undefined || items.length !== 7) throw new Error("Original Project snapshot batch is unavailable");
        const native = items.map(item => {
          const value = statements.get(item); if (!value) throw new Error("Foreign Project snapshot statement"); return value;
        });
        const results = await read(native, true);
        return results;
      },
    });
    const result = await readProjectSnapshot(db, owner.id, owner.includeDeleted);
    // Recheck original reference dependencies + every live permission after
    // asynchronous chunk resolution and before releasing any serialized value.
    selected(request, token);
    await runSqliteAdmittedBatch(database, [], readAdmission(owner, capturedDependencies));
    selected(request, token); return result;
  }
  return Object.freeze({ capture, snapshot, discard() { active = false; } });
}
