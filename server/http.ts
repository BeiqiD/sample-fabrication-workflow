import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PassThrough, Readable } from "node:stream";

export type FetchHandler = (request: Request) => Promise<Response> | Response;
export type NodeHttpOptions = {
  /** Deployment-owned origin; Host and forwarding headers never select it. */
  publicOrigin: string;
  /** Trusted composition-owned admission of this exact request and actual ingress.
   * Returning a fixed denial prevents handler dispatch; omitted keeps transport behavior. */
  requestAdmission?: (request: Request, incoming: IncomingMessage, server: Server) => void | Response;
  maxBodyBytes?: number;
  maxHeaderBytes?: number;
  maxHeaderCount?: number;
  timeoutMs?: number;
};

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
  signal: AbortSignal, maxHeaderBytes: number) {
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
    await response.body?.cancel(); outgoing.end(); return;
  }
  const reader = response.body.getReader();
  const cancelled = () => { void reader.cancel(signal.reason).catch(() => undefined); };
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
    await reader.cancel().catch(() => undefined); reader.releaseLock();
  }
}

/** HTTP transport only. This supplies no application bindings, login or storage. */
export function createNodeHttpServer(handler: FetchHandler, options: NodeHttpOptions): Server {
  const origin = new URL(options.publicOrigin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Configure a public origin without credentials or path");
  const publicOrigin = origin.origin;
  const requestAdmission = options.requestAdmission;
  const maxBodyBytes = positive(options.maxBodyBytes ?? 100 * 1024 * 1024, "maxBodyBytes");
  const maxHeaderBytes = positive(options.maxHeaderBytes ?? 16 * 1024, "maxHeaderBytes");
  const maxHeaderCount = positive(options.maxHeaderCount ?? 128, "maxHeaderCount");
  const timeoutMs = positive(options.timeoutMs ?? 60_000, "timeoutMs");
  const server = createServer({ maxHeaderSize: maxHeaderBytes, requestTimeout: timeoutMs,
    headersTimeout: Math.min(timeoutMs, 10_000), connectionsCheckingInterval: Math.min(timeoutMs, 1_000) }, (incoming, outgoing) => {
    void handle(incoming, outgoing);
  });
  // Keep all parsed fields available for our explicit count guard rather than truncating them.
  server.maxHeadersCount = 0;
  server.headersTimeout = Math.min(timeoutMs, 10_000);
  server.requestTimeout = timeoutMs;
  // Idle/incomplete headers also receive a bound before a Fetch owner exists.
  server.setTimeout(timeoutMs);
  server.keepAliveTimeout = 5_000;
  server.on("checkContinue", (incoming, outgoing) => { void handle(incoming, outgoing, true); });
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
  async function handle(incoming: IncomingMessage, outgoing: ServerResponse, continueRequested = false) {
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
    const disconnect = () => rejectFailure(new Error("Client disconnected"));
    controller.signal.addEventListener("abort", disconnect, { once: true });
    let limiter: PassThrough | undefined;
    let producedResponse: Response | undefined;
    try {
      if (incoming.rawHeaders.length / 2 > maxHeaderCount) throw new HttpBoundaryError(431, "Too many request headers");
      const target = requestTarget(incoming.url ?? "/");
      const method = incoming.method ?? "GET";
      const declaredLength = incoming.headers["content-length"];
      if (declaredLength && BigInt(declaredLength) > BigInt(maxBodyBytes)) throw new HttpBoundaryError(413, "Request body exceeds the runtime limit");
      const hasBody = Boolean(incoming.headers["transfer-encoding"] || declaredLength && BigInt(declaredLength) !== 0n);
      if ((method === "GET" || method === "HEAD") && hasBody) throw new HttpBoundaryError(400, "GET and HEAD bodies are unsupported");
      let consumed = 0;
      const count = (chunk: Buffer) => {
        consumed += chunk.byteLength;
        if (consumed > maxBodyBytes) throw new HttpBoundaryError(413, "Request body exceeds the runtime limit");
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
        let consumptionCancelled = false;
        init.body = new ReadableStream<Uint8Array>({
          async pull(body) {
            try {
              const next = await reader.read();
              if (consumptionCancelled) return;
              if (next.done) { body.close(); reader.releaseLock(); }
              else body.enqueue(next.value);
            } catch (error) {
              if (consumptionCancelled) return;
              reader.releaseLock(); body.error(error);
            }
          },
          async cancel() {
            consumptionCancelled = true;
            incoming.unpipe(bodyStream); incoming.resume();
            try { await reader.cancel(consumptionEnded); }
            finally { reader.releaseLock(); }
          },
        }, { highWaterMark: 0 });
        init.duplex = "half";
        incoming.pipe(limiter);
      }
      const request = new Request(publicOrigin + target, init);
      if (continueRequested) outgoing.writeContinue();
      const admitted = requestAdmission?.(request, incoming, server);
      const applicationResponse = Promise.resolve(admitted instanceof Response ? admitted : handler(request)).then(response => {
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          throw controller.signal.reason;
        }
        producedResponse = response;
        return response;
      });
      const response = await Promise.race([applicationResponse, failure]);
      // Returning a Response ends handler ownership of upload consumption. Drain
      // unused bytes without queuing them in the Fetch body; validate before ACK.
      if (limiter && !incoming.readableEnded) {
        incoming.unpipe(limiter); limiter.destroy();
      }
      incoming.resume();
      if (!incoming.readableEnded) await Promise.race([complete, failure]);
      await Promise.race([writeResponse(response, incoming, outgoing, controller.signal, maxHeaderBytes), failure]);
    } catch (error) {
      // Upload rejection can occur after the handler has produced a body but
      // before response streaming starts. Release that unconsumed body too.
      if (producedResponse?.body && !producedResponse.body.locked) {
        void producedResponse.body.cancel().catch(() => undefined);
      }
      const boundary = error instanceof HttpBoundaryError ? error
        : controller.signal.reason instanceof HttpBoundaryError ? controller.signal.reason : undefined;
      errorResponse(outgoing, boundary?.status ?? 500, boundary?.message ?? "Request failed");
    } finally {
      clearTimeout(timeout); limiter?.destroy();
      controller.signal.removeEventListener("abort", disconnect);
      incoming.off("aborted", abort); outgoing.off("close", onClose);
    }
  }
  return server;
}
