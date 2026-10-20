import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { MAX_SPLIT_PIECES } from "../../shared/types";
import { createSampleSplitService } from "../../worker/samples/split-service";
import type { SampleSplitDatabase, SampleSplitStatement } from "../../worker/samples/split-sql";
import { CURRENT_SAMPLE_STRUCTURE_SQL } from "../../worker/sample-structure-query";
import { readSqlFileAuthorityMode } from "../../worker/files/authority-mode";
import type { ReadSqlCell } from "../../worker/runtime/read-sql";
import { configurationSqlCell, configurationSqlInteger, configurationSqlRow } from "../../worker/runtime/configuration-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";

declare const sampleSplitPermissionBrand: unique symbol;
export interface SampleSplitPermissionRequest {
  readonly kind: "unmounted-current-sample-split-permission-v28/1";
  readonly [sampleSplitPermissionBrand]: true;
}
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  sampleId: string; actor: string; tokenHash: string;
  credentialRevision: bigint; sessionCreatedAt: bigint;
}>;
const unavailable = () => new HTTPException(503, { message: "Current media-free Sample split permissions are unavailable" });
const denied = () => new HTTPException(403, { message: "Current Sample edit and explicit Sample creation permission are required" });
const memberWhere = "i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";

// Select exactly the mature current accepted structure. Unrelated historical
// media is not a global disable flag; relevant execution/inherited bytes are
// unavailable in this first slice before their keys can be projected.
const MEDIA_FREE = `SELECT 1 admitted WHERE
  NOT EXISTS(SELECT 1 FROM run_step_assets rsa
    WHERE rsa.role='execution' AND rsa.deleted_at IS NULL
      AND rsa.run_step_id=(SELECT step_id FROM (${CURRENT_SAMPLE_STRUCTURE_SQL})))
  AND NOT EXISTS(SELECT 1 FROM state_representation_assets sra
    WHERE sra.state_hash=(SELECT state_hash FROM (${CURRENT_SAMPLE_STRUCTURE_SQL})))`;

/** Unmounted genuine V28 Sample split only. Original Sample edit/manage and
 * the actual active member's explicit createSample flag are independent rights
 * inside each native BEGIN. New restricted roots and named initial managers
 * join the complete original business/audit batch; no creator/admin backfill,
 * live Template grant, media opening, schema/default activation or host exists.
 * The composer retains the original Request in its physical withWriter scope
 * and discards this owner only after all original operations have settled. */
export function createLocalSampleSplitPermissionV28Candidate(options: {
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
  const requests = new WeakMap<SampleSplitPermissionRequest, Captured>(), consumed = new WeakSet<SampleSplitPermissionRequest>();
  let active = true;
  function selected(request: Request, token: SampleSplitPermissionRequest): Captured {
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
      { statement: database.prepare(`SELECT 1 admitted FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
        WHERE ${memberWhere} AND m.can_create_samples=1 LIMIT 1`).bind(localIssuer, owner.facts.subject), rejection: denied() },
      { statement: database.prepare(`SELECT 1 admitted FROM samples s
        JOIN collaboration_resources root ON root.root_kind='sample' AND root.root_id=s.id
        JOIN collaboration_grants g ON g.root_kind=root.root_kind AND g.root_id=root.root_id
        JOIN collaboration_identities i ON i.member_id=g.member_id JOIN collaboration_members m ON m.member_id=i.member_id
        WHERE s.id=? AND s.deleted_at IS NULL AND ${memberWhere} AND g.enabled=1 AND g.capability IN('edit','manage') LIMIT 1`)
        .bind(owner.sampleId, localIssuer, owner.facts.subject), rejection: denied() },
      { statement: database.prepare(`SELECT 1 admitted FROM system_recovery_maintenance WHERE singleton=1 AND state='open'
        AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
        AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='legacy')`), rejection: unavailable() },
      { statement: database.prepare(MEDIA_FREE).bind(owner.sampleId, owner.sampleId, owner.sampleId,
        owner.sampleId, owner.sampleId, owner.sampleId), rejection: unavailable() },
    ]; // Six original fresh guards, below the unchanged core bound eight.
  }
  async function capture(request: Request, sampleId: string): Promise<SampleSplitPermissionRequest> {
    if (!active || request.method !== "POST" || request.bodyUsed || !canonicalIdentityText(sampleId, 256)) throw denied();
    const url = new URL(request.url);
    if (url.pathname !== `/api/samples/${encodeURIComponent(sampleId)}/split` || [...url.searchParams.keys()].length) throw denied();
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request, subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash, facts.subject); issuer.read(request, subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({ kind: "unmounted-current-sample-split-permission-v28/1" as const }) as SampleSplitPermissionRequest;
    requests.set(token, Object.freeze({ request, subject, facts, sampleId, actor, tokenHash,
      credentialRevision: row.credential_revision, sessionCreatedAt: row.created_at }));
    return token;
  }
  async function perform(request: Request, token: SampleSplitPermissionRequest, readInput: () => Promise<unknown>) {
    const owner = selected(request, token); if (consumed.has(token)) throw denied(); consumed.add(token);
    const admissionNow = () => { selected(request, token); return createSqliteBatchAdmission(database, checks(owner)); };
    await runSqliteAdmittedBatch(database, [], admissionNow());
    const value = await readInput(); selected(request, token);
    const statements = new WeakMap<SampleSplitStatement, SqliteStatement>(); let mutationAccepted = false;
    const wrap = (native: SqliteStatement): SampleSplitStatement => {
      const statement: SampleSplitStatement = Object.freeze({
        bind(...values: ReadSqlCell[]) { return wrap(native.bind(...values.map(configurationSqlCell))); },
        async first() {
          const result = await runSqliteAdmittedBatch(database, [native], admissionNow());
          if (result.length !== 1 || result[0]!.results.length > 1) throw unavailable();
          const row = result[0]!.results[0]; return row === undefined ? null : configurationSqlRow(row);
        },
        async all() {
          const result = await runSqliteAdmittedBatch(database, [native], admissionNow());
          if (result.length !== 1) throw unavailable(); return { results: result[0]!.results.map(configurationSqlRow) };
        },
      }); statements.set(statement, native); return statement;
    };
    const original = (items: readonly SampleSplitStatement[]) => items.map(item => {
      const native = statements.get(item); if (!native) throw denied(); return native;
    });
    const port: SampleSplitDatabase = Object.freeze({
      prepare(sql: string) { return wrap(database.prepare(sql)); },
      async batch() { throw denied(); }, // Group writes require the atomic child-authority coupling below.
    });
    const admit = async (actor: string) => {
      if (actor !== owner.actor) throw denied();
      await runSqliteAdmittedBatch(database, [], admissionNow()); selected(request, token);
    };
    const service = createSampleSplitService({
      database: () => port, authorityDatabase: () => port, fileAuthorityMode: () => readSqlFileAuthorityMode(() => port),
      // Relevant media is denied in the actual same-BEGIN guard, before the
      // inherited helper reaches these provider-independent File branches.
      async resolveConsumerFileId() { throw unavailable(); }, consumerFileBindingFence() { throw unavailable(); },
      admit, now: Date.now, randomId: () => crypto.randomUUID(),
      async commitSplit(source, items) {
        selected(request, token);
        if (mutationAccepted || source.parentId !== owner.sampleId || source.actor !== owner.actor
          || source.childIds.length < 1 || source.childIds.length > MAX_SPLIT_PIECES
          || new Set(source.childIds).size !== source.childIds.length
          || source.childIds.some(id => !canonicalIdentityText(id, 256))
          || items.length !== source.childIds.length * 2 + 2) throw denied();
        const business = original(items), authority: SqliteStatement[] = [];
        for (const id of source.childIds) {
          authority.push(database.prepare(`INSERT INTO collaboration_resources(root_kind,root_id,visibility,revision)
            SELECT 'sample',s.id,'restricted',1 FROM samples s
            WHERE s.id=? AND s.parent_id=? AND s.created_by=? AND s.created_at=? AND s.deleted_at IS NULL`)
            .bind(id, source.parentId, owner.actor, source.createdAt));
          // The initial manager is selected from the genuine current identity
          // mapping/create flag. created_by above proves only this new row's
          // provenance and never resolves a principal or grants a legacy root.
          authority.push(database.prepare(`INSERT INTO collaboration_grants(root_kind,root_id,member_id,capability,enabled,revision)
            SELECT 'sample',s.id,(SELECT m.member_id FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
              WHERE ${memberWhere} AND m.can_create_samples=1),'manage',1,1
            FROM samples s JOIN collaboration_resources root ON root.root_kind='sample' AND root.root_id=s.id
            WHERE s.id=? AND s.parent_id=? AND s.created_by=? AND s.created_at=? AND s.deleted_at IS NULL
              AND root.visibility='restricted' AND root.revision=1`)
            .bind(localIssuer, owner.facts.subject, id, source.parentId, owner.actor, source.createdAt));
        }
        // No added SQL is interleaved with original changes()-adjacent state
        // writes or child audits. Return only the original result positions.
        const results = await runSqliteAdmittedBatch(database, [...business, ...authority], admissionNow());
        mutationAccepted = true;
        if (results.length !== business.length + authority.length) throw unavailable();
        const accepted = results.slice(0, business.length).map(result => ({
          meta: { changes: configurationSqlInteger(result.meta.totalChanges, "Original Sample split changes") },
        }));
        for (let child = 0; child < source.childIds.length; child++) {
          if (accepted[child * 2]!.meta.changes !== 0
            && (configurationSqlInteger(results[business.length + child * 2]!.meta.directChanges, "Split resource changes") !== 1
              || configurationSqlInteger(results[business.length + child * 2 + 1]!.meta.directChanges, "Split manager changes") !== 1)) throw unavailable();
        }
        return accepted;
      },
    });
    const result = await service.split(owner.sampleId, value, owner.actor);
    selected(request, token); return result;
  }
  return Object.freeze({ kind: "unmounted-local-sample-split-permission-v28/1" as const, capture, perform,
    discard() { active = false; } });
}
