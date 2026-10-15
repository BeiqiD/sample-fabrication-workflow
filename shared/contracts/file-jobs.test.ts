import { describe, expect, it } from "vitest";
import { checkedFileMigrationRequestReceipt, checkedFileMigrationRequestAbsent, type FileMigrationRequestReceipt } from "./file-jobs";

const receipt: FileMigrationRequestReceipt = { requestId: "original:request", input: { requestId: "original:request",
  fileIds: ["file-1"], target: { profileId: "target-profile", configurationRevision: 1 } },
  job: { id: "accepted-job", actor: "admin@example.test", state: "paused", target: { profileId: "target-profile", configurationRevision: 1 },
    acceptedAt: "2026-10-15T09:00:00.000Z", updatedAt: "2026-10-15T09:00:01.000Z", reason: "operator_paused",
    moved: 0, remaining: 1, failed: 0, cleanupPending: 0 } };

describe("File migration immutable request receipt", () => {
  it("admits only a closed absence response for the exact original queried identity", () => {
    const absent = { schema: "file-migration-request-absent/1", requestId: receipt.requestId };
    expect(checkedFileMigrationRequestAbsent(absent, receipt.requestId)).toEqual(absent);
    for (const value of [{ error: "Not found" }, { ...absent, requestId: "another-request" },
      { ...absent, schema: "file-migration-request-absent/2" }, { ...absent, final: true }, null]) {
      expect(() => checkedFileMigrationRequestAbsent(value, receipt.requestId)).toThrow();
    }
  });
  it("retains the accepted input and current job without creating an absence or retry claim", () => {
    expect(checkedFileMigrationRequestReceipt(receipt)).toEqual(receipt);
  });
  it("rejects another request, changed target or revision and additional proof fields", () => {
    for (const value of [{ ...receipt, requestId: "another-request" },
      { ...receipt, job: { ...receipt.job, target: { ...receipt.job.target, profileId: "different-profile" } } },
      { ...receipt, job: { ...receipt.job, target: { ...receipt.job.target, configurationRevision: 2 } } },
      { ...receipt, neverAccepted: true }, { ...receipt, job: { ...receipt.job, credentials: "private" } },
      { ...receipt, input: { ...receipt.input, overwrite: true } }]) {
      expect(() => checkedFileMigrationRequestReceipt(value)).toThrow();
    }
  });
});
