import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { createSampleMetadataService } from "../../worker/samples/metadata-service";
import { createSampleReadService } from "../../worker/samples/read-service";
import { configurationSqlInteger, configurationSqlMutation, configurationSqlRow,
  type ConfigurationSqlDatabase, type ConfigurationSqlRow, type ConfigurationSqlStatement } from "../../worker/runtime/configuration-sql";
import type { ReadSqlStatement } from "../../worker/runtime/read-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability,
  type SqliteRow, type SqliteStatement } from "../sqlite";

declare const samplePermissionRequestBrand: unique symbol;
/** Privately issued operation intent, not a cached permission decision. No
 * member/root rights or session secret are exposed. Every query/commit must
 * execute the owned guards inside its actual native BEGIN. */
export interface SamplePermissionRequest {
  readonly kind: "unmounted-local-sample-permission-request/1";
  readonly [samplePermissionRequestBrand]: true;
}
type Operation = "directory" | "directory_options" | "create" | "update" | "remove" | "restore";
export type SamplePermissionScope = Readonly<
  { operation: "directory" | "directory_options" | "create"; id?: never }
  | { operation: "update" | "remove" | "restore"; id: string }
>;
interface CapturedRequest {
  readonly request: Request; readonly subject: LocalRequestSubject; readonly facts: Readonly<RequestSubjectFacts>;
  readonly operation: Operation; readonly id: string | undefined;
  readonly actor: string; readonly tokenHash: string; readonly createdAt: bigint; readonly credentialRevision: bigint;
}
const memberWhere = "i.provider=? AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";
const unavailable = () => new HTTPException(503, { message: "Sample collaboration permissions are not installed" });
const denied = () => new HTTPException(403, { message: "Current Sample permission is required" });
function sameRows(left: readonly SqliteRow[], right: readonly SqliteRow[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => {
    const other = right[index]!, names = Object.keys(row).sort();
    if (names.join("\0") !== Object.keys(other).sort().join("\0")) return false;
    return names.every(name => {
      const a = row[name], b = other[name];
      return a instanceof Uint8Array ? b instanceof Uint8Array && a.length === b.length && a.every((v, i) => v === b[i]) : Object.is(a, b);
    });
  });
}

/** SOURCE-ONLY, UNMOUNTED successor. The exact reviewed inactive V27 checkpoint
 * may construct this candidate, but its disabled control ALWAYS rejects every
 * domain read/write. An enabled successor needs a separately paired forward
 * schema/recovery review; this source neither changes nor bypasses that control.
 * Operational V26/24 and unchecked augmented schemas are refused at construction.
 * Composer owns the ORIGINAL operation in writerLease.withWriter and must discard
 * this factory before actual connection close, metadata upgrade or recovery. */
interface SamplePermissionFactoryOptions {
  database: SqliteCapability; nativeDatabase: DatabaseSync; admission: ReviewedInstallationAdmission;
  writerLease: LinuxWriterLease; authentication: object;
}
export function createLocalSamplePermissionCandidate(options: SamplePermissionFactoryOptions) {
  return createOwnedSamplePermission(options, Object.freeze({ checkpointId: "portable-runtime/v27", schemaVersion: 1 as const }));
}
/** SOURCE-ONLY reviewed forward candidate. No fixture can toggle the old V27
 * control into authority. Only actual V28/schema2 may construct this separate
 * owner, and every query/mutation still requires explicit currently enabled
 * control, mapping/member/root permissions INSIDE its real native BEGIN. */
export function createLocalSamplePermissionV28Candidate(options: SamplePermissionFactoryOptions) {
  return createOwnedSamplePermission(options, Object.freeze({ checkpointId: "portable-runtime/v28", schemaVersion: 2 as const }));
}
function createOwnedSamplePermission(options: SamplePermissionFactoryOptions,
  generation: Readonly<{ checkpointId: "portable-runtime/v27" | "portable-runtime/v28"; schemaVersion: 1 | 2 }>) {
  const { database, nativeDatabase, admission, writerLease, authentication } = options;
  const auth = localAuthenticationIdentityAuthority(authentication);
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  const policy = assertInstalledLocalIdentityOwner(auth.identity, database, nativeDatabase, admission);
  const installation = Object.freeze({ ...assertInstallationAdmission(nativeDatabase, admission) });
  if (installation.checkpointId !== generation.checkpointId) throw unavailable();
  const control = nativeDatabase.prepare(`SELECT schema_version,enforcement${generation.schemaVersion === 2 ? ",revision" : ""} FROM collaboration_control WHERE singleton=1`).get();
  if (control?.schema_version !== generation.schemaVersion
    || generation.schemaVersion === 1 && control.enforcement !== "disabled"
    || generation.schemaVersion === 2 && (!["disabled", "enabled"].includes(control.enforcement as string)
      || typeof control.revision !== "number" || !Number.isSafeInteger(control.revision) || control.revision < 1)) throw unavailable();
  const sentinel = nativeDatabase.prepare("SELECT bootstrap_principal_id,initialized_at FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'").get();
  if (typeof sentinel?.bootstrap_principal_id !== "string" || typeof sentinel.initialized_at !== "number"
    || !Number.isSafeInteger(sentinel.initialized_at) || sentinel.initialized_at < 0) throw unavailable();
  const bootstrapPrincipalId = sentinel.bootstrap_principal_id, initializedAt = sentinel.initialized_at;
  const issuer = createLocalRequestSubjectIssuer({ database, nativeDatabase, admission, writerLease, authentication });
  const requests = new WeakMap<SamplePermissionRequest, CapturedRequest>();
  function selected(request: Request, token: SamplePermissionRequest): CapturedRequest {
    const owner = requests.get(token);
    if (!owner || owner.request !== request || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    const facts = issuer.read(request, owner.subject);
    if (facts.provider !== owner.facts.provider || facts.issuer !== owner.facts.issuer || facts.subject !== owner.facts.subject
      || auth.currentSessionPredicate(request, owner.actor).tokenHash !== owner.tokenHash) throw denied();
    return owner;
  }
  function permissions(owner: CapturedRequest, operation: Operation, id?: string, observed?: ConfigurationSqlRow) {
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    const { provider, issuer: verifiedIssuer, subject } = owner.facts;
    const authenticationCheck = database.prepare(`SELECT 1 admitted FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
      CROSS JOIN (WITH observed AS MATERIALIZED (SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) now) SELECT now FROM observed) clock
      WHERE s.token_hash=? AND a.principal_id=? AND a.enabled=1 AND s.credential_revision=a.credential_revision
        AND a.credential_revision=? AND s.created_at=? AND s.revoked_at IS NULL
        AND typeof(clock.now)='integer' AND clock.now BETWEEN 0 AND 9007199254740991
        AND clock.now>=s.last_seen_at AND clock.now<s.absolute_expires_at AND clock.now<s.last_seen_at+? LIMIT 1`)
      .bind(owner.tokenHash, subject, owner.credentialRevision, owner.createdAt, policy.idleLifetimeMs);
    const installed = database.prepare(`SELECT 1 admitted WHERE
      EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=?
        AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
      AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'
        AND bootstrap_principal_id=? AND initialized_at=?)`)
      .bind(installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256,
        installation.createdAt, bootstrapPrincipalId, initializedAt);
    const enabled = database.prepare("SELECT 1 admitted FROM collaboration_control WHERE singleton=1 AND schema_version=? AND enforcement='enabled'").bind(generation.schemaVersion);
    const membership = database.prepare(`SELECT 1 admitted FROM collaboration_identities i
      JOIN collaboration_members m ON m.member_id=i.member_id WHERE ${memberWhere}
        ${operation === "create" ? "AND m.can_create_samples=1" : ""} LIMIT 1`).bind(provider, verifiedIssuer, subject);
    const checks = [
      { statement: authenticationCheck, rejection: new HTTPException(401, { message: "Current local authentication is required" }) },
      { statement: installed, rejection: unavailable() },
      { statement: enabled, rejection: unavailable() },
      { statement: membership, rejection: denied() },
    ];
    if (operation !== "directory" && operation !== "directory_options") {
      checks.push({ statement: database.prepare(`SELECT 1 admitted FROM system_recovery_maintenance m
        WHERE m.singleton=1 AND m.state='open'
          AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
          AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='legacy')`), rejection: unavailable() });
    }
    if (id !== undefined) {
      const required = operation === "update" ? "('edit','manage')" : "('manage')";
      checks.push({ statement: database.prepare(`SELECT 1 admitted FROM samples s
        JOIN collaboration_resources r ON r.root_kind='sample' AND r.root_id=s.id
        JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id
        JOIN collaboration_identities i ON i.member_id=g.member_id JOIN collaboration_members m ON m.member_id=i.member_id
        WHERE s.id=? AND ${memberWhere} AND g.enabled=1 AND g.capability IN ${required} LIMIT 1`)
        .bind(id, provider, verifiedIssuer, subject), rejection: denied() });
      if (observed) {
        const live = operation === "restore" ? "s.deleted_at IS NOT NULL AND s.deleted_at=?" : "s.deleted_at IS NULL";
        const bindings = operation === "restore" ? [observed.deleted_at!] : [];
        const counts = operation === "remove" ? ["run_count", "step_count", "event_count", "verification_count", "child_count"] as const : [];
        const countSql = counts.length ? `
          AND (SELECT COUNT(*) FROM runs r WHERE r.sample_id=s.id)=?
          AND (SELECT COUNT(*) FROM run_steps rs JOIN runs r ON r.id=rs.run_id WHERE r.sample_id=s.id)=?
          AND (SELECT COUNT(*) FROM events e WHERE e.sample_id=s.id)=?
          AND (SELECT COUNT(*) FROM state_verifications sv WHERE sv.sample_id=s.id)=?
          AND (SELECT COUNT(*) FROM samples child WHERE child.parent_id=s.id)=?` : "";
        checks.push({ statement: database.prepare(`SELECT 1 admitted FROM samples s WHERE s.id=? AND s.updated_at=? AND ${live}${countSql}`)
          .bind(id, observed.updated_at, ...bindings, ...counts.map(name => observed[name])),
          rejection: new HTTPException(409, { message: "This sample changed elsewhere. Reload it before continuing." }) });
      }
    }
    return createSqliteBatchAdmission(database, checks);
  }
  async function capture(request: Request, scope: SamplePermissionScope): Promise<SamplePermissionRequest> {
    const { operation, id } = scope;
    const methods: Record<Operation, string> = { directory: "GET", directory_options: "GET", create: "POST", update: "PATCH", remove: "DELETE", restore: "POST" };
    if (!Object.hasOwn(methods, operation) || request.method !== methods[operation] || request.bodyUsed) throw denied();
    const targetOperation = operation === "update" || operation === "remove" || operation === "restore";
    if (targetOperation ? !canonicalIdentityText(id, 256) : id !== undefined) throw denied();
    const path = operation === "directory_options" ? "/api/sample-directory-options" : targetOperation
      ? `/api/samples/${encodeURIComponent(id!)}${operation === "restore" ? "/restore" : ""}` : "/api/samples";
    if (new URL(request.url).pathname !== path) throw denied();
    // The exact route/method/id scope is captured before JSON/body clone ownership.
    // A genuinely issued GET token cannot be borrowed by a mutation method.
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request, subject);
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash, facts.subject);
    issuer.read(request, subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({ kind: "unmounted-local-sample-permission-request/1" as const }) as SamplePermissionRequest;
    requests.set(token, Object.freeze({ request, subject, facts, operation, id, actor, tokenHash,
      credentialRevision: row.credential_revision, createdAt: row.created_at }));
    return token;
  }
  function metadata(request: Request, token: SamplePermissionRequest, operation: Exclude<Operation, "directory" | "directory_options">, id?: string) {
    const owner = selected(request, token);
    if (owner.operation !== operation || owner.id !== id) throw denied();
    if ((operation === "create") !== (id === undefined) || id !== undefined && !canonicalIdentityText(id, 256)) throw denied();
    let observed: ConfigurationSqlRow | undefined;
    const statements = new WeakMap<ConfigurationSqlStatement, { native: SqliteStatement; mutation: boolean }>();
    const guard = () => { selected(request, token); return permissions(owner, operation, id, observed); };
    const wrap = (native: SqliteStatement, mutation: boolean): ConfigurationSqlStatement => {
      const statement: ConfigurationSqlStatement = Object.freeze({
        bind(...values: unknown[]) { return wrap(native.bind(...values), mutation); },
        async first() {
          if (mutation) throw denied();
          const result = (await runSqliteAdmittedBatch(database, [native], guard()))[0]!.results;
          const row = result[0] === undefined ? null : configurationSqlRow(result[0]);
          if (row && typeof row.updated_at === "string") observed = Object.freeze({ ...row });
          return row;
        },
        async all() { if (mutation) throw denied(); return { results: (await runSqliteAdmittedBatch(database, [native], guard()))[0]!.results.map(configurationSqlRow) }; },
      });
      statements.set(statement, { native, mutation }); return statement;
    };
    const originals = (items: readonly ConfigurationSqlStatement[]) => items.map(item => {
      const actual = statements.get(item); if (!actual || !actual.mutation) throw denied(); return actual.native;
    });
    const db: ConfigurationSqlDatabase = Object.freeze({
      prepare(sql: string) { return wrap(database.prepare(sql), configurationSqlMutation(sql)); },
      async batch(items: readonly ConfigurationSqlStatement[]) {
        const results = await runSqliteAdmittedBatch(database, originals(items), guard()); observed = undefined;
        return results.map(result => ({ directChanges: configurationSqlInteger(result.meta.directChanges, "Sample direct changes") }));
      },
      primary() { selected(request, token); return db; },
    });
    const admit = async (actor: string) => {
      if (actor !== owner.actor) throw denied();
      await runSqliteAdmittedBatch(database, [], guard()); selected(request, token);
    };
    const service = createSampleMetadataService({ database: () => db, admit, now: Date.now, randomId: randomUUID,
      ...(operation !== "create" ? {} : { async commitCreation(createdId: string, items: readonly ConfigurationSqlStatement[]) {
        if (!canonicalIdentityText(createdId, 256) || items.length !== 2) throw denied();
        const root = database.prepare("INSERT INTO collaboration_resources(root_kind,root_id,visibility,revision) VALUES('sample',?,'restricted',1)").bind(createdId);
        // A missing member is a NOT NULL failure, never a zero-row manager insert
        // followed by a committed orphan. All four original+authority statements
        // share the same BEGIN and original create-flag/session permission guard.
        const manager = database.prepare(`INSERT INTO collaboration_grants(root_kind,root_id,member_id,capability,enabled,revision)
          VALUES('sample',?,(SELECT m.member_id FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
            WHERE ${memberWhere} AND m.can_create_samples=1),'manage',1,1)`)
          .bind(createdId, owner.facts.provider, owner.facts.issuer, owner.facts.subject);
        await runSqliteAdmittedBatch(database, [...originals(items), root, manager], guard());
      } }),
    });
    return { service, actor: owner.actor, admit };
  }
  function reads(request: Request, token: SamplePermissionRequest, operation: "directory" | "directory_options") {
    const owner = selected(request, token), statements = new WeakMap<ReadSqlStatement, SqliteStatement>();
    if (owner.operation !== operation || owner.id !== undefined) throw denied();
    let previous: Readonly<{ statements: readonly SqliteStatement[]; results: readonly SqliteRow[][] }> | undefined;
    const guard = () => { selected(request, token); return permissions(owner, operation); };
    const wrap = (native: SqliteStatement): ReadSqlStatement => {
      const statement: ReadSqlStatement = Object.freeze({
        bind(...values: unknown[]) { return wrap(native.bind(...values)); },
        async first() { return (await runSqliteAdmittedBatch(database, [native], guard()))[0]!.results[0] ?? null; },
        async all() { return { results: (await runSqliteAdmittedBatch(database, [native], guard()))[0]!.results }; },
      }); statements.set(statement, native); return statement;
    };
    const admit = async (actor: string) => {
      if (actor !== owner.actor) throw denied();
      const current = await runSqliteAdmittedBatch(database, previous?.statements ?? [], guard());
      if (previous && current.some((result, i) => !sameRows(previous!.results[i]!, result.results))) throw unavailable();
      selected(request, token);
    };
    return { actor: owner.actor, service: createSampleReadService({
      database: () => Object.freeze({ prepare(sql: string) { return wrap(database.prepare(sql)); } }),
      visibility: owner.facts, visibilitySchemaVersion: generation.schemaVersion, admit,
      async readMany(items) {
        const actual = Object.freeze(items.map(item => { const native = statements.get(item); if (!native) throw denied(); return native; }));
        const results = (await runSqliteAdmittedBatch(database, actual, guard())).map(result => result.results);
        previous = Object.freeze({ statements: actual, results }); return results;
      },
    }) };
  }
  async function acknowledged<T>(owner: ReturnType<typeof metadata>, result: Promise<T>): Promise<T> {
    const accepted = await result; await owner.admit(owner.actor); return accepted;
  }
  return Object.freeze({
    kind: "unmounted-local-sample-permission-candidate/1" as const, capture,
    async directoryOptions(request: Request, token: SamplePermissionRequest) { const owner = reads(request, token, "directory_options"); return owner.service.directoryOptions(owner.actor); },
    async directory(request: Request, token: SamplePermissionRequest) {
      const owner = reads(request, token, "directory"), query = new URL(request.url).searchParams;
      return owner.service.directory(key => query.get(key) ?? undefined, owner.actor);
    },
    async create(request: Request, token: SamplePermissionRequest, value: unknown) { const owner = metadata(request, token, "create"); return acknowledged(owner, owner.service.create(value, owner.actor)); },
    async update(request: Request, token: SamplePermissionRequest, id: string, value: unknown) { const owner = metadata(request, token, "update", id); return acknowledged(owner, owner.service.update(id, value, owner.actor)); },
    async remove(request: Request, token: SamplePermissionRequest, id: string, value: unknown) { const owner = metadata(request, token, "remove", id); return acknowledged(owner, owner.service.remove(id, value, owner.actor)); },
    async restore(request: Request, token: SamplePermissionRequest, id: string, value: unknown) { const owner = metadata(request, token, "restore", id); return acknowledged(owner, owner.service.restore(id, value, owner.actor)); },
  });
}
