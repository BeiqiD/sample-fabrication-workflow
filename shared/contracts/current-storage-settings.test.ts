import { describe, expect, it } from "vitest";
import { checkedCurrentStorageSettings, checkedCurrentStorageSettingsProfile, type CurrentStorageSettingsStatus } from "./current-storage-settings";

const snapshot = (): CurrentStorageSettingsStatus => ({ version: 3, kind: "storage-settings-status", readOnly: true, health: "not_checked",
  authority: { mode: "active", shadowConversions: "paused", fileAccess: "enabled" },
  roleDefaults: { state: "configured", policyRevision: 3, internal: { profileId: "r2", adapterType: "r2", availability: "available" },
    originals: { profileId: "native", adapterType: "s3", availability: "available" } },
  bindings: { r2: { configuration: "configured" }, managed: { provider: "none", configuration: "missing" } },
  profiles: { items: [
    { id: "r2", adapterType: "r2", configurationRevision: 1, runtimeAccess: "read_write", bindingMatch: "matched", bindingRevision: null, availability: "available" },
    { id: "native", adapterType: "s3", configurationRevision: 1, runtimeAccess: "read_write", bindingMatch: "matched", bindingRevision: 1, availability: "available" },
  ], hasMore: false, limit: 100 } });

describe("current Storage Settings role bindings", () => {
  it("retains exact unavailable selected profiles after recovery without silently replacing them", () => {
    const value = snapshot(); value.profiles.items[1].availability = "unavailable"; value.profiles.items[1].bindingMatch = "mismatch";
    value.profiles.items[1].bindingRevision = null; value.roleDefaults.originals!.availability = "unavailable";
    value.authority.fileAccess = "paused"; expect(checkedCurrentStorageSettings(value)).toEqual(value);
  });
  it.each([
    ["missing selected profile in a complete list", (value: CurrentStorageSettingsStatus) => { value.profiles.items.pop(); }],
    ["wrong selected adapter", (value: CurrentStorageSettingsStatus) => { value.roleDefaults.originals!.adapterType = "r2"; }],
    ["wrong selected availability", (value: CurrentStorageSettingsStatus) => { value.roleDefaults.originals!.availability = "unavailable"; }],
    ["native profile at historical policy2", (value: CurrentStorageSettingsStatus) => { value.roleDefaults.policyRevision = 2; }],
    ["independent R2 profiles at historical policy2", (value: CurrentStorageSettingsStatus) => {
      value.roleDefaults.policyRevision = 2; value.profiles.items[1] = { ...value.profiles.items[0], id: "second-r2" };
      value.roleDefaults.originals = { profileId: "second-r2", adapterType: "r2", availability: "available" };
    }],
  ])("rejects %s", (_name, mutate) => { const value = snapshot(); mutate(value); expect(() => checkedCurrentStorageSettings(value)).toThrow("Invalid storage settings response."); });
  it("accepts frozen policy2 only with the same exact R2 selection for both roles", () => {
    const value = snapshot(); value.roleDefaults.policyRevision = 2; value.roleDefaults.originals = { ...value.roleDefaults.internal! };
    expect(checkedCurrentStorageSettings(value)).toEqual(value);
  });
  it("permits real selected profiles beyond a bounded truncated page while binding every visible selection", () => {
    const value = snapshot(); value.profiles.hasMore = true;
    value.profiles.items = Array.from({ length: 100 }, (_, index) => ({ ...value.profiles.items[0], id: `profile:${index}` }));
    expect(checkedCurrentStorageSettings(value)).toEqual(value);
    value.roleDefaults.originals = { profileId: "profile:1", adapterType: "s3", availability: "available" };
    expect(() => checkedCurrentStorageSettings(value)).toThrow();
  });
  it("does not allow the same omitted profile to acquire contradictory role metadata", () => {
    const value = snapshot(); value.profiles.hasMore = true;
    value.profiles.items = Array.from({ length: 100 }, (_, index) => ({ ...value.profiles.items[0], id: `profile:${index}` }));
    value.roleDefaults.originals = { ...value.roleDefaults.internal!, availability: "unavailable" };
    expect(() => checkedCurrentStorageSettings(value)).toThrow();
  });
  it("strictly validates a profile sentinel without requiring unrelated role selections in that one-row check", () => {
    const value = snapshot().profiles.items[1]; expect(checkedCurrentStorageSettingsProfile(value)).toEqual(value);
    expect(() => checkedCurrentStorageSettingsProfile({ ...value, credentialRef: "private" })).toThrow();
    expect(() => checkedCurrentStorageSettingsProfile({ ...value, bindingRevision: null })).toThrow();
  });
});
