import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { createSampleReadService } from "../../worker/samples/read-service";
import type { ReadSqlCell, ReadSqlDatabase, ReadSqlStatement } from "../../worker/runtime/read-sql";
import { configurationSqlRow } from "../../worker/runtime/configuration-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability,
  type SqliteRow, type SqliteStatement } from "../sqlite";
import { SAMPLE_DETAIL_SOURCE_CAPTURE_SQL, SAMPLE_DETAIL_SOURCE_CHECK_SQL,
  SAMPLE_DETAIL_TEXT_ELIGIBILITY_SQL } from "./sample-detail-source-sql";

declare const sampleDetailV28Brand: unique symbol;
export interface SampleDetailV28Request {
  readonly kind: "unmounted-sample-text-detail-v28/1";
  readonly [sampleDetailV28Brand]: true;
}
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  id: string; processing: boolean; actor: string;
  tokenHash: string; credentialRevision: bigint; createdAt: bigint;
}>;
const unavailable = () => new HTTPException(503, { message: "Current text-only Sample history is unavailable" });
const denied = () => new HTTPException(403, { message: "Current Sample membership is required" });
const hidden = () => new HTTPException(404, { message: "Sample not found" });
const changed = () => new HTTPException(409, { message: "Sample history changed. Reload before reading." });
const memberWhere = "i.provider=? AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";
function sameRows(left: readonly SqliteRow[], right: readonly SqliteRow[]): boolean {
  return left.length === right.length && left.every((row, i) => {
    const other = right[i]!, keys = Object.keys(row).sort();
    return keys.join("\0") === Object.keys(other).sort().join("\0") && keys.every(key => {
      const a = row[key], b = other[key];
      return a instanceof Uint8Array ? b instanceof Uint8Array && a.length === b.length && a.every((v, j) => v === b[j]) : Object.is(a, b);
    });
  });
}

/** Separate unmounted V28 original-Request detail owner. It delegates all
 * twelve original queries, typed decoders and serializers. Same-BEGIN guards
 * precede every SQL read, actual visible parent/child and shared Comment roots
 * are filtered before projection, and DATA plus original projected rows are
 * compared again before returning. No mutation, live Template permission,
 * File opening, canonical protocol, default mount or Group activation exists.
 * The host retains the original request in withWriter and discards this owner
 * only after original HTTP/request operations finish, before native closure. */
export function createLocalSampleDetailReadV28Candidate(options: {
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
  const requests = new WeakMap<SampleDetailV28Request, Captured>(); let active = true;
  function selected(request: Request, token: SampleDetailV28Request): Captured {
    const owner = requests.get(token);
    if (!active || !owner || owner.request !== request || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    const facts = issuer.read(request, owner.subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || facts.subject !== owner.facts.subject
      || auth.currentSessionPredicate(request, owner.actor).tokenHash !== owner.tokenHash) throw denied();
    return owner;
  }
  function readAdmission(owner: Captured, dependencies?: string) {
    return createSqliteBatchAdmission(database, [
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
        .bind(installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256,
          installation.createdAt, bootstrapPrincipalId, initializedAt), rejection: unavailable() },
      { statement: database.prepare(`SELECT 1 admitted FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id WHERE ${memberWhere} LIMIT 1`)
        .bind(owner.facts.provider, owner.facts.issuer, owner.facts.subject), rejection: denied() },
      { statement: database.prepare(`SELECT 1 admitted FROM samples s
        JOIN collaboration_resources root ON root.root_kind='sample' AND root.root_id=s.id
        CROSS JOIN collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
        LEFT JOIN collaboration_grants grant_row ON grant_row.root_kind=root.root_kind AND grant_row.root_id=root.root_id AND grant_row.member_id=m.member_id
        WHERE s.id=? AND s.deleted_at IS NULL AND ${memberWhere}
          AND (root.visibility='workspace' OR grant_row.enabled=1 AND grant_row.capability IN('read','operate','edit','manage')) LIMIT 1`)
        .bind(owner.id, owner.facts.provider, owner.facts.issuer, owner.facts.subject), rejection: hidden() },
      { statement: database.prepare(`SELECT 1 admitted FROM system_recovery_maintenance maintenance
        WHERE maintenance.singleton=1 AND maintenance.state='open'
          AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
          AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='legacy')`), rejection: unavailable() },
      { statement: database.prepare(SAMPLE_DETAIL_TEXT_ELIGIBILITY_SQL).bind(owner.id), rejection: unavailable() },
      ...(dependencies === undefined ? [] : [{
        statement: database.prepare(SAMPLE_DETAIL_SOURCE_CHECK_SQL).bind(dependencies, owner.id), rejection: changed(),
      }]),
    ]);
  }
  async function capture(request: Request): Promise<SampleDetailV28Request> {
    if (!active || request.method !== "GET" || request.bodyUsed) throw denied();
    const url = new URL(request.url), prefix = "/api/samples/";
    let id: string;
    try { id = decodeURIComponent(url.pathname.slice(prefix.length)); } catch { throw denied(); }
    if (!url.pathname.startsWith(prefix) || !canonicalIdentityText(id, 256)
      || url.pathname !== `${prefix}${encodeURIComponent(id)}`) throw denied();
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request, subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash, facts.subject);
    issuer.read(request, subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({ kind: "unmounted-sample-text-detail-v28/1" }) as SampleDetailV28Request;
    requests.set(token, Object.freeze({ request, subject, facts, id, processing: url.searchParams.get("view") === "processing",
      actor, tokenHash, credentialRevision: row.credential_revision, createdAt: row.created_at }));
    return token;
  }
  async function detail(request: Request, token: SampleDetailV28Request) {
    const owner = selected(request, token), statements = new WeakMap<ReadSqlStatement, SqliteStatement>();
    let dependencies: string | undefined;
    let previous: Readonly<{ statements: readonly SqliteStatement[]; results: readonly SqliteRow[][] }> | undefined;
    async function read(items: readonly SqliteStatement[]) {
      selected(request, token);
      const originals = dependencies === undefined ? [...items, database.prepare(SAMPLE_DETAIL_SOURCE_CAPTURE_SQL).bind(owner.id)] : items;
      const results = await runSqliteAdmittedBatch(database, originals, readAdmission(owner, dependencies));
      if (results.length !== originals.length) throw new Error("Incomplete original Sample detail acknowledgement");
      if (dependencies === undefined) {
        const rows = results[items.length]!.results;
        if (rows.length !== 1 || typeof rows[0]?.state !== "string") throw new Error("Incomplete Sample source dependency capture");
        dependencies = rows[0].state;
      }
      selected(request, token); return results.slice(0, items.length);
    }
    function wrap(native: SqliteStatement): ReadSqlStatement {
      const statement: ReadSqlStatement = Object.freeze({
        bind(...values: ReadSqlCell[]) { return wrap(native.bind(...values)); },
        async first() { const row = (await read([native]))[0]!.results[0]; return row === undefined ? null : configurationSqlRow(row); },
        async all() { return { results: (await read([native]))[0]!.results.map(configurationSqlRow) }; },
      }); statements.set(statement, native); return statement;
    }
    const db: ReadSqlDatabase = Object.freeze({ prepare(sql: string) { return wrap(database.prepare(sql)); } });
    const admit = async (actor: string) => {
      if (actor !== owner.actor) throw denied();
      const results = await read(previous?.statements ?? []);
      if (previous && results.some((result, index) => !sameRows(previous!.results[index]!, result.results))) throw changed();
    };
    const service = createSampleReadService({ database: () => db, admit, visibility: owner.facts,
      visibilitySchemaVersion: 2, detailProjection: "text-history-v28",
      async readMany(items) {
        if (previous || items.length !== (owner.processing ? 10 : 12)) throw unavailable();
        const originals = Object.freeze(items.map(item => { const native = statements.get(item); if (!native) throw denied(); return native; }));
        const results = (await read(originals)).map(result => result.results);
        previous = Object.freeze({ statements: originals, results }); return results.map(rows => rows.map(configurationSqlRow));
      },
    });
    const result = await service.detail(owner.id, key => key === "view" && owner.processing ? "processing" : undefined, owner.actor);
    selected(request, token); return result;
  }
  return Object.freeze({ kind: "unmounted-local-sample-text-detail-v28/1" as const, capture, detail,
    discard() { active = false; } });
}
