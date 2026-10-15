import { describe, expect, it } from "vitest";
import { checkedSystemRecoveryCapabilities, checkedSystemRecoverySourceResumeInput, checkedSystemRecoverySourceResumeReceipt, checkedSystemRecoveryRequestAbsent,
  type SystemRecoveryCapabilities, type SystemRecoverySourceResumeReceipt } from "./system-recovery";

const capability: SystemRecoveryCapabilities = { supported: true, canManage: true, enabled: false, stale: true,
  lastHeartbeatAt: null, cadenceSeconds: 120, maxStepMs: 60000, reason: "executor_disabled",
  target: { configured: false, id: null, mode: "fresh" }, maintenance: { state: "open", checkpoint: null },
  policy: { recoveryMapping: "inert-preserve", backupMaintenance: "always", maintenanceWithoutTarget: true, recoveryCleanup: false, sourceResume: true } };
const receipt: SystemRecoverySourceResumeReceipt = { schema: "node-original-source-resume/1", requestId: "resume-1",
  releaseRequestId: "release-1", backupJobId: "backup-1", expectedGeneration: 2,
  sourceInstallationId: "original-installation", incarnation: "original-incarnation", sourceCheckpoint: "a".repeat(64),
  resumedAt: "2026-10-15T08:00:00.000Z", enabled: true, shadowEnabled: false, jobsEnabled: false, noBindingCutover: true, noJobReplay: true };

describe("request-bound system recovery absence", () => {
  it("checks the exact queried operation without claiming permanent absence", () => {
    const value = { schema: "system-recovery-request-absent/1", requestId: "original:request" };
    expect(checkedSystemRecoveryRequestAbsent(value, value.requestId)).toEqual(value);
    for (const candidate of [{ error: "Not found" }, { ...value, schema: "system-recovery-request-absent/2" },
      { ...value, requestId: "other-request" }, { ...value, neverAccepted: true }, null]) {
      expect(() => checkedSystemRecoveryRequestAbsent(candidate, value.requestId)).toThrow();
    }
    for (const requestId of ["", ".", "..", "path/private", "path\\private", "with space", "x".repeat(129), "bad\u0000id"]) {
      expect(() => checkedSystemRecoveryRequestAbsent({ ...value, requestId }, requestId)).toThrow();
    }
  });
});

describe("explicit system recovery runtime policy and original source resume", () => {
  it("requires an exact advertised policy instead of inferring capabilities from an unconfigured target", () => {
    expect(checkedSystemRecoveryCapabilities(capability)).toEqual(capability);
    expect(checkedSystemRecoveryCapabilities({ ...capability, policy: { recoveryMapping: "explicit-profile", backupMaintenance: "planned-only",
      maintenanceWithoutTarget: false, recoveryCleanup: true, sourceResume: false } }).policy.recoveryMapping).toBe("explicit-profile");
    const { policy: _policy, ...legacy } = capability;
    expect(() => checkedSystemRecoveryCapabilities(legacy)).toThrow();
    for (const policy of [{ ...capability.policy, recoveryMapping: "automatic" }, { ...capability.policy, backupMaintenance: "none" },
      { ...capability.policy, sourceResume: "true" }, { ...capability.policy, credentials: "private" }]) {
      expect(() => checkedSystemRecoveryCapabilities({ ...capability, policy })).toThrow();
    }
  });
  it("preserves the original resume operation, release receipt, backup and generation in a checked receipt", () => {
    const input = { requestId: receipt.requestId, releaseRequestId: receipt.releaseRequestId,
      backupJobId: receipt.backupJobId, expectedGeneration: receipt.expectedGeneration };
    expect(checkedSystemRecoverySourceResumeInput(input)).toEqual(input);
    expect(checkedSystemRecoverySourceResumeReceipt(receipt)).toEqual(receipt);
    for (const change of [{ expectedGeneration: 1 }, { expectedGeneration: 2.5 }, { requestId: "resume/private" },
      { releaseRequestId: "release:1" }, { backupJobId: "" }, { bypassValidation: true }]) {
      expect(() => checkedSystemRecoverySourceResumeInput({ ...input, ...change })).toThrow();
    }
  });
  it("rejects receipts that claim job replay, target activation, unchecked execution or malformed proof", () => {
    for (const change of [{ enabled: false }, { shadowEnabled: true }, { jobsEnabled: true }, { noBindingCutover: false },
      { noJobReplay: false }, { sourceCheckpoint: "A".repeat(64) }, { resumedAt: "yesterday" }, { schema: "node-original-source-resume/2" },
      { sourceInstallationId: "../other" }, { credentials: "private" }]) {
      expect(() => checkedSystemRecoverySourceResumeReceipt({ ...receipt, ...change })).toThrow();
    }
  });
});
