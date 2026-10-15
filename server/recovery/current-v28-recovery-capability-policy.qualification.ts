import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkedSystemRecoveryCapabilities } from "../../shared/contracts/system-recovery.ts";
import { CANONICAL_FILE_PASSWORD, CANONICAL_FILE_IDENTITY_POLICY, assertCanonicalFileOwnersReleased,
  canonicalFileClient, canonicalFilePrivateOrigin, listenCanonicalFileApplication, retainedCanonicalFileCase,
  withCanonicalFileDatabase } from "../collaboration/current-v28-canonical-comment-file.qualification-support.ts";
import { createPasswordHasher } from "../auth/passwords.ts";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate.ts";
import { admitInstallationRecoverySource } from "../migrations.ts";
import { loadNodeRuntimeConfiguration } from "../node-runtime-config.ts";
import { executeV28OrdinaryAccountOperatorCandidate } from "../operations/ordinary-account-v28-candidate.ts";
import { executeCollaborationV28OperatorCandidate } from "../operations/collaboration-v28-operator-candidate.ts";
import { executeDomainRootV28OperatorCandidate } from "../operations/collaboration-domain-roots-v28-candidate.ts";
import { createNodeV28WorkflowApplication } from "../workflow/node-v28-workflow-application.ts";
import { createNodeSystemRecoveryV28Application } from "./node-system-recovery-v28-application.ts";
import { prepareCurrentV28OnlineRecoverySource, prepareCurrentV28WorkflowSharedFileSource } from "./current-v28-online-recovery.qualification-support.ts";

const policy = { recoveryMapping: "inert-preserve", backupMaintenance: "always", maintenanceWithoutTarget: true, recoveryCleanup: false };
describe("genuine native Node recovery capability policy", () => {
  it("advertises backup-only Recovery maintenance and gates original source resume to an actual administrator", () => retainedCanonicalFileCase(async () => {
    const source = await prepareCurrentV28OnlineRecoverySource(), baseline = source.baseline;
    await executeV28OrdinaryAccountOperatorCandidate({ databasePath: baseline.path, filesystemRootOwnerUid: baseline.rootOwnerUid,
      kind: "provision-account", username: "reader" }, CANONICAL_FILE_PASSWORD);
    await withCanonicalFileDatabase(baseline.path, async (owner, lease, native, core) => {
      const origin = await canonicalFilePrivateOrigin(owner), configuration = await source.loadRecoveryConfiguration(origin);
      owner.applicationAttempted = true;
      owner.originalApplication = Promise.resolve().then(() => createNodeSystemRecoveryV28Application({ configuration,
        database: core, nativeDatabase: native, writerLease: lease,
        admission: admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE),
        hasher: createPasswordHasher(), identityPolicy: CANONICAL_FILE_IDENTITY_POLICY, publicOrigin: origin }));
      owner.application = await owner.originalApplication; await listenCanonicalFileApplication(owner, origin);
      const client = canonicalFileClient(owner, origin), administrator = await client.login("operator");
      const response = await client.request("/api/system-recovery/capabilities", "GET", undefined, administrator);
      expect(response.status).toBe(200); expect(checkedSystemRecoveryCapabilities(response.value)).toMatchObject({ supported: true,
        canManage: true, target: { configured: false, id: null }, policy: { ...policy, sourceResume: true } });
      const reader = await client.login("reader"), denied = await client.request("/api/system-recovery/capabilities", "GET", undefined, reader);
      expect(denied.status).toBe(200); expect(checkedSystemRecoveryCapabilities(denied.value)).toMatchObject({ supported: false,
        canManage: false, enabled: false, reason: "administrator_required", policy: { ...policy, sourceResume: false } });
      expect((await client.request("/api/system-recovery/maintenance", "GET", undefined, reader)).status).toBe(403);
      expect(native.prepare("SELECT count(*) n FROM system_recovery_jobs").get()?.n).toBe(0);
    });
    assertCanonicalFileOwnersReleased();
  }), 90_000);
  it("advertises the borrowed online recovery policy without offering stopped-profile source resume", () => retainedCanonicalFileCase(async () => {
    const source = await prepareCurrentV28WorkflowSharedFileSource(), baseline = source.baseline;
    const base = { databasePath: baseline.path, filesystemRootOwnerUid: baseline.rootOwnerUid };
    await executeCollaborationV28OperatorCandidate({ ...base, kind: "enroll-local-member", principalId: baseline.principalId,
      displayName: "Capability policy operator", workspaceRole: "membershipAdministrator", canCreateSamples: true, expectedControlRevision: 1 });
    const flags = await executeDomainRootV28OperatorCandidate({ ...base, kind: "set-creation-flags", principalId: baseline.principalId,
      expectedMemberRevision: 1, expectedControlRevision: 1, canCreateSamples: true, canCreateProjects: false, canCreateTemplates: false });
    await executeDomainRootV28OperatorCandidate({ ...base, kind: "allocate-existing-root", rootKind: "sample", rootId: source.workflowSampleId,
      visibility: "restricted", principalId: baseline.principalId, expectedMemberRevision: flags.memberRevision, expectedControlRevision: 1 });
    await executeCollaborationV28OperatorCandidate({ ...base, kind: "set-enforcement", enforcement: "enabled", expectedControlRevision: 1 });
    await withCanonicalFileDatabase(baseline.path, async (owner, lease, native, core) => {
      const origin = await canonicalFilePrivateOrigin(owner), path = join(baseline.root, "capability-policy-workflow.json");
      await writeFile(path, JSON.stringify({ format: "node-loopback-development-v1", dataDirectory: baseline.dataDirectory,
        expectedInstallationId: baseline.installationId, publicOrigin: origin, clientDirectory: baseline.clientDirectory,
        localVolumes: baseline.descriptors, enableLocalFile: true, enableLocalJobs: true, enableLocalRecovery: true,
        recoveryArtifacts: source.recoveryArtifacts }), { flag: "wx", mode: 0o600 });
      const configuration = loadNodeRuntimeConfiguration(path, { filesystemRootOwnerUid: baseline.rootOwnerUid, runtimeProfile: "v28-workflow" });
      owner.applicationAttempted = true;
      owner.originalApplication = Promise.resolve().then(() => createNodeV28WorkflowApplication({ configuration,
        database: core, nativeDatabase: native, writerLease: lease,
        admission: admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE),
        hasher: createPasswordHasher(), identityPolicy: CANONICAL_FILE_IDENTITY_POLICY, publicOrigin: origin,
        httpLimits: { timeoutMs: 5000, maxBodyBytes: 2_500_000 } }));
      owner.application = await owner.originalApplication; await listenCanonicalFileApplication(owner, origin);
      const client = canonicalFileClient(owner, origin), session = await client.login("operator");
      const response = await client.request("/api/system-recovery/capabilities", "GET", undefined, session);
      expect(response.status).toBe(200); expect(checkedSystemRecoveryCapabilities(response.value)).toMatchObject({ supported: true,
        canManage: true, target: { configured: false, id: null }, policy: { ...policy, sourceResume: false } });
      expect((await client.request("/api/system-recovery/source-resume", "POST", { requestId: "resume", releaseRequestId: "release",
        backupJobId: "backup", expectedGeneration: 2 }, session)).status).toBe(409);
      expect(native.prepare("SELECT count(*) n FROM system_recovery_jobs").get()?.n).toBe(0);
    });
    assertCanonicalFileOwnersReleased();
  }), 90_000);
});
