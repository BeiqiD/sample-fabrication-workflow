import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest, type Server } from "node:http";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createNodeHttpServer, type FetchHandler, type NodeHttpOptions } from "./http.ts";

async function listening(handler: FetchHandler, options: Partial<NodeHttpOptions> = {}) {
  const server = createNodeHttpServer(handler, { publicOrigin: "https://qualified.example", ...options });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  return { server, port: address.port, base: `http://127.0.0.1:${address.port}` };
}
async function stop(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
async function raw(port: number, text: string) {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.setTimeout(2000, () => socket.destroy(new Error("Raw HTTP test timed out")));
  const result: Buffer[] = []; socket.on("data", bytes => result.push(bytes));
  await once(socket, "connect"); socket.write(text); await once(socket, "close");
  return Buffer.concat(result).toString();
}

test("actual HTTP keeps configured origin, strips proxy and hop fields, preserves cookies and query", async () => {
  const live = await listening(request => Response.json({ url: request.url,
    forwarded: request.headers.get("x-forwarded-host"), removed: request.headers.get("x-remove"), cookie: request.headers.get("cookie") }));
  try {
    const result = await raw(live.port, "GET /api/health?q=1 HTTP/1.1\r\nHost: hostile.example\r\nX-Forwarded-Host: hostile.example\r\nConnection: close, x-remove\r\nX-Remove: hidden\r\nCookie: first=1\r\nCookie: second=2\r\n\r\n");
    assert.match(result, /200 OK/); assert.match(result, /https:\/\/qualified.example\/api\/health\?q=1/);
    assert.match(result, /"forwarded":null/); assert.match(result, /"removed":null/);
    assert.match(result, /first=1; second=2/);
  } finally { await stop(live.server); }
});

test("streamed upload reaches Fetch before completion and missing Content-Length remains bounded", async () => {
  let first = false;
  const live = await listening(async request => {
    const reader = request.body!.getReader(); const initial = await reader.read(); first = true;
    let bytes = initial.value!.length; while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; }
    return Response.json({ bytes });
  }, { maxBodyBytes: 20 });
  try {
    const request = httpRequest(`${live.base}/api/upload`, { method: "POST" });
    const answer = new Promise<{ status: number; text: string }>((resolve, reject) => {
      request.on("response", response => { let text = ""; response.on("data", chunk => { text += chunk; }); response.on("end", () => resolve({ status: response.statusCode!, text })); }); request.on("error", reject);
    });
    request.write("abcd");
    for (let i = 0; i < 100 && !first; i++) await delay(2);
    assert.equal(first, true, "Handler consumes before client finishes, proving duplex streaming");
    request.end("efgh"); assert.deepEqual(await answer, { status: 200, text: '{"bytes":8}' });
    const oversized = await fetch(`${live.base}/api/upload`, { method: "POST", body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(21)); controller.close(); } }), duplex: "half" } as RequestInit);
    assert.equal(oversized.status, 413);
  } finally { await stop(live.server); }
});

test("ignored streaming bodies still reject actual overflow before successful ACK", async () => {
  const live = await listening(() => new Response("accepted"), { maxBodyBytes: 8 });
  try {
    const result = await raw(live.port, "POST /api/ignored HTTP/1.1\r\nHost: test\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n9\r\n123456789\r\n0\r\n\r\n");
    assert.match(result, /413 Payload Too Large/); assert.doesNotMatch(result, /accepted/);
    let responseCancelled = false;
    const largeLive = await listening(() => new Response(new ReadableStream({ cancel() { responseCancelled = true; } })), { maxBodyBytes: 72 * 1024 });
    try {
      const body = "x".repeat(128 * 1024);
      const large = await raw(largeLive.port, `POST /api/ignored HTTP/1.1\r\nHost: test\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`);
      assert.match(large, /413/); assert.doesNotMatch(large, /accepted/);
      assert.equal(responseCancelled, true);
    } finally { await stop(largeLive.server); }
  } finally { await stop(live.server); }
});

test("declared oversize and forbidden HEAD body fail before dispatch, including Expect continue", async () => {
  let calls = 0;
  const live = await listening(() => { calls++; return new Response("wrong"); }, { maxBodyBytes: 8 });
  try {
    const tooLarge = await raw(live.port, "POST /api HTTP/1.1\r\nHost: test\r\nConnection: close\r\nContent-Length: 99\r\nExpect: 100-continue\r\n\r\n");
    assert.match(tooLarge, /413/); assert.doesNotMatch(tooLarge, /100 Continue/);
    const headBody = await raw(live.port, "HEAD /api HTTP/1.1\r\nHost: test\r\nConnection: close\r\nContent-Length: 1\r\n\r\nx");
    assert.match(headBody, /400/); assert.equal(calls, 0);
  } finally { await stop(live.server); }
});

test("dishonest larger Content-Length aborts the Fetch owner without successful ACK", async () => {
  let signal: AbortSignal | undefined;
  const live = await listening(async request => { signal = request.signal; await request.text(); return new Response("accepted"); });
  try {
    const socket = createConnection({ host: "127.0.0.1", port: live.port });
    await once(socket, "connect"); socket.end("POST /api HTTP/1.1\r\nHost: test\r\nContent-Length: 9\r\n\r\nshort");
    socket.on("error", () => undefined); socket.resume(); await once(socket, "close");
    for (let i = 0; i < 100 && !signal?.aborted; i++) await delay(2);
    assert.equal(signal?.aborted, true);
  } finally { await stop(live.server); }
});

test("HTTP parser rejects a shorter dishonest length and Content-Length/TE ambiguity", async () => {
  let signal: AbortSignal | undefined;
  const live = await listening(async request => { signal = request.signal; await request.text(); await delay(30); return new Response("accepted"); });
  try {
    const short = await raw(live.port, "POST /api HTTP/1.1\r\nHost: test\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabcdefgh");
    assert.match(short, /400 Bad Request/); assert.doesNotMatch(short, /200 OK|accepted/);
    for (let i = 0; i < 100 && !signal?.aborted; i++) await delay(2);
    assert.equal(signal?.aborted, true);
    const ambiguous = await raw(live.port, "POST /api HTTP/1.1\r\nHost: test\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n");
    assert.match(ambiguous, /400 Bad Request/); assert.doesNotMatch(ambiguous, /accepted/);
  } finally { await stop(live.server); }
});

test("application endpoint-specific body rejection stays stricter than the transport ceiling", async () => {
  const live = await listening(async request => {
    return (await request.arrayBuffer()).byteLength > 3 ? new Response("Endpoint limit", { status: 413 }) : new Response("ok");
  }, { maxBodyBytes: 20 });
  try {
    const response = await fetch(`${live.base}/api/small`, { method: "POST", body: "1234" });
    assert.equal(response.status, 413); assert.equal(await response.text(), "Endpoint limit");
  } finally { await stop(live.server); }
});

test("bounded header bytes/count and encoded target guards reject before application dispatch", async () => {
  let calls = 0;
  const live = await listening(() => { calls++; return new Response("wrong"); }, { maxHeaderBytes: 1024, maxHeaderCount: 4 });
  try {
    assert.match(await raw(live.port, `GET / HTTP/1.1\r\nHost: test\r\nConnection: close\r\nLong: ${"x".repeat(1100)}\r\n\r\n`), /431/);
    assert.match(await raw(live.port, "GET / HTTP/1.1\r\nHost: test\r\nConnection: close\r\nA: 1\r\nB: 2\r\nC: 3\r\n\r\n"), /431/);
    for (const path of ["//evil.test/x", "/%2e%2e/secret", "/assets/%2fsecret", "/assets/%5csecret", "/assets/%00x", "/assets/%zz"]) {
      assert.match(await raw(live.port, `GET ${path} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n`), /400/);
    }
    assert.equal(calls, 0);
  } finally { await stop(live.server); }
});

test("whole-request timeout aborts handler, and incomplete upload timeout returns 408", async () => {
  let signal: AbortSignal | undefined;
  const live = await listening(request => { signal = request.signal; return new Promise<Response>(() => undefined); }, { timeoutMs: 40 });
  try {
    const result = await fetch(`${live.base}/api/held`); assert.equal(result.status, 408); assert.equal(signal?.aborted, true);
    const incomplete = await raw(live.port, "POST /api HTTP/1.1\r\nHost: test\r\nContent-Length: 5\r\n\r\nx");
    assert.match(incomplete, /408 Request Timeout/);
  } finally { await stop(live.server); }
});

test("incomplete headers close within the configured idle bound without dispatch", async () => {
  let calls = 0;
  const live = await listening(() => { calls++; return new Response(); }, { timeoutMs: 40 });
  try {
    const socket = createConnection({ host: "127.0.0.1", port: live.port });
    socket.setTimeout(1000, () => socket.destroy(new Error("Header deadline did not close connection")));
    await once(socket, "connect"); const started = performance.now();
    socket.write("GET /api HTTP/1.1\r\nHost:"); socket.resume(); await once(socket, "close");
    assert(performance.now() - started < 500); assert.equal(calls, 0);
  } finally { await stop(live.server); }
});

test("multiple Set-Cookie values survive and HEAD cancels rather than streams a body", async () => {
  let cancellations = 0;
  const live = await listening(() => {
    const headers = new Headers({ "content-length": "7", "connection": "x-internal", "x-internal": "must-not-leak" }); headers.append("set-cookie", "a=1; Path=/"); headers.append("set-cookie", "b=2; Path=/");
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("content")); }, cancel() { cancellations++; } }), { headers });
  });
  try {
    const response = await fetch(`${live.base}/api`, { method: "HEAD" });
    assert.deepEqual(response.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
    assert.equal(response.headers.get("content-length"), "7"); assert.equal(await response.text(), ""); assert.equal(cancellations, 1);
    assert.equal(response.headers.get("x-internal"), null);
  } finally { await stop(live.server); }
});

test("a handler's late response after timeout has its stream cancelled", async () => {
  let cancelled = false;
  const live = await listening(async () => { await delay(70); return new Response(new ReadableStream({ cancel() { cancelled = true; } })); }, { timeoutMs: 30 });
  try {
    assert.equal((await fetch(`${live.base}/api/late`)).status, 408);
    await delay(60); assert.equal(cancelled, true);
  } finally { await stop(live.server); }
});

test("slow real client bounds response pulls and disconnect cancels stream/Fetch signal", async () => {
  let pulls = 0, cancelled = false; let signal: AbortSignal | undefined;
  const live = await listening(request => {
    signal = request.signal;
    return new Response(new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(64 * 1024)); }, cancel() { cancelled = true; } }));
  });
  try {
    const request = httpRequest(`${live.base}/api/stream`); let response: import("node:http").IncomingMessage;
    request.end(); [response] = await once(request, "response") as [import("node:http").IncomingMessage]; response.pause();
    await delay(80); const earlier = pulls; await delay(80);
    assert(pulls < 256, "Backpressure prevents indefinitely pulling an unread response");
    assert(pulls - earlier < 16, "Pulling stops after kernel buffers fill");
    response.destroy();
    for (let i = 0; i < 100 && !cancelled; i++) await delay(2);
    assert.equal(cancelled, true); assert.equal(signal?.aborted, true);
  } finally { await stop(live.server); }
});
