import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import type { CreateRecordInput } from "../../shared/types";
import { createSampleRecordWithDatabase } from "../../worker/samples/record-service";
import type { SampleFileMetadataDatabase, SampleFileMetadataStatement } from "../../worker/samples/file-metadata-sql";
import { configurationSqlCell, configurationSqlInteger, configurationSqlRow } from "../../worker/runtime/configuration-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";

declare const sampleRecordPermissionBrand: unique symbol;
export interface SampleRecordPermissionRequest {
  readonly kind: "unmounted-current-sample-record-permission-v28/1";
  readonly [sampleRecordPermissionBrand]: true;
}
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  sampleId: string; actor: string; tokenHash: string;
  credentialRevision: bigint; sessionCreatedAt: bigint;
}>;
const unavailable = () => new HTTPException(503, { message: "Current text-only Sample record permissions are unavailable" });
const denied = () => new HTTPException(403, { message: "Current Sample operation permission is required" });
const memberWhere = "i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";

/** Unmounted genuine V28 routine text-record creation only. The mature
 * operation records status/location/pinned and optional text under current
 * Sample operate/edit/manage; it never changes title, code or workflow. Each
 * original SQL read and complete mutation batch rechecks the same Request,
 * current installed identity/member/root inside BEGIN. Unsupported supplied
 * media is refused before any private asset/File/key read. No Group grant is
 * inferred from the neutral donor or ordinary V26 File system-scope owner.
 * The future host retains the full original request in its physical withWriter
 * and discards this factory only after original operations settle. */
export function createLocalSampleRecordPermissionV28Candidate(options: {
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
  const requests = new WeakMap<SampleRecordPermissionRequest, Captured>(), consumed = new WeakSet<SampleRecordPermissionRequest>();
  let active = true;
  function selected(request: Request, token: SampleRecordPermissionRequest): Captured {
    const owner = requests.get(token);
    if (!active || !owner || owner.request !== request || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
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
        WHERE s.id=? AND s.deleted_at IS NULL AND ${memberWhere} AND g.enabled=1 AND g.capability IN('operate','edit','manage') LIMIT 1`)
        .bind(owner.sampleId, localIssuer, owner.facts.subject), rejection: denied() },
      { statement: database.prepare(`SELECT 1 admitted FROM system_recovery_maintenance WHERE singleton=1 AND state='open'
        AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
        AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='legacy')`), rejection: unavailable() },
    ]; // Four fresh guards, below the unchanged core bound eight.
  }
  async function capture(request: Request, sampleId: string): Promise<SampleRecordPermissionRequest> {
    if (!active || request.method !== "POST" || request.bodyUsed || !canonicalIdentityText(sampleId, 256)) throw denied();
    const url = new URL(request.url);
    if (url.pathname !== `/api/samples/${encodeURIComponent(sampleId)}/records` || [...url.searchParams.keys()].length) throw denied();
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request, subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash, facts.subject); issuer.read(request, subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({ kind: "unmounted-current-sample-record-permission-v28/1" as const }) as SampleRecordPermissionRequest;
    requests.set(token, Object.freeze({ request, subject, facts, sampleId, actor, tokenHash,
      credentialRevision: row.credential_revision, sessionCreatedAt: row.created_at }));
    return token;
  }
  async function perform(request: Request, token: SampleRecordPermissionRequest, readInput: () => Promise<unknown>) {
    const owner = selected(request, token); if (consumed.has(token)) throw denied(); consumed.add(token);
    const admissionNow = () => { selected(request, token); return createSqliteBatchAdmission(database, checks(owner)); };
    await runSqliteAdmittedBatch(database, [], admissionNow());
    const supplied = await readInput(); selected(request, token);
    if (supplied === null || typeof supplied !== "object" || Array.isArray(supplied))
      throw new HTTPException(400, { message: "A valid Sample record request is required" });
    // No original asset SELECT or File resolver can execute for this first
    // slice. Even a supplied empty media selector is outside text-only scope.
    const value = Object.freeze({ ...supplied }) as Readonly<CreateRecordInput>;
    for (const name of ["assetKey", "thumbnailKey", "assetId", "thumbnailAssetId"])
      if (Object.hasOwn(value, name)) throw unavailable();
    interface Statement extends SampleFileMetadataStatement<Statement> {}
    const statements = new WeakMap<Statement, SqliteStatement>();
    const wrap = (native: SqliteStatement): Statement => {
      const statement: Statement = Object.freeze({
        bind(...values: unknown[]) { return wrap(native.bind(...values.map(configurationSqlCell))); },
        async first<Row = Record<string, unknown>>(): Promise<Row | null> {
          const result = await runSqliteAdmittedBatch(database, [native], admissionNow());
          if (result.length !== 1 || result[0]!.results.length > 1) throw unavailable();
          const row = result[0]!.results[0]; return row === undefined ? null : configurationSqlRow(row) as Row;
        },
        async all<Row = Record<string, unknown>>(): Promise<{ results: Row[] }> {
          const result = await runSqliteAdmittedBatch(database, [native], admissionNow());
          if (result.length !== 1) throw unavailable(); return { results: result[0]!.results.map(row => configurationSqlRow(row) as Row) };
        },
      }); statements.set(statement, native); return statement;
    };
    const port: SampleFileMetadataDatabase<Statement> = Object.freeze({
      prepare(sql: string) { return wrap(database.prepare(sql)); },
      primary() { selected(request, token); return port; },
      // Original text-only creation never enters a File branch. This selector
      // is not File authority; fail closed if a future algorithm requests it.
      async authorityMode() { throw unavailable(); },
      async atomicBatch(items: Statement[]) {
        const actual = items.map(item => { const native = statements.get(item); if (!native) throw denied(); return native; });
        const results = await runSqliteAdmittedBatch(database, actual, admissionNow());
        if (results.length !== items.length) throw unavailable();
        // Preserve the donor's original D1 changes semantics, including the
        // mature status history triggers; no extra SQL between original items.
        return results.map(result => ({ meta: { changes: configurationSqlInteger(result.meta.totalChanges, "Original Sample record changes") } }));
      },
    });
    const result = await createSampleRecordWithDatabase(port, owner.sampleId, value, owner.actor);
    await runSqliteAdmittedBatch(database, [], admissionNow()); selected(request, token);
    return result;
  }
  return Object.freeze({ kind: "unmounted-local-sample-record-permission-v28/1" as const, capture, perform,
    discard() { active = false; } });
}
