import { randomUUID } from "node:crypto";
import { ownedLocalVolumeProfileContext, prepareLocalVolumeProfileSqliteFence,
  type LocalVolumeProfileAuthority, type LocalVolumeProfileOpening } from "../../storage/local-volume-profile-opening";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../../operations/writer-lease";
import { runSqliteAdmittedBatch, createSqliteBatchAdmission, type SqliteBatchAdmissionCheck } from "../../sqlite";
import { ownedJobPrincipalAuthority, type InstalledJobPrincipalAuthority } from "./principal-authority";

/** A genuine scheduled source owner, not a caller-provided SQL or actor grant. */
export interface NodeFileJobExecutionAdmission { readonly kind: "node-local-file-job-original-execution/1" }
interface SourceOwner {
  readonly authority: InstalledJobPrincipalAuthority;
  readonly lease: LinuxWriterLease;
  readonly opening: LocalVolumeProfileOpening;
  readonly incarnation: string;
  readonly fileIncarnation: string;
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly profiles: Set<LocalVolumeProfileAuthority>;
  phase: "new" | "held" | "closed" | "quarantined";
  generation?: bigint;
  acquisition?: Promise<void>;
  release?: Promise<void>;
}
const issued = new WeakMap<NodeFileJobExecutionAdmission, SourceOwner>();
const retained = new Set<SourceOwner>();
function unavailable(): never { throw new Error("Original scheduled File job source ownership is unavailable"); }
function owned(token: NodeFileJobExecutionAdmission, authority: InstalledJobPrincipalAuthority): SourceOwner {
  const source = issued.get(token); if (!source || source.authority !== authority) unavailable();
  const owner = ownedJobPrincipalAuthority(authority), profile = ownedLocalVolumeProfileContext(source.opening);
  if (owner.database !== profile.database || owner.nativeDatabase !== profile.nativeDatabase
    || source.lease !== profile.writerLease) unavailable();
  owner.assertCurrent(); profile.assertCurrent();
  assertLinuxWriterLeaseBinding(source.lease, owner.database, owner.nativeDatabase);
  return source;
}
function maintenance(source: SourceOwner, settlement = false): SqliteBatchAdmissionCheck {
  const core = ownedJobPrincipalAuthority(source.authority).database;
  const statement = source.phase === "new"
    ? core.prepare(`SELECT 1 AS admitted FROM system_recovery_maintenance m WHERE m.singleton=1 AND m.state='open'
      AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)`)
    : core.prepare(`SELECT 1 AS admitted FROM system_recovery_maintenance m
      JOIN system_recovery_write_leases l ON l.id=? AND l.owner=? AND l.kind='scheduled'
        AND l.generation=? AND l.created_at=? AND l.expires_at=? AND l.released_at IS NULL
      WHERE m.singleton=1 AND ((m.state='open' AND m.generation=l.generation)
        OR(m.state='draining' AND m.generation=l.generation+1))
        AND (?=1 OR NOT EXISTS(SELECT 1 FROM system_recovery_write_leases other WHERE other.released_at IS NULL AND other.id<>l.id))`)
      .bind(source.id, source.label, source.generation, source.createdAt, source.expiresAt, settlement ? 1 : 0);
  return { statement, rejection: new Error("Original File job recovery source changed") };
}
function installation(source: SourceOwner): SqliteBatchAdmissionCheck {
  const owner=ownedJobPrincipalAuthority(source.authority), i=owner.installation, identity=owner.identityInstallation;
  return {statement:owner.database.prepare(`SELECT 1 AS admitted WHERE EXISTS(SELECT 1 FROM node_installation
    WHERE singleton=1 AND installation_id=? AND catalog_id=? AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
    AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'
      AND bootstrap_principal_id=? AND initialized_at=?)`)
    .bind(i.installationId,i.catalogId,i.checkpointId,i.schemaSha256,i.createdAt,identity.bootstrapPrincipalId,identity.initializedAt),
    rejection:new Error("Original File Job installation changed")};
}
function execution(source: SourceOwner): SqliteBatchAdmissionCheck {
  const core = ownedJobPrincipalAuthority(source.authority).database;
  return { statement: core.prepare(`SELECT 1 AS admitted FROM file_job_runtime_guard j
    JOIN file_authority_control c ON c.singleton=j.singleton AND c.mode='active'
    JOIN file_authority_runtime_guard f ON f.singleton=j.singleton AND f.enabled=1 AND f.incarnation=?
    WHERE j.singleton=1 AND j.enabled=1 AND j.incarnation=?`).bind(source.fileIncarnation, source.incarnation),
    rejection: new Error("Original File job execution incarnation changed") };
}
/** Existing repository commands append these checks before their unchanged
 * statements in the SAME genuine BEGIN. No SQL parsing guesses write intent.
 * Settlement retains its exact source even after executor/admin disablement;
 * principal and maintenance publication still require the captured live File
 * and Job incarnation plus every original profile authority tuple. */
export function nodeFileJobExecutionChecks(token: NodeFileJobExecutionAdmission,
  authority: InstalledJobPrincipalAuthority, settlement: boolean): readonly SqliteBatchAdmissionCheck[] {
  const source = owned(token, authority); if (source.phase !== "held") unavailable();
  const core = ownedJobPrincipalAuthority(authority).database;
  return [installation(source),maintenance(source,settlement), ...(!settlement ? [execution(source),
    ...[...source.profiles].map(profile => ({ statement: prepareLocalVolumeProfileSqliteFence(profile, core),
      rejection: new Error("Captured File job profile authority changed") }))] : [])];
}
/** Same privately issued scheduled owner, reused by a concrete package adapter.
 * A copied source method bag cannot omit its physical profile SQL snapshot.
 * Four distinct profile/access tuples leave one of the original eight checks
 * for ordinary Package actor admission; no global admission bound expands. */
export function captureNodeJobProfileAuthority(token: NodeFileJobExecutionAdmission,
  authority: InstalledJobPrincipalAuthority,
  frozen: Readonly<{profileId: string; configurationRevision: number}>, access: "read" | "write",
  maximum = 5): LocalVolumeProfileAuthority {
  const current = owned(token, authority);
  if (current.phase !== "held" || !Number.isInteger(maximum) || maximum < 1 || maximum > 5) unavailable();
  const owner = ownedJobPrincipalAuthority(authority), profile = ownedLocalVolumeProfileContext(current.opening);
  const existing = [...current.profiles].find(value => value.profile.profileId === frozen.profileId
    && value.profile.configurationRevision === frozen.configurationRevision && value.access === access);
  if (existing) {
    // Revalidate the original captured tuple; never replace it with a new live
    // binding merely because another archive scan reopens the same profile.
    prepareLocalVolumeProfileSqliteFence(existing, owner.database); return existing;
  }
  if (current.profiles.size >= maximum) throw new Error("Original job profile admission budget is unavailable");
  const captured = profile.captureProfileAuthority(frozen, access);
  current.profiles.add(captured); return captured;
}
export function createNodeFileJobExecutionAdmission(options: {
  authority: InstalledJobPrincipalAuthority; writerLease: LinuxWriterLease;
  opening: LocalVolumeProfileOpening; incarnation: string;
}) {
  const { authority, writerLease, opening, incarnation } = options;
  const owner = ownedJobPrincipalAuthority(authority), profile = ownedLocalVolumeProfileContext(opening);
  if (owner.database !== profile.database || owner.nativeDatabase !== profile.nativeDatabase
    || writerLease !== profile.writerLease || typeof incarnation !== "string" || !incarnation || incarnation.length > 128) unavailable();
  assertLinuxWriterLeaseBinding(writerLease, owner.database, owner.nativeDatabase);
  const file = owner.nativeDatabase.prepare(`SELECT g.incarnation FROM file_authority_control c
    JOIN file_authority_runtime_guard g ON g.singleton=c.singleton AND g.enabled=1 WHERE c.singleton=1 AND c.mode='active'`).get();
  if (typeof file?.incarnation !== "string" || !file.incarnation) unavailable();
  const createdAt = new Date().toISOString();
  const source: SourceOwner = { authority, lease: writerLease, opening, incarnation, fileIncarnation: file.incarnation,
    id: randomUUID(), label: `node-file-job:${owner.installation.installationId}:${incarnation}`,
    createdAt, expiresAt: new Date(Date.parse(createdAt)+300_000).toISOString(), profiles: new Set(), phase: "new" };
  const token: NodeFileJobExecutionAdmission = Object.freeze({ kind: "node-local-file-job-original-execution/1" });
  issued.set(token, source); retained.add(source);
  return Object.freeze({ token,
    acquire(): Promise<void> {
      if (source.acquisition) return source.acquisition;
      source.acquisition = (async () => {
        owned(token, authority); if (source.phase !== "new") unavailable();
        let originalFailure: unknown;
        try {
          await runSqliteAdmittedBatch(owner.database, [owner.database.prepare(`INSERT INTO system_recovery_write_leases
            (id,owner,kind,generation,created_at,expires_at)
            SELECT ?,?,'scheduled',generation,?,? FROM system_recovery_maintenance WHERE singleton=1 AND state='open'`)
            .bind(source.id, source.label, source.createdAt, source.expiresAt)],
          createSqliteBatchAdmission(owner.database, [installation(source), maintenance(source), execution(source)]));
        } catch (error) { originalFailure = error; }
        // A lost write acknowledgement is resolved only by this exact receipt;
        // do not repeat the INSERT or guess release from its expiry.
        const receipt = owner.database.primary().prepare(`SELECT generation,released_at FROM system_recovery_write_leases
          WHERE id=? AND owner=? AND kind='scheduled' AND created_at=? AND expires_at=?`)
          .bind(source.id, source.label, source.createdAt, source.expiresAt);
        let row;
        try { row = await receipt.first(); owned(token, authority); }
        catch (readError) {
          if (originalFailure !== undefined) throw new AggregateError([originalFailure, readError], "Original scheduled source write and exact receipt read failed");
          throw readError;
        }
        if (!row || row.released_at !== null || typeof row.generation !== "bigint" || row.generation < 0n)
          throw originalFailure ?? new Error("Scheduled File job source acquisition has no exact acknowledgement");
        source.generation = row.generation; source.phase = "held";
      })().catch(error => { source.phase="quarantined"; throw error; });
      source.acquisition.then(() => undefined, () => undefined); return source.acquisition;
    },
    async beforeRequest(): Promise<void> {
      const checks = nodeFileJobExecutionChecks(token, authority, false);
      await runSqliteAdmittedBatch(owner.database, [owner.database.prepare("SELECT 1 AS admitted")],
        createSqliteBatchAdmission(owner.database, checks));
      owned(token, authority);
    },
    captureProfile(frozen: Readonly<{profileId: string; configurationRevision: number}>, access: "read" | "write") {
      return captureNodeJobProfileAuthority(token, authority, frozen, access);
    },
    close(): Promise<void> {
      if (source.release) return source.release;
      source.release = (async () => {
        if (source.acquisition) await source.acquisition;
        if (source.phase === "new") { source.phase="closed"; retained.delete(source); return; }
        const checks = nodeFileJobExecutionChecks(token, authority, true), at = new Date().toISOString();
        const results = await runSqliteAdmittedBatch(owner.database, [owner.database.prepare(`UPDATE system_recovery_write_leases
          SET released_at=? WHERE id=? AND owner=? AND kind='scheduled' AND generation=?
          AND created_at=? AND expires_at=? AND released_at IS NULL`)
          .bind(at, source.id, source.label, source.generation, source.createdAt, source.expiresAt)],
          createSqliteBatchAdmission(owner.database, checks));
        if (results[0]?.meta.directChanges !== 1) unavailable();
        const row = await owner.database.primary().prepare(`SELECT released_at FROM system_recovery_write_leases
          WHERE id=? AND owner=? AND kind='scheduled' AND generation=? AND created_at=? AND expires_at=?`)
          .bind(source.id, source.label, source.generation, source.createdAt, source.expiresAt).first();
        owned(token, authority); if (row?.released_at !== at) unavailable();
        source.phase="closed"; retained.delete(source);
      })().catch(error => { source.phase="quarantined"; throw error; });
      source.release.then(() => undefined, () => undefined); return source.release;
    },
  });
}
