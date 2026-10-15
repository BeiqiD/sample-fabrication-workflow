import { HTTPException } from "hono/http-exception";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { captureInstalledIdentityExecutionOwner } from "../auth/installed-identity-execution-owner";
import type { ReviewedInstallationAdmission } from "../migrations";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteStatement } from "../sqlite";
import { asFileAuthoritySqlDatabase } from "../file-authority-sql";
import { captureLocalVolumeProfileAuthority, createLocalVolumeFileAuthorityDatabase,
  ownedLocalVolumeProfileContext, prepareLocalVolumeProfileAuthorityFence,
  type LocalVolumeProfileOpening } from "../storage/local-volume-profile-opening";
import { prepareLocalVolumeRoleSelectionFence } from "../storage/local-volume-role-policy";
import { StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";
import { configurationSqlCell, configurationSqlInteger, configurationSqlRow } from "../../worker/runtime/configuration-sql";
import { restoreProjectItemWithDatabase } from "../../worker/projects/attachment-service";
import { removeMetrologyReferenceWithDatabase, restoreMetrologyReferenceWithDatabase } from "../../worker/process-definition/reference-lifecycle-service";
import type { TemplateReferenceLifecycleDatabase } from "../../worker/process-definition/reference-lifecycle-sql";
import type { ProjectAttachmentDatabase, ProjectAttachmentStatement } from "../../worker/projects/attachment-sql";
import type { ProjectWorkspaceStatement } from "../../worker/projects/workspace-sql";
import type { ReadSqlRow } from "../../worker/runtime/read-sql";
import { isProjectApiId, isProjectItemLifecycleInput } from "../../shared/project-api";

/** Unmounted V26 ordinary authenticated system-scope restoration owner.
 * Issues exactly original metrology reference removal/restoration and Project
 * item restoration for one actual transport Request. It issues no provider,
 * raw database, V28 member/root right, general File or administrator grant.
 *
 * The sole host owns the complete original invocation inside its existing
 * writerLease.withWriter and retains settled/dispose before native/physical
 * close. Same-BEGIN session/install/File incarnation/recovery/physical roles
 * precede complete immutable published-parent, source binding, replay and CAS
 * algorithms. Typed restoration checks never select a replacement File.
 */
export function createLocalFileRestorationMetadataExecution(options: {
  opening: LocalVolumeProfileOpening; authentication: object; request: Request;
  actor: string; admission: ReviewedInstallationAdmission;
}) {
  if (Object.keys(options).sort().join(",") !== "actor,admission,authentication,opening,request")
    throw new Error("Local File restoration policy is unavailable");
  const { opening, authentication, request, actor, admission } = options;
  if (!(request instanceof Request) || request.bodyUsed)
    throw new HTTPException(403, { message: "Request admission is required." });
  const pathname = new URL(request.url).pathname;
  const reference = /^\/api\/metrology-templates\/([^/]+)\/references\/([^/]+)$/.exec(pathname);
  const referenceRestore = /^\/api\/metrology-templates\/([^/]+)\/references\/([^/]+)\/restore$/.exec(pathname);
  const projectRestore = /^\/api\/projects\/([^/]+)\/items\/([^/]+)\/restore$/.exec(pathname);
  const selectedOperation = request.method === "DELETE" && reference ? "removeReference"
    : request.method === "POST" && referenceRestore ? "restoreReference"
    : request.method === "POST" && projectRestore ? "restoreProjectItem" : null;
  const match = reference ?? referenceRestore ?? projectRestore;
  if (!selectedOperation || !match)
    throw new HTTPException(403, { message: "Original restoration ingress is required." });
  function decode(value: string): string {
    try {
      const id = decodeURIComponent(value);
      if (!id || id.length > 256 || id.includes("\0") || projectRestore && !isProjectApiId(id)) throw new Error("Invalid identifier");
      return id;
    } catch { throw new HTTPException(400, { message: "A valid restoration identifier is required." }); }
  }
  const rootId = decode(match[1]!), occurrenceId = decode(match[2]!);
  function select(operation: string, selectedRootId: string, selectedOccurrenceId: string): void {
    if (operation !== selectedOperation || selectedRootId !== rootId || selectedOccurrenceId !== occurrenceId)
      throw new HTTPException(403, { message: "Original restoration mutation ingress changed." });
  }
  async function input<T>(guard: (value: unknown) => value is T, message: string): Promise<T> {
    let value: unknown;
    try { value = await request.json(); }
    catch { throw new HTTPException(400, { message: "A valid JSON request body is required" }); }
    if (!guard(value)) throw new HTTPException(400, { message });
    return value;
  }
  const owner = ownedLocalVolumeProfileContext(opening);
  const auth = localAuthenticationIdentityAuthority(authentication);
  const identity = captureInstalledIdentityExecutionOwner(auth.identity, owner.database, owner.nativeDatabase, admission);
  const session = auth.currentSessionPredicate(request, actor);
  const installation = identity.installation, idleLifetimeMs = identity.policy.idleLifetimeMs;
  const sentinel = owner.nativeDatabase.prepare("SELECT bootstrap_principal_id,initialized_at FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'").get();
  if (typeof sentinel?.bootstrap_principal_id !== "string" || typeof sentinel.initialized_at !== "number"
    || !Number.isSafeInteger(sentinel.initialized_at)) throw new Error("Local identity installation is unavailable");
  const bootstrapPrincipalId = sentinel.bootstrap_principal_id, initializedAt = sentinel.initialized_at;
  const runtime = owner.nativeDatabase.prepare(`SELECT g.incarnation FROM file_authority_control a JOIN file_authority_runtime_guard g
    ON g.singleton=a.singleton AND g.enabled=1 JOIN file_shadow_checkpoints cp ON cp.id=g.incarnation
    WHERE a.singleton=1 AND a.mode='active'`).get();
  if (typeof runtime?.incarnation !== "string" || !runtime.incarnation)
    throw new HTTPException(503, { message: "Active local File restoration writes are unavailable." });
  const incarnation = runtime.incarnation;
  const selectRoles = owner.nativeDatabase.prepare(`SELECT d.role,d.storage_profile_id,d.storage_profile_revision,d.policy_revision,d.created_at
    FROM storage_role_defaults d JOIN storage_role_policy_revisions h ON h.role=d.role AND h.policy_revision=d.policy_revision
      AND h.storage_profile_id=d.storage_profile_id AND h.storage_profile_revision=d.storage_profile_revision AND h.created_at=d.created_at
    ORDER BY d.role`);
  selectRoles.setReadBigInts(true); const roles = selectRoles.all();
  const [internal, originals] = roles;
  if (roles.length !== 2 || internal?.role !== "internal" || originals?.role !== "originals"
    || typeof internal.storage_profile_id !== "string" || typeof originals.storage_profile_id !== "string"
    || internal.storage_profile_revision !== 1n || originals.storage_profile_revision !== 1n
    || internal.policy_revision !== originals.policy_revision || internal.created_at !== originals.created_at)
    throw new HTTPException(503, { message: "Active local File restoration writes are unavailable." });
  const policyRevision = configurationSqlInteger(internal.policy_revision, "localFile.restorationPolicyRevision", 3);
  const authorities = [captureLocalVolumeProfileAuthority(opening,
    { profileId: internal.storage_profile_id, configurationRevision: 1 }, "read"),
  captureLocalVolumeProfileAuthority(opening, { profileId: originals.storage_profile_id, configurationRevision: 1 }, "read")];
  const targets = Object.freeze({ internal: Object.freeze({ id: internal.storage_profile_id, configurationRevision: 1 as const,
    namespaceIdentity: authorities[0]!.profile.namespaceIdentity }), originals: Object.freeze({ id: originals.storage_profile_id,
    configurationRevision: 1 as const, namespaceIdentity: authorities[1]!.profile.namespaceIdentity }) });
  const graph = createLocalVolumeFileAuthorityDatabase(opening, authorities);
  let used = false, closing = false;
  let resolveSettled!: () => void, rejectSettled!: (error: unknown) => void;
  const settled = new Promise<void>((resolve, reject) => { resolveSettled = resolve; rejectSettled = reject; });
  settled.then(() => undefined, () => undefined);
  function current(): void {
    owner.assertCurrent(); identity.assertCurrent(); graph.primary();
    if (closing || localAuthenticationIdentityAuthority(authentication) !== auth || auth.captureSessionDigest(request) !== session.tokenHash)
      throw new HTTPException(403, { message: "Request admission is required." });
  }
  function admissionChecks(lease?: Readonly<{ id: string; generation: number }>) {
    current();
    const authenticated = owner.database.prepare(`SELECT 1 AS admitted FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
      CROSS JOIN (WITH observed AS MATERIALIZED (SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now) SELECT now FROM observed) clock
      WHERE s.token_hash=? AND ('local-account:' || a.principal_id)=? AND a.enabled=1 AND a.credential_revision=s.credential_revision
        AND s.revoked_at IS NULL AND typeof(clock.now)='integer' AND clock.now BETWEEN 0 AND 9007199254740991
        AND clock.now>=s.last_seen_at AND clock.now<s.absolute_expires_at AND clock.now<s.last_seen_at+?
        AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1') LIMIT 1`)
      .bind(session.tokenHash, session.actor, idleLifetimeMs);
    const installed = owner.database.prepare(`SELECT 1 AS admitted WHERE EXISTS(SELECT 1 FROM node_installation
      WHERE singleton=1 AND installation_id=? AND catalog_id=? AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
      AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'
        AND bootstrap_principal_id=? AND initialized_at=?)`)
      .bind(installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256,
        installation.createdAt, bootstrapPrincipalId, initializedAt);
    const activeFile = owner.database.prepare(`SELECT 1 AS admitted FROM file_authority_control a JOIN file_authority_runtime_guard g
      ON g.singleton=a.singleton AND g.enabled=1 JOIN file_shadow_checkpoints cp ON cp.id=g.incarnation
      WHERE a.singleton=1 AND a.mode='active' AND g.incarnation=?`).bind(incarnation);
    // Preserve zero UNRELATED persisted writers. Only this exact original
    // acquired lease is exempt; expiry never proves an owner settled.
    const recovery = lease ? owner.database.prepare(`SELECT 1 AS admitted FROM system_recovery_maintenance m
      JOIN system_recovery_write_leases l ON l.id=? AND l.generation=? AND l.owner=? AND l.kind='http' AND l.released_at IS NULL
      WHERE m.singleton=1 AND ((m.state='open' AND m.generation=l.generation)
        OR(m.state='draining' AND m.generation=l.generation+1))
        AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases other WHERE other.released_at IS NULL AND other.id<>l.id)`).bind(lease.id, lease.generation, actor)
      : owner.database.prepare("SELECT 1 AS admitted FROM system_recovery_maintenance WHERE singleton=1 AND state='open' AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)");
    return createSqliteBatchAdmission(owner.database, [
      { statement: authenticated, rejection: new HTTPException(401, { message: "Authentication is required." }) },
      { statement: installed, rejection: new HTTPException(503, { message: "Installation write admission is unavailable." }) },
      { statement: activeFile, rejection: new HTTPException(503, { message: "Active local File restoration writes are unavailable." }) },
      { statement: recovery, rejection: new HTTPException(503, { message: "Source mutations are paused for system recovery." }) },
    ]);
  }
  function originalGraphGuards(): SqliteStatement[] {
    current();
    return [...authorities.map(authority => graph.nativeStatement(prepareLocalVolumeProfileAuthorityFence(authority, graph))),
      graph.nativeStatement(prepareLocalVolumeRoleSelectionFence(graph, policyRevision, targets))];
  }
  interface Statement extends ProjectAttachmentStatement {
    bind(...values: unknown[]): Statement;
    all<Row = ReadSqlRow>(): Promise<{ results: Row[] }>;
  }
  type Database = ProjectAttachmentDatabase & TemplateReferenceLifecycleDatabase<Statement>;
  async function run<T>(operation: (database: Database) => Promise<T>): Promise<T> {
    if (used) throw new Error("Original LocalFile restoration execution was already consumed");
    used = true;
    const original = (async () => {
      const id = crypto.randomUUID(), createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.parse(createdAt) + 300_000).toISOString();
      const cleanup = asFileAuthoritySqlDatabase(owner.database, { assertHeld: owner.assertCurrent });
      let lease: Readonly<{ id: string; generation: number }> | undefined;
      let acquisition: Promise<void> | undefined, release: Promise<unknown> | undefined;
      async function acquire(): Promise<void> {
        if (acquisition) return acquisition;
        acquisition = (async () => {
          const rows = await runSqliteAdmittedBatch(owner.database, [...originalGraphGuards(), owner.database.prepare(`INSERT INTO system_recovery_write_leases
            (id,owner,kind,generation,created_at,expires_at) SELECT ?,?,'http',generation,?,? FROM system_recovery_maintenance
            WHERE singleton=1 AND state='open' RETURNING id,generation`).bind(id, actor, createdAt, expiresAt)], admissionChecks());
          current(); const row = rows.at(-1)?.results[0];
          if (!row || row.id !== id) throw new HTTPException(503, { message: "Source mutations are paused for system recovery." });
          lease = Object.freeze({ id, generation: configurationSqlInteger(row.generation, "localFile.restorationSourceLeaseGeneration") });
        })();
        acquisition.then(() => undefined, () => undefined); return acquisition;
      }
      async function execute(statements: readonly SqliteStatement[]) {
        if (!lease) throw new Error("Original restoration source lease was not acquired");
        const guards = originalGraphGuards();
        const result = await runSqliteAdmittedBatch(owner.database, [...guards, ...statements], admissionChecks(lease));
        current(); return result.slice(guards.length);
      }
      const prepared = new WeakMap<Statement, SqliteStatement>();
      // Preserve exact native int64/blob rows. The original Project row
      // decoders alone check each domain integer/geometry boundary.
      function row(value: Record<string, unknown>) { return configurationSqlRow(value); }
      function wrap(statement: SqliteStatement): Statement {
        const view: Statement = Object.freeze({
          bind(...values: unknown[]) { current(); return wrap(statement.bind(...values.map(configurationSqlCell))); },
          async first<Row>() { const value = (await execute([statement]))[0]?.results[0] ?? null;
            return value === null ? null : row(value) as Row; },
          async all<Row>() { return { results: (await execute([statement]))[0]!.results.map(value => row(value) as Row) }; },
          async run() { return { changes: configurationSqlInteger((await execute([statement]))[0]!.meta.directChanges, "Restoration.directChanges") }; },
        });
        prepared.set(view, statement); return view;
      }
      function selected(items: readonly ProjectWorkspaceStatement[]): SqliteStatement[] {
        return items.map(item => {
          const statement = prepared.get(item as Statement);
          if (!statement) throw new Error("Restoration metadata statement ownership is unavailable");
          return statement;
        });
      }
      async function batch(items: readonly ProjectWorkspaceStatement[]) {
        return (await execute(selected(items))).map(value => {
          const changes = configurationSqlInteger(value.meta.directChanges, "Restoration.directChanges");
          return { results: value.results.map(row), changes, meta: { changes } };
        });
      }
      const database: Database = Object.freeze({
        nativeAssetAdapter: "local" as const,
        nativeAssetProfileIds: Object.freeze([targets.internal.id, targets.originals.id] as const),
        prepare(sql: string) { current(); return wrap(owner.database.prepare(sql)); },
        readBatch: batch, atomicBatch: batch,
        async mutation(statement: Statement) {
          return { changes: configurationSqlInteger((await execute(selected([statement])))[0]!.meta.directChanges, "Restoration.directChanges") };
        },
        primary() { current(); owner.database.primary(); return database; },
        async authorityMode() {
          const value = (await execute([owner.database.prepare("SELECT mode FROM file_authority_control WHERE singleton=1")]))[0]?.results[0];
          if (value?.mode !== "active") throw new HTTPException(503, { message: "Active local File restoration writes are unavailable." });
          return "active" as const;
        },
      });
      let answer: T | undefined, cause: unknown, failed = false;
      try {
        await acquire();
        answer = await operation(database);
        // Original accepted metadata survives a revoked final ACK. This is a
        // fresh actual admitted read, not an awaited callback as session proof.
        if (lease) await execute([owner.database.prepare("SELECT 1 AS admitted")]);
      } catch (error) {
        failed = true; cause = error;
        if (!lease && acquisition) {
          // Unknown original acquisition ACK: retain only its exact receipt;
          // never retry SQL, begin domain work, or treat expiry as settlement.
          try {
            const row = await cleanup.primary().prepare(`SELECT id,generation FROM system_recovery_write_leases
              WHERE id=? AND owner=? AND kind='http' AND created_at=? AND expires_at=? AND released_at IS NULL`)
              .bind(id, actor, createdAt, expiresAt).first();
            if (row) lease = Object.freeze({ id, generation: configurationSqlInteger(row.generation, "localFile.restorationSourceLeaseGeneration") });
          } catch (cleanupCause) {
            closing = true;
            throw new StorageProfileCleanupError(cause, cleanupCause, { owner: Object.freeze({ opening, actor, id, acquisition }), dispose: () => settled });
          }
        }
      }
      closing = true;
      if (lease) {
        try {
          // Original-owner-only settlement remains allowed after principal
          // revocation; physical/current native ownership is still mandatory.
          const at = new Date().toISOString();
          release = (async () => {
            owner.assertCurrent();
            const releaseStatement = cleanup.primary().prepare(`UPDATE system_recovery_write_leases SET released_at=?
              WHERE id=? AND owner=? AND kind='http' AND generation=? AND created_at=? AND released_at IS NULL`)
              .bind(at, lease!.id, actor, lease!.generation, createdAt);
            const receipt = await cleanup.nativeStatement(releaseStatement).run();
            if (configurationSqlInteger(receipt.meta.directChanges, "Restoration.sourceLeaseReleaseChanges") !== 1)
              throw new Error("Original restoration source lease close is unproven");
            const acknowledged = await cleanup.primary().prepare(`SELECT released_at FROM system_recovery_write_leases
              WHERE id=? AND owner=? AND kind='http' AND generation=? AND created_at=?`)
              .bind(lease!.id, actor, lease!.generation, createdAt).first();
            if (acknowledged?.released_at !== at) throw new Error("Original restoration source lease close acknowledgement is unavailable");
            owner.assertCurrent();
          })();
          release.then(() => undefined, () => undefined); await release;
        } catch (cleanupCause) {
          throw new StorageProfileCleanupError(cause, cleanupCause, {
            owner: Object.freeze({ opening, actor, lease, acquisition, release }), dispose: () => settled,
          });
        }
      }
      if (failed) throw cause; return answer!;
    })();
    original.then(resolveSettled, rejectSettled); return original;
  }
  return Object.freeze({ settled, dispose(): Promise<void> {
    if (!used) { used = true; closing = true; resolveSettled(); } return settled;
  }, removeReference(id: string, referenceId: string) {
    select("removeReference", id, referenceId);
    return run(database => removeMetrologyReferenceWithDatabase(database, id, referenceId, actor));
  }, restoreReference(id: string, referenceId: string) {
    select("restoreReference", id, referenceId);
    return run(database => restoreMetrologyReferenceWithDatabase(database, id, referenceId));
  }, restoreProjectItem(id: string, itemId: string) {
    select("restoreProjectItem", id, itemId);
    return run(async database => restoreProjectItemWithDatabase(database, id, itemId,
      await input(isProjectItemLifecycleInput, "Invalid Project item restore request"), actor));
  } });
}
