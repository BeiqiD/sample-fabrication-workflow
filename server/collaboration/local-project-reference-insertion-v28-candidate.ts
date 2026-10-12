import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { isProjectApiId, isCreateReferenceProjectItemInput } from "../../shared/project-api";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { createProjectItemMetadataService } from "../../worker/projects/item-metadata-service";
import type { ProjectItemMetadataDatabase } from "../../worker/projects/item-metadata-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { asProjectItemMetadataDatabase } from "../project-item-metadata-sql";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability } from "../sqlite";
import { REFERENCE_FILTERED_MODES_SQL, REFERENCE_FILTERED_DEPENDENCIES_SQL, REFERENCE_FILTERED_DEPENDENCIES_CHECK_SQL } from "./reference-filtered-read-sql";

declare const referenceInsertionBrand: unique symbol;
export interface ProjectReferenceInsertionV28Request {
  readonly kind: "unmounted-current-project-reference-insertion-v28/1";
  readonly [referenceInsertionBrand]: true;
}
type Captured = Readonly<{ request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  projectId: string; actor: string; tokenHash: string; credentialRevision: bigint; createdAt: bigint }>;
const unavailable = () => new HTTPException(503, { message: "Current Project Reference insertion is unavailable" });
const denied = () => new HTTPException(403, { message: "Current Project edit and every Reference source read permission are required" });
const changed = () => new HTTPException(409, { message: "Project Reference identity or source provenance changed. Reload before continuing." });
const memberWhere = "i.provider=? AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";

/** One original source algorithm, two independent authorities. Explicit named
 * destination Project edit/manage never grants the target's actual Sample or
 * live Template-family read, every canonical Comment occurrence, or File bytes.
 * Registry/context DATA is an operation-local comparison witness, never rights.
 * This subordinate issuer owns no native/physical handle and is not a default.
 */
export function createLocalProjectReferenceInsertionV28Candidate(options: {
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
  const requests = new WeakMap<ProjectReferenceInsertionV28Request, Captured>();
  const settlements = new WeakMap<ProjectReferenceInsertionV28Request, {
    completed: boolean; work(): Promise<boolean>; original?: Promise<boolean>;
  }>();
  const consumed = new WeakSet<ProjectReferenceInsertionV28Request>(); let active = true;
  function selected(request: Request, token: ProjectReferenceInsertionV28Request): Captured {
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
        .bind(owner.tokenHash, owner.facts.subject, owner.credentialRevision, owner.createdAt, policy.idleLifetimeMs),
        rejection: new HTTPException(401, { message: "Current local authentication is required" }) },
      { statement: database.prepare(`SELECT 1 admitted WHERE
        EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=? AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
        AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1' AND bootstrap_principal_id=? AND initialized_at=?)
        AND EXISTS(SELECT 1 FROM collaboration_control WHERE singleton=1 AND schema_version=2 AND enforcement='enabled')`)
        .bind(installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256, installation.createdAt, bootstrapPrincipalId, initializedAt), rejection: unavailable() },
      { statement: database.prepare(`SELECT 1 admitted FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id WHERE ${memberWhere} LIMIT 1`)
        .bind(owner.facts.provider, owner.facts.issuer, owner.facts.subject), rejection: denied() },
      ...([{ statement: database.prepare(`SELECT 1 admitted FROM system_recovery_maintenance WHERE singleton=1 AND state='open'
        AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
        AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='legacy')`), rejection: unavailable() }]),
    ];
  }
  function editCheck(owner: Captured, id: string) {
    return { statement: database.prepare(`SELECT 1 admitted FROM projects p JOIN collaboration_resources r ON r.root_kind='project' AND r.root_id=p.id
      JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id
      JOIN collaboration_identities i ON i.member_id=g.member_id JOIN collaboration_members m ON m.member_id=i.member_id
      WHERE p.id=? AND p.deleted_at IS NULL AND ${memberWhere} AND g.enabled=1 AND g.capability IN('edit','manage') LIMIT 1`)
      .bind(id, owner.facts.provider, owner.facts.issuer, owner.facts.subject), rejection: denied() };
  }
  async function capture(request: Request, projectId: string): Promise<ProjectReferenceInsertionV28Request> {
    if (!active || request.method !== "POST" || request.bodyUsed || !isProjectApiId(projectId)
      || !canonicalIdentityText(projectId, 256)) throw denied();
    const url = new URL(request.url);
    if (url.pathname !== `/api/projects/${encodeURIComponent(projectId)}/items/reference` || [...url.searchParams.keys()].length) throw denied();
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
    issuer.read(request, subject); const row = rows[0];
    if (rows.length !== 1 || typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({ kind: "unmounted-current-project-reference-insertion-v28/1" as const }) as ProjectReferenceInsertionV28Request;
    requests.set(token, Object.freeze({ request, subject, facts, projectId, actor, tokenHash,
      credentialRevision: row.credential_revision, createdAt: row.created_at }));
    selected(request, token); return token;
  }
  function captureInput(value: unknown) {
    if (!isCreateReferenceProjectItemInput(value)) throw new HTTPException(400, { message: "Invalid Project reference insertion request" });
    const input = Object.freeze({ itemId: value.itemId, placementId: value.placementId,
      target: Object.freeze({ type: value.target.type, id: value.target.id }),
      expectedProjectRevision: value.expectedProjectRevision, operationId: value.operationId,
      geometry: Object.freeze({ x: value.geometry.x, y: value.geometry.y, width: value.geometry.width,
        height: value.geometry.height, zIndex: value.geometry.zIndex }) });
    if (!isCreateReferenceProjectItemInput(input) || !canonicalIdentityText(input.target.id, 256))
      throw new HTTPException(400, { message: "Invalid Project reference insertion request" });
    return input;
  }
  async function createReference(request: Request, token: ProjectReferenceInsertionV28Request, readInput: () => Promise<unknown>) {
    const owner = selected(request, token); if (consumed.has(token)) throw denied(); consumed.add(token);
    const initial = () => { selected(request, token);
      return createSqliteBatchAdmission(database, [...checks(owner), editCheck(owner, owner.projectId)]); };
    // Destination rights are fresh before the original input is consumed.
    await runSqliteAdmittedBatch(database, [], initial());
    const input = captureInput(await readInput()); selected(request, token);
    const targets = JSON.stringify([input.target]), member = [owner.facts.provider, owner.facts.issuer, owner.facts.subject];
    let capturedDependencies: string | undefined, mutationAccepted = false;
    const lifecycle = () => ({ statement: database.prepare(`SELECT 1 admitted WHERE
      NOT EXISTS(SELECT 1 FROM project_items WHERE id=?) OR EXISTS(
        SELECT 1 FROM project_items item JOIN reference_targets target ON target.id=item.reference_target_id
        JOIN project_map_placements placement ON placement.project_item_id=item.id
        WHERE item.id=? AND item.project_id=? AND item.item_type='reference' AND item.project_content_id IS NULL
          AND item.deleted_at IS NULL AND target.target_type=? AND target.target_id=? AND placement.id=?)`)
      .bind(input.itemId, input.itemId, owner.projectId, input.target.type, input.target.id, input.placementId), rejection: changed() });
    const guard = () => {
      selected(request, token);
      return createSqliteBatchAdmission(database, [
        ...checks(owner), editCheck(owner, owner.projectId),
        { statement: database.prepare(`SELECT 1 admitted FROM (${REFERENCE_FILTERED_MODES_SQL}) current
          WHERE current.target_type=? AND current.target_id=? AND current.mode='readable'`)
          .bind(...member, targets, input.target.type, input.target.id), rejection: denied() },
        ...(capturedDependencies === undefined ? [] : [{
          statement: database.prepare(REFERENCE_FILTERED_DEPENDENCIES_CHECK_SQL).bind(...member, targets, capturedDependencies), rejection: changed(),
        }]), lifecycle(),
      ]);
    }; // At most EIGHT original core guards, including all source/context roots.
    async function observeDependencies() {
      if (capturedDependencies !== undefined) return;
      const result = await runSqliteAdmittedBatch(database, [database.prepare(REFERENCE_FILTERED_DEPENDENCIES_SQL).bind(...member, targets)], guard());
      if (result.length !== 1 || !result[0]!.results.length) throw unavailable();
      capturedDependencies = JSON.stringify(result[0]!.results.map(row => {
        const values = [row.target_type,row.target_id,row.kind,row.ordinal,row.state];
        if (!values.every(value => typeof value === "string")) throw unavailable(); return values;
      }));
      selected(request, token);
    }
    await observeDependencies();
    const original = asProjectItemMetadataDatabase(database, guard);
    const port: ProjectItemMetadataDatabase = Object.freeze({ ...original,
      async atomicBatch(items: Parameters<ProjectItemMetadataDatabase["atomicBatch"]>[0]) {
        if (mutationAccepted) throw denied();
        const originalCommit = original.atomicBatch(items);
        const results = await originalCommit;
        mutationAccepted = true;
        // Our own original registration legitimately updates registry-history
        // DATA. It is accepted history, not a reason to roll back or replay.
        // The next original read recaptures the new data under all live guards.
        capturedDependencies = undefined; await observeDependencies(); return results;
      },
    });
    const service = createProjectItemMetadataService({ database: () => port, now: Date.now, registryId: () => crypto.randomUUID(),
      async admit(actor) { if (actor !== owner.actor) throw denied(); await observeDependencies();
        await runSqliteAdmittedBatch(database, [], guard()); selected(request, token); } });
    const settlement = { completed: false, work: async () => {
      // Original uncertain-write settlement reads current revision/identity;
      // it never republishes old source metadata or infers a grant. Its own
      // DATA comparison starts under the same fresh all-source/destination
      // guards after the original primary operation has actually settled.
      capturedDependencies = undefined; await observeDependencies();
      return service.creationSettlement(owner.projectId, input, owner.actor);
    }, original: undefined as Promise<boolean> | undefined };
    settlements.set(token, settlement);
    try {
      const result = await service.createReference(owner.projectId, input, owner.actor);
      if (result.project.id !== owner.projectId || result.item.id !== input.itemId || result.item.projectId !== owner.projectId
        || result.item.itemType !== "reference" || result.item.projectContentId !== null || result.item.referenceTargetId === null
        || result.content !== null || result.attachment !== null || result.placement.id !== input.placementId
        || result.placement.projectItemId !== input.itemId) throw changed();
      await runSqliteAdmittedBatch(database, [], guard()); selected(request, token); return result;
    } finally { settlement.completed = true; }
  }
  function creationSettlement(request: Request, token: ProjectReferenceInsertionV28Request): Promise<boolean> {
    selected(request, token); const state = settlements.get(token);
    if (!state) return Promise.resolve(false);
    if (!state.completed) throw denied();
    if (!state.original) {
      state.original = Promise.resolve().then(state.work);
      void state.original.catch(() => undefined);
    }
    return state.original;
  }
  return Object.freeze({ capture, createReference, creationSettlement, discard() { active = false; } });
}
