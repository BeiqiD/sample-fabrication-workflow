import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { removeSampleRecordWithDatabase } from "../../worker/samples/record-service";
import type { SampleFileMetadataDatabase, SampleFileMetadataStatement } from "../../worker/samples/file-metadata-sql";
import { configurationSqlCell, configurationSqlInteger, configurationSqlRow } from "../../worker/runtime/configuration-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";

import { SAMPLE_RECORD_REMOVE_SCHEMA_SQL, SAMPLE_RECORD_REMOVE_SOURCE_CAPTURE_SQL,
  SAMPLE_RECORD_REMOVE_SOURCE_CHECK_SQL, SAMPLE_RECORD_REMOVE_ACCEPTED_CHECK_SQL,
  sampleRecordRemoveTextEligibilitySql } from "./sample-record-remove-source-sql";

declare const sampleRecordRemovePermissionBrand: unique symbol;
export interface SampleRecordRemovePermissionRequest {
  readonly kind: "unmounted-current-sample-record-remove-permission-v28/1";
  readonly [sampleRecordRemovePermissionBrand]: true;
}
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  sampleId: string; eventId: string; actor: string; tokenHash: string;
  credentialRevision: bigint; sessionCreatedAt: bigint;
}>;
const unavailable = () => new HTTPException(503, { message: "Current text-only Sample record deletion permissions are unavailable" });
const denied = () => new HTTPException(403, { message: "Current Sample edit permission is required" });
const memberWhere = "i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";

/** Unmounted genuine V28 deletion of an exact media-free legacy Sample
 * record. The complete original remove algorithm runs under current Sample
 * edit/manage, not routine operate. Every original read and single batch
 * rechecks original Request/session/member/root/source inside BEGIN. This
 * grants no File, canonical Comment or arbitrary legacy metadata capability.
 * The future host owns full original operation/first ACK and physical lease. */
export function createLocalSampleRecordRemovePermissionV28Candidate(options: {
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
  const requests = new WeakMap<SampleRecordRemovePermissionRequest, Captured>(), consumed = new WeakSet<SampleRecordRemovePermissionRequest>();
  let active = true;
  function selected(request: Request, token: SampleRecordRemovePermissionRequest): Captured {
    const owner = requests.get(token);
    if (!active || !owner || owner.request !== request || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    const facts = issuer.read(request, owner.subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || facts.subject !== owner.facts.subject
      || auth.currentSessionPredicate(request, owner.actor).tokenHash !== owner.tokenHash) throw denied();
    return owner;
  }
  function checks(owner: Captured, snapshot?: string, acceptedMetadata?: string) {
    const guards = [
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
        .bind(installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256,
          installation.createdAt, bootstrapPrincipalId, initializedAt), rejection: unavailable() },
      { statement: database.prepare(`SELECT 1 admitted FROM samples s
        JOIN collaboration_resources root ON root.root_kind='sample' AND root.root_id=s.id
        JOIN collaboration_grants g ON g.root_kind=root.root_kind AND g.root_id=root.root_id
        JOIN collaboration_identities i ON i.member_id=g.member_id JOIN collaboration_members m ON m.member_id=i.member_id
        WHERE s.id=? AND s.deleted_at IS NULL AND ${memberWhere} AND g.enabled=1 AND g.capability IN('edit','manage') LIMIT 1`)
        .bind(owner.sampleId, localIssuer, owner.facts.subject), rejection: denied() },
      { statement: database.prepare(`SELECT 1 admitted FROM system_recovery_maintenance WHERE singleton=1 AND state='open'
        AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
        AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='legacy')`), rejection: unavailable() },
    ];
    guards.push({ statement: database.prepare(sampleRecordRemoveTextEligibilitySql(acceptedMetadata !== undefined))
      .bind(owner.eventId, owner.sampleId), rejection: unavailable() });
    if (snapshot !== undefined) guards.push({ statement: database.prepare(acceptedMetadata === undefined
      ? SAMPLE_RECORD_REMOVE_SOURCE_CHECK_SQL : SAMPLE_RECORD_REMOVE_ACCEPTED_CHECK_SQL)
      .bind(owner.eventId, owner.sampleId, snapshot, ...(acceptedMetadata === undefined ? [] : [acceptedMetadata])),
      rejection: new HTTPException(409, { message: "The Sample record source changed. Review the current record again." }) });
    return guards; // Four current, one eligibility, one DATA: at most six/core eight unchanged.
  }
  async function capture(request: Request, sampleId: string, eventId: string): Promise<SampleRecordRemovePermissionRequest> {
    if (!active || request.method !== "DELETE" || request.bodyUsed
      || !canonicalIdentityText(sampleId, 256) || !canonicalIdentityText(eventId, 256)) throw denied();
    const url = new URL(request.url);
    if (url.pathname !== `/api/samples/${encodeURIComponent(sampleId)}/records/${encodeURIComponent(eventId)}` || [...url.searchParams.keys()].length) throw denied();
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request, subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash, facts.subject); issuer.read(request, subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({ kind: "unmounted-current-sample-record-remove-permission-v28/1" as const }) as SampleRecordRemovePermissionRequest;
    requests.set(token, Object.freeze({ request, subject, facts, sampleId, eventId, actor, tokenHash,
      credentialRevision: row.credential_revision, sessionCreatedAt: row.created_at }));
    return token;
  }
  async function perform(request: Request, token: SampleRecordRemovePermissionRequest) {
    const owner = selected(request, token); if (consumed.has(token)) throw denied(); consumed.add(token);
    let snapshot: string | undefined, acceptedMetadata: string | undefined;
    const admissionNow = () => { selected(request, token); return createSqliteBatchAdmission(database, checks(owner, snapshot, acceptedMetadata)); };
    const observed = await runSqliteAdmittedBatch(database,
      [database.prepare(SAMPLE_RECORD_REMOVE_SOURCE_CAPTURE_SQL).bind(owner.eventId, owner.sampleId)], admissionNow());
    const state = observed[0]?.results[0]?.state;
    if (observed.length !== 1 || observed[0]!.results.length !== 1 || typeof state !== "string") throw unavailable();
    if (Buffer.byteLength(state) > 1024 * 1024) throw new HTTPException(413, { message: "Sample record source exceeds this candidate's limit" });
    snapshot = state;
    interface Statement extends SampleFileMetadataStatement<Statement> {}
    type Original = Readonly<{ native: SqliteStatement; sql: string; values: readonly unknown[] }>;
    const statements = new WeakMap<Statement, Original>();
    const wrap = (native: SqliteStatement, sql: string, values: readonly unknown[] = []): Statement => {
      const statement: Statement = Object.freeze({
        bind(...values: unknown[]) {
          const bindings = values.map(configurationSqlCell);
          return wrap(native.bind(...bindings), sql, Object.freeze(bindings));
        },
        async first<Row = Record<string, unknown>>(): Promise<Row | null> {
          const result = await runSqliteAdmittedBatch(database, [native], admissionNow());
          if (result.length !== 1 || result[0]!.results.length > 1) throw unavailable();
          const row = result[0]!.results[0];
          if (row === undefined) return null;
          const typed = configurationSqlRow(row);
          // Only these original fixed schema-count cells need D1 Number
          // compatibility. Never convert numeric business cells wholesale.
          if (sql === SAMPLE_RECORD_REMOVE_SCHEMA_SQL) {
            typed.authority_tables = configurationSqlInteger(typed.authority_tables, "Sample File authority table count");
            typed.file_columns = configurationSqlInteger(typed.file_columns, "Sample File column count");
          }
          return typed as Row;
        },
        async all<Row = Record<string, unknown>>(): Promise<{ results: Row[] }> {
          const result = await runSqliteAdmittedBatch(database, [native], admissionNow());
          if (result.length !== 1) throw unavailable(); return { results: result[0]!.results.map(row => configurationSqlRow(row) as Row) };
        },
      }); statements.set(statement, Object.freeze({ native, sql, values })); return statement;
    };
    const port: SampleFileMetadataDatabase<Statement> = Object.freeze({
      prepare(sql: string) { return wrap(database.prepare(sql), sql); },
      primary() { selected(request, token); return port; },
      // The unchanged original deletion algorithm selects its metadata SQL
      // from the actual current legacy control. This supplies no File grant.
      async authorityMode() {
        await runSqliteAdmittedBatch(database, [], admissionNow()); selected(request, token);
        return "legacy" as const;
      },
      async atomicBatch(items: Statement[]) {
        if (acceptedMetadata !== undefined || items.length !== 3) throw denied();
        const originals = items.map(item => { const original = statements.get(item); if (!original) throw denied(); return original; });
        const deletionMetadata = originals[0]!.values[0];
        if (typeof deletionMetadata !== "string") throw unavailable();
        const results = await runSqliteAdmittedBatch(database, originals.map(item => item.native), admissionNow());
        // Record only the exact original owned bind after original COMMIT
        // returns. A late denied/unknown ACK never undoes or retries it.
        acceptedMetadata = deletionMetadata;
        if (results.length !== items.length) throw unavailable();
        // Preserve original D1 change counts and three original item ordinals;
        // no extra SQL or fallback between the original mutations.
        return results.map(result => ({ meta: { changes: configurationSqlInteger(result.meta.totalChanges, "Original Sample record changes") } }));
      },
    });
    const result = await removeSampleRecordWithDatabase(port, owner.sampleId, owner.eventId, owner.actor);
    await runSqliteAdmittedBatch(database, [], admissionNow()); selected(request, token);
    return result;
  }
  return Object.freeze({ kind: "unmounted-local-sample-record-remove-permission-v28/1" as const, capture, perform,
    discard() { active = false; } });
}
