import { randomUUID } from "node:crypto";
import { closeFileJobExecutions } from "../../worker/files/jobs/execution-lifetime";
import { runFileJobCleanupStep, runFileJobStep } from "../../worker/files/jobs/migration-kernel";
import type { FileJobCapabilities } from "../../worker/files/jobs/types";
import { openStorageProfile } from "../../worker/files/storage-profile-opening";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createNodeFileJobExecutionAdmission } from "../files/jobs/execution-admission";
import { ownedJobPrincipalAuthority, type InstalledJobPrincipalAuthority } from "../files/jobs/principal-authority";
import { createOwnedNodeFileJobPort } from "../files/jobs/repository";
import type { NodeV28OwnedJobPort, NodeV28JobResult } from "../jobs/node-v28-job-scheduler";
import { assertNodeRuntimeConfigurationForProfile, type LoadedNodeRuntimeConfiguration } from "../node-runtime-config";
import { assertNodeV28SourceBarrierBinding, type createNodeV28SourceBarrier } from "../recovery/node-v28-source-barrier";
import { assertLocalVolumeProfileOpeningV28Binding } from "../storage/local-volume-profile-opening";
import { ownedLocalVolumeProfileContextV28Candidate, type LocalVolumeProfileOpeningV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate";

type Barrier = ReturnType<typeof createNodeV28SourceBarrier>;
type Binding = Readonly<{configuration: LoadedNodeRuntimeConfiguration; opening: LocalVolumeProfileOpeningV28Candidate;
  authentication: object; authority: InstalledJobPrincipalAuthority; barrier: Barrier; assertCurrent(): void}>;
const issued = new WeakMap<NodeV28OwnedJobPort, Binding>();
export function assertNodeV28FileJobChildBinding(port: NodeV28OwnedJobPort, opening: LocalVolumeProfileOpeningV28Candidate,
  authentication: object, authority: InstalledJobPrincipalAuthority, barrier: Barrier, configuration: LoadedNodeRuntimeConfiguration): void {
  const binding = issued.get(port);
  if (!binding || binding.opening !== opening || binding.authentication !== authentication || binding.authority !== authority
    || binding.barrier !== barrier || binding.configuration !== configuration) throw new Error("Original V28 File child binding is unavailable");
  binding.assertCurrent();
}
/** One concrete, timer-free File family. The original migration and cleanup
 * kernels consume the existing principal/source registries. Parent owns every
 * borrowed physical/auth/opening resource and the sole three-family timer. */
export function createNodeV28FileJobChild(options: {
  configuration: LoadedNodeRuntimeConfiguration; opening: LocalVolumeProfileOpeningV28Candidate;
  authentication: object; authority: InstalledJobPrincipalAuthority; sourceBarrier: Barrier;
}): NodeV28OwnedJobPort {
  if (Object.keys(options).sort().join(",") !== "authentication,authority,configuration,opening,sourceBarrier")
    throw new Error("Closed original V28 File child configuration is required");
  const {configuration,opening,authentication,authority,sourceBarrier} = Object.freeze({...options});
  const config = assertNodeRuntimeConfigurationForProfile(configuration,"v28-workflow");
  const physical = ownedLocalVolumeProfileContextV28Candidate(opening), owner = ownedJobPrincipalAuthority(authority);
  const auth = localAuthenticationIdentityAuthority(authentication);
  if (owner.database !== physical.database || owner.nativeDatabase !== physical.nativeDatabase
    || owner.installation.checkpointId !== "portable-runtime/v28" || config.expectedInstallationId !== physical.installationId
    || !config.enableLocalFile || !config.enableLocalJobs || !config.enableLocalRecovery) throw new Error("Original V28 File parent tuple is unavailable");
  let phase: "open" | "stopping" | "closed" | "quarantined" = "open", failed = false, failure: unknown;
  let active: Promise<NodeV28JobResult> | undefined, closing: Promise<void> | undefined;
  const originals = new Set<Promise<NodeV28JobResult>>();
  function current(): void {
    if (phase === "closed" || assertNodeRuntimeConfigurationForProfile(configuration,"v28-workflow") !== config
      || localAuthenticationIdentityAuthority(authentication) !== auth) throw new Error("Original V28 File child is unavailable");
    ownedJobPrincipalAuthority(authority);
    assertLocalVolumeProfileOpeningV28Binding(opening,owner.database,owner.nativeDatabase,physical.writerLease,authentication);
    assertNodeV28SourceBarrierBinding(sourceBarrier,owner.database,owner.nativeDatabase,physical.writerLease,authentication);
    if (owner.nativeDatabase.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file !== config.databasePath)
      throw new Error("Original V28 File Native owner changed");
  }
  function runtime(): string | undefined {
    current(); if (sourceBarrier.state().phase !== "open") return;
    const row = owner.nativeDatabase.prepare(`SELECT j.incarnation FROM file_job_runtime_guard j
      JOIN file_authority_control f ON f.singleton=j.singleton AND f.mode='active'
      JOIN file_authority_runtime_guard e ON e.singleton=j.singleton AND e.enabled=1
      JOIN system_recovery_maintenance m ON m.singleton=j.singleton AND m.state='open'
      JOIN collaboration_control c ON c.singleton=j.singleton AND c.schema_version=2 AND c.enforcement='enabled'
      WHERE j.singleton=1 AND j.enabled=1 AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)`).get();
    return typeof row?.incarnation === "string" && row.incarnation ? row.incarnation : undefined;
  }
  current();
  const port: NodeV28OwnedJobPort = Object.freeze({
    async eligible() {
      if (phase !== "open" || active) return false;
      const incarnation = runtime(); if (!incarnation) return false;
      // Deny-only copies of the original queued/stale and cleanup selection
      // envelopes. No preflight claim, hold, source lease or enablement write.
      return Boolean(owner.nativeDatabase.prepare(`SELECT 1 WHERE
        EXISTS(SELECT 1 FROM file_migration_jobs WHERE state='queued'
          OR(state='running' AND julianday(lease_expires_at)<=julianday('now')))
        OR EXISTS(SELECT 1 FROM file_migration_attempts a
          JOIN file_migration_items i ON i.job_id=a.job_id AND i.file_id=a.file_id
          JOIN file_migration_jobs j ON j.id=a.job_id
          JOIN file_location_holds h ON h.location_id=a.location_id AND h.operation_id=i.hold_operation_id AND h.released_at IS NULL
          WHERE i.cleanup_requested_at IS NOT NULL AND julianday(i.cleanup_not_before)<=julianday('now')
            AND EXISTS(SELECT 1 FROM file_job_cleanup_grants g WHERE g.job_id=i.job_id AND g.runtime_incarnation=?)
            AND(j.state='cancelled' OR i.state IN('failed','stale','cancelled','moved')) AND a.state<>'published'
            AND NOT EXISTS(SELECT 1 FROM file_location_publications p WHERE p.location_id=a.location_id))
        OR EXISTS(SELECT 1 FROM file_migration_items i
          JOIN file_publications f ON f.file_id=i.file_id AND f.state='ready' AND f.active_location_id<>i.source_location_id
          WHERE i.state IN('moved','stale','failed','cancelled') AND i.cleanup_requested_at IS NOT NULL AND i.cleanup_released_at IS NULL
            AND EXISTS(SELECT 1 FROM file_job_cleanup_grants g WHERE g.job_id=i.job_id AND g.runtime_incarnation=?)
            AND julianday(i.cleanup_not_before)<=julianday('now')
            AND NOT EXISTS(SELECT 1 FROM file_migration_attempts a JOIN file_location_holds h ON h.location_id=a.location_id
              AND h.operation_id=i.hold_operation_id AND h.released_at IS NULL
              WHERE a.job_id=i.job_id AND a.file_id=i.file_id AND a.state<>'published'))
        OR EXISTS(SELECT 1 FROM file_migration_items i JOIN file_publications f ON f.file_id=i.file_id AND f.state='retired'
          WHERE i.cleanup_requested_at IS NOT NULL AND i.cleanup_released_at IS NULL AND julianday(i.cleanup_not_before)<=julianday('now')
            AND EXISTS(SELECT 1 FROM file_job_cleanup_grants g WHERE g.job_id=i.job_id AND g.runtime_incarnation=?)
            AND NOT EXISTS(SELECT 1 FROM file_retention_edges e WHERE e.file_id=i.file_id)
            AND NOT EXISTS(SELECT 1 FROM file_holds h WHERE h.file_id=i.file_id AND h.released_at IS NULL
              AND(h.expires_at IS NULL OR julianday(h.expires_at)>julianday('now')))
            AND NOT EXISTS(SELECT 1 FROM file_migration_attempts a JOIN file_location_holds h ON h.location_id=a.location_id
              AND h.operation_id=i.hold_operation_id AND h.released_at IS NULL
              WHERE a.job_id=i.job_id AND a.file_id=i.file_id AND a.state<>'published')
            AND EXISTS(SELECT 1 FROM file_location_holds h WHERE h.operation_id=i.hold_operation_id
              AND h.hold_kind='transition_source' AND h.released_at IS NULL))`).get(incarnation,incarnation,incarnation));
    },
    runAndDrain() {
      if (phase !== "open" || active) return Promise.reject(failed ? failure : new Error("Original V28 File child admission is closed or busy"));
      current();
      const original = sourceBarrier.runSource(async (): Promise<NodeV28JobResult> => {
        current(); const incarnation = runtime(); if (!incarnation) return {jobId:null,outcome:"disabled"};
        const source = createNodeFileJobExecutionAdmission({authority,writerLease:physical.writerLease,opening,incarnation});
        let capabilities: FileJobCapabilities | undefined, workFailed = false, workFailure: unknown;
        try {
          await source.acquire();
          const repository = createOwnedNodeFileJobPort({authority,incarnation,executionAdmission:source.token});
          capabilities = Object.freeze({repository:repository.repository,incarnation,now:()=>new Date(),randomId:randomUUID,
            authorizeAdministrator:repository.authorizeAdministrator,authorizeSystemCleanup:repository.authorizeSystemCleanup,
            async openStorage(target: Parameters<FileJobCapabilities["openStorage"]>[0],access: Parameters<FileJobCapabilities["openStorage"]>[1],
              beforeRequest: Parameters<FileJobCapabilities["openStorage"]>[2],signal: Parameters<FileJobCapabilities["openStorage"]>[3]) {
              current(); await source.beforeRequest(); source.captureProfile(target,access);
              const opened = await openStorageProfile(opening.capabilities,target,access,{signal,async beforeRequest(operation) {
                current(); await source.beforeRequest(); if (await beforeRequest(operation) !== true) return false;
                current(); await source.beforeRequest(); return true;
              }});
              return {namespaceIdentity:opened.storage.namespaceIdentity,adapterType:opened.storage.adapterType,
                reader:opened.reader,writer:opened.writer,createHash:opened.createHash,atomicSinglePut:true,
                ...(opened.dispose ? {dispose:opened.dispose.bind(opened)} : {})};
            }});
          const cleanup = await runFileJobCleanupStep(capabilities);
          if (!["idle","disabled"].includes(cleanup.outcome)) return {jobId:null,outcome:cleanup.outcome};
          return await runFileJobStep(capabilities);
        } catch (error) {workFailed = true; workFailure = error; throw error;}
        finally {
          try {
            if (capabilities) await closeFileJobExecutions(capabilities);
            // No release of the original scheduled source before provider ACK.
            await source.close();
          } catch (error) {
            if (workFailed) throw new AggregateError([workFailure,error],"Original V28 File work and first provider/source close failed");
            throw error;
          }
        }
      });
      active = original; originals.add(original);
      void original.then(() => {if (active === original) active = undefined; originals.delete(original);}, error => {
        if (active === original) active = undefined;
        if (!failed) {failed = true; failure = error;} phase = "quarantined";
      });
      return original;
    },
    stopAdmission() {if (phase === "open") phase = "stopping";},
    drain() {
      if (closing) return closing;
      if (phase === "open") phase = "stopping";
      closing = Promise.resolve().then(async () => {
        await Promise.allSettled([...originals]); if (failed) throw failure;
        current(); phase = "closed";
      });
      void closing.catch(() => undefined); return closing;
    },
  });
  issued.set(port,Object.freeze({configuration,opening,authentication,authority,barrier:sourceBarrier,assertCurrent:current}));
  return port;
}
