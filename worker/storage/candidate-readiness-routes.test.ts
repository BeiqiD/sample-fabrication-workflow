import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import type { Env } from "../types";
import { StorageCandidateReadinessError } from "./candidate-readiness-service";

const mocked = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }));
vi.mock("../auth", () => ({ authenticateRequest: mocked.auth }));
vi.mock("./candidate-readiness-service", () => ({
  readStorageCandidateReadiness: mocked.read,
  StorageCandidateReadinessError: class extends Error {
    constructor(readonly status: 400 | 404 | 409 | 503, message: string) { super(message); }
  },
}));
const input = { profileId: "external:test", expectedRevision: 1 };
const evidence = { profileId: input.profileId, revision: 1, observedAt: "2026-10-02T08:00:01.000Z",
  credential: { envelopeRevision: 1, status: "current" },
  evidence: { currentConfigurationSuccessCount: 1, historicalConfigurationSuccessCount: 0,
    exactCurrentContextSuccess: { checkId: "44444444-4444-4444-8444-444444444444", completedAt: "2026-10-02T08:00:00.000Z" },
    inProgressCount: 0, unresolvedCleanupCount: 0 }, canActivate: false };
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
function fixture() {
  const prepare = vi.fn(() => { throw new Error("File execution admission must not run for readiness"); });
  const env = { DB: { prepare }, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "admin@example.org" } as unknown as Env;
  const request = (query = "?profileId=external%3Atest&expectedRevision=1", headers: HeadersInit = {}, bindings = env) =>
    worker.fetch(new Request(`https://app.test/api/storage/configuration/readiness${query}`, { headers }), bindings, context);
  return { env, prepare, request };
}
beforeEach(() => {
  Object.values(mocked).forEach(mock => mock.mockReset());
  mocked.auth.mockResolvedValue({ email: "admin@example.org" });
  mocked.read.mockResolvedValue(evidence);
});
afterEach(() => vi.restoreAllMocks());

describe("administrator candidate readiness HTTP boundary", () => {
  it("reads a validated report before paused File execution with private responses", async () => {
    const f = fixture(), response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(await response.json()).toEqual(evidence);
    expect(mocked.read).toHaveBeenCalledExactlyOnceWith(f.env, input, "admin@example.org");
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("denies readers, File operators, forged identities, local mode and missing administrator policy", async () => {
    const f = fixture();
    for (const [email, env] of [["reader@example.org", { ...f.env, FILE_EVIDENCE_OPERATOR_EMAILS: "reader@example.org" }],
      ["admin@example.org", { ...f.env, AUTH_MODE: "disabled" }],
      ["admin@example.org", { ...f.env, SYSTEM_ADMIN_EMAILS: undefined }]] as const) {
      mocked.auth.mockResolvedValue({ email });
      const response = await f.request(undefined, { "x-user-email": "admin@example.org" }, env);
      expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocked.read).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  });

  it("accepts exactly one profile and a canonical positive safe revision", async () => {
    const f = fixture();
    for (const query of ["", "?profileId=a", "?expectedRevision=1", "?profileId=a&profileId=b&expectedRevision=1",
      "?profileId=a&expectedRevision=1&expectedRevision=1", "?profileId=a&expectedRevision=1&endpoint=x",
      ...["", "0", "01", "-1", "+1", "%201", "1%20", "1.0", "1e0", "Infinity", "NaN", "9007199254740992"]
        .map(revision => `?profileId=a&expectedRevision=${revision}`), "?profileId=&expectedRevision=1"]) {
      const response = await f.request(query); expect(response.status, query).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocked.read).not.toHaveBeenCalled();
    const response = await f.request("?expectedRevision=9007199254740991&profileId=external%3Atest");
    expect(response.status).toBe(200);
    expect(mocked.read).toHaveBeenCalledWith(f.env, { ...input, expectedRevision: Number.MAX_SAFE_INTEGER }, "admin@example.org");
  });

  it("preserves not-found and stale outcomes while sanitizing unavailability and malformed reports", async () => {
    const f = fixture();
    for (const [status, message] of [[404, "Storage candidate was not found."],
      [409, "Storage candidate changed. Refresh and try again."]] as const) {
      mocked.read.mockRejectedValueOnce(new StorageCandidateReadinessError(status, message));
      const response = await f.request(); expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: message });
    }
    for (const error of [new StorageCandidateReadinessError(503, "private SQL ciphertext endpoint"), new Error("private provider credentials")]) {
      mocked.read.mockRejectedValueOnce(error);
      const response = await f.request(); expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Storage candidate readiness is temporarily unavailable." });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    mocked.read.mockResolvedValueOnce({ ...evidence, privateKey: "sensitive" });
    const malformed = await f.request(); expect(malformed.status).toBe(503);
    expect(await malformed.json()).toEqual({ error: "Storage candidate readiness is temporarily unavailable." });
  });
});
