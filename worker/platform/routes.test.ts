import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context, Hono } from "hono";
import { generateKeyPair, jwtVerify, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadinessDatabase } from "../runtime/sql";
import { createAuthenticationMiddleware } from "./authentication";
import { createPlatformRoutes } from "./routes";

/** This is a platform-seam test adapter, not the production SQLite adapter. */
class FileBackedReadinessDatabase implements ReadinessDatabase {
  readonly directory = mkdtempSync(join(tmpdir(), "rt1-platform-sqlite-"));
  readonly filename = join(this.directory, "fixture.sqlite");
  readonly database = new DatabaseSync(this.filename, { allowExtension: false });
  readonly sql: string[] = [];
  executions = 0;
  private closed = false;

  constructor() {
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; CREATE TABLE fixture_identity(value TEXT NOT NULL)");
    this.database.prepare("INSERT INTO fixture_identity VALUES(?)").run(crypto.randomUUID());
    expect(this.database.prepare("PRAGMA database_list").all()).toContainEqual(expect.objectContaining({ file: this.filename }));
  }
  prepare(sql: string) {
    this.sql.push(sql);
    const prepared = this.database.prepare(sql);
    return { first: async <T>() => {
      this.executions++;
      return (prepared.get() ?? null) as T | null;
    } };
  }
  close() {
    if (!this.closed) { this.database.close(); this.closed = true; }
  }
  dispose() { this.close(); rmSync(this.directory, { recursive: true }); }
}
type PlatformBindings = {
  database: ReadinessDatabase;
  verificationKey: CryptoKey;
  replacement?: ReadinessDatabase;
};
const databases: FileBackedReadinessDatabase[] = [];
const servers: Server[] = [];
let privateKey: CryptoKey, publicKey: CryptoKey;
const issuer = "urn:rt1-platform-fixture", audience = "rt1-platform-fixture";
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
  databases.splice(0).forEach(database => database.dispose());
  vi.restoreAllMocks();
});
function database() {
  const database = new FileBackedReadinessDatabase(); databases.push(database); return database;
}
async function credential(tokenAudience = audience) {
  return new SignJWT({ email: "fixture-actor@example.test" }).setProtectedHeader({ alg: "ES256" })
    .setIssuer(issuer).setAudience(tokenAudience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
}
function composition() {
  const authentication = vi.fn(async (request: Request, bindings: PlatformBindings) => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) throw new Error("Fixture credential required");
    const { payload } = await jwtVerify(authorization.slice(7), bindings.verificationKey, { issuer, audience });
    if (typeof payload.email !== "string") throw new Error("Fixture principal required");
    return { email: payload.email };
  });
  const selectDatabase = vi.fn((bindings: PlatformBindings) => bindings.database);
  const errors: Error[] = [];
  const app = new Hono<{ Bindings: PlatformBindings; Variables: { userEmail: string } }>().basePath("/api");
  app.onError((error, c) => { errors.push(error); return c.json({ error: "Unexpected server error" }, 500); });
  app.use("*", createAuthenticationMiddleware(authentication));
  app.use("*", async (c, next) => {
    if (c.env.replacement) c.env = { ...c.env, database: c.env.replacement };
    await next();
  });
  app.route("/", createPlatformRoutes(selectDatabase));
  app.get("/fixture-identity", c => c.json({ email: c.get("userEmail") }));
  return { app, authentication, selectDatabase, errors };
}
type Composition = ReturnType<typeof composition>;
type Requester = (path: string, bindings: PlatformBindings, init?: RequestInit) => Promise<Response>;
async function requester(mode: "Fetch" | "Node HTTP", c: Composition): Promise<Requester> {
  if (mode === "Fetch") return async (path, bindings, init) => c.app.fetch(new Request(`https://fixture.test/api${path}`, init), bindings);

  // A real loopback listener tests only these bounded no-body platform requests.
  // This harness does not implement a server distribution, body streaming,
  // static serving, proxy trust, disconnect propagation or local accounts.
  let currentBindings: PlatformBindings;
  let origin: string;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
      }
      const response = await c.app.fetch(new Request(new URL(incoming.url ?? "/", origin), {
        method: incoming.method, headers,
      }), currentBindings);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.statusCode = 500; outgoing.end("Fixture HTTP adapter failed");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback TCP listener");
  origin = `http://127.0.0.1:${address.port}`;
  return async (path, bindings, init) => {
    currentBindings = bindings;
    return fetch(`${origin}/api${path}`, init);
  };
}
function bindings(database: ReadinessDatabase): PlatformBindings { return { database, verificationKey: publicKey }; }

describe.each(["Fetch", "Node HTTP"] as const)("neutral platform routes through %s", mode => {
  it("keeps health public with a closed actual SQLite connection and never selects SQL or authenticates", async () => {
    const db = database(), c = composition(), request = await requester(mode, c);
    db.close();
    const response = await request("/health", bindings(db));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    expect(c.authentication).not.toHaveBeenCalled(); expect(c.selectDatabase).not.toHaveBeenCalled();
    expect(db.sql).toEqual([]); expect(db.executions).toBe(0);
  });

  it("rejects missing trusted credentials and forged principal headers before database selection", async () => {
    const db = database(), c = composition(), request = await requester(mode, c);
    const response = await request("/ready", bindings(db), { headers: { "x-user-email": "fixture-actor@example.test", "cf-access-authenticated-user-email": "fixture-actor@example.test" } });
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "Authentication required" });
    expect(c.authentication).toHaveBeenCalledTimes(1); expect(c.selectDatabase).not.toHaveBeenCalled();
    expect(db.sql).toEqual([]); expect(db.executions).toBe(0);
  });

  it("uses the real prepared-first capability on file-backed SQLite after verifying the fixture signature", async () => {
    const db = database(), c = composition(), request = await requester(mode, c);
    const response = await request("/ready", bindings(db), { headers: { authorization: `Bearer ${await credential()}` } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    expect(c.authentication).toHaveBeenCalledTimes(1); expect(c.selectDatabase).toHaveBeenCalledTimes(1);
    expect(db.sql).toEqual(["SELECT 1 AS ok"]); expect(db.executions).toBe(1);
  });

  it("denies a signed credential for another audience before SQL execution", async () => {
    const db = database(), c = composition(), request = await requester(mode, c);
    const response = await request("/ready", bindings(db), { headers: { authorization: `Bearer ${await credential("another-fixture")}` } });
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "Authentication required" });
    expect(c.selectDatabase).not.toHaveBeenCalled(); expect(db.sql).toEqual([]); expect(db.executions).toBe(0);
  });

  it("rejects a cross-origin POST before the trusted authenticator or SQL runs", async () => {
    const db = database(), c = composition(), request = await requester(mode, c);
    const response = await request("/ready", bindings(db), { method: "POST", headers: { origin: "https://other.test" } });
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "Cross-origin writes are not allowed" });
    expect(c.authentication).not.toHaveBeenCalled(); expect(c.selectDatabase).not.toHaveBeenCalled();
    expect(db.sql).toEqual([]); expect(db.executions).toBe(0);
  });

  it("selects the current replacement binding after middleware without changing the original bindings", async () => {
    const original = database(), replacement = database(), c = composition(), request = await requester(mode, c);
    const env = { ...bindings(original), replacement };
    const response = await request("/ready", env, { headers: { authorization: `Bearer ${await credential()}` } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    expect(c.selectDatabase.mock.calls[0]![0]).not.toBe(env);
    expect(c.selectDatabase.mock.calls[0]![0].database).toBe(replacement);
    expect(original.sql).toEqual([]); expect(original.executions).toBe(0);
    expect(replacement.sql).toEqual(["SELECT 1 AS ok"]); expect(replacement.executions).toBe(1);
    expect(env.database).toBe(original);
  });

  it("retains the composed database error response for a genuinely closed SQLite connection", async () => {
    const db = database(), c = composition(), request = await requester(mode, c);
    db.close();
    const response = await request("/ready", bindings(db), { headers: { authorization: `Bearer ${await credential()}` } });
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "Unexpected server error" });
    expect(c.errors).toHaveLength(1); expect(c.errors[0]).toBeInstanceOf(Error);
    expect(db.sql).toEqual(["SELECT 1 AS ok"]); expect(db.executions).toBe(0);
  });

  it("reuses one route graph across distinct actual database bindings and exposes only the verified actor", async () => {
    const a = database(), b = database(), c = composition(), request = await requester(mode, c);
    const headers = { authorization: `Bearer ${await credential()}`, "x-user-email": "forged@example.test" };
    for (const db of [a, b]) {
      expect((await request("/ready", bindings(db), { headers })).status).toBe(200);
      expect(db.sql).toEqual(["SELECT 1 AS ok"]); expect(db.executions).toBe(1);
    }
    const response = await request("/fixture-identity", bindings(a), { headers });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ email: "fixture-actor@example.test" });
    expect(a.executions).toBe(1); expect(b.executions).toBe(1);
  });
});

it("retains successful null-first readiness semantics without inventing schema or provider checks", async () => {
  const first = vi.fn(async () => null), prepare = vi.fn(() => ({ first }));
  const c = composition();
  const response = await c.app.fetch(new Request("https://fixture.test/api/ready", { headers: { authorization: `Bearer ${await credential()}` } }), bindings({ prepare }));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
  expect(prepare.mock.calls).toEqual([["SELECT 1 AS ok"]]); expect(first).toHaveBeenCalledTimes(1);
});

it("preserves the authentication middleware catch scope for a rejecting downstream continuation", async () => {
  const db = database(), c = composition();
  const context = new Context<{ Bindings: PlatformBindings; Variables: { userEmail: string } }>(new Request("https://fixture.test/api/ready", {
    headers: { authorization: `Bearer ${await credential()}` },
  }), { env: bindings(db) });
  const response = await createAuthenticationMiddleware(c.authentication)(context, async () => { throw new Error("Downstream fixture failed"); });
  expect(response).toBeInstanceOf(Response);
  if (!(response instanceof Response)) throw new Error("Expected retained authentication rejection response");
  expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "Authentication required" });
  expect(context.get("userEmail")).toBe("fixture-actor@example.test");
  expect(db.sql).toEqual([]); expect(db.executions).toBe(0);
});

it("uses an actual persistent SQLite file whose fixture identity survives a closed connection", () => {
  const db = database();
  const identity = db.database.prepare("SELECT value FROM fixture_identity").get()!.value;
  db.close();
  const reopened = new DatabaseSync(db.filename, { readOnly: true, allowExtension: false });
  try {
    expect(reopened.prepare("SELECT value FROM fixture_identity").get()!.value).toBe(identity);
    expect(reopened.prepare("PRAGMA quick_check").get()!.quick_check).toBe("ok");
    expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { reopened.close(); }
});
