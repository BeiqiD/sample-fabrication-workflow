// SOURCE-ONLY closed Sample-only host; no current main/default/Worker import.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { createInstalledLocalIdentity, type IdentityPolicy } from "../auth/identity";
import type { PasswordHasher } from "../auth/passwords";
import { createLocalAuthentication, type LocalAuthEnvironment } from "../auth/local-auth-http";
import { createLoopbackLocalAuthTransport } from "../auth/local-auth-transport";
import { createNodeHttpServer, stopNodeHttpServerAndDrain, type NodeHttpOptions } from "../http";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import type { SqliteCapability } from "../sqlite";
import { createLocalSamplePermissionV28Candidate, type SamplePermissionScope } from "./local-sample-permission-candidate";

const unavailable = () => Response.json({ error: "This operation is unavailable in the Sample-only collaboration candidate." },
  { status: 503, headers: { "Cache-Control": "private, no-store" } });
const MAX_METADATA_BYTES = 65_536;
const claimed = new WeakSet<LinuxWriterLease>();
interface HostOwner {
  readonly database: SqliteCapability; readonly nativeDatabase: DatabaseSync; readonly writerLease: LinuxWriterLease;
  server?: Server; quarantined: boolean;
}
const owners = new Set<HostOwner>();
export const SAMPLE_ONLY_V28_ROUTES = Object.freeze([
  { method: "GET", path: "/api/sample-directory-options" }, { method: "GET", path: "/api/samples" },
  { method: "POST", path: "/api/samples" }, { method: "PATCH", path: "/api/samples/:id" },
  { method: "DELETE", path: "/api/samples/:id" }, { method: "POST", path: "/api/samples/:id/restore" },
].map(value => Object.freeze(value)));

async function metadataBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const bytes = new Uint8Array(MAX_METADATA_BYTES); let used = 0, failed = false, failure: unknown;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      if (part.value.length > bytes.length - used) throw new HTTPException(413, { message: "Sample metadata request is too large." });
      bytes.set(part.value, used); used += part.value.length;
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used))) as unknown; }
    catch { return null; } // Preserve mature invalid-input validation behavior.
  } catch (error) { failed = true; failure = error; throw error; }
  finally {
    bytes.fill(0);
    try { await reader.cancel(); }
    catch (error) { throw failed ? new AggregateError([failure, error], "Sample input and original body cleanup failed") : error; }
    finally { reader.releaseLock(); }
  }
}

/** The caller acquires the real private Linux writer lease BEFORE native open,
 * installs/adopts the explicit V28 candidate while stopped, binds the actual
 * core/native tuple, and supplies a genuine issued current admission. This host
 * never installs metadata, enrolls accounts/members or enables control. It
 * refuses operational26/historical27 and never exposes its offline operators.
 * A new physical owner is required after close; opaque services cannot be reused.
 * No SPA, Project/Template/Execution/search/reference/File/export/job/config
 * routes are mounted. System administrator grants do not bypass member/root SQL.
 * Only numeric loopback development ingress is supported, with real cookie,
 * Origin/CSRF and current session proof before body and again INSIDE native BEGIN.
 * The full original HTTP/body/application owners drain before native close and
 * physical release; any uncertain original cleanup is permanently quarantined. */
export async function createSampleOnlyV28HostCandidate(options: {
  database: SqliteCapability; nativeDatabase: DatabaseSync; writerLease: LinuxWriterLease;
  admission: ReviewedInstallationAdmission; hasher: PasswordHasher; identityPolicy: IdentityPolicy;
  publicOrigin: string; httpLimits?: Pick<NodeHttpOptions, "maxBodyBytes" | "maxHeaderBytes" | "maxHeaderCount" | "timeoutMs">;
}) {
  const { database, nativeDatabase, writerLease, admission, hasher, publicOrigin } = options;
  const identityPolicy = Object.freeze({ ...options.identityPolicy }), httpLimits = Object.freeze({ ...options.httpLimits });
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  if (assertInstallationAdmission(nativeDatabase, admission).checkpointId !== "portable-runtime/v28"
    || claimed.has(writerLease) || owners.size >= 2) throw new Error("Sample-only collaboration host is unavailable");
  claimed.add(writerLease);
  const owner: HostOwner = { database, nativeDatabase, writerLease, quarantined: false }; owners.add(owner);
  let active = true, appOwner: Hono<LocalAuthEnvironment> | undefined;
  const pending = new Set<Promise<Response>>();
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing; // Keep the original REJECTED promise too.
    active = false;
    const httpDrain = owner.server ? stopNodeHttpServerAndDrain(owner.server) : Promise.resolve();
    const physicalDrain = writerLease.stopAdmissionAndDrain();
    void httpDrain.catch(() => undefined); void physicalDrain.catch(() => undefined);
    closing = (async () => {
      try {
        // Failure at any preceding original owner prevents native/FD cleanup.
        await httpDrain;
        await Promise.allSettled([...pending]);
        await physicalDrain;
        appOwner = undefined;
        database.close(); // Reported failure is unknown custody, never a raw fallback.
        if (nativeDatabase.isOpen) throw new Error("Sample-only native close is unavailable");
        await writerLease.release(); owners.delete(owner);
      } catch (error) { owner.quarantined = true; throw error; }
    })();
    void closing.catch(() => undefined); return closing;
  }
  try {
    await writerLease.withWriter(async () => {
      const transport = createLoopbackLocalAuthTransport({ publicOrigin });
      const identity = await createInstalledLocalIdentity({ database, nativeDatabase, admission, hasher, policy: identityPolicy });
      assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
      assertInstallationAdmission(nativeDatabase, admission);
      const authentication = createLocalAuthentication({ identity, transport, now: Date.now });
      const permission = createLocalSamplePermissionV28Candidate({ database, nativeDatabase, admission, writerLease, authentication });
      const app = new Hono<LocalAuthEnvironment>();
      app.use("*", async (c, next) => { c.header("Cache-Control", "private, no-store"); c.header("X-Content-Type-Options", "nosniff"); await next(); });
      app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status)
        : c.json({ error: "Sample collaboration operation is unavailable." }, 503));
      app.route("/api/auth", authentication.routes);
      const capture = (request: Request, scope: SamplePermissionScope) => permission.capture(request, scope);
      app.get("/api/sample-directory-options", async c => {
        const request = c.req.raw, token = await capture(request, { operation: "directory_options" });
        const result = await permission.directoryOptions(request, token);
        c.header("Server-Timing", result.serverTiming); return c.json(result.payload);
      });
      app.get("/api/samples", async c => {
        const request = c.req.raw, token = await capture(request, { operation: "directory" });
        const result = await permission.directory(request, token);
        c.header("Server-Timing", result.serverTiming); return c.json(result.payload);
      });
      app.post("/api/samples", async c => {
        const request = c.req.raw, token = await capture(request, { operation: "create" });
        return c.json(await permission.create(request, token, await metadataBody(request)), 201);
      });
      app.patch("/api/samples/:id", async c => {
        const request = c.req.raw, id = c.req.param("id"), token = await capture(request, { operation: "update", id });
        return c.json(await permission.update(request, token, id, await metadataBody(request)));
      });
      app.delete("/api/samples/:id", async c => {
        const request = c.req.raw, id = c.req.param("id"), token = await capture(request, { operation: "remove", id });
        return c.json(await permission.remove(request, token, id, await metadataBody(request)));
      });
      app.post("/api/samples/:id/restore", async c => {
        const request = c.req.raw, id = c.req.param("id"), token = await capture(request, { operation: "restore", id });
        return c.json(await permission.restore(request, token, id, await metadataBody(request)));
      });
      app.all("*", () => unavailable()); appOwner = app;
      const authRoutes = new Set(["POST /api/auth/login", "GET /api/auth/session", "POST /api/auth/logout", "POST /api/auth/rotate"]);
      const admitted = (request: Request) => authRoutes.has(`${request.method} ${new URL(request.url).pathname}`)
        || SAMPLE_ONLY_V28_ROUTES.some(route => route.method === request.method
          && new RegExp(`^${route.path.replace(":id", "[^/]+")}$`).test(new URL(request.url).pathname));
      owner.server = createNodeHttpServer(async request => {
        if (!active || !admitted(request)) return unavailable();
        const original = writerLease.withWriter(() => {
          const application = appOwner;
          return application ? Promise.resolve(application.fetch(request, {})) : Promise.resolve(unavailable());
        });
        pending.add(original);
        try { return await original; } finally { pending.delete(original); }
      }, { ...httpLimits, publicOrigin, requestAdmission(request, incoming, actualServer) {
        try { transport.admit(request, incoming, actualServer); }
        catch { return Response.json({ error: "Request admission is required." }, { status: 403, headers: { "Cache-Control": "private, no-store" } }); }
      } });
    });
    return Object.freeze({ server: owner.server!, close, scope: "sample-only-collaboration-candidate" as const,
      routes: SAMPLE_ONLY_V28_ROUTES, unsupportedBusinessRoutes: "all other methods and paths" as const });
  } catch (error) {
    // The ORIGINAL constructor/KDF promise has already actually settled here.
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Sample host construction and original cleanup failed"); }
    throw error;
  }
}
