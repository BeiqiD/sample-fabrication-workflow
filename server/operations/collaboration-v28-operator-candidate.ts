// SOURCE-ONLY stopped deployment operator; no HTTP/default/anonymous entry.
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalIdentityText } from "../../shared/contracts/request-subject";
import { V26_NODE_INSTALLATION_CATALOG } from "../installation-catalog-v26";
import { V27_INERT_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v27-candidate";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate";
import { admitInstallationRecoverySource, assertInstallationAdmission, installReviewedSqliteCatalog } from "../migrations";
import { createSqliteCapability, createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";
import { acquireLinuxWriterLease, assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "./writer-lease";

// Pure code-owned source compilation only. Native and current authority
// admissions below remain fresh on every operation/constructor/KDF fence.
const reviewedV28Catalog = V28_NODE_INSTALLATION_CATALOG_CANDIDATE;

export class CollaborationOperatorCandidateError extends Error {
  constructor() { super("The stopped collaboration operation is unavailable."); this.name = "CollaborationOperatorCandidateError"; }
}
type Base = Readonly<{ databasePath: string; filesystemRootOwnerUid?: number }>;
export type CollaborationOperatorV28Command = Base & Readonly<
  { kind: "upgrade-metadata" }
  | { kind: "enroll-local-member"; principalId: string; displayName: string;
      workspaceRole: "member" | "membershipAdministrator"; canCreateSamples: boolean; expectedControlRevision: number }
  | { kind: "allocate-sample-root"; principalId: string; sampleId: string;
      visibility: "restricted" | "workspace"; expectedControlRevision: number }
  | { kind: "set-enforcement"; enforcement: "disabled" | "enabled"; expectedControlRevision: number }
>;
export type CollaborationOperatorV28Receipt = Readonly<{
  checkpointId: "portable-runtime/v28"; installationId: string; operation: CollaborationOperatorV28Command["kind"];
  controlRevision?: number; memberId?: string; principalId?: string; sampleId?: string; enforcement?: "disabled" | "enabled";
}>;
const principalPattern = /^local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type CollaborationOperatorOwner = { lease?: LinuxWriterLease; native?: DatabaseSync; quarantined: boolean; nativeConstructionAttempted: boolean; nativeConstructionFailure?: unknown };
const owners = new Set<CollaborationOperatorOwner>();
function ensure(value: unknown): asserts value { if (!value) throw new CollaborationOperatorCandidateError(); }
function command(input: CollaborationOperatorV28Command): CollaborationOperatorV28Command {
  ensure(input && typeof input === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(input)));
  // Capture once before acquisition. No mutable caller property is read again.
  const selected = { ...input };
  const specific = selected.kind === "upgrade-metadata" ? [] : selected.kind === "enroll-local-member"
    ? ["principalId", "displayName", "workspaceRole", "canCreateSamples", "expectedControlRevision"]
    : selected.kind === "allocate-sample-root" ? ["principalId", "sampleId", "visibility", "expectedControlRevision"]
    : selected.kind === "set-enforcement" ? ["enforcement", "expectedControlRevision"] : null;
  ensure(specific && Reflect.ownKeys(selected).every(key => typeof key === "string" && ["kind", "databasePath", "filesystemRootOwnerUid", ...specific].includes(key)));
  ensure(typeof selected.databasePath === "string" && selected.databasePath.length > 0 && selected.databasePath.length <= 4000 && !selected.databasePath.includes("\0"));
  ensure(selected.filesystemRootOwnerUid === undefined || Number.isSafeInteger(selected.filesystemRootOwnerUid)
    && selected.filesystemRootOwnerUid >= 0 && selected.filesystemRootOwnerUid <= 0xffff_ffff);
  if (selected.kind !== "upgrade-metadata") ensure(Number.isSafeInteger(selected.expectedControlRevision)
    && selected.expectedControlRevision >= 1 && selected.expectedControlRevision < Number.MAX_SAFE_INTEGER);
  if (selected.kind === "enroll-local-member" || selected.kind === "allocate-sample-root") ensure(typeof selected.principalId === "string" && principalPattern.test(selected.principalId));
  if (selected.kind === "enroll-local-member") ensure(canonicalIdentityText(selected.displayName, 200)
    && ["member", "membershipAdministrator"].includes(selected.workspaceRole) && typeof selected.canCreateSamples === "boolean");
  if (selected.kind === "allocate-sample-root") ensure(canonicalIdentityText(selected.sampleId, 256) && ["restricted", "workspace"].includes(selected.visibility));
  if (selected.kind === "set-enforcement") ensure(selected.enforcement === "disabled" || selected.enforcement === "enabled");
  return Object.freeze(selected);
}

/** Every invocation reacquires the SAME OS lock used by the server before opening
 * native SQLite. A live server therefore blocks this operator; an in-process
 * callback/idle boolean is not substituted for stopped physical ownership. The
 * upgrade command alone may apply reviewed metadata and always leaves disabled;
 * all other commands are admission-only. No archived/caller issuer or Access
 * subject string is accepted. Local issuer derives from the actual installation.
 * This explicit deployment authority is separate from system administrator and
 * browser member rights. Receipts identify selected records, not bearer grants. */
export async function executeCollaborationV28OperatorCandidate(input: CollaborationOperatorV28Command): Promise<CollaborationOperatorV28Receipt> {
  const selected = command(input);
  ensure(owners.size < 2);
  const owner: CollaborationOperatorOwner = { quarantined: false, nativeConstructionAttempted: false }; owners.add(owner);
  let database: SqliteCapability | undefined, result: CollaborationOperatorV28Receipt | undefined, failed = false;
  try {
    owner.lease = await acquireLinuxWriterLease({ databasePath: selected.databasePath,
      ...(selected.filesystemRootOwnerUid === undefined ? {} : { filesystemRootOwnerUid: selected.filesystemRootOwnerUid }) });
    owner.nativeConstructionAttempted = true;
    try { owner.native = new DatabaseSync(selected.databasePath, { allowExtension: false, enableForeignKeyConstraints: true }); }
    catch (error) { owner.nativeConstructionFailure = error; throw error; }
    database = createSqliteCapability(owner.native); owner.lease.bind(database, owner.native);
    const lease = owner.lease, native = owner.native, core = database;
    await lease.withWriter(async () => {
      assertLinuxWriterLeaseBinding(lease, core, native);
      if (selected.kind === "upgrade-metadata") {
        const checkpoint = native.prepare("SELECT schema_checkpoint FROM node_installation WHERE singleton=1").get()?.schema_checkpoint;
        const prior = checkpoint === "portable-runtime/v26" ? V26_NODE_INSTALLATION_CATALOG
          : checkpoint === "portable-runtime/v27" ? V27_INERT_NODE_INSTALLATION_CATALOG_CANDIDATE
          : checkpoint === "portable-runtime/v28" ? reviewedV28Catalog : undefined;
        ensure(prior); admitInstallationRecoverySource(native, prior);
        installReviewedSqliteCatalog(native, reviewedV28Catalog);
      }
      const admission = admitInstallationRecoverySource(native, reviewedV28Catalog);
      const installation = Object.freeze({ ...assertInstallationAdmission(native, admission) });
      ensure(installation.checkpointId === "portable-runtime/v28");
      if (selected.kind === "upgrade-metadata") {
        ensure(native.prepare("SELECT schema_version,enforcement,revision FROM collaboration_control WHERE singleton=1").get()?.enforcement === "disabled");
        result = Object.freeze({ checkpointId: "portable-runtime/v28", installationId: installation.installationId, operation: selected.kind }); return;
      }
      const sentinel = native.prepare("SELECT bootstrap_principal_id,initialized_at FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'").get();
      ensure(typeof sentinel?.bootstrap_principal_id === "string" && typeof sentinel.initialized_at === "number"
        && Number.isSafeInteger(sentinel.initialized_at) && sentinel.initialized_at >= 0);
      const issuer = `node-installation:${installation.installationId}`;
      const prepare = (sql: string, ...values: unknown[]) => core.prepare(sql).bind(...values);
      const checks: { statement: SqliteStatement; rejection: Error }[] = [{ statement: prepare(`SELECT 1 admitted WHERE
        EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=? AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
        AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1' AND bootstrap_principal_id=? AND initialized_at=?)`,
        installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256, installation.createdAt,
        sentinel.bootstrap_principal_id, sentinel.initialized_at), rejection: new CollaborationOperatorCandidateError() },
        { statement: prepare(`SELECT 1 admitted FROM collaboration_control WHERE singleton=1 AND schema_version=2 AND revision=?
          ${selected.kind === "set-enforcement" ? "" : "AND enforcement='disabled'"}`, selected.expectedControlRevision), rejection: new CollaborationOperatorCandidateError() }];
      let mutations: readonly SqliteStatement[];
      let memberId: string | undefined;
      if (selected.kind === "enroll-local-member") {
        memberId = randomUUID();
        checks.push({ statement: prepare(`SELECT 1 admitted FROM local_accounts WHERE principal_id=? AND enabled=1
          AND NOT EXISTS(SELECT 1 FROM collaboration_identities WHERE provider='local' AND issuer=? AND subject=?)`, selected.principalId, issuer, selected.principalId), rejection: new CollaborationOperatorCandidateError() });
        mutations = [prepare(`INSERT INTO collaboration_members(member_id,display_name,state,workspace_role,can_create_samples,can_create_projects,can_create_templates,revision)
          VALUES(?,?,'active',?,?,0,0,1)`, memberId, selected.displayName, selected.workspaceRole, selected.canCreateSamples ? 1 : 0),
          prepare("INSERT INTO collaboration_identities(provider,issuer,subject,member_id,enabled,revision) VALUES('local',?,?,?,1,1)", issuer, selected.principalId, memberId)];
      } else if (selected.kind === "allocate-sample-root") {
        checks.push({ statement: prepare(`SELECT 1 admitted FROM local_accounts a JOIN collaboration_identities i
          ON i.provider='local' AND i.issuer=? AND i.subject=a.principal_id JOIN collaboration_members m ON m.member_id=i.member_id
          WHERE a.principal_id=? AND a.enabled=1 AND i.enabled=1 AND m.state='active'`, issuer, selected.principalId), rejection: new CollaborationOperatorCandidateError() });
        checks.push({ statement: prepare(`SELECT 1 admitted FROM samples s WHERE s.id=? AND s.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM collaboration_resources WHERE root_kind='sample' AND root_id=s.id)`, selected.sampleId), rejection: new CollaborationOperatorCandidateError() });
        mutations = [prepare("INSERT INTO collaboration_resources(root_kind,root_id,visibility,revision) VALUES('sample',?,?,1)", selected.sampleId, selected.visibility),
          prepare(`INSERT INTO collaboration_grants(root_kind,root_id,member_id,capability,enabled,revision)
            VALUES('sample',?,(SELECT m.member_id FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
              WHERE i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'),'manage',1,1)`, selected.sampleId, issuer, selected.principalId)];
      } else {
        if (selected.enforcement === "enabled") checks.push({ statement: prepare(`SELECT 1 admitted FROM collaboration_members m
          JOIN collaboration_identities i ON i.member_id=m.member_id JOIN local_accounts a ON a.principal_id=i.subject
          WHERE m.state='active' AND m.workspace_role='membershipAdministrator' AND i.provider='local' AND i.issuer=?
            AND i.enabled=1 AND a.enabled=1 LIMIT 1`, issuer), rejection: new CollaborationOperatorCandidateError() });
        mutations = [prepare("UPDATE collaboration_control SET enforcement=?,revision=revision+1 WHERE singleton=1 AND schema_version=2 AND revision=?", selected.enforcement, selected.expectedControlRevision)];
      }
      assertLinuxWriterLeaseBinding(lease, core, native);
      await runSqliteAdmittedBatch(core, mutations, createSqliteBatchAdmission(core, checks));
      result = Object.freeze({ checkpointId: "portable-runtime/v28", installationId: installation.installationId, operation: selected.kind,
        ...(selected.kind === "enroll-local-member" ? { memberId: memberId!, principalId: selected.principalId } : {}),
        ...(selected.kind === "allocate-sample-root" ? { sampleId: selected.sampleId, principalId: selected.principalId } : {}),
        ...(selected.kind === "set-enforcement" ? { enforcement: selected.enforcement, controlRevision: selected.expectedControlRevision + 1 } : {}) });
    });
  } catch { failed = true; }
  finally {
    if (owner.lease) {
      try {
        await owner.lease.stopAdmissionAndDrain();
        if (owner.nativeConstructionAttempted && !owner.native) throw owner.nativeConstructionFailure;
        if (database) database.close(); else if (owner.native?.isOpen) owner.native.close();
        // A reported original drain/native-close failure permanently retains
        // the strong owner. No raw fallback, retry or premature FD release.
        if (owner.native?.isOpen) throw new CollaborationOperatorCandidateError();
        await owner.lease.release(); owners.delete(owner);
      } catch { owner.quarantined = true; failed = true; }
    } else owners.delete(owner); // Acquisition uncertainty stays lease-factory-owned.
  }
  if (failed || !result) throw new CollaborationOperatorCandidateError();
  return result;
}
