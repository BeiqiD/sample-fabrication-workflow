import { closeFileJobExecutions } from "../../worker/files/jobs/execution-lifetime";
import { runPackageJobStep } from "../../worker/packages/jobs/kernel";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createNodeFileJobExecutionAdmission } from "../files/jobs/execution-admission";
import { ownedJobPrincipalAuthority, type InstalledJobPrincipalAuthority } from "../files/jobs/principal-authority";
import type { NodeV28OwnedJobPort, NodeV28JobResult } from "../jobs/node-v28-job-scheduler";
import type { ReviewedInstallationAdmission } from "../migrations";
import { assertNodeRuntimeConfigurationForProfile, type LoadedNodeRuntimeConfiguration } from "../node-runtime-config";
import { assertNodeV28SourceBarrierBinding, type createNodeV28SourceBarrier } from "../recovery/node-v28-source-barrier";
import { assertLocalVolumeProfileOpeningV28Binding } from "../storage/local-volume-profile-opening";
import { ownedLocalVolumeProfileContextV28Candidate, type LocalVolumeProfileOpeningV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate";
import { createNodePackageCapabilitiesV28Candidate } from "./local-capabilities-v28-candidate";

type Barrier = ReturnType<typeof createNodeV28SourceBarrier>;
type Binding = Readonly<{ opening: LocalVolumeProfileOpeningV28Candidate; authentication: object; authority: InstalledJobPrincipalAuthority;
  barrier: Barrier; configuration: LoadedNodeRuntimeConfiguration; assertCurrent(): void }>;
const issued = new WeakMap<NodeV28OwnedJobPort, Binding>();
/** Parent composition may check the original concrete child, never its copied
 * four-method shape. This issues no slot, principal, root or profile grant. */
export function assertNodeV28PackageJobChildBinding(port: NodeV28OwnedJobPort, opening: LocalVolumeProfileOpeningV28Candidate,
  authentication: object, authority: InstalledJobPrincipalAuthority, barrier: Barrier, configuration: LoadedNodeRuntimeConfiguration): void {
  const binding = issued.get(port);
  if (!binding || binding.opening !== opening || binding.authentication !== authentication || binding.authority !== authority
    || binding.barrier !== barrier || binding.configuration !== configuration) throw new Error("Original V28 Package child binding is unavailable");
  binding.assertCurrent();
}
/** One timer-free Package family. Parent owns the sole three-family scheduler,
 * Native, physical lease, auth and shared opening. No borrowed parent closes here. */
export function createNodeV28PackageJobChild(options: {
  configuration: LoadedNodeRuntimeConfiguration; opening: LocalVolumeProfileOpeningV28Candidate;
  authentication: object; admission: ReviewedInstallationAdmission; authority: InstalledJobPrincipalAuthority; sourceBarrier: Barrier;
}): NodeV28OwnedJobPort {
  if (Object.keys(options).sort().join(",") !== "admission,authentication,authority,configuration,opening,sourceBarrier")
    throw new Error("Closed original V28 Package child configuration is required");
  const { configuration, opening, authentication, admission, authority, sourceBarrier } = options;
  const config = assertNodeRuntimeConfigurationForProfile(configuration,"v28-workflow"), physical = ownedLocalVolumeProfileContextV28Candidate(opening);
  const owner = ownedJobPrincipalAuthority(authority), auth = localAuthenticationIdentityAuthority(authentication);
  if (owner.database !== physical.database || owner.nativeDatabase !== physical.nativeDatabase
    || owner.installation.checkpointId !== "portable-runtime/v28" || config.expectedInstallationId !== physical.installationId
    || !config.enableLocalFile || !config.enableLocalJobs || !config.enableLocalRecovery) throw new Error("Original V28 Package parent tuple is unavailable");
  let phase: "open" | "stopping" | "closed" | "quarantined" = "open", failed = false, failure: unknown;
  let active: Promise<NodeV28JobResult> | undefined, closing: Promise<void> | undefined;
  const originals = new Set<Promise<NodeV28JobResult>>();
  function current() {
    if (phase === "closed" || assertNodeRuntimeConfigurationForProfile(configuration,"v28-workflow") !== config
      || localAuthenticationIdentityAuthority(authentication) !== auth) throw new Error("Original V28 Package child is unavailable");
    ownedJobPrincipalAuthority(authority);
    assertLocalVolumeProfileOpeningV28Binding(opening,owner.database,owner.nativeDatabase,physical.writerLease,authentication);
    assertNodeV28SourceBarrierBinding(sourceBarrier,owner.database,owner.nativeDatabase,physical.writerLease,authentication);
    if (owner.nativeDatabase.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file !== config.databasePath)
      throw new Error("Original V28 Package Native owner changed");
  }
  function runtime(): string | undefined {
    current(); if (sourceBarrier.state().phase !== "open") return;
    const row = owner.nativeDatabase.prepare(`SELECT j.incarnation FROM file_job_runtime_guard j
      JOIN file_authority_control f ON f.singleton=j.singleton AND f.mode='active'
      JOIN file_authority_runtime_guard execution ON execution.singleton=j.singleton AND execution.enabled=1
      JOIN system_recovery_maintenance m ON m.singleton=j.singleton AND m.state='open'
      JOIN collaboration_control policy ON policy.singleton=j.singleton AND policy.schema_version=2 AND policy.enforcement='enabled'
      WHERE j.singleton=1 AND j.enabled=1 AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)`).get();
    return typeof row?.incarnation === "string" && row.incarnation ? row.incarnation : undefined;
  }
  current();
  const port: NodeV28OwnedJobPort = Object.freeze({
    async eligible() {
      if (phase !== "open" || active) return false;
      const incarnation = runtime(); if (!incarnation) return false;
      // Same original candidate/cancellation/explicit-expiry cleanup envelopes;
      // no preflight claims work, enables flags or creates a durable source.
      return Boolean(owner.nativeDatabase.prepare(`SELECT 1 FROM research_package_jobs j LEFT JOIN system_research_package_cleanup_grants g ON g.job_id=j.id
        WHERE j.state IN('queued','cancel_requested') OR(j.state='running' AND julianday(j.lease_expires_at)<=julianday('now'))
        OR(g.runtime_incarnation=? AND j.state IN('completed','cancelled','preview')
          AND(g.mode='explicit' OR julianday(j.expires_at)<=julianday('now')) AND julianday(g.requested_at)<=julianday('now','-120 seconds')) LIMIT 1`).get(incarnation));
    },
    runAndDrain() {
      if (phase !== "open" || active) return Promise.reject(failed ? failure : new Error("Original V28 Package child admission is closed or busy"));
      current();
      // runSource reserves this WHOLE invocation before its first await. A
      // naked source.close is never registered as a barrier retention closer.
      const original = sourceBarrier.runSource(async (): Promise<NodeV28JobResult> => {
        current(); const incarnation = runtime(); if (!incarnation) return { jobId: null, outcome: "disabled" };
        const source = createNodeFileJobExecutionAdmission({authority,opening,writerLease:physical.writerLease,incarnation});
        let packagePort: ReturnType<typeof createNodePackageCapabilitiesV28Candidate> | undefined;
        let workFailed = false, workFailure: unknown;
        try {
          await source.acquire();
          packagePort = createNodePackageCapabilitiesV28Candidate({configuration,opening,authentication,admission,authority,
            executionAdmission:source.token,incarnation});
          if (await packagePort.maintain()) return {jobId:null,outcome:"cleaned"};
          return await runPackageJobStep(packagePort.capabilities);
        } catch (error) { workFailed = true; workFailure = error; throw error; }
        finally {
          try {
            if (packagePort) await closeFileJobExecutions(packagePort.capabilities);
            // Failed ORIGINAL provider/body close prevents this exact source
            // close; its rejected acquisition/release is never retried.
            await source.close();
          } catch (error) {
            if (workFailed) throw new AggregateError([workFailure,error],"Original V28 Package work and first source/provider close failed");
            throw error;
          }
        }
      });
      active = original; originals.add(original);
      void original.then(() => { if (active === original) active = undefined; originals.delete(original); }, error => {
        if (active === original) active = undefined;
        if (!failed) { failed = true; failure = error; } phase = "quarantined"; // Retain rejecting original.
      });
      return original;
    },
    stopAdmission() { if (phase === "open") phase = "stopping"; },
    drain() {
      if (closing) return closing;
      if (phase === "open") phase = "stopping";
      closing = Promise.resolve().then(async () => {
        await Promise.allSettled([...originals]);
        if (failed) throw failure;
        current(); phase = "closed";
      });
      void closing.catch(() => undefined); return closing;
    },
  });
  issued.set(port,Object.freeze({opening,authentication,authority,barrier:sourceBarrier,configuration,assertCurrent:current}));
  return port;
}
