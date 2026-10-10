import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import type { Env } from "../types";
import { StorageProfileAdmissionError } from "./storage-profile-admission-service";

const mocked = vi.hoisted(() => ({ auth: vi.fn(), register: vi.fn(), read: vi.fn(), find: vi.fn() }));
vi.mock("../auth", () => ({ authenticateRequest: mocked.auth }));
vi.mock("./storage-profile-admission-service", () => ({ registerStorageProfile: mocked.register,
  readStorageProfileAdmission: mocked.read, findStorageProfileAdmission: mocked.find,
  StorageProfileAdmissionError: class extends Error { constructor(readonly status: 400 | 404 | 409 | 503, message: string) { super(message); } },
}));
const input = { operationId: "11111111-1111-4111-8111-111111111111", profileId: "external:fixture",
  expectedRevision: 3, expectedEnvelopeRevision: 2, checkId: "22222222-2222-4222-8222-222222222222" };
const receipt = { operationId: input.operationId, profileId: input.profileId, revision: 3, envelopeRevision: 2,
  checkId: input.checkId, nativeProfileId: `storage-profile:aws-s3:${"a".repeat(64)}`, configurationRevision: 1,
  runtimeAccess: "read_only", createdAt: "2026-10-02T08:00:00.000Z", createdBy: "admin@example.test" };
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
function expectRequestEnvironment(request: Env, original: Env) {
  expect(request).not.toBe(original);
  expect(request.DB).not.toBe(original.DB);
  expect(Reflect.ownKeys(request)).toEqual(Reflect.ownKeys(original));
  for (const key of Reflect.ownKeys(original)) {
    if (key !== "DB") expect(Reflect.get(request, key)).toBe(Reflect.get(original, key));
  }
}
function fixture() {
  const prepare = vi.fn(() => { throw new Error("File execution gate must not run for administrator registration"); });
  const env = {
    DB: { prepare }, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "admin@example.test",
    R2_BOOTSTRAP_NAMESPACE: JSON.stringify({ kind: "local-r2", installationId: "4e5c6dd7-325b-4eae-8499-518eaa0fcb40", bucketName: "untouched-fixture" }),
    STORAGE_CREDENTIAL_KEYRING: "unchanged-fixture-binding",
  } as unknown as Env;
  const request = (path = "", init: RequestInit = {}, bindings = env) => worker.fetch(new Request(`https://app.test/api/storage/configuration/registrations${path}`, init), bindings, context);
  const post = (value: unknown = input, headers: HeadersInit = { "content-type": "application/json" }) => request("", { method: "POST", headers, body: JSON.stringify(value) });
  return { env, prepare, request, post };
}
beforeEach(() => {
  Object.values(mocked).forEach(mock => mock.mockReset()); mocked.auth.mockResolvedValue({ email: "admin@example.test" });
  for (const fn of [mocked.register, mocked.read, mocked.find]) fn.mockResolvedValue(receipt);
});
afterEach(() => vi.restoreAllMocks());

describe("administrator native profile registration HTTP boundary", () => {
  it("mounts private POST, receipt replay and current-namespace lookup before the File execution gate", async () => {
    const f = fixture();
    const responses = [await f.post(), await f.request(`/${input.operationId}`), await f.request("?profileId=external%3Afixture&expectedRevision=3")];
    for (const response of responses) {
      expect(response.status).toBe(200); expect(await response.json()).toEqual(receipt);
      expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("pragma")).toBe("no-cache");
    }
    const requestEnv = mocked.register.mock.calls[0][0] as Env;
    expectRequestEnvironment(requestEnv, f.env);
    expect(f.env.DB.prepare).toBe(f.prepare);
    expect(mocked.register).toHaveBeenCalledExactlyOnceWith(requestEnv, input, "admin@example.test");
    expect(mocked.read).toHaveBeenCalledExactlyOnceWith(f.env, input.operationId, "admin@example.test");
    expect(mocked.find).toHaveBeenCalledExactlyOnceWith(f.env, { profileId: input.profileId, expectedRevision: 3 }, "admin@example.test");
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("denies readers, forged identity and disabled or missing administrator policy before service work", async () => {
    const f = fixture();
    for (const [email, bindings] of [["reader@example.test", f.env], ["admin@example.test", { ...f.env, AUTH_MODE: "disabled" }],
      ["admin@example.test", { ...f.env, SYSTEM_ADMIN_EMAILS: undefined }]] as const) {
      mocked.auth.mockResolvedValue({ email });
      const response = await f.request("", { method: "POST", headers: { "content-type": "application/json", "x-user-email": "admin@example.test" }, body: JSON.stringify(input) }, bindings);
      expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocked.register).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  });

  it("rejects unknown fields, invalid exact identities, media types, duplicate query keys and oversized bodies", async () => {
    const f = fixture();
    for (const value of [{ ...input, namespace: "injected" }, { ...input, expectedRevision: 0 }, { ...input, expectedEnvelopeRevision: "2" },
      { ...input, operationId: "invalid" }, { ...input, checkId: "invalid" }]) expect((await f.post(value)).status).toBe(400);
    expect((await f.post(input, { "content-type": "application/jsonp" })).status).toBe(400);
    expect((await f.request("?x=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).status).toBe(400);
    expect((await f.post({ ...input, profileId: "x".repeat(5000) })).status).toBe(413);
    for (const query of ["", "?profileId=a", "?profileId=a&expectedRevision=01", "?profileId=a&expectedRevision=3&expectedRevision=3",
      "?profileId=a&profileId=b&expectedRevision=3", "?profileId=a&expectedRevision=3&extra=1", "?profileId=a&expectedRevision=9007199254740992"])
      expect((await f.request(query)).status).toBe(400);
    expect((await f.request(`/${input.operationId}?extra=1`)).status).toBe(400);
    expect((await f.request("/invalid")).status).toBe(400);
    expect(mocked.register).not.toHaveBeenCalled(); expect(mocked.find).not.toHaveBeenCalled(); expect(mocked.read).not.toHaveBeenCalled();
  });

  it("preserves actionable conflicts and missing records while sanitizing database errors and malformed receipts", async () => {
    const f = fixture();
    for (const [status, message] of [[400, "Only qualified AWS S3 candidates can be registered."], [404, "Storage candidate was not found."],
      [409, "Storage candidate or registration changed. Refresh and try again."]] as const) {
      mocked.register.mockRejectedValueOnce(new StorageProfileAdmissionError(status, message));
      const response = await f.post(); expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: message });
    }
    for (const error of [new StorageProfileAdmissionError(503, "private ciphertext SQL"), new Error("private credential material")]) {
      mocked.register.mockRejectedValueOnce(error);
      const response = await f.post(); expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Storage profile registration is temporarily unavailable." });
    }
    mocked.register.mockResolvedValueOnce({ ...receipt, privateSecret: "hidden" });
    const invalid = await f.post(); expect(invalid.status).toBe(503); expect(JSON.stringify(await invalid.json())).not.toContain("hidden");
  });
});
