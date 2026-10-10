import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalLocalVolumeNamespace, checkedLocalVolumeNamespace, checkedStoredLocalVolumeNamespace,
  localVolumeStorageProfileId, LocalVolumeNamespaceError } from "./local-volume-profile";
import { checkedRegisterLocalProfileInput } from "./local-profile-registration";

const volumeId = "10000000-0000-4000-8000-000000000001", rootId = "20000000-0000-4000-8000-000000000002";
const namespace = { kind: "local-volume", volumeId, rootId, namespaceRevision: 1 };
const canonical = `{"kind":"local-volume","volumeId":"${volumeId}","rootId":"${rootId}","namespaceRevision":1}`;
it("hashes the exact fixed-order closed UTF8 namespace, independent of input field order", async () => {
  const reordered = { namespaceRevision: 1, rootId, volumeId, kind: "local-volume" };
  expect(canonicalLocalVolumeNamespace(reordered)).toBe(canonical);
  const profile = await localVolumeStorageProfileId(reordered);
  expect(profile).toBe(`storage-profile:local:${createHash("sha256").update(canonical, "utf8").digest("hex")}`);
  expect(profile).toHaveLength(86);
  expect(await localVolumeStorageProfileId({ ...namespace, rootId: "20000000-0000-4000-8000-000000000003" })).not.toBe(profile);
  expect(await localVolumeStorageProfileId({ ...namespace, volumeId: "10000000-0000-4000-8000-000000000004" })).not.toBe(profile);
});
it.each([
  null, [], "namespace", { ...namespace, path: "/private/volume" }, { ...namespace, profileId: "forged" },
  { ...namespace, namespaceRevision: 2 }, { ...namespace, namespaceRevision: "1" },
  { ...namespace, volumeId: volumeId.toUpperCase().replace("000000000001", "ABCDEF000001") },
  { ...namespace, volumeId: "10000000-0000-1000-8000-000000000001" },
  { ...namespace, rootId: "20000000-0000-4000-7000-000000000002" },
  { ...namespace, [Symbol("hidden")]: "extra" },
])("rejects extra fields, non-UUIDv4 identity and alternate revisions %#", input => {
  expect(() => checkedLocalVolumeNamespace(input)).toThrow(LocalVolumeNamespaceError);
});
it("snapshots accessor values once and freezes a fresh canonical identity", () => {
  let reads = 0;
  const input = { kind: "local-volume", get volumeId() { reads++; return volumeId; }, rootId, namespaceRevision: 1 };
  const checked = checkedLocalVolumeNamespace(input);
  expect(reads).toBe(1); expect(Object.isFrozen(checked)).toBe(true);
  expect(checked).toEqual(namespace); input.rootId = "20000000-0000-4000-8000-000000000009";
  expect(canonicalLocalVolumeNamespace(checked)).toBe(canonical);
});
it("admits only exact canonical stored strings rather than repairing uploaded namespace cells", () => {
  expect(checkedStoredLocalVolumeNamespace(canonical)).toEqual(namespace);
  for (const value of [" " + canonical, canonical + "\n", JSON.stringify({ rootId, kind: "local-volume", volumeId, namespaceRevision: 1 }),
    canonical.replace('"namespaceRevision":1', '"namespaceRevision":1.0'), canonical.replace(rootId, rootId + "\\u0000"), "x".repeat(257), "{"])
    expect(() => checkedStoredLocalVolumeNamespace(value)).toThrow(LocalVolumeNamespaceError);
});
it("the public registration request selects only an operation and opaque trusted descriptor", () => {
  const input = { operationId: "30000000-0000-4000-8000-000000000003", volumeDescriptorId: "40000000-0000-4000-8000-000000000004" };
  const checked = checkedRegisterLocalProfileInput(input);
  expect(checked).toEqual(input); expect(Object.isFrozen(checked)).toBe(true);
  for (const value of [{ ...input, path: "/private" }, { ...input, namespace }, { ...input, credentials: "secret" },
    { ...input, environmentKey: "PRIVATE_ROOT" }, { ...input, operationId: "operation" }, { ...input, [Symbol("extra")]: true }])
    expect(() => checkedRegisterLocalProfileInput(value)).toThrow();
});
