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
import { configurationSqlCell, configurationSqlInteger, configurationSqlMutation, configurationSqlRow,
  type ConfigurationSqlCell, type ConfigurationSqlDatabase, type ConfigurationSqlStatement } from "../../worker/runtime/configuration-sql";
import { createSampleMetadataService } from "../../worker/samples/metadata-service";

/** A separate, unmounted Sample-metadata policy for an explicitly initialized
 * genuine LocalFile installation. This is not the legacy research factory, an
 * administrator grant, a resource/group grant, or a byte/provider executor.
 * Every original Sample SQL operation retains its mature cells/results, while
 * fresh issued session/install/recovery checks and exact local graph/source
 * guards execute in the same native BEGIN. The host must own settled/dispose.
 * Recovery/upgrade must close and discard this immutable-schema service. */
export function createLocalFileSampleMetadataExecution(options: {
  opening: LocalVolumeProfileOpening; authentication: object; request: Request;
  actor: string; admission: ReviewedInstallationAdmission;
}) {
  if (Object.keys(options).sort().join(",") !== "actor,admission,authentication,opening,request")
    throw new Error("Local File Sample policy is unavailable");
  const { opening, authentication, request, actor, admission } = options;
  if (!(request instanceof Request) || request.bodyUsed)
    throw new HTTPException(403, { message: "Request admission is required." });
  // A real safe-method session Request is not a mutation ingress. This closed
  // factory binds the original method/path to exactly one mature Sample action.
  const pathname = new URL(request.url).pathname;
  const existing = /^\/api\/samples\/([^/]+)(\/restore)?$/.exec(pathname);
  const selectedOperation = request.method === "POST" && pathname === "/api/samples" ? "create"
    : existing && !existing[2] && request.method === "PATCH" ? "update"
    : existing && !existing[2] && request.method === "DELETE" ? "remove"
    : existing && existing[2] === "/restore" && request.method === "POST" ? "restore" : null;
  if (!selectedOperation) throw new HTTPException(403, { message: "Sample mutation ingress is required." });
  let selectedId: string | undefined;
  if (existing) {
    try { selectedId = decodeURIComponent(existing[1]!); }
    catch { throw new HTTPException(400, { message: "A valid sample ID is required." }); }
  }
  function select(operation: string, id?: string): void {
    if (operation !== selectedOperation || id !== selectedId)
      throw new HTTPException(403, { message: "Original Sample mutation ingress changed." });
  }
  const owner = ownedLocalVolumeProfileContext(opening);
  const auth = localAuthenticationIdentityAuthority(authentication);
  const identity = captureInstalledIdentityExecutionOwner(auth.identity, owner.database, owner.nativeDatabase, admission);
  const session = Object.freeze({ tokenHash: auth.captureSessionDigest(request), actor });
  const installation = identity.installation, idleLifetimeMs = identity.policy.idleLifetimeMs;
  const sentinel = owner.nativeDatabase.prepare("SELECT bootstrap_principal_id,initialized_at FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'").get();
  if (typeof sentinel?.bootstrap_principal_id !== "string" || typeof sentinel.initialized_at !== "number"
    || !Number.isSafeInteger(sentinel.initialized_at)) throw new Error("Local identity installation is unavailable");
  const bootstrapPrincipalId = sentinel.bootstrap_principal_id, initializedAt = sentinel.initialized_at;
  const runtime = owner.nativeDatabase.prepare(`SELECT g.incarnation FROM file_authority_control a JOIN file_authority_runtime_guard g
    ON g.singleton=a.singleton AND g.enabled=1 JOIN file_shadow_checkpoints cp ON cp.id=g.incarnation
    WHERE a.singleton=1 AND a.mode='active'`).get();
  if (typeof runtime?.incarnation !== "string" || !runtime.incarnation)
    throw new HTTPException(503, { message: "Active local File Sample writes are unavailable." });
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
    throw new HTTPException(503, { message: "Active local File Sample writes are unavailable." });
  const policyRevision = configurationSqlInteger(internal.policy_revision, "localFile.samplePolicyRevision", 3);
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
      { statement: activeFile, rejection: new HTTPException(503, { message: "Active local File Sample writes are unavailable." }) },
      { statement: recovery, rejection: new HTTPException(503, { message: "Source mutations are paused for system recovery." }) },
    ]);
  }
  function originalGraphGuards(): SqliteStatement[] {
    current();
    return [...authorities.map(authority => graph.nativeStatement(prepareLocalVolumeProfileAuthorityFence(authority, graph))),
      graph.nativeStatement(prepareLocalVolumeRoleSelectionFence(graph, policyRevision, targets))];
  }
  async function run<T>(operation: (service: ReturnType<typeof createSampleMetadataService>) => Promise<T>): Promise<T> {
    if (used) throw new Error("Original LocalFile Sample execution was already consumed");
    used = true;
    const original = owner.writerLease.withWriter(async () => {
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
          lease = Object.freeze({ id, generation: configurationSqlInteger(row.generation, "localFile.sampleSourceLeaseGeneration") });
        })();
        acquisition.then(() => undefined, () => undefined); return acquisition;
      }
      async function execute(statements: readonly SqliteStatement[]) {
        if (!lease) throw new Error("Original Sample source lease was not acquired");
        const guards = originalGraphGuards();
        const result = await runSqliteAdmittedBatch(owner.database, [...guards, ...statements], admissionChecks(lease));
        current(); return result.slice(guards.length);
      }
      const prepared = new WeakMap<ConfigurationSqlStatement, { statement: SqliteStatement; mutation: boolean }>();
      function wrap(statement: SqliteStatement, mutation: boolean): ConfigurationSqlStatement {
        const view: ConfigurationSqlStatement = Object.freeze({
          bind(...values: ConfigurationSqlCell[]) { current(); return wrap(statement.bind(...values.map(configurationSqlCell)), mutation); },
          async first() { const row = (await execute([statement]))[0]?.results[0] ?? null; return row === null ? null : configurationSqlRow(row); },
          async all() { return { results: (await execute([statement]))[0]!.results.map(configurationSqlRow) }; },
        });
        prepared.set(view, { statement, mutation }); return view;
      }
      const database: ConfigurationSqlDatabase = Object.freeze({
        prepare(sql: string) { current(); return wrap(owner.database.prepare(sql), configurationSqlMutation(sql)); },
        async batch(items: readonly ConfigurationSqlStatement[]) {
          const selected = items.map(item => {
            const record = prepared.get(item); if (!record || !record.mutation) throw new Error("Sample metadata only admits its original top-level mutation batch");
            return record.statement;
          });
          return (await execute(selected)).map(value => ({ directChanges: configurationSqlInteger(value.meta.directChanges, "direct changes") }));
        },
        primary() { current(); owner.database.primary(); return database; },
      });
      const service = createSampleMetadataService({ database: () => database, async admit(selectedActor) {
        if (selectedActor !== actor) throw new HTTPException(403, { message: "Request admission is required." });
        await acquire(); await execute([owner.database.prepare("SELECT 1 AS admitted")]);
      }, now: () => Date.now(), randomId: () => crypto.randomUUID() });
      let answer: T | undefined, cause: unknown, failed = false;
      try {
        answer = await operation(service);
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
            if (row) lease = Object.freeze({ id, generation: configurationSqlInteger(row.generation, "localFile.sampleSourceLeaseGeneration") });
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
          release = cleanup.primary().prepare("UPDATE system_recovery_write_leases SET released_at=? WHERE id=? AND generation=? AND released_at IS NULL")
            .bind(new Date().toISOString(), lease.id, lease.generation).run();
          release.then(() => undefined, () => undefined); await release;
        } catch (cleanupCause) {
          throw new StorageProfileCleanupError(cause, cleanupCause, {
            owner: Object.freeze({ opening, actor, lease, acquisition, release }), dispose: () => settled,
          });
        }
      }
      if (failed) throw cause; return answer!;
    });
    original.then(resolveSettled, rejectSettled); return original;
  }
  return Object.freeze({ settled, dispose(): Promise<void> {
    if (!used) { used = true; closing = true; resolveSettled(); } return settled;
  }, create(value: unknown) { select("create"); return run(service => service.create(value, actor)); },
  update(id: string, value: unknown) { select("update", id); return run(service => service.update(id, value, actor)); },
  remove(id: string, value: unknown) { select("remove", id); return run(service => service.remove(id, value, actor)); },
  restore(id: string, value: unknown) { select("restore", id); return run(service => service.restore(id, value, actor)); } });
}
