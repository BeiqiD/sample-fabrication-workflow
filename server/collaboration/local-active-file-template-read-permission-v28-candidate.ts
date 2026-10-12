import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { createTemplateReadService, type TemplateDirectoryInput, type TemplateReadService } from "../../worker/process-definition/read-service";
import { configurationSqlRow } from "../../worker/runtime/configuration-sql";
import { FileAuthorityUnavailableError } from "../../worker/files/authority-mode";
import type { ReadSqlCell, ReadSqlDatabase, ReadSqlStatement } from "../../worker/runtime/read-sql";
import { publishedTemplateVersionSql } from "../../worker/template-publication";
import { hashInitialSubstrateRepresentation, sha256Hex, stableJson, STATE_HASH_SCHEME, SUBSTRATE_STATE_HASH_SCHEME } from "../../shared/content-addressing";
import { parseInitialSubstrateStep } from "../../worker/process-definition/substrate";
import { TEMPLATE_READ_ACTIVE_FILE_AFFILIATION_SQL, TEMPLATE_READ_ACTIVE_FILE_STATE_SQL,
  TEMPLATE_READ_ACTIVE_FILE_PROFILES_SQL, TEMPLATE_READ_ACTIVE_FILE_SUBSTRATE_ROWS_SQL } from "../../worker/application/template-read-active-file-fence-sql";
import { ownedLocalVolumeProfileContextV28Candidate, type LocalVolumeProfileOpeningV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate";
import { captureLocalVolumeProfileAuthority, createLocalVolumeFileAuthorityDatabase, prepareLocalVolumeProfileAuthorityFence,
  type LocalVolumeProfileAuthority } from "../storage/local-volume-profile-opening";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteRow, type SqliteStatement } from "../sqlite";

type Operation = "options" | "families" | "versions" | "metrology" | "list" | "detail";
type Scope = Readonly<{ operation: Operation; id?: string; input: Readonly<TemplateDirectoryInput>; picker: boolean }>;
type Captured = Readonly<{
  request: Request; url: string; scope: Scope; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  actor: string; tokenHash: string; credentialRevision: bigint; sessionCreatedAt: bigint;
}>;
const unavailable = () => new HTTPException(503, { message: "Current Template collaboration reads are unavailable" });
const denied = () => new HTTPException(403, { message: "Current recipe-family read permission is required" });
const changed = () => new HTTPException(409, { message: "This Template directory changed. Reload before continuing." });
const memberWhere = "i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";

function scopeFor(request: Request): Scope {
  if (request.method !== "GET" || request.bodyUsed || request.body !== null) throw denied();
  const url = new URL(request.url);
  let operation: Operation, id: string | undefined;
  if (url.pathname === "/api/template-families/options") operation = "options";
  else if (url.pathname === "/api/template-families") operation = "families";
  else if (url.pathname === "/api/metrology-templates") operation = "metrology";
  else if (url.pathname === "/api/templates") operation = "list";
  else {
    const family = /^\/api\/template-families\/([^/]+)\/versions$/.exec(url.pathname);
    const version = /^\/api\/templates\/([^/]+)$/.exec(url.pathname);
    const raw = family?.[1] ?? version?.[1];
    if (!raw) throw denied();
    try { id = decodeURIComponent(raw); } catch { throw denied(); }
    if (!canonicalIdentityText(id, 256) || encodeURIComponent(id) !== raw) throw denied();
    operation = family ? "versions" : "detail";
  }
  const allowed = operation === "families" || operation === "metrology" ? ["q", "page", "pageSize"]
    : operation === "versions" ? ["q"] : operation === "list" ? ["view"] : [];
  if (url.hash || [...url.searchParams.keys()].some(key => !allowed.includes(key))) throw denied();
  return Object.freeze({ operation, ...(id === undefined ? {} : { id }), picker: url.searchParams.get("view") === "picker",
    input: Object.freeze({ query: url.searchParams.get("q") ?? undefined, page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined }) });
}
function sameRows(left: readonly SqliteRow[], right: readonly SqliteRow[]) {
  return left.length === right.length && left.every((row, index) => {
    const other = right[index]!, keys = Object.keys(row).sort();
    return keys.join("\0") === Object.keys(other).sort().join("\0") && keys.every(key => {
      const a = row[key], b = other[key];
      return a instanceof Uint8Array ? b instanceof Uint8Array && a.length === b.length && a.every((v, i) => v === b[i]) : Object.is(a, b);
    });
  });
}

/** Explicit opt-in active Local File metadata owner. The six mature neutral
 * read algorithms, DTOs, ordering and locked-reader behavior remain unchanged.
 * Native File references and source URLs are metadata, never a byte grant. The
 * legacy owner and every default mount remain protected. */
export function createLocalActiveFileTemplateReadPermissionV28Candidate(options: {
  database: SqliteCapability; nativeDatabase: DatabaseSync; admission: ReviewedInstallationAdmission;
  writerLease: LinuxWriterLease; authentication: object; opening: LocalVolumeProfileOpeningV28Candidate;
}) {
  if (Object.keys(options).sort().join(',') !== 'admission,authentication,database,nativeDatabase,opening,writerLease') throw unavailable();
  const { database, nativeDatabase, admission, writerLease, authentication, opening } = options;
  const physical = ownedLocalVolumeProfileContextV28Candidate(opening);
  if (physical.database !== database || physical.nativeDatabase !== nativeDatabase || physical.writerLease !== writerLease) throw unavailable();
  physical.assertCurrent();
  const auth = localAuthenticationIdentityAuthority(authentication);
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  const policy = assertInstalledLocalIdentityOwner(auth.identity, database, nativeDatabase, admission);
  const installation = Object.freeze({ ...assertInstallationAdmission(nativeDatabase, admission) });
  if (installation.checkpointId !== "portable-runtime/v28" || physical.installationId !== installation.installationId
    || physical.installationCheckpointId !== installation.checkpointId) throw unavailable();
  const runtime = nativeDatabase.prepare(`SELECT g.incarnation FROM file_authority_control a JOIN file_authority_runtime_guard g
    ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active'`).get();
  if (typeof runtime?.incarnation !== "string" || !runtime.incarnation) throw unavailable();
  const incarnation = runtime.incarnation;
  const control = nativeDatabase.prepare("SELECT schema_version,enforcement,revision FROM collaboration_control WHERE singleton=1").get();
  if (control?.schema_version !== 2 || !["disabled", "enabled"].includes(control.enforcement as string)
    || typeof control.revision !== "number" || !Number.isSafeInteger(control.revision) || control.revision < 1) throw unavailable();
  const sentinel = nativeDatabase.prepare("SELECT bootstrap_principal_id,initialized_at FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'").get();
  if (typeof sentinel?.bootstrap_principal_id !== "string" || typeof sentinel.initialized_at !== "number"
    || !Number.isSafeInteger(sentinel.initialized_at) || sentinel.initialized_at < 0) throw unavailable();
  const bootstrapPrincipalId = sentinel.bootstrap_principal_id, initializedAt = sentinel.initialized_at;
  const localIssuer = `node-installation:${installation.installationId}`;
  const issuer = createLocalRequestSubjectIssuer({ database, nativeDatabase, admission, writerLease, authentication });
  const consumed = new WeakSet<Request>(), pending = new Set<Promise<unknown>>();
  let active = true, accepting = true, closing: Promise<void> | undefined;

  function selected(owner: Captured) {
    if (!active || owner.request.url !== owner.url || owner.request.method !== "GET" || owner.request.bodyUsed
      || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    physical.assertCurrent();
    const facts = issuer.read(owner.request, owner.subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || facts.subject !== owner.facts.subject
      || auth.currentSessionPredicate(owner.request, owner.actor).tokenHash !== owner.tokenHash) throw denied();
  }
  async function capture(request: Request, operation: Operation, actor: string): Promise<Captured> {
    if (!active || !(request instanceof Request) || consumed.has(request)) throw denied();
    const url = request.url, scope = scopeFor(request); if (scope.operation !== operation) throw denied();
    consumed.add(request);
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request, subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || actor !== `local-account:${facts.subject}`) throw denied();
    if (auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash, facts.subject); issuer.read(request, subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const owner = Object.freeze({ request, url, scope, subject, facts, actor, tokenHash,
      credentialRevision: row.credential_revision, sessionCreatedAt: row.created_at });
    selected(owner); return owner;
  }
  const readableFamily = `EXISTS(SELECT 1 FROM main.recipe_families rf
    JOIN main.collaboration_resources r ON r.root_kind='template' AND r.root_id=rf.id
    JOIN main.collaboration_identities i ON i.provider='local' AND i.issuer=? AND i.subject=?
    JOIN main.collaboration_members m ON m.member_id=i.member_id
    WHERE rf.id=tv.recipe_family_id AND rf.archived_at IS NULL AND i.enabled=1 AND m.state='active'
      AND (r.visibility='workspace' OR EXISTS(SELECT 1 FROM main.collaboration_grants g
        WHERE g.root_kind=r.root_kind AND g.root_id=r.root_id AND g.member_id=i.member_id
          AND g.enabled=1 AND g.capability IN('read','edit','manage'))))`;
  function filteredPrefix() {
    // Only this private source prefix changes. Every mature SELECT, search,
    // order, LIMIT, count, decoder and payload runs against these current rows.
    return `WITH template_versions AS (SELECT tv.* FROM main.template_versions tv
      WHERE tv.deleted_at IS NULL AND ${publishedTemplateVersionSql("tv")} AND ${readableFamily}),
      template_steps AS (SELECT ts.* FROM main.template_steps ts
        JOIN template_versions visible_version ON visible_version.id=ts.template_version_id) `;
  }
  function rich(owner: Captured) { return owner.scope.operation === "detail" || owner.scope.operation === "list" && !owner.scope.picker; }
  function fileStatement(owner: Captured, sql: string) {
    return database.prepare(sql).bind(localIssuer, owner.facts.subject, owner.scope.operation === "detail" ? owner.scope.id! : null);
  }
  function checks(owner: Captured, fileState?: string) {
    selected(owner);
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
        .bind(installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256, installation.createdAt, bootstrapPrincipalId, initializedAt), rejection: unavailable() },
      { statement: database.prepare(`SELECT 1 admitted FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id WHERE ${memberWhere} LIMIT 1`)
        .bind(localIssuer, owner.facts.subject), rejection: denied() },
      { statement: database.prepare(`SELECT 1 admitted FROM system_recovery_maintenance WHERE singleton=1 AND state='open'
        AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
        AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g
          ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active' AND g.incarnation=?)`)
        .bind(incarnation), rejection: unavailable() },
    ];
    if (owner.scope.operation === "versions") {
      // An authorized live family with no eligible process versions keeps the
      // mature empty-list behavior. Publication is still filtered per version.
      guards.push({ statement: database.prepare(`SELECT 1 admitted FROM main.recipe_families request_family
        WHERE request_family.id=? AND ${readableFamily.replace("tv.recipe_family_id", "request_family.id")} LIMIT 1`)
        .bind(owner.scope.id!, localIssuer, owner.facts.subject), rejection: denied() });
    } else if (owner.scope.operation === "detail") {
      guards.push({ statement: database.prepare(`SELECT 1 admitted FROM main.template_versions tv
        WHERE tv.id=? AND tv.deleted_at IS NULL AND ${publishedTemplateVersionSql("tv")} AND ${readableFamily} LIMIT 1`)
        .bind(owner.scope.id!, localIssuer, owner.facts.subject), rejection: denied() });
    }
    if (rich(owner)) {
      guards.push({ statement: fileStatement(owner, `SELECT 1 admitted WHERE EXISTS (${TEMPLATE_READ_ACTIVE_FILE_AFFILIATION_SQL})`), rejection: unavailable() });
      if (fileState !== undefined) guards.push({ statement: database.prepare(`SELECT 1 admitted
        WHERE (${TEMPLATE_READ_ACTIVE_FILE_STATE_SQL}) IS ?4`)
        .bind(localIssuer, owner.facts.subject, owner.scope.operation === "detail" ? owner.scope.id! : null, fileState), rejection: changed() });
    }
    return guards; // Four base + optional family/detail + affiliation + exact source CAS: maximum7, below core8.
  }
  async function validateSources(rows: readonly SqliteRow[]) {
    for (const row of rows) {
      if (typeof row.templateVersionId !== "string" || typeof row.templateContentJson !== "string") throw unavailable();
      let substrate: ReturnType<typeof parseInitialSubstrateStep>;
      try { substrate = parseInitialSubstrateStep(row.templateContentJson); } catch { throw unavailable(); }
      if (substrate && typeof row.initialStateHash !== "string") throw unavailable();
      if (row.stateHash === null) {
        if (row.initialStateHash !== null) throw unavailable();
        continue;
      }
      if (typeof row.stateHash !== "string" || !/^[0-9a-f]{64}$/.test(row.stateHash)
        || typeof row.stateContentJson !== "string" || typeof row.assetHashesJson !== "string") throw unavailable();
      let canonical: unknown, aliases: unknown;
      try { canonical = JSON.parse(row.stateContentJson); aliases = JSON.parse(row.assetHashesJson); }
      catch { throw unavailable(); }
      if (!canonical || typeof canonical !== "object" || Array.isArray(canonical) || !Array.isArray(aliases)) throw unavailable();
      const state = canonical as Record<string, unknown>, hashes = state.assetHashes;
      if (!Array.isArray(hashes) || hashes.some(hash => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
        || state.schema !== row.stateHashScheme || state.type !== row.stateType
        || !(state.schema === STATE_HASH_SCHEME && state.type === "diagram"
          || state.schema === SUBSTRATE_STATE_HASH_SCHEME && state.type === "substrate")) throw unavailable();
      // The original derivation collapses repeated asset IDs in its alias map,
      // while canonical assetHashes retains original duplicates. Validate the
      // retained alias positions and coverage without inventing new aliases.
      const actual = new Set<string>();
      for (const value of aliases) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
        const alias = value as Record<string, unknown>;
        if (typeof alias.position !== "number" || !Number.isSafeInteger(alias.position) || alias.position < 0
          || typeof alias.sha256 !== "string" || hashes[alias.position] !== alias.sha256) throw unavailable();
        actual.add(alias.sha256);
      }
      if (hashes.some(hash => !actual.has(hash))) throw unavailable();
      if (await sha256Hex(stableJson(canonical)) !== row.stateHash) throw unavailable();
      if (row.stateHash === row.initialStateHash) {
        if (substrate) {
          let original: Awaited<ReturnType<typeof hashInitialSubstrateRepresentation>>;
          try { original = await hashInitialSubstrateRepresentation(substrate, hashes as string[]); } catch { throw unavailable(); }
          if (original.hash !== row.initialStateHash || stableJson(original.canonical) !== stableJson(canonical)) throw unavailable();
        }
      }
    }
  }
  async function perform<T>(request: Request, operation: Operation, actor: string,
    run: (service: TemplateReadService, owner: Captured) => Promise<T>): Promise<T> {
    const owner = await capture(request, operation, actor);
    let fileState: string | undefined;
    let physicalProfiles: readonly LocalVolumeProfileAuthority[] = Object.freeze([]);
    const observations: Array<{ statement: SqliteStatement; rows: SqliteRow[] }> = [];
    const originalReads: Promise<unknown>[] = [];
    function retainRead<R>(original: Promise<R>): Promise<R> {
      originalReads.push(original);
      // The mature detail array can await authority before Promise.all owns
      // its earlier reads. Observe the exact public promise immediately; its
      // caller still receives that original value or rejection unchanged.
      original.then(() => undefined, () => undefined);
      return original;
    }
    // Only original issued batch rejection identities are retained. This is a
    // failed-operation witness, never a permission success or reusable grant.
    let firstGuardRejection: HTTPException | undefined;
    let failedOriginalBatch = false, firstOriginalBatchFailure: unknown;
    const guardedBatch = async (statements: readonly SqliteStatement[]) => {
      const currentChecks = checks(owner, fileState), admission = createSqliteBatchAdmission(database, currentChecks);
      const physicalView = physicalProfiles.length ? createLocalVolumeFileAuthorityDatabase(opening, physicalProfiles) : undefined;
      const fences = physicalView ? physicalProfiles.map(profile => physicalView.nativeStatement(
        prepareLocalVolumeProfileAuthorityFence(profile, physicalView))) : [];
      try {
        const results = await runSqliteAdmittedBatch(database, [...fences, ...statements], admission);
        if (results.length !== fences.length + statements.length) throw unavailable();
        selected(owner); return results.slice(fences.length);
      }
      catch (error) {
        if (error instanceof HTTPException && currentChecks.some(check => check.rejection === error)) {
          // Core throws this exact rejection only after confirmed rollback.
          firstGuardRejection ??= error;
        } else if (!failedOriginalBatch) {
          // An uncertain rollback or original native failure must never be
          // replaced by a permission denial or the compatibility fallback.
          failedOriginalBatch = true; firstOriginalBatchFailure = error;
        }
        throw error;
      }
    };
    // Read true scalar Native source facts under current permission before any
    // mature rich response. The resulting string is only an immutable compare
    // witness; every subsequent read and ACK rechecks it inside the same BEGIN.
    if (rich(owner)) {
      const source = await guardedBatch([fileStatement(owner, TEMPLATE_READ_ACTIVE_FILE_STATE_SQL),
        fileStatement(owner, TEMPLATE_READ_ACTIVE_FILE_PROFILES_SQL), fileStatement(owner, TEMPLATE_READ_ACTIVE_FILE_SUBSTRATE_ROWS_SQL)]);
      const state = source[0];
      if (state?.results.length !== 1 || typeof state.results[0]?.state !== "string") throw unavailable();
      fileState = state.results[0].state;
      if (Buffer.byteLength(fileState) > 1024 * 1024) throw new HTTPException(413, { message: "Template source state exceeds this candidate's limit" });
      const profiles = source[1];
      if (!profiles || profiles.results.length > 32) throw unavailable();
      const profileIds = profiles.results.map(row => {
        if (Object.keys(row).length !== 1 || typeof row.profileId !== "string" || !row.profileId) throw unavailable();
        return row.profileId;
      });
      if (new Set(profileIds).size !== profileIds.length) throw unavailable();
      physicalProfiles = Object.freeze(profileIds.map(profileId => captureLocalVolumeProfileAuthority(opening,
        { profileId, configurationRevision: 1 }, "read")));
      if (!source[2]) throw unavailable();
      await validateSources(source[2].results);
      await guardedBatch([]);
    }
    const wrap = (sql: string, bindings: readonly ReadSqlCell[]): ReadSqlStatement => {
      if (!/^\s*SELECT\b/i.test(sql)) throw unavailable();
      const statement = database.prepare(filteredPrefix() + sql).bind(localIssuer, owner.facts.subject, ...bindings);
      const read = async () => {
        const results = await guardedBatch([statement]);
        if (results.length !== 1) throw unavailable();
        const rows = results[0]!.results;
        observations.push({ statement, rows: rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
          [key, value instanceof Uint8Array ? Uint8Array.from(value) : value])) as SqliteRow) });
        return rows.map(configurationSqlRow);
      };
      return Object.freeze({ bind(...values: ReadSqlCell[]) { return wrap(sql, values); },
        first() { return retainRead(read().then(rows => rows[0] ?? null)); },
        all() { return retainRead(read().then(results => ({ results }))); } });
    };
    const port: ReadSqlDatabase = Object.freeze({ prepare(sql: string) { return wrap(sql, []); } });
    const original = createTemplateReadService({ database: () => port, authorityDatabase: () => port,
      async admit(currentActor) { if (currentActor !== owner.actor) throw denied(); await guardedBatch([]); } });
    let value: T | undefined, operationFailed = false, originalOperationFailure: unknown;
    try { value = await run(original, owner); }
    catch (error) { operationFailed = true; originalOperationFailure = error; }
    // Await every already-issued public read even if array construction failed
    // before the mature Promise.all. No query is retried or failure made into
    // success; an otherwise swallowed original read also prevents ACK.
    const settledReads = await Promise.allSettled(originalReads);
    if (!operationFailed) {
      const rejected = settledReads.find(result => result.status === "rejected");
      if (rejected?.status === "rejected") {
        operationFailed = true; originalOperationFailure = rejected.reason;
      }
    }
    if (operationFailed) {
      const error = originalOperationFailure;
      // The unchanged Worker authority helper may hide a rejected private
      // read while probing old-schema absence. Restore only actual original
      // batch errors, without retrying any operation, query or payload read.
      if (failedOriginalBatch) {
        if (firstGuardRejection) throw new AggregateError([firstGuardRejection, firstOriginalBatchFailure],
          "Original Template permission rejection and batch failure remain retained");
        if (error === firstOriginalBatchFailure || error instanceof FileAuthorityUnavailableError) throw firstOriginalBatchFailure;
        throw new AggregateError([error, firstOriginalBatchFailure], "Original Template operation and batch failure remain retained");
      }
      if (error instanceof FileAuthorityUnavailableError && firstGuardRejection) throw firstGuardRejection;
      throw error;
    }
    // Operation-local rows are a comparison witness, never permission. Replay
    // ALL exact originals under fresh guards in one genuine BEGIN before ACK.
    // A grant/name/version/count change cannot publish an earlier private row.
    const current = await guardedBatch(observations.map(item => item.statement));
    if (current.length !== observations.length || current.some((row, index) => !sameRows(observations[index]!.rows, row.results))) throw changed();
    selected(owner); return value as T;
  }
  function execute<T>(request: Request, operation: Operation, actor: string,
    run: (service: TemplateReadService, owner: Captured) => Promise<T>): Promise<T> {
    if (!active || !accepting || !(request instanceof Request)) throw denied();
    // Retain the whole genuine operation before capture/auth/native/hash awaits.
    const original = Promise.resolve().then(() => perform(request, operation, actor, run));
    pending.add(original); original.then(() => pending.delete(original), () => pending.delete(original)); return original;
  }
  function service(request: Request): TemplateReadService {
    const directory = (supplied: TemplateDirectoryInput, scope: Scope) => {
      if (supplied.query !== scope.input.query || supplied.page !== scope.input.page || supplied.pageSize !== scope.input.pageSize) throw denied();
      return scope.input;
    };
    return Object.freeze({
      options(actor: string) { return execute(request, "options", actor, (original) => original.options(actor)); },
      families(input: TemplateDirectoryInput, actor: string) { return execute(request, "families", actor, (original, owner) => original.families(directory(input, owner.scope), actor)); },
      versions(id: string, query: string, actor: string) { return execute(request, "versions", actor, (original, owner) => {
        if (id !== owner.scope.id || query !== (owner.scope.input.query?.trim() ?? "")) throw denied();
        return original.versions(owner.scope.id!, query, actor);
      }); },
      metrology(input: TemplateDirectoryInput, actor: string) { return execute(request, "metrology", actor, (original, owner) => original.metrology(directory(input, owner.scope), actor)); },
      list(picker: boolean, actor: string) { return execute(request, "list", actor, (original, owner) => {
        if (picker !== owner.scope.picker) throw denied(); return original.list(picker, actor);
      }); },
      detail(id: string, actor: string) { return execute(request, "detail", actor, (original, owner) => {
        if (id !== owner.scope.id) throw denied(); return original.detail(owner.scope.id!, actor);
      }); },
    });
  }
  return Object.freeze({ kind: "unmounted-current-active-file-template-metadata-read-v28/1" as const, service,
    close(): Promise<void> {
      if (closing) return closing;
      accepting = false;
      closing = Promise.resolve().then(async () => {
        await Promise.allSettled([...pending]); physical.assertCurrent(); active = false;
      }); void closing.catch(() => undefined); return closing;
    },
  });
}
