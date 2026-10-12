import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import type { RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { isReferenceTarget, isReferenceTargetType, MAX_REFERENCE_RESOLUTION_TARGETS, type ReferenceTarget, type ReferenceTargetType } from "../../shared/reference-types";
import { createReferenceReadService } from "../../worker/references/read-service";
import { ReferenceResolutionInputError, type ReferenceSourceReadDatabase } from "../../worker/references/read-resolver";
import { ReferenceChildrenInputError } from "../../worker/references/read-children";
import { ReferenceSearchInputError } from "../../worker/references/read-search";
import type { ReferenceCandidateReadDatabase } from "../../worker/references/read-policy-sql";
import type { ReadSqlCell, ReadSqlDatabase, ReadSqlRow, ReadSqlStatement } from "../../worker/runtime/read-sql";
import { configurationSqlCell, configurationSqlRow } from "../../worker/runtime/configuration-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";
import { REFERENCE_FILTERED_MODES_SQL, REFERENCE_FILTERED_DEPENDENCIES_SQL, REFERENCE_FILTERED_DEPENDENCIES_CHECK_SQL,
  referenceFilteredSearchSql, referenceFilteredChildrenSql, referenceCandidateDependenciesSql } from "./reference-filtered-read-sql";

declare const referenceReadV28Brand: unique symbol;
export interface ReferenceReadV28Request {
  readonly kind: "unmounted-current-reference-filtered-read-v28/1";
  readonly [referenceReadV28Brand]: true;
}
type Operation = "resolve" | "children" | "search";
type Captured = Readonly<{ request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  operation: Operation; actor: string; tokenHash: string; credentialRevision: bigint; createdAt: bigint }>;
type Dependency = readonly [ReferenceTargetType, string, string, string, string];
const unavailable = () => new HTTPException(503, { message: "Current collaboration Reference reads are unavailable" });
const denied = () => new HTTPException(403, { message: "Current collaboration Reference read permission is required" });
const changed = () => new HTTPException(409, { message: "Reference provenance changed. Reload before reading." });
const key = (target: ReferenceTarget) => `${target.type}\0${target.id}`;
const memberWhere = "i.provider=? AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";

/** Unmounted original Request-owned metadata reads for all nine reference types.
 * Search and children select current-readable candidates before their ORIGINAL
 * native per-type/child limits, pooled limit, count and truncated decisions.
 * Explicit resolve delegates the full mature source/registry/destination code;
 * hidden rows are genuinely absent, while authorized neutral Gone delegates an
 * empty source-ID JSON to the original adapter and retains only readable history.
 *
 * This object owns no Native/FD/Host or physical close. Its authentic composer
 * must retain this WHOLE operation and discard it before closing its sole core
 * and original physical lease. Every issued native read, including final ACK,
 * runs through that SAME core/lease with fresh identity, current member/root and
 * complete captured DATA checks inside actual BEGIN. No default mount, File or
 * provider byte capability, serialized grant, admin or creator shortcut exists. */
export function createLocalReferenceReadV28Candidate(options: {
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
  const requests = new WeakMap<ReferenceReadV28Request, Captured>(), consumed = new WeakSet<ReferenceReadV28Request>();
  let active = true;
  function selected(request: Request, token: ReferenceReadV28Request) {
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
  async function capture(request: Request): Promise<ReferenceReadV28Request> {
    if (!active || request.method !== "POST" || request.bodyUsed) throw denied();
    const url = new URL(request.url), operations: readonly Operation[] = ["resolve", "children", "search"];
    const operation = operations.find(name => url.pathname === `/api/references/${name}`);
    if (!operation || url.search) throw denied();
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
    const token = Object.freeze({ kind: "unmounted-current-reference-filtered-read-v28/1" }) as ReferenceReadV28Request;
    requests.set(token, Object.freeze({ request, subject, facts, operation, actor, tokenHash, credentialRevision: row.credential_revision, createdAt: row.created_at }));
    selected(request, token); return token;
  }

  async function perform(request: Request, token: ReferenceReadV28Request) {
    const owner = selected(request, token);
    if (consumed.has(token)) throw denied(); consumed.add(token);
    const member: ReadSqlCell[] = [owner.facts.provider, owner.facts.issuer, owner.facts.subject];
    const capturedTargets = new Map<string, ReferenceTarget>(), capturedRows = new Map<string, readonly Dependency[]>();
    let readQueue: Promise<void> = Promise.resolve(), readsOpen = true, failed = false, firstFailure: unknown;
    function admission() {
      selected(request, token);
      const targets = JSON.stringify([...capturedTargets.values()]), rows = JSON.stringify([...capturedRows.values()].flat());
      return createSqliteBatchAdmission(database, [
        ...identityChecks(owner),
        ...(capturedTargets.size ? [{ statement: database.prepare(REFERENCE_FILTERED_DEPENDENCIES_CHECK_SQL)
          .bind(...member, targets, rows), rejection: changed() }] : []),
      ]); // At most FOUR original native guard SELECTs, below the core limit8.
    }
    function enqueue<T>(work: () => Promise<T>): Promise<T> {
      if (!readsOpen) return Promise.reject(failed ? firstFailure : denied());
      const original = readQueue.then(async () => {
        if (failed) throw firstFailure;
        try { return await work(); }
        catch (error) { if (!failed) { failed = true; firstFailure = error; } throw error; }
      });
      // Serialise preparation as well as execution. Promise.all in the mature
      // nine adapters remains original; later admissions include ALL DATA
      // already captured by preceding queued reads, not an early empty snapshot.
      readQueue = original.then(() => undefined, () => undefined);
      return original;
    }
    async function nativeRead(items: readonly SqliteStatement[]) {
      const result = await runSqliteAdmittedBatch(database, items, admission());
      if (result.length !== items.length) throw new Error("Incomplete original Reference read acknowledgement");
      selected(request, token); return result;
    }
    function targetsFromJson(value: ReadSqlCell, type?: ReferenceTargetType): ReferenceTarget[] {
      if (typeof value !== "string") throw new Error("Original Reference JSON binding required");
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed) || parsed.length > MAX_REFERENCE_RESOLUTION_TARGETS) throw new Error("Original Reference ID bounds unavailable");
      const targets: ReferenceTarget[] = parsed.map(value => {
        const target: unknown = type === undefined ? value : { type, id: value };
        if (!isReferenceTarget(target) || target.id.trim() !== target.id) throw new Error("Invalid original Reference identity binding");
        return Object.freeze({ type: target.type, id: target.id });
      });
      return [...new Map(targets.map(target => [key(target), target])).values()];
    }
    function captureDependencies(rows: readonly ReadSqlRow[]) {
      const groups = new Map<string, Dependency[]>();
      for (const row of rows) {
        if (!isReferenceTargetType(row.target_type) || typeof row.target_id !== "string"
          || ![row.kind, row.ordinal, row.state].every(cell => typeof cell === "string")) throw new Error("Incomplete Reference DATA projection");
        const target = { type: row.target_type, id: row.target_id };
        if (!isReferenceTarget(target)) throw new Error("Invalid Reference DATA identity");
        const id = key(target), list = groups.get(id) ?? [];
        list.push(Object.freeze([target.type, target.id, row.kind as string, row.ordinal as string, row.state as string]));
        groups.set(id, list);
      }
      for (const [id, list] of groups) {
        const previous = capturedRows.get(id);
        if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(list)) throw changed();
        const first = list[0]!;
        capturedTargets.set(id, Object.freeze({ type: first[0], id: first[1] }));
        capturedRows.set(id, Object.freeze(list));
      }
      // 9 search batches include 151 returned candidates each; original pool
      // resolution/children cannot add an unbounded caller source set. This is
      // a private safety ceiling, not a truncation or substitute search limit.
      if (capturedTargets.size > 1800) throw new Error("Original bounded Reference DATA set exceeded");
    }
    function originalSelect(sql: string) {
      if (!/^\s*SELECT\b/i.test(sql) || /;/.test(sql)) throw new Error("Code-owned original Reference SELECT required");
      return sql;
    }
    function statement(work: (values: readonly ReadSqlCell[]) => Promise<{ results: ReadSqlRow[] }>, bound?: readonly ReadSqlCell[]): ReadSqlStatement {
      return Object.freeze({
        bind(...values: ReadSqlCell[]) {
          if (bound !== undefined) throw new Error("Original Reference statement was already bound");
          return statement(work, Object.freeze(values.map(configurationSqlCell)));
        },
        async all() {
          if (bound === undefined) throw new Error("Original Reference values must be bound before reading");
          return enqueue(() => work(bound));
        },
        async first() { const result = await this.all(); return result.results[0] ?? null; },
      });
    }
    function scopedOriginalDatabase(type?: ReferenceTargetType): ReadSqlDatabase {
      return Object.freeze({ prepare(sql: string) {
        originalSelect(sql);
        return statement(async values => {
          if (values.length !== 1) throw new Error("Original Reference scoped JSON arity changed");
          const requested = targetsFromJson(values[0]!, type), json = JSON.stringify(requested);
          const capture = await nativeRead([
            database.prepare(REFERENCE_FILTERED_MODES_SQL).bind(...member, json),
            database.prepare(REFERENCE_FILTERED_DEPENDENCIES_SQL).bind(...member, json),
          ]);
          captureDependencies(capture[1]!.results.map(configurationSqlRow));
          const modes = new Map<string, string>();
          for (const row of capture[0]!.results) {
            if (!isReferenceTargetType(row.target_type) || typeof row.target_id !== "string"
              || !["hidden", "neutral", "readable"].includes(row.mode as string)) throw new Error("Invalid native Reference mode");
            modes.set(key({ type: row.target_type, id: row.target_id }), row.mode as string);
          }
          const visible = requested.filter(target => {
            const mode = modes.get(key(target));
            if (mode === undefined || !capturedTargets.has(key(target))) throw new Error("Missing original Reference DATA capture");
            return type === undefined ? mode !== "hidden" : mode === "readable";
          });
          // Full unchanged original source/registry SQL. Neutral source IDs
          // become actual [], while permitted registry history stays genuine.
          const originalJson = JSON.stringify(type === undefined ? visible : visible.map(target => target.id));
          const result = await nativeRead([database.prepare(sql).bind(originalJson)]);
          return { results: result[0]!.results.map(configurationSqlRow) };
        });
      } });
    }
    function candidates(filteredSql: string, type?: ReferenceTargetType) {
      return statement(async values => {
        const result = await nativeRead([
          database.prepare(filteredSql).bind(...member, ...values),
          database.prepare(referenceCandidateDependenciesSql(filteredSql, type)).bind(...member, ...member, ...values),
        ]);
        captureDependencies(result[1]!.results.map(configurationSqlRow));
        // Capture includes the ORIGINAL overflow row before any library slice.
        for (const row of result[0]!.results) {
          const target = { type: type ?? row.target_type, id: row.target_id };
          if (!isReferenceTarget(target) || !capturedTargets.has(key(target))) throw new Error("Original Reference candidate DATA is missing");
        }
        return { results: result[0]!.results.map(configurationSqlRow) };
      });
    }
    const port: ReferenceSourceReadDatabase & ReferenceCandidateReadDatabase = Object.freeze({
      prepare() { throw new Error("Unscoped original Reference query is unavailable"); },
      referenceSourceDatabase: scopedOriginalDatabase,
      referenceRegistryDatabase() { return scopedOriginalDatabase(); },
      referenceSearchStatement(type: ReferenceTargetType, idSql: string, sql: string) {
        return candidates(referenceFilteredSearchSql(type, idSql, sql), type);
      },
      referenceChildrenStatement(parent: ReferenceTarget, sql: string) {
        return candidates(referenceFilteredChildrenSql(parent, sql));
      },
    });
    const service = createReferenceReadService({ database: () => port,
      async admit(actor: string) {
        if (actor !== owner.actor) throw denied();
        await enqueue(async () => { await nativeRead([]); });
      },
    });
    try {
      await enqueue(async () => { await nativeRead([]); }); // Current identity before original body parser.
      let value: unknown;
      try { value = await request.json(); }
      catch { throw new HTTPException(400, { message: "A valid JSON request body is required" }); }
      selected(request, token);
      let result: unknown;
      if (owner.operation === "resolve") {
        const targets = value && typeof value === "object" ? (value as { targets?: unknown }).targets : undefined;
        if (!Array.isArray(targets)) throw new HTTPException(400, { message: "Reference targets are required" });
        if (targets.length < 1 || targets.length > MAX_REFERENCE_RESOLUTION_TARGETS)
          throw new HTTPException(400, { message: `Between 1 and ${MAX_REFERENCE_RESOLUTION_TARGETS} reference targets are required` });
        if (!targets.every(target => isReferenceTarget(target) && target.id.trim() === target.id))
          throw new HTTPException(400, { message: "Every reference target needs a known type and valid stable ID" });
        result = await service.resolve(targets as ReferenceTarget[], owner.actor);
      } else result = owner.operation === "children" ? await service.children(value, owner.actor) : await service.search(value, owner.actor);
      await enqueue(async () => { await nativeRead([]); }); // Final current policy AND entire captured DATA, original BEGIN.
      selected(request, token); return result;
    } catch (error) {
      if (error instanceof ReferenceResolutionInputError || error instanceof ReferenceChildrenInputError || error instanceof ReferenceSearchInputError)
        throw new HTTPException(400, { message: error.message });
      throw error;
    } finally {
      readsOpen = false; // No later adapter continuation can start a new native read.
      // On Promise.all rejection, every originally queued native operation is
      // still held here until settled; no detached read survives whole perform.
      // The private completion tail resolves only after each original outcome
      // settles. Original returned Promises keep their exact rejection; this
      // wait performs no disposal, retry, or replacement of the work error.
      await readQueue;
    }
  }
  return Object.freeze({ capture, perform, discard() { active = false; } });
}
