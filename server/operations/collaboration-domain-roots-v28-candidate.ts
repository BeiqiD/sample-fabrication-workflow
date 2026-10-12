// Unmounted stopped deployment operation; no default migration or HTTP powers.
import { DatabaseSync } from "node:sqlite";
import { canonicalIdentityText } from "../../shared/contracts/request-subject";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate";
import { admitInstallationRecoverySource, assertInstallationAdmission } from "../migrations";
import { createSqliteCapability, createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";
import { acquireLinuxWriterLease, assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "./writer-lease";

const reviewedCatalog = V28_NODE_INSTALLATION_CATALOG_CANDIDATE;
const principalPattern = /^local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class StoppedDomainRootOperationUnavailable extends Error {
  constructor() { super("The named stopped resource operation is unavailable"); this.name = "StoppedDomainRootOperationUnavailable"; }
}
type Base = Readonly<{ databasePath: string; filesystemRootOwnerUid?: number; principalId: string; expectedMemberRevision: number; expectedControlRevision: number }>;
export type DomainRootOperatorV28Command = Base & Readonly<
  { kind: "allocate-existing-root"; rootKind: "sample" | "project" | "template"; rootId: string; visibility: "restricted" | "workspace" }
  | { kind: "set-creation-flags"; canCreateSamples: boolean; canCreateProjects: boolean; canCreateTemplates: boolean }
>;
export type DomainRootOperatorV28Receipt = Readonly<{
  checkpointId: "portable-runtime/v28"; installationId: string; operation: DomainRootOperatorV28Command["kind"];
  principalId: string; memberId: string; memberRevision: number;
  root?: Readonly<{ kind: "sample" | "project" | "template"; id: string; resourceRevision: 1; grantRevision: 1 }>;
  creationFlags?: Readonly<{ sample: boolean; project: boolean; template: boolean }>;
}>;
function requireInput(value: unknown): asserts value { if (!value) throw new StoppedDomainRootOperationUnavailable(); }
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER;
function capture(input: DomainRootOperatorV28Command): DomainRootOperatorV28Command {
  requireInput(input && typeof input === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(input)));
  const selected = { ...input }; // Capture all caller properties exactly once before I/O.
  const specific = selected.kind === "allocate-existing-root" ? ["rootKind", "rootId", "visibility"]
    : selected.kind === "set-creation-flags" ? ["canCreateSamples", "canCreateProjects", "canCreateTemplates"] : null;
  requireInput(specific && Reflect.ownKeys(selected).every(key => typeof key === "string" && ["kind", "databasePath", "filesystemRootOwnerUid", "principalId", "expectedMemberRevision", "expectedControlRevision", ...specific].includes(key)));
  requireInput(typeof selected.databasePath === "string" && selected.databasePath.length > 0 && selected.databasePath.length <= 4000 && !selected.databasePath.includes("\0"));
  requireInput(selected.filesystemRootOwnerUid === undefined || Number.isSafeInteger(selected.filesystemRootOwnerUid) && selected.filesystemRootOwnerUid >= 0 && selected.filesystemRootOwnerUid <= 0xffff_ffff);
  requireInput(typeof selected.principalId === "string" && principalPattern.test(selected.principalId) && revision(selected.expectedMemberRevision) && revision(selected.expectedControlRevision));
  if (selected.kind === "allocate-existing-root") requireInput(["sample", "project", "template"].includes(selected.rootKind) && canonicalIdentityText(selected.rootId, 256) && ["restricted", "workspace"].includes(selected.visibility));
  else requireInput(typeof selected.canCreateSamples === "boolean" && typeof selected.canCreateProjects === "boolean" && typeof selected.canCreateTemplates === "boolean");
  return Object.freeze(selected);
}
interface Owner {
  lease?: LinuxWriterLease; native?: DatabaseSync; core?: SqliteCapability;
  nativeConstructionAttempted?: true; nativeConstructionFailure?: unknown;
  closeNative?: () => void; nativeCloseAcknowledged?: true;
  quarantined: boolean; workFailed: boolean; originalFailure?: unknown;
}
const owners = new Set<Owner>();

/** Explicit named deployment authority, separate from browser/admin/resource
 * permissions. The same genuine OS writer lock is acquired before native open,
 * so a live host blocks this stopped operation. No imported map, creator/email,
 * first visitor, default successor or automatic historical root enrollment is
 * used. Current OPV26/V27 refuse this owner; reviewed V28 admission stays fresh.
 * This operation does not enable control or mount any business/File API. */
export async function executeDomainRootV28OperatorCandidate(input: DomainRootOperatorV28Command): Promise<DomainRootOperatorV28Receipt> {
  const selected = capture(input); requireInput(owners.size < 2);
  const owner: Owner = { quarantined: false, workFailed: false }; owners.add(owner); // Synchronous capacity reservation, including failed owners.
  let result: DomainRootOperatorV28Receipt | undefined, failed = false;
  try {
    owner.lease = await acquireLinuxWriterLease({ databasePath: selected.databasePath,
      ...(selected.filesystemRootOwnerUid === undefined ? {} : { filesystemRootOwnerUid: selected.filesystemRootOwnerUid }) });
    owner.nativeConstructionAttempted = true;
    try { owner.native = new DatabaseSync(selected.databasePath, { allowExtension: false, enableForeignKeyConstraints: true }); }
    catch (error) { owner.nativeConstructionFailure = error; throw error; }
    const originalNativeClose = owner.native.close.bind(owner.native);
    let closeAttempted = false, closeFailed = false, closeFailure: unknown;
    owner.closeNative = () => {
      if (!closeAttempted) {
        closeAttempted = true;
        try { originalNativeClose(); owner.nativeCloseAcknowledged = true; }
        catch (error) { closeFailed = true; closeFailure = error; }
      }
      if (closeFailed) throw closeFailure;
    };
    owner.native.close = owner.closeNative; // Core and parent share the single original Native outcome.
    owner.core = createSqliteCapability(owner.native); owner.lease.bind(owner.core, owner.native);
    const native = owner.native, core = owner.core, lease = owner.lease;
    await lease.withWriter(async () => {
      const admission = admitInstallationRecoverySource(native, reviewedCatalog);
      const installation = Object.freeze({ ...assertInstallationAdmission(native, admission) });
      requireInput(installation.checkpointId === "portable-runtime/v28");
      const sentinel = native.prepare("SELECT bootstrap_principal_id,initialized_at FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'").get();
      requireInput(typeof sentinel?.bootstrap_principal_id === "string" && principalPattern.test(sentinel.bootstrap_principal_id)
        && typeof sentinel.initialized_at === "number" && Number.isSafeInteger(sentinel.initialized_at) && sentinel.initialized_at >= 0);
      const issuer = `node-installation:${installation.installationId}`;
      const target = native.prepare(`SELECT m.member_id FROM collaboration_members m
        JOIN collaboration_identities i ON i.member_id=m.member_id JOIN local_accounts a ON a.principal_id=i.subject
        WHERE i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND a.enabled=1
          AND m.state='active' AND m.revision=?`).get(issuer, selected.principalId, selected.expectedMemberRevision);
      requireInput(typeof target?.member_id === "string"); const memberId = target.member_id;
      const prepare = (sql: string, ...values: unknown[]) => core.prepare(sql).bind(...values);
      const denied = () => new StoppedDomainRootOperationUnavailable();
      const checks: { statement: SqliteStatement; rejection: Error }[] = [
        { statement: prepare(`SELECT 1 admitted WHERE
          EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=? AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
          AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1' AND bootstrap_principal_id=? AND initialized_at=?)`,
          installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256, installation.createdAt, sentinel.bootstrap_principal_id, sentinel.initialized_at), rejection: denied() },
        { statement: prepare("SELECT 1 admitted FROM collaboration_control WHERE singleton=1 AND schema_version=2 AND revision=? AND enforcement IN('disabled','enabled')", selected.expectedControlRevision), rejection: denied() },
        { statement: prepare(`SELECT 1 admitted FROM collaboration_members m
          JOIN collaboration_identities i ON i.member_id=m.member_id JOIN local_accounts a ON a.principal_id=i.subject
          WHERE m.member_id=? AND m.state='active' AND m.revision=? AND i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND a.enabled=1`,
          memberId, selected.expectedMemberRevision, issuer, selected.principalId), rejection: denied() },
        { statement: prepare(`SELECT 1 admitted FROM system_recovery_maintenance WHERE singleton=1 AND state='open'
          AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)`), rejection: denied() },
      ];
      const statements: SqliteStatement[] = [];
      if (selected.kind === "allocate-existing-root") {
        checks.push({ statement: prepare(selected.rootKind === "sample"
          ? "SELECT 1 admitted FROM samples WHERE id=? AND deleted_at IS NULL"
          : selected.rootKind === "project" ? "SELECT 1 admitted FROM projects WHERE id=? AND deleted_at IS NULL"
          : "SELECT 1 admitted FROM recipe_families WHERE id=? AND archived_at IS NULL", selected.rootId), rejection: denied() });
        checks.push({ statement: prepare("SELECT 1 admitted WHERE NOT EXISTS(SELECT 1 FROM collaboration_resources WHERE root_kind=? AND root_id=?)", selected.rootKind, selected.rootId), rejection: denied() });
        statements.push(prepare("INSERT INTO collaboration_resources(root_kind,root_id,visibility,revision) VALUES(?,?,?,1)", selected.rootKind, selected.rootId, selected.visibility),
          prepare("INSERT INTO collaboration_grants(root_kind,root_id,member_id,capability,enabled,revision) VALUES(?,?,?,'manage',1,1)", selected.rootKind, selected.rootId, memberId));
      } else statements.push(prepare(`UPDATE collaboration_members SET can_create_samples=?,can_create_projects=?,can_create_templates=?,revision=revision+1
        WHERE member_id=? AND revision=? AND revision<9007199254740991`, selected.canCreateSamples ? 1 : 0, selected.canCreateProjects ? 1 : 0, selected.canCreateTemplates ? 1 : 0, memberId, selected.expectedMemberRevision));
      assertLinuxWriterLeaseBinding(lease, core, native);
      const actual = await runSqliteAdmittedBatch(core, statements, createSqliteBatchAdmission(core, checks));
      requireInput(actual.length === statements.length && actual.every(row => row.meta.directChanges === 1));
      result = Object.freeze({ checkpointId: "portable-runtime/v28", installationId: installation.installationId, operation: selected.kind,
        principalId: selected.principalId, memberId, memberRevision: selected.expectedMemberRevision + (selected.kind === "set-creation-flags" ? 1 : 0),
        ...(selected.kind === "allocate-existing-root" ? { root: Object.freeze({ kind: selected.rootKind, id: selected.rootId, resourceRevision: 1 as const, grantRevision: 1 as const }) }
          : { creationFlags: Object.freeze({ sample: selected.canCreateSamples, project: selected.canCreateProjects, template: selected.canCreateTemplates }) }) });
    });
  } catch (error) { failed = true; owner.workFailed = true; owner.originalFailure = error; }
  finally {
    if (owner.lease) {
      try {
        await owner.lease.stopAdmissionAndDrain();
        if (owner.nativeConstructionAttempted && !owner.native) throw owner.nativeConstructionFailure;
        if (owner.core) owner.core.close();
        owner.closeNative?.(); // Observe the same first outcome even after a closed native handle.
        // Exactly one original close attempt: an error (even closed-then-lostACK)
        // prevents physical release. The strong core/native/error owner survives.
        if (owner.native && (!owner.nativeCloseAcknowledged || owner.native.isOpen)) throw new StoppedDomainRootOperationUnavailable();
        await owner.lease.release(); owners.delete(owner);
      } catch (error) { owner.quarantined = true; failed = true; owner.originalFailure = owner.workFailed ? new AggregateError([owner.originalFailure, error], "Original stopped resource work and close remain unproven") : error; }
    } else owners.delete(owner); // Uncertain acquire remains original lease-factory owned.
  }
  if (failed || !result) throw new StoppedDomainRootOperationUnavailable();
  return result;
}
