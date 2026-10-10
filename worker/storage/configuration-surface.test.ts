import type { webcrypto } from "node:crypto";
import type { Server } from "node:http";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { generateKeyPair, jwtVerify, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_STORAGE_CONFIGURATION_INPUT_BYTES, type SaveStorageCandidateInput, type StorageCandidate } from "../../shared/contracts/storage-configuration";
import { createNodeHttpServer } from "../../server/http";
import { createAuthenticationMiddleware } from "../platform/authentication";
import { createFileEvidenceAccessRoutes, createFileEvidenceOperatorMiddleware, principalHasCapability, type AuthenticatedPrincipal } from "../runtime/authorization";
import { createStorageConfigurationCacheControl, createStorageConfigurationSurface } from "./configuration-surface";

// Only the trusted composition and service ports are fixture-specific. This is
// the actual shared HTTP surface, not local accounts, sessions, SQL or providers.
type Bindings = {
  verificationKey: webcrypto.CryptoKey;
  principals: ReadonlyMap<string, AuthenticatedPrincipal>;
  replacement?: Bindings;
};
const accountId = `local_${crypto.randomUUID()}`, actor = `local-account:${accountId}`;
const issuer = "urn:rt1-local-principal-fixture", audience = "rt1-local-principal-fixture";
let privateKey: webcrypto.CryptoKey, publicKey: webcrypto.CryptoKey;
const servers: Server[] = [];
beforeAll(async () => {
  const keys = await generateKeyPair("ES256");
  privateKey = keys.privateKey; publicKey = keys.publicKey;
});
beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => undefined));
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    expect(server.listening).toBe(false);
  }
  vi.restoreAllMocks();
});
function bindings(systemAdministrator = false, fileEvidenceOperator = false): Bindings {
  return { verificationKey: publicKey, principals: new Map([[actor, {
    id: accountId, actor, capabilities: { systemAdministrator, fileEvidenceOperator },
  }]]) };
}
async function credential() {
  return new SignJWT({}).setProtectedHeader({ alg: "ES256" }).setSubject(accountId)
    .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
}
const input = (): SaveStorageCandidateInput => ({ expectedRevision: null, label: "Fixture archive",
  namespace: { kind: "webdav", endpoint: "https://archive.example.test", root: "files" },
  credentials: { mode: "replace", value: { username: "fixture-name", password: "fixture-secret" } } });
class ServiceError extends Error {
  readonly status: 400 | 409 | 503;
  constructor(status: 400 | 409 | 503, message: string) { super(message); this.status = status; }
}
function composition() {
  const authenticate = vi.fn(async (request: Request, env: Bindings) => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) throw new Error("Fixture credential required");
    const { payload } = await jwtVerify(authorization.slice(7), env.verificationKey, { issuer, audience });
    if (payload.sub !== accountId) throw new Error("Fixture subject required");
    return { actor: `local-account:${payload.sub}` };
  });
  // Persisted-grant lookup belongs to the trusted composer. Nothing from a
  // request header, email spelling or submitted configuration selects a grant.
  const authorizeAdministrator = vi.fn((_request: Request, env: Bindings, verifiedActor: string) =>
    principalHasCapability(env.principals.get(verifiedActor), verifiedActor, "systemAdministrator"));
  const authorizeOperator = vi.fn((_request: Request, env: Bindings, verifiedActor: string) =>
    principalHasCapability(env.principals.get(verifiedActor), verifiedActor, "fileEvidenceOperator"));
  const credentialEditingAvailable = vi.fn(async (_env: Bindings) => true);
  const read = vi.fn(async (_env: Bindings, _actor: string) => ({
    scope: "system" as const, credentialEditingAvailable: true, candidates: { items: [], hasMore: false },
  }));
  const save = vi.fn(async (_env: Bindings, value: SaveStorageCandidateInput, verifiedActor: string): Promise<StorageCandidate> => ({
    profileId: "fixture-profile", revision: 1, label: value.label, namespace: value.namespace,
    credentials: { status: "configured", ref: "fixture-credential-ref" }, createdAt: "2026-10-10T00:00:00.000Z", createdBy: verifiedActor,
  }));
  const app = new Hono<{ Bindings: Bindings; Variables: { userEmail: string } }>().basePath("/api");
  app.onError((error, c) => error instanceof HTTPException
    ? c.json({ error: error.message }, error.status) : c.json({ error: "Unexpected server error" }, 500));
  app.use("/storage/configuration", createStorageConfigurationCacheControl());
  app.use("/storage/configuration/*", createStorageConfigurationCacheControl());
  app.use("*", createAuthenticationMiddleware(authenticate));
  app.use("*", async (c, next) => { if (c.env.replacement) c.env = c.env.replacement; await next(); });
  app.route("/", createStorageConfigurationSurface({ authorizeAdministrator, credentialEditingAvailable, read, save,
    routeError: error => error instanceof ServiceError ? { status: error.status, message: error.message } : null }));
  app.route("/", createFileEvidenceAccessRoutes(authorizeOperator));
  app.post("/fixture-evidence-action", createFileEvidenceOperatorMiddleware(authorizeOperator), c => c.json({ actor: c.get("userEmail") }));
  return { app, authenticate, authorizeAdministrator, authorizeOperator, credentialEditingAvailable, read, save };
}
type Composition = ReturnType<typeof composition>;
type Requester = (path: string, env: Bindings, init?: RequestInit) => Promise<Response>;
async function requester(mode: "Fetch" | "Node HTTP", c: Composition): Promise<Requester> {
  if (mode === "Fetch") return async (path, env, init) => c.app.fetch(new Request(`https://fixture.test/api${path}`, init), env);
  let currentBindings: Bindings;
  const server = createNodeHttpServer(request => c.app.fetch(request, currentBindings), { publicOrigin: "https://fixture.test" });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback listener");
  return async (path, env, init) => { currentBindings = env; return fetch(`http://127.0.0.1:${address.port}/api${path}`, init); };
}
async function authorizedHeaders() {
  return { authorization: `Bearer ${await credential()}`, "content-type": "application/json",
    "x-user-email": "admin@example.test", "cf-access-authenticated-user-email": "admin@example.test" };
}
async function answer(response: Response, status: number, body: unknown, storage = true) {
  expect(response.status).toBe(status); expect(await response.json()).toEqual(body);
  if (storage) {
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
  }
}
describe.each(["Fetch", "Node HTTP"] as const)("explicit local capabilities through %s", mode => {
  it("denies forged actor headers and unauthenticated bodies before privilege or service selection", async () => {
    const c = composition(), request = await requester(mode, c), env = bindings(true);
    const headers = { "x-user-email": "admin@example.test", "cf-access-authenticated-user-email": "admin@example.test" };
    await answer(await request("/storage/configuration/capability", env, { headers }), 403, { error: "Authentication required" });
    await answer(await request("/storage/configuration/candidates", env, { method: "PUT", headers, body: "invalid-json" }), 403, { error: "Authentication required" });
    expect(c.authorizeAdministrator).not.toHaveBeenCalled(); expect(c.credentialEditingAvailable).not.toHaveBeenCalled();
    expect(c.read).not.toHaveBeenCalled(); expect(c.save).not.toHaveBeenCalled();
  });
  it("accepts a verified local actor with an explicit admin grant without granting File operator access", async () => {
    const c = composition(), request = await requester(mode, c), env = bindings(true), headers = await authorizedHeaders();
    await answer(await request("/storage/configuration/capability", env, { headers }), 200, { canManage: true, credentialEditingAvailable: true });
    await answer(await request("/storage/configuration", env, { headers }), 200,
      { scope: "system", credentialEditingAvailable: true, candidates: { items: [], hasMore: false } });
    const response = await request("/storage/configuration/candidates", env, { method: "PUT", headers, body: JSON.stringify(input()) });
    expect(response.status).toBe(200); const body = await response.json();
    expect(body).toMatchObject({ createdBy: actor, credentials: { status: "configured", ref: "fixture-credential-ref" } });
    expect(JSON.stringify(body)).not.toContain("fixture-secret");
    expect(c.read.mock.calls).toEqual([[env, actor]]); expect(c.save.mock.calls).toEqual([[env, input(), actor]]);
    await answer(await request("/files/shadow/evidence/capabilities", env, { headers }), 200, { canAdjudicate: false }, false);
    const denied = await request("/fixture-evidence-action", env, { method: "POST", headers });
    await answer(denied, 403, { error: "File evidence operator access is required." }, false);
    expect(denied.headers.get("cache-control")).toBe("no-store");
  });
  it("keeps File operator grants independent and short-circuits administrator-only service ports", async () => {
    const c = composition(), request = await requester(mode, c), env = bindings(false, true), headers = await authorizedHeaders();
    await answer(await request("/storage/configuration/capability", env, { headers }), 200, { canManage: false, credentialEditingAvailable: false });
    await answer(await request("/storage/configuration/candidates", env, { method: "PUT", headers, body: "invalid-json" }), 403, { error: "System administrator access is required." });
    await answer(await request("/files/shadow/evidence/capabilities", env, { headers }), 200, { canAdjudicate: true }, false);
    await answer(await request("/fixture-evidence-action", env, { method: "POST", headers }), 200, { actor }, false);
    expect(c.credentialEditingAvailable).not.toHaveBeenCalled(); expect(c.read).not.toHaveBeenCalled(); expect(c.save).not.toHaveBeenCalled();
  });
  it("resolves authorization from current bindings and rechecks revoked grants across requests", async () => {
    const c = composition(), request = await requester(mode, c), original = bindings(true), denied = bindings(), headers = await authorizedHeaders();
    await answer(await request("/storage/configuration/capability", original, { headers }), 200, { canManage: true, credentialEditingAvailable: true });
    await answer(await request("/storage/configuration/candidates", { ...original, replacement: denied }, { method: "PUT", headers, body: JSON.stringify(input()) }), 403,
      { error: "System administrator access is required." });
    expect(c.authorizeAdministrator.mock.calls.at(-1)![1]).toBe(denied);
    expect(original.principals.get(actor)!.capabilities.systemAdministrator).toBe(true);
    await answer(await request("/storage/configuration/capability", denied, { headers }), 200, { canManage: false, credentialEditingAvailable: false });
    const mismatched = { ...original, principals: new Map([[actor, { ...original.principals.get(actor)!, actor: "local-account:other" }]]) };
    await answer(await request("/storage/configuration", mismatched, { headers }), 403, { error: "System administrator access is required." });
    expect(c.save).not.toHaveBeenCalled(); expect(c.read).not.toHaveBeenCalled();
  });
  it("retains endpoint parsing and the existing 48 KiB input ceiling before service writes", async () => {
    const c = composition(), request = await requester(mode, c), env = bindings(true), headers = await authorizedHeaders();
    for (const init of [
      { method: "PUT", headers: { ...headers, "content-type": "text/plain" }, body: JSON.stringify(input()) },
      { method: "PUT", headers, body: "invalid-json" },
      { method: "PUT", headers, body: JSON.stringify({ ...input(), actor, capabilities: { systemAdministrator: true } }) },
    ]) await answer(await request("/storage/configuration/candidates", env, init), 400, { error: "Invalid storage configuration." });
    await answer(await request("/storage/configuration/candidates", env, { method: "PUT", headers, body: JSON.stringify({ ...input(), label: "x".repeat(MAX_STORAGE_CONFIGURATION_INPUT_BYTES) }) }),
      413, { error: "Storage configuration is too large." });
    expect(c.save).not.toHaveBeenCalled();
  });
  it("retains mapped conflicts and fixed unavailable responses without leaking private service errors", async () => {
    const c = composition(), request = await requester(mode, c), env = bindings(true), headers = await authorizedHeaders();
    c.save.mockRejectedValueOnce(new ServiceError(409, "Storage configuration changed. Refresh and try again."));
    await answer(await request("/storage/configuration/candidates", env, { method: "PUT", headers, body: JSON.stringify(input()) }), 409,
      { error: "Storage configuration changed. Refresh and try again." });
    c.read.mockRejectedValueOnce(new Error("fixture-secret private SQL"));
    await answer(await request("/storage/configuration", env, { headers }), 503, { error: "Storage configuration is temporarily unavailable." });
  });
  it("does not invent default grants and preserves the current cross-origin write guard", async () => {
    const c = composition(), request = await requester(mode, c), env = { verificationKey: publicKey, principals: new Map() }, headers = await authorizedHeaders();
    await answer(await request("/storage/configuration/capability", env, { headers }), 200, { canManage: false, credentialEditingAvailable: false });
    await answer(await request("/storage/configuration/candidates", bindings(true), { method: "PUT", headers: { ...headers, origin: "https://other.test" }, body: JSON.stringify(input()) }),
      403, { error: "Cross-origin writes are not allowed" });
    expect(c.authenticate).toHaveBeenCalledTimes(1); expect(c.credentialEditingAvailable).not.toHaveBeenCalled(); expect(c.save).not.toHaveBeenCalled();
  });
});
