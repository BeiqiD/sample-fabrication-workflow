import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_STORAGE_CREDENTIAL_REENVELOPE_INPUT_BYTES } from "../../shared/contracts/storage-credential-reenvelope";
import worker from "../index";
import type { Env } from "../types";
import { StorageCredentialReenvelopeError } from "./credential-reenvelope-service";

const mocked = vi.hoisted(() => ({ auth: vi.fn(), reenvelope: vi.fn(), read: vi.fn(), list: vi.fn() }));
vi.mock("../auth", () => ({ authenticateRequest: mocked.auth }));
vi.mock("./credential-reenvelope-service", () => ({
  reenvelopeStoredStorageCredential: mocked.reenvelope, readStorageCredentialReenvelope: mocked.read,
  listStorageCredentialEnvelopes: mocked.list,
  StorageCredentialReenvelopeError: class extends Error {
    constructor(readonly status: 400 | 404 | 409 | 503, message: string) { super(message); }
  },
}));
const id = "44444444-4444-4444-8444-444444444444";
const input = { operationId: id, profileId: "external:test", revision: 1, credentialRef: "credential:test", expectedEnvelopeRevision: 1 };
const receipt = { operationId: id, profileId: input.profileId, revision: 1, credentialRef: input.credentialRef,
  previousEnvelopeRevision: 1, envelopeRevision: 2, outcome: "reenveloped", createdAt: "2026-10-02T08:00:00.000Z", createdBy: "admin@example.org" };
const list = { items: [{ profileId: input.profileId, revision: 1, credentialRef: input.credentialRef,
  envelopeRevision: 1, isCurrentCandidate: true, status: "needs_reenvelope" }], hasMore: false };
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
  const prepare = vi.fn(() => { throw new Error("File execution admission must not run for administrator maintenance"); });
  const env = {
    DB: { prepare }, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "admin@example.org",
    R2_BOOTSTRAP_NAMESPACE: JSON.stringify({ kind: "local-r2", installationId: "4e5c6dd7-325b-4eae-8499-518eaa0fcb40", bucketName: "untouched-fixture" }),
    STORAGE_CREDENTIAL_KEYRING: "unchanged-fixture-binding",
  } as unknown as Env;
  const request = (path: string, method = "GET", body?: unknown, headers: HeadersInit = {}, bindings = env) =>
    worker.fetch(new Request(`https://app.test/api/storage/configuration/${path}`, {
      method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), bindings, context);
  return { env, prepare, request };
}
beforeEach(() => {
  Object.values(mocked).forEach(mock => mock.mockReset()); mocked.auth.mockResolvedValue({ email: "admin@example.org" });
  mocked.reenvelope.mockResolvedValue(receipt); mocked.read.mockResolvedValue(receipt); mocked.list.mockResolvedValue(list);
});
afterEach(() => vi.restoreAllMocks());

describe("administrator credential re-envelope HTTP boundary", () => {
  it("reaches metadata, mutation and immutable receipt before paused File execution, with private responses", async () => {
    const f = fixture();
    for (const [path, method, body, expected] of [["credential-envelopes?profileId=external%3Atest", "GET", undefined, list],
      ["credential-reenvelopes", "POST", input, receipt], [`credential-reenvelopes/${id}`, "GET", undefined, receipt]] as const) {
      const response = await f.request(path, method, body); expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("pragma")).toBe("no-cache");
      expect(await response.json()).toEqual(expected);
    }
    const requestEnv = mocked.reenvelope.mock.calls[0][0] as Env;
    expectRequestEnvironment(requestEnv, f.env);
    expect(f.env.DB.prepare).toBe(f.prepare);
    expect(mocked.reenvelope).toHaveBeenCalledWith(requestEnv, input, "admin@example.org");
    expect(mocked.read).toHaveBeenCalledWith(f.env, id, "admin@example.org");
    expect(mocked.list).toHaveBeenCalledWith(f.env, input.profileId, "admin@example.org"); expect(f.prepare).not.toHaveBeenCalled();
  });

  it("denies ordinary readers, File operators, forged identities, disabled auth and absent administrator policy before services", async () => {
    const f = fixture();
    for (const [email, env] of [["reader@example.org", { ...f.env, FILE_EVIDENCE_OPERATOR_EMAILS: "reader@example.org" }],
      ["admin@example.org", { ...f.env, AUTH_MODE: "disabled" }], ["admin@example.org", { ...f.env, SYSTEM_ADMIN_EMAILS: undefined }]] as const) {
      mocked.auth.mockResolvedValue({ email });
      for (const [path, method, body] of [["credential-envelopes?profileId=external%3Atest", "GET", undefined],
        ["credential-reenvelopes", "POST", input], [`credential-reenvelopes/${id}`, "GET", undefined]] as const) {
        const response = await f.request(path, method, body, { "x-user-email": "admin@example.org" }, env);
        expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("private, no-store");
      }
    }
    for (const operation of [mocked.reenvelope, mocked.read, mocked.list]) expect(operation).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  });

  it("rejects cross-origin mutation, extra or malformed parameters, non-JSON and oversized input before services", async () => {
    const f = fixture();
    expect((await f.request("credential-reenvelopes", "POST", input, { origin: "https://other.test" })).status).toBe(403);
    for (const body of [{ ...input, keyId: "arbitrary" }, { ...input, operationId: "invalid" }, { ...input, expectedEnvelopeRevision: 1.5 }])
      expect((await f.request("credential-reenvelopes", "POST", body)).status).toBe(400);
    expect((await f.request("credential-reenvelopes", "POST", input, { "content-type": "application/jsonp" })).status).toBe(400);
    expect((await f.request("credential-reenvelopes", "POST", { ...input, credentialRef: "x".repeat(MAX_STORAGE_CREDENTIAL_REENVELOPE_INPUT_BYTES) })).status).toBe(413);
    for (const path of ["credential-envelopes", "credential-envelopes?profileId=a&profileId=b", "credential-envelopes?profileId=a&keyId=b",
      "credential-reenvelopes/invalid", `credential-reenvelopes/${id}?keyId=other`]) expect((await f.request(path)).status).toBe(400);
    for (const operation of [mocked.reenvelope, mocked.read, mocked.list]) expect(operation).not.toHaveBeenCalled();
  });

  it("preserves typed not-found/conflict results while sanitizing unexpected failures", async () => {
    const f = fixture();
    mocked.read.mockRejectedValueOnce(new StorageCredentialReenvelopeError(404, "Storage credential re-envelope was not found."));
    const missing = await f.request(`credential-reenvelopes/${id}`); expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Storage credential re-envelope was not found." });
    mocked.reenvelope.mockRejectedValueOnce(new StorageCredentialReenvelopeError(409, "Storage credential envelope changed. Refresh and try again."));
    expect((await f.request("credential-reenvelopes", "POST", input)).status).toBe(409);
    mocked.list.mockRejectedValueOnce(new Error("private key material ciphertext SQL provider URL"));
    const failure = await f.request("credential-envelopes?profileId=external%3Atest"); expect(failure.status).toBe(503);
    expect(await failure.json()).toEqual({ error: "Storage credential re-envelope is temporarily unavailable." });
    expect(failure.headers.get("cache-control")).toBe("private, no-store");
  });
});
