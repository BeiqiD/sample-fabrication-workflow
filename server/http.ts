import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { readFabubloxWireRouteAdmission, type FabubloxWireRouteAdmission } from "./imports/fabublox-wire-route-admission.ts";

export interface NodeHttpRequestLifetime {
  readonly kind: "node-http-original-request-lifetime/1";
  readonly settled: Promise<void>;
  /** Abort only this actual ingress and join its original handler/pump/cancel ACK. */
  close(): Promise<void>;
}
const issuedRequestLifetimes = new WeakMap<Request, Readonly<{ server: Server; lifetime: NodeHttpRequestLifetime }>>();
export function ownedNodeHttpRequestLifetime(request: Request, server: Server): NodeHttpRequestLifetime {
  const owner = issuedRequestLifetimes.get(request);
  if (!owner || owner.server !== server || !issuedHttpServers.has(server))
    throw new Error("Original HTTP Request lifetime is unavailable");
  return owner.lifetime;
}

export type FetchHandler = (request: Request) => Promise<Response> | Response;
export type NodeHttpOptions = {
  /** Deployment-owned origin; Host and forwarding headers never select it. */
  publicOrigin: string;
  /** Trusted composition-owned admission of this exact request and actual ingress.
   * Returning a fixed denial prevents handler dispatch; omitted keeps transport behavior. */
  requestAdmission?: (request: Request, incoming: IncomingMessage, server: Server) => void | Response;
  /** Genuine fixed-route child token; supplies no authentication or provider grant. */
  fabubloxWireAdmission?:FabubloxWireRouteAdmission;
  maxBodyBytes?: number;
  maxHeaderBytes?: number;
  maxHeaderCount?: number;
  timeoutMs?: number;
};

interface HttpInvocation {
  settlement: Promise<void>;
  readonly owners: readonly unknown[];
}
interface HttpServerOwner {
  phase: "open" | "stopping" | "closed" | "quarantined";
  readonly invocations: Set<HttpInvocation>;
  readonly listenerClosed: Promise<void>;
  hasListened: boolean;
  listenerSettled: boolean;
  draining?: Promise<void>;
  failure?: NodeHttpServerDrainError;
}
/** Failed original stream disposal retains its real owners. A response or
 * socket close is not permission to close this host's database or lease. */
export class NodeHttpServerDrainError extends AggregateError {
  declare readonly retainedOwners: readonly unknown[];
  constructor(errors: readonly unknown[], owners: readonly unknown[]) {
    super(errors, "Original HTTP transport ownership could not drain");
    this.name = "NodeHttpServerDrainError";
    Object.defineProperty(this, "retainedOwners", { value: Object.freeze([...owners]) });
  }
}
class HttpStreamCleanupError extends AggregateError {
  constructor(error: unknown, readonly owner: unknown) {
    super([error], "Original HTTP stream cleanup failed");
  }
}
const issuedHttpServers = new WeakMap<Server, HttpServerOwner>();
const retainedHttpOwners = new Set<HttpServerOwner>();

/** Only the exact issued server owns this drain. Stop admission synchronously,
 * then await original handlers, pumps and disposers, including late results.
 * Rejection is retained and never causes a guessed cleanup retry. */
export function stopNodeHttpServerAndDrain(server: Server): Promise<void> {
  const owner = issuedHttpServers.get(server);
  if (!owner) return Promise.reject(new Error("HTTP transport ownership is unavailable"));
  if (owner.draining) return owner.draining;
  if (owner.phase !== "quarantined") owner.phase = "stopping";
  let listener: Promise<void>;
  let initialCloseReturned = true;
  if (server.listening) {
    listener = new Promise<void>((resolve, reject) => {
      initialCloseReturned = false;
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
      initialCloseReturned = true;
    });
  } else listener = owner.hasListened && !owner.listenerSettled ? owner.listenerClosed : Promise.resolve();
  void listener.catch(() => undefined); // Retain its original rejection while original invocations settle.
  owner.draining = (async () => {
    const invocations = await Promise.allSettled([...owner.invocations].map(value => value.settlement));
    const idleErrors: unknown[] = [];
    // An admitted request can become idle after the initial listener close.
    // Drain its original handler/body cleanup before sweeping only idle sockets.
    if (initialCloseReturned) {
      try { server.closeIdleConnections(); } catch (error) { idleErrors.push(error); }
    }
    const results = [...await Promise.allSettled([listener]), ...invocations];
    const errors = results.flatMap(value => value.status === "rejected" ? [value.reason as unknown] : []);
    errors.push(...idleErrors);
    if (errors.length || owner.failure) {
      // Keep the first invocation failure as an exact cause when the listener
      // or final idle sweep also reports a distinct cleanup failure.
      if (!owner.failure || errors.some(error => error !== owner.failure)) {
        owner.failure = new NodeHttpServerDrainError(errors, [server, owner, ...owner.invocations]);
      }
      owner.phase = "quarantined"; retainedHttpOwners.add(owner);
      throw owner.failure;
    }
    owner.phase = "closed"; retainedHttpOwners.delete(owner);
  })();
  void owner.draining.catch(() => undefined); // Observe, without replacing its rejecting original promise.
  return owner.draining;
}

class HttpBoundaryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const hopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade"]);
const forwardingHeaders = new Set(["forwarded", "x-forwarded-for", "x-forwarded-host",
  "x-forwarded-proto", "x-forwarded-port", "x-real-ip"]);
function positive(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}
function requestTarget(target: string) {
  if (!target.startsWith("/") || target.startsWith("//") || /[\\\x00-\x20#]/.test(target)) {
    throw new HttpBoundaryError(400, "Invalid request target");
  }
  let path: string;
  try { path = decodeURIComponent(target.split("?", 1)[0]); }
  catch { throw new HttpBoundaryError(400, "Invalid request path encoding"); }
  if (/[\\\x00-\x1f\x7f]/.test(path) || /%2f|%5c/i.test(target.split("?", 1)[0])
    || path.split("/").some(part => part === "." || part === "..")) {
    throw new HttpBoundaryError(400, "Invalid request path");
  }
  return target;
}
function requestHeaders(incoming: IncomingMessage) {
  const excluded = new Set([...hopHeaders, ...forwardingHeaders,
    ...(incoming.headers.connection ?? "").toLowerCase().split(",").map(value => value.trim())]);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined || excluded.has(name)) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  return headers;
}
function errorResponse(outgoing: ServerResponse, status: number, message: string) {
  if (outgoing.destroyed) return;
  if (outgoing.headersSent) { outgoing.destroy(); return; }
  outgoing.writeHead(status, { "content-type": "text/plain; charset=utf-8", "connection": "close" });
  outgoing.end(message);
}
function writableDrain(outgoing: ServerResponse, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => {
      outgoing.off("drain", drain); outgoing.off("close", close); outgoing.off("error", close);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve();
    };
    const drain = () => done();
    const close = () => done(new Error("Client disconnected"));
    const aborted = () => done(new Error("Request aborted"));
    outgoing.once("drain", drain); outgoing.once("close", close); outgoing.once("error", close);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted || outgoing.destroyed) aborted();
  });
}
async function writeResponse(response: Response, incoming: IncomingMessage, outgoing: ServerResponse,
  signal: AbortSignal, maxHeaderBytes: number,
  ownBody: (reader: ReadableStreamDefaultReader<Uint8Array> | null) => void) {
  if (response.body?.locked) throw new HttpStreamCleanupError(
    new Error("Response body is owned by an external reader"), { response, body: response.body });
  const headers: Record<string, string | string[]> = {};
  let bytes = 0;
  const excluded = new Set([...hopHeaders,
    ...(response.headers.get("connection") ?? "").toLowerCase().split(",").map(value => value.trim())]);
  for (const [name, value] of response.headers) {
    if (excluded.has(name) || name === "set-cookie") continue;
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    headers[name] = value;
  }
  const cookies = excluded.has("set-cookie") ? [] : response.headers.getSetCookie();
  for (const cookie of cookies) bytes += Buffer.byteLength(cookie) + 14;
  if (bytes > maxHeaderBytes) throw new HttpBoundaryError(500, "Response headers exceed the runtime limit");
  if (cookies.length) headers["set-cookie"] = cookies;
  if (signal.aborted) throw new Error("Request aborted");
  outgoing.writeHead(response.status, headers);
  if (incoming.method === "HEAD" || !response.body) {
    ownBody(null); // The original HEAD cancellation below owns this unlocked body.
    try { await response.body?.cancel(); }
    catch (error) { throw new HttpStreamCleanupError(error, response); }
    outgoing.end(); return;
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = response.body.getReader(); }
  catch (error) { throw new HttpStreamCleanupError(error, { response, body: response.body }); }
  ownBody(reader); // Only this exact acquired reader owns the memoized pump/cancel.
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    if (!cancellation) {
      cancellation = reader.cancel(signal.reason);
      void cancellation.catch(() => undefined);
    }
    return cancellation;
  };
  const cancelled = () => { cancel(); };
  signal.addEventListener("abort", cancelled, { once: true });
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) { outgoing.end(); return; }
      if (!outgoing.write(next.value)) await writableDrain(outgoing, signal);
    }
    throw new Error("Request aborted");
  } finally {
    signal.removeEventListener("abort", cancelled);
    try { await cancel(); }
    catch (error) { throw new HttpStreamCleanupError(error, { response, reader, cancellation }); }
    finally { reader.releaseLock(); }
  }
}

/** HTTP transport only. This supplies no application bindings, login or storage. */
export function createNodeHttpServer(handler: FetchHandler, options: NodeHttpOptions): Server {
  const origin = new URL(options.publicOrigin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Configure a public origin without credentials or path");
  const publicOrigin = origin.origin;
  const requestAdmission = options.requestAdmission;
  const fabubloxMaximum=options.fabubloxWireAdmission===undefined?undefined
    :readFabubloxWireRouteAdmission(options.fabubloxWireAdmission,publicOrigin);
  const maxBodyBytes = positive(options.maxBodyBytes ?? 100 * 1024 * 1024, "maxBodyBytes");
  const maxHeaderBytes = positive(options.maxHeaderBytes ?? 16 * 1024, "maxHeaderBytes");
  const maxHeaderCount = positive(options.maxHeaderCount ?? 128, "maxHeaderCount");
  const timeoutMs = positive(options.timeoutMs ?? 60_000, "timeoutMs");
  let listenerClosed!: () => void;
  const owner: HttpServerOwner = { phase: "open", invocations: new Set(), hasListened: false, listenerSettled: false,
    listenerClosed: new Promise<void>(resolve => { listenerClosed = resolve; }) };
  const server = createServer({ maxHeaderSize: maxHeaderBytes, requestTimeout: timeoutMs,
    headersTimeout: Math.min(timeoutMs, 10_000), connectionsCheckingInterval: Math.min(timeoutMs, 1_000) }, (incoming, outgoing) => {
    dispatch(incoming, outgoing);
  });
  issuedHttpServers.set(server, owner);
  server.on("listening", () => { owner.hasListened = true; });
  server.on("close", () => { owner.listenerSettled = true; listenerClosed(); });
  // Keep all parsed fields available for our explicit count guard rather than truncating them.
  server.maxHeadersCount = 0;
  server.headersTimeout = Math.min(timeoutMs, 10_000);
  server.requestTimeout = timeoutMs;
  // Idle/incomplete headers also receive a bound before a Fetch owner exists.
  server.setTimeout(timeoutMs);
  server.keepAliveTimeout = 5_000;
  server.on("checkContinue", (incoming, outgoing) => { dispatch(incoming, outgoing, true); });
  server.on("clientError", (error, socket) => {
    if (!socket.writable) return;
    const code = (error as NodeJS.ErrnoException).code;
    // Native requestTimeout and the Fetch owner deadline can expire in either
    // order. The native deadline is still a timeout, not malformed HTTP syntax.
    const status = code === "ERR_HTTP_REQUEST_TIMEOUT" ? 408 : code === "HPE_HEADER_OVERFLOW" ? 431 : 400;
    const reason = status === 408 ? "Request Timeout" : status === 431 ? "Request Header Fields Too Large" : "Bad Request";
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  server.on("connect", (_incoming, socket) => { socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
  server.on("upgrade", (_incoming, socket) => { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
  function dispatch(incoming: IncomingMessage, outgoing: ServerResponse, continueRequested = false) {
    if (owner.phase !== "open") {
      errorResponse(outgoing, 503, "HTTP transport is stopping"); incoming.resume(); return;
    }
    const invocation: HttpInvocation = { settlement: Promise.resolve(), owners: Object.freeze([incoming, outgoing]) };
    owner.invocations.add(invocation); retainedHttpOwners.add(owner);
    // Register before invoking any original application/body owner.
    invocation.settlement = Promise.resolve().then(() => handle(incoming, outgoing, invocation, continueRequested)).then(() => {
      owner.invocations.delete(invocation);
      if (!owner.invocations.size && !owner.failure) retainedHttpOwners.delete(owner);
    }, error => {
      owner.failure ??= new NodeHttpServerDrainError([error], [server, invocation, ...invocation.owners]);
      owner.phase = "quarantined"; retainedHttpOwners.add(owner);
      throw owner.failure;
    });
    void invocation.settlement.catch(() => undefined);
  }
  async function handle(incoming: IncomingMessage, outgoing: ServerResponse, invocation: HttpInvocation, continueRequested = false) {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Client disconnected"));
    const onClose = () => { if (!outgoing.writableFinished) abort(); };
    incoming.once("aborted", abort); outgoing.once("close", onClose);
    let rejectFailure: (error: Error) => void = () => undefined;
    const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
    // A disconnected or rejected upload is observed even when the handler ignores its stream.
    failure.catch(() => undefined);
    const fail = (error: Error) => { controller.abort(error); rejectFailure(error); };
    const timeout = setTimeout(() => fail(new HttpBoundaryError(408, "Request timed out")), timeoutMs);
    // The original request deadline is now armed. A competing socket idle
    // timeout must not destroy this accepted connection before its 408 ACK.
    incoming.socket.setTimeout(0);
    const disconnect = () => rejectFailure(new Error("Client disconnected"));
    controller.signal.addEventListener("abort", disconnect, { once: true });
    let limiter: PassThrough | undefined;
    let limiterClosed: Promise<void> | undefined;
    let producedResponse: Response | undefined;
    let applicationResponse: Promise<Response> | undefined, responsePump: Promise<void> | undefined;
    let responseBodyOwner: { response: Response; reader: ReadableStreamDefaultReader<Uint8Array> | null } | undefined;
    let responseCancellation: Promise<void> | undefined;
    let cancelRequestBody: (() => Promise<void>) | undefined;
    const requestPulls = new Set<Promise<void>>(), cleanupErrors: unknown[] = [];
    const cancelResponse = () => {
      if (responseCancellation) return responseCancellation;
      if (!producedResponse?.body) return Promise.resolve();
      if (producedResponse.body.locked) {
        responseCancellation = Promise.reject(new HttpStreamCleanupError(
          new Error("Response body is owned by an external reader"), { response: producedResponse, body: producedResponse.body }));
        void responseCancellation.catch(() => undefined);
        return responseCancellation;
      }
      if (!responseCancellation) {
        const originalResponse = producedResponse;
        responseCancellation = originalResponse.body!.cancel().catch(error => {
          throw new HttpStreamCleanupError(error, originalResponse);
        });
        void responseCancellation.catch(() => undefined);
      }
      return responseCancellation;
    };
    try {
      if (incoming.rawHeaders.length / 2 > maxHeaderCount) throw new HttpBoundaryError(431, "Too many request headers");
      const target = requestTarget(incoming.url ?? "/");
      const method = incoming.method ?? "GET";
      const selectedBodyMaximum=fabubloxMaximum!==undefined && method==="POST" && target==="/api/imports/fabublox"
        ?fabubloxMaximum:maxBodyBytes;
      const declaredLength = incoming.headers["content-length"];
      if (declaredLength && BigInt(declaredLength) > BigInt(selectedBodyMaximum)) throw new HttpBoundaryError(413, "Request body exceeds the runtime limit");
      const hasBody = Boolean(incoming.headers["transfer-encoding"] || declaredLength && BigInt(declaredLength) !== 0n);
      if ((method === "GET" || method === "HEAD") && hasBody) throw new HttpBoundaryError(400, "GET and HEAD bodies are unsupported");
      let consumed = 0;
      const count = (chunk: Buffer) => {
        consumed += chunk.byteLength;
        if (consumed > selectedBodyMaximum) throw new HttpBoundaryError(413, "Request body exceeds the runtime limit");
      };
      const complete = new Promise<void>((resolve, reject) => {
        incoming.once("end", resolve);
        incoming.once("aborted", () => reject(new Error("Incomplete request body")));
        incoming.once("error", reject);
      });
      complete.catch(() => undefined);
      const headers = requestHeaders(incoming);
      const init: RequestInit & { duplex?: "half" } = { method, headers, signal: controller.signal };
      if (hasBody) {
        limiter = new PassThrough({ highWaterMark: 64 * 1024 });
        limiterClosed = new Promise<void>(resolve => { limiter!.once("close", resolve); });
        const bodyStream = limiter;
        // A Fetch consumer may stop reading (for example after its smaller
        // credential limit). Only this privately owned cancellation ends the
        // downstream stream; the HTTP upload still counts and drains to EOF.
        const consumptionEnded = new Error("Fetch body consumption ended");
        // Count at IncomingMessage, including bytes queued in a downstream
        // writable buffer if the handler returns without reading its body.
        incoming.on("data", (chunk: Buffer) => {
          try { count(chunk); } catch (error) { incoming.pause(); limiter?.destroy(error as Error); fail(error as Error); }
        });
        limiter.on("error", (error) => {
          if (error === consumptionEnded) return;
          incoming.unpipe(bodyStream); incoming.pause(); fail(error);
        });
        const reader = (Readable.toWeb(limiter) as ReadableStream<Uint8Array>).getReader();
        // This reader owns only our private PassThrough. Its ordinary read
        // error is settled once that exact native buffer emits close; it is
        // distinct from a provider's failed response-body disposer.
        const readerCompleted = reader.closed.then(() => undefined, () => undefined);
        let consumptionCancelled = false, readerReleased = false, cancellation: Promise<void> | undefined;
        const releaseReader = () => { if (!readerReleased) { reader.releaseLock(); readerReleased = true; } };
        cancelRequestBody = () => {
          if (cancellation) return cancellation;
          if (readerReleased) return Promise.resolve();
          // Native normal EOF/autoDestroy does not consume the Web adapter's
          // unread queue. Cancel that exact reader once; only premature/error
          // destruction already owns its original error/closed settlement.
          if (bodyStream.destroyed && (!bodyStream.readableEnded || bodyStream.errored)) return readerCompleted.then(releaseReader);
          if (!cancellation) {
            consumptionCancelled = true;
            incoming.unpipe(bodyStream); incoming.resume();
            cancellation = reader.cancel(consumptionEnded).finally(releaseReader);
            void cancellation.catch(() => undefined);
          }
          return cancellation;
        };
        init.body = new ReadableStream<Uint8Array>({
          pull(body) {
            const original = (async () => {
              try {
                const next = await reader.read();
                if (consumptionCancelled) return;
                if (next.done) { body.close(); releaseReader(); }
                else body.enqueue(next.value);
              } catch (error) {
                if (consumptionCancelled) return;
                releaseReader(); body.error(error);
              }
            })();
            requestPulls.add(original);
            void original.then(() => { requestPulls.delete(original); }, () => { /* Retain the failed original pull. */ });
            return original;
          },
          cancel: () => cancelRequestBody!(),
        }, { highWaterMark: 0 });
        init.duplex = "half";
        incoming.pipe(limiter);
      }
      const request = new Request(publicOrigin + target, init);
      let completed = false, originalClose: Promise<void> | undefined;
      void invocation.settlement.then(() => { completed = true; }, () => { completed = true; });
      const lifetime: NodeHttpRequestLifetime = Object.freeze({
        kind: "node-http-original-request-lifetime/1" as const,
        settled: invocation.settlement,
        close(): Promise<void> {
          if (originalClose) return originalClose;
          originalClose = Promise.resolve().then(() => {
            if (!completed && !controller.signal.aborted) controller.abort(new Error("Original source ingress is draining"));
            return invocation.settlement;
          });
          void originalClose.catch(() => undefined); return originalClose;
        },
      });
      issuedRequestLifetimes.set(request, Object.freeze({ server, lifetime }));
      if (continueRequested) outgoing.writeContinue();
      const admitted = requestAdmission?.(request, incoming, server);
      applicationResponse = Promise.resolve(admitted instanceof Response ? admitted : handler(request)).then(async response => {
        producedResponse = response;
        if (controller.signal.aborted) {
          await cancelResponse();
          throw controller.signal.reason;
        }
        return response;
      });
      const response = await Promise.race([applicationResponse, failure]);
      // Returning a Response ends handler ownership of upload consumption. Drain
      // unused bytes without queuing them in the Fetch body; validate before ACK.
      if (limiter) {
        await cancelRequestBody?.();
        incoming.unpipe(limiter); limiter.destroy();
      }
      incoming.resume();
      if (!incoming.readableEnded) await Promise.race([complete, failure]);
      responsePump = writeResponse(response, incoming, outgoing, controller.signal, maxHeaderBytes,
        reader => { responseBodyOwner = { response, reader }; });
      await Promise.race([responsePump, failure]);
    } catch (error) {
      // Upload rejection can occur after the handler has produced a body but
      // before response streaming starts. Release that unconsumed body too.
      if (!controller.signal.aborted) controller.abort(error);
      // Unblock the original Fetch-body reader after a rejected ingress. This
      // destroys only our transport buffer, never an application/provider owner.
      if (limiter) { incoming.unpipe(limiter); limiter.destroy(); }
      const boundary = error instanceof HttpBoundaryError ? error
        : controller.signal.reason instanceof HttpBoundaryError ? controller.signal.reason : undefined;
      errorResponse(outgoing, boundary?.status ?? 500, boundary?.message ?? "Request failed");
    } finally {
      // An early error ACK does not abandon the original handler or a late
      // returned body. Preserve each original pump/cancel promise until actual
      // settlement; cleanup failures retain the host instead of releasing it.
      if (applicationResponse) {
        try { await applicationResponse; }
        catch (error) { if (error instanceof HttpStreamCleanupError) cleanupErrors.push(error); }
      }
      if (responsePump) {
        try { await responsePump; }
        catch (error) { if (error instanceof HttpStreamCleanupError) cleanupErrors.push(error); }
      }
      if (!responseBodyOwner) {
        // Header/signal/reader-acquisition failure never acquired body custody.
        // Cancel only an unlocked unowned body; a foreign lock is quarantine.
        try { await cancelResponse(); } catch (error) { cleanupErrors.push(error); }
      }
      try { await cancelRequestBody?.(); }
      catch (error) { cleanupErrors.push(new HttpStreamCleanupError(error, { incoming, limiter, cancelRequestBody })); }
      const pulls = await Promise.allSettled([...requestPulls]);
      cleanupErrors.push(...pulls.flatMap(value => value.status === "rejected" ? [value.reason as unknown] : []));
      limiter?.destroy(); await limiterClosed;
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", disconnect);
      incoming.off("aborted", abort); outgoing.off("close", onClose);
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Original HTTP stream owners remain retained");
    }
  }
  return server;
}
