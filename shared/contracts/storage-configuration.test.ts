import { describe, expect, it } from "vitest";
import { checkedExternalStorageNamespace, StorageConfigurationInputError, supportsExpectedS3BucketOwner } from "./storage-configuration";

const namespace = { kind: "s3", endpoint: "https://s3.eu-central-1.amazonaws.com", bucket: "research-data",
  region: "eu-central-1", root: "research", forcePathStyle: true };
const owner = "012345678901";

describe("S3 expected bucket owner configuration", () => {
  it.each([
    ["https://s3.amazonaws.com", "us-east-1"],
    ["https://s3.amazonaws.com:443/", "us-east-1"],
    ["https://s3.us-east-1.amazonaws.com", "us-east-1"],
    ["https://s3.eu-central-1.amazonaws.com/", "eu-central-1"],
    ["https://s3.ap-southeast-5.amazonaws.com", "ap-southeast-5"],
    ["https://s3.us-gov-west-1.amazonaws.com", "us-gov-west-1"],
  ])("retains a canonical owner on AWS service endpoint %s", (endpoint, region) => {
    expect(supportsExpectedS3BucketOwner(endpoint, region)).toBe(true);
    const value = checkedExternalStorageNamespace({ ...namespace, endpoint, region, expectedBucketOwner: owner });
    expect(value).toMatchObject({ expectedBucketOwner: owner, endpoint: endpoint.replace(":443", "").replace(/\/$/, "") });
    expect(checkedExternalStorageNamespace(value)).toEqual(value);
  });

  it.each([undefined, null, "", 123456789012, "12345678901", "1234567890123", " 123456789012", "123456789012 ",
    "1234-5678-9012", "１２３４５６７８９０１２", "12345678901\n", "aws:12345678"])("rejects a present noncanonical owner %j", expectedBucketOwner => {
    expect(() => checkedExternalStorageNamespace({ ...namespace, expectedBucketOwner })).toThrow(StorageConfigurationInputError);
  });

  it.each([
    ["https://objects.example.test", "eu-central-1"],
    ["https://example.r2.cloudflarestorage.com", "auto"],
    ["https://s3.amazonaws.com", "eu-central-1"],
    ["https://s3.eu-west-1.amazonaws.com", "eu-central-1"],
    ["https://s3.eu-central-1.amazonaws.com.evil.test", "eu-central-1"],
    ["https://s3.eu-central-1.amazonaws.com:9443", "eu-central-1"],
    ["https://s3.eu-central-1.amazonaws.com/path", "eu-central-1"],
    ["https://s3.eu-central-1.amazonaws.com/path/..", "eu-central-1"],
    ["https://s3.eu-central-1.amazonaws.com/%2e", "eu-central-1"],
    ["https://s3.eu-central-1.amazonaws.com//", "eu-central-1"],
    ["https://s3.eu-central-1.amazonaws.com/?query", "eu-central-1"],
    ["https://s3.eu-central-1.amazonaws.com/#fragment", "eu-central-1"],
    ["https://user@s3.eu-central-1.amazonaws.com", "eu-central-1"],
    ["https://s3.eu-central-1.amazonaws.com.", "eu-central-1"],
    ["https://S3.eu-central-1.amazonaws.com", "eu-central-1"],
    ["http://s3.eu-central-1.amazonaws.com", "eu-central-1"],
    ["https://s3.dualstack.eu-central-1.amazonaws.com", "eu-central-1"],
    ["https://s3-accelerate.amazonaws.com", "eu-central-1"],
    ["https://s3-eu-central-1.amazonaws.com", "eu-central-1"],
    ["https://research-data.s3.eu-central-1.amazonaws.com", "eu-central-1"],
    ["https://s3-accesspoint.eu-central-1.amazonaws.com", "eu-central-1"],
    ["https://s3express-euc1-az1.eu-central-1.amazonaws.com", "eu-central-1"],
    ["https://s3.cn-north-1.amazonaws.com.cn", "cn-north-1"],
    ["https://s3.auto.amazonaws.com", "auto"],
  ])("rejects unsupported owner endpoint %s", (endpoint, region) => {
    expect(supportsExpectedS3BucketOwner(endpoint, region)).toBe(false);
    expect(() => checkedExternalStorageNamespace({ ...namespace, endpoint, region, expectedBucketOwner: owner })).toThrow(StorageConfigurationInputError);
  });

  it.each(["bucket-s3alias", "bucket--ol-s3", "bucket.mrap", "bucket--euc1-az1--x-s3", "bucket--table-s3",
    "xn--bucket", "sthree-bucket", "amzn-s3-demo-bucket", "research..data", "192.168.1.1",
    "arn:aws:s3:eu-central-1:012345678901:accesspoint/example"])("rejects a non-general-purpose bucket %s", bucket => {
    expect(() => checkedExternalStorageNamespace({ ...namespace, bucket, expectedBucketOwner: owner })).toThrow(StorageConfigurationInputError);
  });

  it("allows a dotted path-style bucket but rejects its unsupported HTTPS virtual host", () => {
    expect(checkedExternalStorageNamespace({ ...namespace, bucket: "research.data", expectedBucketOwner: owner })).toMatchObject({ bucket: "research.data" });
    expect(() => checkedExternalStorageNamespace({ ...namespace, bucket: "research.data", forcePathStyle: false, expectedBucketOwner: owner })).toThrow(StorageConfigurationInputError);
    expect(checkedExternalStorageNamespace({ ...namespace, forcePathStyle: false, expectedBucketOwner: owner })).toMatchObject({ forcePathStyle: false });
  });

  it("preserves omitted owner and exact legacy JSON for AWS, generic S3 and R2", () => {
    for (const [endpoint, region] of [[namespace.endpoint, namespace.region], ["https://objects.example.test:9443/gateway", "eu-test-1"],
      ["https://example.r2.cloudflarestorage.com", "auto"]]) {
      const original = { kind: "s3", endpoint, bucket: namespace.bucket, region, root: namespace.root, forcePathStyle: true };
      const parsed = checkedExternalStorageNamespace(original);
      expect(Object.hasOwn(parsed, "expectedBucketOwner")).toBe(false);
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(original));
    }
    expect(() => checkedExternalStorageNamespace({ kind: "webdav", endpoint: "https://drive.example.test", root: "", expectedBucketOwner: owner }))
      .toThrow(StorageConfigurationInputError);
  });
});
