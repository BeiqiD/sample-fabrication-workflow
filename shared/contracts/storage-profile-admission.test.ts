import { describe, expect, it } from "vitest";
import { awsS3NativeNamespace, canonicalNativeS3Namespace, checkedStorageProfileAdmissionInput,
  checkedStorageProfileAdmissionReceipt } from "./storage-profile-admission";

const namespace = { kind: "s3", endpoint: "https://s3.eu-central-1.amazonaws.com", region: "eu-central-1",
  bucket: "research-files", root: "project/原始数据", forcePathStyle: true, expectedBucketOwner: "012345678901" };
const input = { operationId: "11111111-1111-4111-8111-111111111111", profileId: "candidate", expectedRevision: 2,
  expectedEnvelopeRevision: 3, checkId: "22222222-2222-4222-8222-222222222222" };

describe("native profile admission contract", () => {
  it("qualifies commercial AWS identity with owner, preserving root and separating transport configuration", () => {
    const expected = JSON.stringify({ kind: "aws-s3", partition: "aws", accountId: "012345678901", bucketName: namespace.bucket, root: namespace.root });
    expect(awsS3NativeNamespace(namespace)).toBe(expected);
    expect(awsS3NativeNamespace({ ...namespace, endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", forcePathStyle: false })).toBe(expected);
    expect(canonicalNativeS3Namespace(JSON.parse(expected))).toBe(expected);
    expect(awsS3NativeNamespace({ ...namespace, expectedBucketOwner: "111122223333" })).not.toBe(expected);
    for (const bucket of ["123", "123.456"]) expect(JSON.parse(awsS3NativeNamespace({ ...namespace, bucket })).bucketName).toBe(bucket);
  });

  it("rejects unbound, other-partition and malformed physical identities", () => {
    for (const region of ["us-gov-west-1", "us-iso-east-1", "us-isob-east-1", "eu-isoe-west-1", "cn-north-1"])
      expect(() => awsS3NativeNamespace({ ...namespace, region, endpoint: `https://s3.${region}.amazonaws.com` })).toThrow();
    for (const patch of [{ expectedBucketOwner: undefined }, { expectedBucketOwner: "11112222333" },
      { endpoint: "https://s3.example.test" }, { bucket: "1.2.3.4" }, { root: "../private" }, { root: '"'.repeat(1024) }])
      expect(() => awsS3NativeNamespace({ ...namespace, ...patch })).toThrow();
    const value = JSON.parse(awsS3NativeNamespace(namespace));
    for (const patch of [{ partition: "aws-cn" }, { endpoint: namespace.endpoint }, { root: "research\nprivate" }])
      expect(() => canonicalNativeS3Namespace({ ...value, ...patch })).toThrow();
  });

  it("keeps the registration command and historical receipt strict and bounded", () => {
    expect(checkedStorageProfileAdmissionInput(input)).toEqual(input);
    for (const patch of [{ expectedRevision: 0 }, { expectedEnvelopeRevision: 1.5 }, { profileId: "bad\u0000id" }, { nativeProfileId: "injected" }])
      expect(() => checkedStorageProfileAdmissionInput({ ...input, ...patch })).toThrow();
    const receipt = { operationId: input.operationId, profileId: input.profileId, revision: input.expectedRevision,
      envelopeRevision: input.expectedEnvelopeRevision, checkId: input.checkId, nativeProfileId: `storage-profile:aws-s3:${"a".repeat(64)}`,
      configurationRevision: 1, runtimeAccess: "read_only", createdAt: "2026-10-02T12:00:00.000Z", createdBy: "admin@example.test" };
    expect(checkedStorageProfileAdmissionReceipt(receipt)).toEqual(receipt);
    for (const patch of [{ runtimeAccess: "read_write" }, { configurationRevision: 2 }, { createdAt: "2026-10-02" }, { credentials: {} }])
      expect(() => checkedStorageProfileAdmissionReceipt({ ...receipt, ...patch })).toThrow();
  });
});
