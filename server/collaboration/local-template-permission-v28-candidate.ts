import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { cloneTemplateWithDatabase, createTemplateStepWithDatabase, updateTemplateStepWithDatabase } from "../../worker/process-definition/template-content-service";
import type { TemplateContentDatabase, TemplateContentStatement } from "../../worker/process-definition/template-content-sql";
import { configurationSqlRow } from "../../worker/runtime/configuration-sql";
import { publishedTemplateVersionSql } from "../../worker/template-publication";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";

declare const templatePermissionBrand: unique symbol;
export interface TemplatePermissionRequest {
  readonly kind: "unmounted-current-template-permission-v28/1";
  readonly [templatePermissionBrand]: true;
}
export type TemplatePermissionScope = Readonly<
  { operation: "clone" | "createStep"; templateId: string; stepId?: never }
  | { operation: "updateStep"; templateId: string; stepId: string }
>;
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  scope: TemplatePermissionScope; actor: string; tokenHash: string;
  credentialRevision: bigint; sessionCreatedAt: bigint;
}>;
interface Statement extends TemplateContentStatement<Statement> {}
type Snapshot = Readonly<{ version: string; steps: string; familyVersions?: string }>;
const unavailable = () => new HTTPException(503, { message: "Current Template collaboration permissions are unavailable" });
const denied = () => new HTTPException(403, { message: "Current explicit recipe-family edit permission is required" });
const changed = () => new HTTPException(409, { message: "This Template changed. Reload before continuing." });
const memberWhere = "i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";

// Fixed, operation-local equality predicates capture exactly the values read by
// the mature algorithms. They are not cached permission or an archive proof.
const VERSION_STATE = `SELECT json_array(tv.id,tv.recipe_family_id,tv.name,tv.template_type,tv.template_kind,tv.version,
  tv.manifest_hash,tv.initial_state_hash,tv.source_filename,tv.source_asset_key,tv.source_file_id,tv.content_json,
  tv.created_by,tv.created_at,tv.locked_at,tv.locked_by,tv.archived_at,tv.archived_by,tv.deleted_at,tv.deleted_by,
  tv.metrology_notes) state FROM template_versions tv WHERE tv.id=?`;
const STEPS_STATE = `SELECT json_group_array(json_array(id,template_version_id,logical_step_key,position,source_row,
  step_number,section_name,definition_hash,expected_state_hash,raw_json)) state FROM
  (SELECT * FROM template_steps WHERE template_version_id=? ORDER BY position,id)`;
const FAMILY_VERSIONS_STATE = `SELECT json_group_array(json_array(id,version)) state FROM
  (SELECT id,version FROM template_versions WHERE recipe_family_id=(SELECT recipe_family_id FROM template_versions WHERE id=?) ORDER BY version,id)`;

/** Unmounted existing-family, text-only mutation owner. No directory, creation
 * of a new family, lifecycle, diagram/provider, File, Sample or admin authority.
 * Each original caller promise stays inside the genuine physical writer owner.
 * Operational V26/defaults and all historical archive catalogs are unchanged. */
export function createLocalTemplatePermissionV28Candidate(options: {
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
  const requests = new WeakMap<TemplatePermissionRequest, Captured>(), consumed = new WeakSet<TemplatePermissionRequest>();
  let active = true;
  function selected(request: Request, token: TemplatePermissionRequest, operation: TemplatePermissionScope["operation"]): Captured {
    const owner = requests.get(token);
    if (!active || !owner || owner.request !== request || owner.scope.operation !== operation
      || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    const facts = issuer.read(request, owner.subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || facts.subject !== owner.facts.subject
      || auth.currentSessionPredicate(request, owner.actor).tokenHash !== owner.tokenHash) throw denied();
    return owner;
  }
  function checks(owner: Captured, snapshot?: Snapshot) {
    const id = owner.scope.templateId;
    const result = [
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
        AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='legacy')`), rejection: unavailable() },
      { statement: database.prepare(`SELECT 1 admitted FROM template_versions tv JOIN recipe_families rf ON rf.id=tv.recipe_family_id
        JOIN collaboration_resources r ON r.root_kind='template' AND r.root_id=rf.id
        JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id
        JOIN collaboration_identities i ON i.member_id=g.member_id JOIN collaboration_members m ON m.member_id=i.member_id
        WHERE tv.id=? AND tv.deleted_at IS NULL AND rf.archived_at IS NULL AND ${publishedTemplateVersionSql("tv")}
          AND ${memberWhere} AND g.enabled=1 AND g.capability IN('edit','manage')
          AND (? IS NULL OR EXISTS(SELECT 1 FROM template_steps ts WHERE ts.id=? AND ts.template_version_id=tv.id)) LIMIT 1`)
        .bind(id, localIssuer, owner.facts.subject, owner.scope.stepId ?? null, owner.scope.stepId ?? null), rejection: denied() },
    ];
    if (snapshot) {
      result.push({ statement: database.prepare(`SELECT 1 admitted WHERE (${VERSION_STATE}) IS ?`).bind(id, snapshot.version), rejection: changed() });
      result.push({ statement: database.prepare(`SELECT 1 admitted WHERE (${STEPS_STATE}) IS ?`).bind(id, snapshot.steps), rejection: changed() });
      if (snapshot.familyVersions !== undefined)
        result.push({ statement: database.prepare(`SELECT 1 admitted WHERE (${FAMILY_VERSIONS_STATE}) IS ?`).bind(id, snapshot.familyVersions), rejection: changed() });
    }
    return result; // At most8 owned checks, preserving the qualified core bound.
  }
  async function capture(request: Request, scopeInput: TemplatePermissionScope): Promise<TemplatePermissionRequest> {
    const { operation, templateId, stepId } = scopeInput;
    const method = operation === "updateStep" ? "PATCH" : operation === "clone" || operation === "createStep" ? "POST" : undefined;
    if (!active || !method || request.method !== method || request.bodyUsed || !canonicalIdentityText(templateId, 256)
      || (operation === "updateStep" ? !canonicalIdentityText(stepId, 256) : stepId !== undefined)) throw denied();
    const suffix = operation === "clone" ? "/clone" : operation === "createStep" ? "/steps" : `/steps/${encodeURIComponent(stepId!)}`;
    const url = new URL(request.url);
    if (url.pathname !== `/api/templates/${encodeURIComponent(templateId)}${suffix}` || [...url.searchParams.keys()].length) throw denied();
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request, subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash, facts.subject); issuer.read(request, subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const scope = Object.freeze({ operation, templateId, ...(stepId === undefined ? {} : { stepId }) }) as TemplatePermissionScope;
    const token = Object.freeze({ kind: "unmounted-current-template-permission-v28/1" as const }) as TemplatePermissionRequest;
    requests.set(token, Object.freeze({ request, subject, facts, scope, actor, tokenHash,
      credentialRevision: row.credential_revision, sessionCreatedAt: row.created_at })); return token;
  }
  async function perform(request: Request, token: TemplatePermissionRequest, operation: TemplatePermissionScope["operation"], readInput?: () => Promise<unknown>) {
    const owner = selected(request, token, operation); if (consumed.has(token)) throw denied(); consumed.add(token);
    const selectAdmission = (snapshot?: Snapshot) => {
      selected(request, token, operation); return createSqliteBatchAdmission(database, checks(owner, snapshot));
    };
    // No denied caller can read even the operation-local source state. Capture
    // all derived inputs in one genuine admitted native transaction.
    const rows = await runSqliteAdmittedBatch(database, [database.prepare(VERSION_STATE).bind(owner.scope.templateId),
      database.prepare(STEPS_STATE).bind(owner.scope.templateId), ...(operation === "clone"
        ? [database.prepare(FAMILY_VERSIONS_STATE).bind(owner.scope.templateId)] : [])], selectAdmission());
    const state = (index: number) => {
      const row = rows[index]; if (row?.results.length !== 1 || typeof row.results[0]?.state !== "string") throw changed();
      const value = row.results[0].state; if (Buffer.byteLength(value) > 1024 * 1024) throw new HTTPException(413, { message: "Template state exceeds this candidate's limit" });
      return value;
    };
    const snapshot: Snapshot = Object.freeze({ version: state(0), steps: state(1), ...(operation === "clone" ? { familyVersions: state(2) } : {}) });
    // This text-only owner cannot copy or attach existing diagram/media aliases.
    const media = await runSqliteAdmittedBatch(database, [database.prepare(`SELECT 1 admitted FROM template_versions tv WHERE tv.id=?
      AND tv.source_asset_key IS NULL AND tv.source_file_id IS NULL AND tv.initial_state_hash IS NULL
      AND NOT EXISTS(SELECT 1 FROM template_steps ts WHERE ts.template_version_id=tv.id AND ts.expected_state_hash IS NOT NULL)`)
      .bind(owner.scope.templateId)], selectAdmission(snapshot));
    if (media[0]?.results.length !== 1) throw unavailable();
    const statements = new WeakMap<Statement, SqliteStatement>(); let mutationAccepted = false;
    const currentAdmission = () => selectAdmission(mutationAccepted ? undefined : snapshot);
    const wrap = (native: SqliteStatement): Statement => {
      const wrapped: Statement = {
        bind(...values) { return wrap(native.bind(...values)); },
        async first<Row>() { const result = await runSqliteAdmittedBatch(database, [native], currentAdmission());
          if (result.length !== 1 || result[0]!.results.length > 1) throw unavailable();
          const row = result[0]!.results[0]; return row === undefined ? null : configurationSqlRow(row) as Row; },
        async all<Row>() { const result = await runSqliteAdmittedBatch(database, [native], currentAdmission());
          if (result.length !== 1) throw unavailable(); return { results: result[0]!.results.map(row => configurationSqlRow(row) as Row) }; },
      };
      statements.set(wrapped, native); return wrapped;
    };
    const port: TemplateContentDatabase<Statement> = Object.freeze({
      prepare(sql: string) { return wrap(database.prepare(sql)); },
      primary() { selected(request, token, operation); return port; },
      async authorityMode() { await runSqliteAdmittedBatch(database, [], currentAdmission()); return "legacy" as const; },
      async atomicBatch(items: Statement[]) {
        if (mutationAccepted) throw denied();
        const original = [...items].map(item => { const owned = statements.get(item); if (!owned) throw denied(); return owned; });
        const results = await runSqliteAdmittedBatch(database, original, currentAdmission());
        mutationAccepted = true;
        return results.map(result => ({ meta: { changes: result.meta.directChanges } }));
      },
    });
    const originalInput = async () => {
      if (!readInput) throw denied(); const value = await readInput(); selected(request, token, operation);
      if (value !== null && typeof value === "object" && ("assetKey" in value && value.assetKey !== undefined || "assetId" in value && value.assetId !== undefined)) throw unavailable();
      return value; // Mature field parser/hash logic receives the original value.
    };
    const value = operation === "clone" ? await cloneTemplateWithDatabase(port, owner.scope.templateId, owner.actor)
      : operation === "createStep" ? await createTemplateStepWithDatabase(port, owner.scope.templateId, originalInput)
        : await updateTemplateStepWithDatabase(port, owner.scope.templateId, owner.scope.stepId!, originalInput);
    // Accepted state remains historical even if current authority no longer
    // permits its ACK. Never compare pre-mutation snapshots after own commit.
    await runSqliteAdmittedBatch(database, [], selectAdmission()); selected(request, token, operation); return value;
  }
  return Object.freeze({ capture,
    clone(request: Request, token: TemplatePermissionRequest) { return perform(request, token, "clone"); },
    createStep(request: Request, token: TemplatePermissionRequest, readInput: () => Promise<unknown>) { return perform(request, token, "createStep", readInput); },
    updateStep(request: Request, token: TemplatePermissionRequest, readInput: () => Promise<unknown>) { return perform(request, token, "updateStep", readInput); },
    discard() { active = false; },
  });
}
