import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_STORAGE_CHECK_INPUT_BYTES } from "../../shared/contracts/storage-candidate-check";
import worker from "../index";
import type { Env } from "../types";
import { StorageCandidateCheckError } from "./candidate-check-service";

const mocked = vi.hoisted(() => ({ auth: vi.fn(), start: vi.fn(), read: vi.fn(), list: vi.fn(), cleanup: vi.fn() }));
vi.mock("../auth", () => ({ authenticateRequest: mocked.auth }));
vi.mock("./candidate-check-service", () => ({
  startStorageCandidateCheck: mocked.start, readStorageCandidateCheck: mocked.read,
  listStorageCandidateChecks: mocked.list, cleanupStorageCandidateCheck: mocked.cleanup,
  StorageCandidateCheckError: class extends Error {
    constructor(readonly status: 400 | 404 | 409 | 503, message: string) { super(message); }
  },
}));
const id = "44444444-4444-4444-8444-444444444444";
const input = { checkId: id, profileId: "external:test", expectedRevision: 1 };
const evidence = { id, profileId: input.profileId, revision: 1, status: "succeeded", write: "passed", read: "passed",
  metadata: "passed", delete: "passed", cleanup: "confirmed_absent", code: null,
  createdAt: "2026-10-02T08:00:00.000Z", updatedAt: "2026-10-02T08:00:01.000Z", completedAt: "2026-10-02T08:00:01.000Z" };
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
function fixture() {
  const prepare = vi.fn(() => { throw new Error("File execution admission must not run for administrator checks"); });
  const env = { DB: { prepare }, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "admin@example.org" } as unknown as Env;
  const request = (path = "", method = "GET", body?: unknown, headers: HeadersInit = {}, bindings = env) =>
    worker.fetch(new Request(`https://app.test/api/storage/configuration/checks${path}`, {
      method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), bindings, context);
  return { env, prepare, request };
}
beforeEach(() => {
  Object.values(mocked).forEach(mock => mock.mockReset());
  mocked.auth.mockResolvedValue({ email: "admin@example.org" });
  mocked.start.mockResolvedValue(evidence); mocked.read.mockResolvedValue(evidence);
  mocked.list.mockResolvedValue({ items: [evidence], hasMore: false }); mocked.cleanup.mockResolvedValue(evidence);
});
afterEach(() => vi.restoreAllMocks());

describe("administrator candidate check HTTP boundary", () => {
  it("reaches start, status, bounded history and cleanup before paused File execution, with private responses", async () => {
    const f = fixture();
    for (const [path, method, body] of [["", "POST", input], [`/${id}`, "GET", undefined],
      ["?profileId=external%3Atest", "GET", undefined], [`/${id}/cleanup`, "POST", {}]] as const) {
      const response = await f.request(path, method, body);
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(await response.json()).toEqual(path.startsWith("?") ? { items: [evidence], hasMore: false } : evidence);
    }
    expect(mocked.start).toHaveBeenCalledWith(f.env, input, "admin@example.org");
    expect(mocked.read).toHaveBeenCalledWith(f.env, id, "admin@example.org");
    expect(mocked.list).toHaveBeenCalledWith(f.env, input.profileId, "admin@example.org");
    expect(mocked.cleanup).toHaveBeenCalledWith(f.env, id, "admin@example.org");
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("denies ordinary readers, File operators, forged identities, local mode and missing administrator policy before service calls", async () => {
    const f = fixture();
    for (const [email, env] of [["reader@example.org", { ...f.env, FILE_EVIDENCE_OPERATOR_EMAILS: "reader@example.org" }],
      ["admin@example.org", { ...f.env, AUTH_MODE: "disabled" }], ["admin@example.org", { ...f.env, SYSTEM_ADMIN_EMAILS: undefined }]] as const) {
      mocked.auth.mockResolvedValue({ email });
      for (const [path, method, body] of [["", "POST", input], [`/${id}`, "GET", undefined],
        ["?profileId=external%3Atest", "GET", undefined], [`/${id}/cleanup`, "POST", {}]] as const) {
        const response = await f.request(path, method, body, { "x-user-email": "admin@example.org" }, env);
        expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("private, no-store");
      }
    }
    for (const operation of [mocked.start, mocked.read, mocked.list, mocked.cleanup]) expect(operation).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("rejects cross-origin mutations, malformed identifiers, extra parameters, oversized and non-JSON bodies without provider commands", async () => {
    const f = fixture();
    expect((await f.request("", "POST", input, { origin: "https://other.test" })).status).toBe(403);
    expect((await f.request(`/${id}/cleanup`, "POST", {}, { origin: "https://other.test" })).status).toBe(403);
    expect((await f.request("", "POST", { ...input, arbitraryKey: "outside" })).status).toBe(400);
    expect((await f.request("", "POST", input, { "content-type": "application/jsonp" })).status).toBe(400);
    expect((await f.request("", "POST", { ...input, profileId: "x".repeat(MAX_STORAGE_CHECK_INPUT_BYTES) })).status).toBe(413);
    expect((await f.request("/invalid" )).status).toBe(400);
    for (const query of ["", "?profileId=a&profileId=b", "?profileId=a&endpoint=https%3A%2F%2Fother.test"])
      expect((await f.request(query)).status).toBe(400);
    expect((await f.request(`/${id}/cleanup`, "POST", { key: "outside" })).status).toBe(400);
    for (const operation of [mocked.start, mocked.read, mocked.list, mocked.cleanup]) expect(operation).not.toHaveBeenCalled();
  });

  it("keeps typed not-found/conflict outcomes and sanitizes unexpected service errors", async () => {
    const f = fixture();
    mocked.read.mockRejectedValueOnce(new StorageCandidateCheckError(404, "Storage candidate check was not found."));
    const missing = await f.request(`/${id}`); expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Storage candidate check was not found." });
    mocked.start.mockRejectedValueOnce(new StorageCandidateCheckError(409, "Storage candidate changed. Refresh and try again."));
    const conflict = await f.request("", "POST", input); expect(conflict.status).toBe(409);
    mocked.cleanup.mockRejectedValueOnce(new Error("private-secret provider URL SQL ciphertext"));
    const failure = await f.request(`/${id}/cleanup`, "POST", {}); expect(failure.status).toBe(503);
    expect(await failure.json()).toEqual({ error: "Storage candidate check is temporarily unavailable." });
    expect(failure.headers.get("cache-control")).toBe("private, no-store");
  });
});
