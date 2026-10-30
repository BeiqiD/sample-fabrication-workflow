import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { createMetrologyDefinitionService } from "../../worker/process-definition/metrology-definition-service";
import { METROLOGY_DEFINITION_CREATE_SQL, type MetrologyDefinitionDatabase, type MetrologyDefinitionStatement } from "../../worker/process-definition/metrology-definition-sql";
import type { ReadSqlCell } from "../../worker/runtime/read-sql";
import { configurationSqlInteger, configurationSqlRow } from "../../worker/runtime/configuration-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";

declare const creationPermissionBrand: unique symbol;
export interface MetrologyTemplateCreationRequest {
  readonly kind: "unmounted-current-metrology-template-creation-v28/1";
  readonly [creationPermissionBrand]: true;
}
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  actor: string; tokenHash: string; credentialRevision: bigint; sessionCreatedAt: bigint;
}>;
const unavailable = () => new HTTPException(503, { message: "Current Metrology Template creation is unavailable" });
const denied = () => new HTTPException(403, { message: "Current explicit Template creation permission is required" });
const changed = () => new HTTPException(409, { message: "This Template creation changed. Reload before continuing." });
const memberWhere = "i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";

/** The original text-only Metrology creator, with a genuine current Request.
 * Four original business statements and the new family policy share one BEGIN.
 * No creator, admin, Sample, imported identifier, File or supplied flag grants
 * Template creation. The enclosing stopped composer retains the original work
 * and drains it before discarding this factory or releasing its physical lease. */
export function createLocalMetrologyTemplateCreationV28Candidate(options: {
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
  const requests = new WeakMap<MetrologyTemplateCreationRequest, Captured>();
  const consumed = new WeakSet<MetrologyTemplateCreationRequest>(); let active = true;
  function selected(request: Request, token: MetrologyTemplateCreationRequest): Captured {
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
        .bind(installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256, installation.createdAt, bootstrapPrincipalId, initializedAt), rejection: unavailable() },
      { statement: database.prepare(`SELECT 1 admitted FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id WHERE ${memberWhere} LIMIT 1`)
        .bind(localIssuer, owner.facts.subject), rejection: denied() },
      { statement: database.prepare(`SELECT 1 admitted FROM system_recovery_maintenance WHERE singleton=1 AND state='open'
        AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
        AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode IN('legacy','active'))`), rejection: unavailable() },
    ];
  }
  async function capture(request: Request): Promise<MetrologyTemplateCreationRequest> {
    const url = new URL(request.url);
    if (!active || request.method !== "POST" || request.bodyUsed || url.pathname !== "/api/metrology-templates"
      || url.search || url.hash) throw denied();
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request, subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || !canonicalIdentityText(facts.subject, 256)) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash, facts.subject); issuer.read(request, subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({ kind: "unmounted-current-metrology-template-creation-v28/1" as const }) as MetrologyTemplateCreationRequest;
    requests.set(token, Object.freeze({ request, subject, facts, actor, tokenHash,
      credentialRevision: row.credential_revision, sessionCreatedAt: row.created_at })); return token;
  }
  async function create(request: Request, token: MetrologyTemplateCreationRequest, readInput: () => Promise<unknown>) {
    const owner = selected(request, token);
    if (consumed.has(token)) throw denied(); consumed.add(token);
    const familyId = crypto.randomUUID(), templateId = crypto.randomUUID(), stepId = crypto.randomUUID();
    const ids = [familyId, templateId, stepId]; let nextId = 0, committed = false;
    function admissionForCurrentOperation() {
      selected(request, token); const guards = checks(owner);
      if (!committed) {
        guards.push({ statement: database.prepare(`SELECT 1 admitted FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
          WHERE ${memberWhere} AND m.can_create_templates=1 LIMIT 1`).bind(localIssuer, owner.facts.subject), rejection: denied() });
        guards.push({ statement: database.prepare(`SELECT 1 admitted WHERE NOT EXISTS(SELECT 1 FROM recipe_families WHERE id=?)
          AND NOT EXISTS(SELECT 1 FROM template_versions WHERE id=?) AND NOT EXISTS(SELECT 1 FROM template_steps WHERE id=?)
          AND NOT EXISTS(SELECT 1 FROM collaboration_resources WHERE root_kind='template' AND root_id=?)`)
          .bind(familyId, templateId, stepId, familyId), rejection: changed() });
      } else {
        guards.push({ statement: database.prepare(`SELECT 1 admitted FROM recipe_families rf JOIN template_versions tv ON tv.recipe_family_id=rf.id
          JOIN collaboration_resources r ON r.root_kind='template' AND r.root_id=rf.id
          JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id
          JOIN collaboration_identities i ON i.member_id=g.member_id JOIN collaboration_members m ON m.member_id=i.member_id
          WHERE rf.id=? AND tv.id=? AND rf.archived_at IS NULL AND tv.archived_at IS NULL AND tv.deleted_at IS NULL
            AND ${memberWhere} AND g.enabled=1 AND g.capability='manage' LIMIT 1`)
          .bind(familyId, templateId, localIssuer, owner.facts.subject), rejection: denied() });
      }
      return createSqliteBatchAdmission(database, guards); // At most six owned guards.
    }
    type Issued = { native: SqliteStatement; sql: string; values: readonly ReadSqlCell[] };
    const issued = new WeakMap<MetrologyDefinitionStatement, Issued>();
    function wrap(native: SqliteStatement, sql: string, values: readonly ReadSqlCell[]): MetrologyDefinitionStatement {
      const statement: MetrologyDefinitionStatement = Object.freeze({
        bind(...input: ReadSqlCell[]) { const captured = Object.freeze([...input]); return wrap(native.bind(...captured), sql, captured); },
        async first() { throw denied(); }, async run() { throw denied(); },
      }); issued.set(statement, { native, sql, values }); return statement;
    }
    const port: MetrologyDefinitionDatabase = Object.freeze({
      prepare(sql: string) {
        if (!METROLOGY_DEFINITION_CREATE_SQL.includes(sql)) throw denied();
        return wrap(database.prepare(sql), sql, Object.freeze([]));
      },
      async atomicBatch(items: readonly MetrologyDefinitionStatement[]) {
        if (committed || nextId !== 3 || items.length !== 4) throw denied();
        const original = items.map((item, index) => {
          const value = issued.get(item);
          if (!value || value.sql !== METROLOGY_DEFINITION_CREATE_SQL[index] || value.values.length !== [4,8,6,4][index]) throw denied();
          return value;
        });
        if (original[0]!.values[0] !== familyId || original[2]!.values[0] !== templateId
          || original[2]!.values[1] !== familyId || original[3]!.values[0] !== stepId
          || original[3]!.values[1] !== templateId || original[0]!.values[2] !== owner.actor
          || original[2]!.values[4] !== owner.actor) throw denied();
        const statements = [...original.map(value => value.native),
          database.prepare("INSERT INTO collaboration_resources(root_kind,root_id,visibility,revision) VALUES('template',?,'restricted',1)").bind(familyId),
          database.prepare(`INSERT INTO collaboration_grants(root_kind,root_id,member_id,capability,enabled,revision)
            VALUES('template',?,(SELECT m.member_id FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
              WHERE ${memberWhere} AND m.can_create_templates=1),'manage',1,1)`).bind(familyId, localIssuer, owner.facts.subject),
        ];
        const results = await runSqliteAdmittedBatch(database, statements, admissionForCurrentOperation());
        if (results.length !== 6 || results.slice(4).some(row => row.meta.directChanges !== 1)) throw unavailable();
        committed = true;
        return results.slice(0,4).map(result => ({ changes: configurationSqlInteger(result.meta.directChanges, "Metrology Template creation direct changes", 0), results: result.results.map(configurationSqlRow) }));
      },
    });
    const service = createMetrologyDefinitionService({ database: () => port, now: Date.now,
      randomId() { if (nextId >= ids.length) throw denied(); return ids[nextId++]!; },
      async admit(actor: string) {
        if (actor !== owner.actor) throw denied();
        await runSqliteAdmittedBatch(database, [], admissionForCurrentOperation()); selected(request, token);
      },
    });
    return service.create(readInput, owner.actor);
  }
  return Object.freeze({ capture, create, discard() { active = false; } });
}
