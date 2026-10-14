import { afterEach, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { fetchCanonicalFileClient, consumeCanonicalFileClient, closeCanonicalFileClient,
  type CanonicalFileFixtureOwner, type CanonicalFileSession } from "../collaboration/current-v28-canonical-comment-file.qualification-support.ts";

export interface ClosedWorkflowCli {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}
export interface WorkflowCliOwner {
  readonly ready: Promise<void>;
  readonly launchedAt:number;
  readonly clients: CanonicalFileFixtureOwner;
  child?: ChildProcess;
  constructionAttempted: boolean;
  constructionFailed: boolean;
  constructionFailure?: unknown;
  originalClose?: Promise<ClosedWorkflowCli>;
  closing?: Promise<ClosedWorkflowCli>;
  ended: boolean;
  stopSent: boolean;
}
export interface WorkflowCliJsonReply {
  readonly response: Response;
  readonly status: number;
  readonly headers: Headers;
  readonly value: unknown;
}
export interface WorkflowCliBytesReply {
  readonly response: Response;
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: Uint8Array;
}
export interface WorkflowCliSession extends CanonicalFileSession {
  readonly principal: Readonly<Record<string, unknown>>;
  readonly principalId: string;
  readonly actor: string;
  readonly systemAdministrator: boolean;
  readonly fileEvidenceOperator: boolean;
}
const owners = new Set<WorkflowCliOwner>();
const STARTED = "Restricted v28-workflow development runtime started.\n";
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
function ensure(value: unknown, message = "Original compiled Workflow CLI ownership is unavailable"): asserts value {
  if (!value) throw new Error(message);
}
function object(value: unknown): Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value), "Actual Workflow CLI JSON object is required");
  return value as Record<string, unknown>;
}
function inputs(distribution: string, configurationPath: string, rootUid: number): void {
  ensure(typeof distribution === "string" && isAbsolute(distribution) && resolve(distribution) === distribution
    && typeof configurationPath === "string" && isAbsolute(configurationPath) && resolve(configurationPath) === configurationPath
    && Number.isSafeInteger(rootUid) && rootUid >= 0 && rootUid <= 0xffff_ffff);
}
afterEach(() => {
  if (owners.size) throw new AggregateError([...owners].map(owner => owner.closing ?? owner.originalClose
    ?? (owner.constructionFailed ? owner.constructionFailure : new Error("Original Workflow child constructor remains unproven"))),
  "Original compiled Workflow CLI parents remain retained");
});

/** Executes the actual verified distribution main. No loader alias, timer
 * replacement, IPC or dispatch endpoint accelerates its production cadence.
 * The caller verifies the distribution and provisions private config/artifacts
 * independently; this helper creates no account, session or database rows. */
export function launchWorkflowCli(distribution: string, configurationPath: string, rootUid: number): WorkflowCliOwner {
  inputs(distribution, configurationPath, rootUid);
  let ready!: () => void, rejectReady!: (error: unknown) => void;
  const readiness = new Promise<void>((done, fail) => { ready = done; rejectReady = fail; });
  void readiness.catch(() => undefined);
  const owner: WorkflowCliOwner = { ready: readiness, launchedAt:performance.now(),
    clients: { clients: new Set(), quarantined: false }, constructionAttempted: false, constructionFailed: false,
    ended: false, stopSent: false };
  owners.add(owner); owner.constructionAttempted = true;
  try {
    owner.child = spawn(process.execPath, [join(distribution, "server/main.mjs"), "--config", configurationPath,
      "--runtime-profile", "v28-workflow", "--filesystem-root-owner-uid", String(rootUid)], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) { owner.constructionFailed = true; owner.constructionFailure = error; rejectReady(error); throw error; }
  const child = owner.child;
  owner.originalClose = new Promise<ClosedWorkflowCli>((done, fail) => {
    let stdout = "", stderr = "", outputBytes = 0, outputFailure: Error | undefined;
    let spawnFailed = false, spawnFailure: unknown;
    child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8");
    const capture = (value: string, standardOutput: boolean) => {
      outputBytes += Buffer.byteLength(value);
      if (outputBytes > MAX_DIAGNOSTIC_BYTES) {
        outputFailure ??= new Error("Compiled Workflow CLI diagnostic budget exceeded"); rejectReady(outputFailure); return;
      }
      if (standardOutput) { stdout += value; if (stdout.includes(STARTED)) ready(); }
      else stderr += value;
    };
    child.stdout!.on("data", (value: string) => capture(value, true));
    child.stderr!.on("data", (value: string) => capture(value, false));
    child.once("error", error => { spawnFailed = true; spawnFailure = error; rejectReady(error); });
    // Only the original close event settles process and diagnostic ownership.
    // Readiness, a signal or an exit-looking flag is never a shutdown ACK.
    child.once("close", (code, signal) => {
      owner.ended = true; rejectReady(new Error("Compiled Workflow CLI closed before startup admission"));
      if (spawnFailed || outputFailure) fail(spawnFailed ? spawnFailure : outputFailure);
      else done({ code, signal, stdout, stderr });
    });
  });
  void owner.originalClose.catch(() => undefined); return owner;
}

/** Collect every original client EOF/cancel outcome, then request the one
 * child stop and join its original close even when a client ACK rejects.
 * A failed first cleanup remains retained after that actual close attempt. */
export function closeWorkflowCli(owner: WorkflowCliOwner): Promise<ClosedWorkflowCli> {
  if (owner.closing) return owner.closing;
  owner.closing = Promise.resolve().then(async () => {
    ensure(owners.has(owner));
    const clients = await Promise.allSettled([...owner.clients.clients].map(client => closeCanonicalFileClient(owner.clients, client)));
    const errors = clients.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
    const child = owner.child, originalClose = owner.originalClose;
    if (!child || !originalClose) {
      errors.push(new Error("Original Workflow child constructor/close ownership is unavailable"));
      throw new AggregateError(errors, "Original Workflow CLI client and child cleanup failed");
    }
    if (!owner.ended && !owner.stopSent) {
      try { owner.stopSent = true; ensure(child.kill("SIGTERM"), "Original Workflow CLI stop request was not acknowledged"); }
      catch (error) { errors.push(error); }
    }
    let result: ClosedWorkflowCli | undefined;
    try { result = await originalClose; }
    catch (error) { errors.push(error); }
    if (result) {
      try {
        ensure(owner.stopSent);
        expect(result.code).toBe(0); expect(result.signal).toBeNull(); expect(result.stderr).toBe("");
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Original Workflow CLI client and child first close failed");
    ensure(result); owners.delete(owner); return result;
  });
  void owner.closing.catch(() => undefined); return owner.closing;
}

/** Expected absent-opt-in refusal: no signal is issued and the caller asserts
 * the actual exit code and fixed public stderr. A missing close stays retained. */
export function runWorkflowCliRefusal(distribution: string, configurationPath: string, rootUid: number): Promise<ClosedWorkflowCli> {
  const owner = launchWorkflowCli(distribution, configurationPath, rootUid);
  ensure(owner.originalClose);
  owner.closing = owner.originalClose.then(result => {
    ensure(owner.ended && !owner.stopSent && owner.clients.clients.size === 0);
    owners.delete(owner); return result;
  });
  void owner.closing.catch(() => undefined); return owner.closing;
}

async function requestOwner(owner: WorkflowCliOwner, origin: string, pathname: string, method: string): Promise<void> {
  await owner.ready;
  ensure(owners.has(owner) && !owner.closing && !owner.ended);
  const parsed = new URL(origin);
  ensure(parsed.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(parsed.hostname)
    && parsed.origin === origin && typeof pathname === "string" && pathname.startsWith("/") && !pathname.startsWith("//")
    && typeof method === "string" && /^(?:GET|POST|PUT|DELETE|PATCH|HEAD)$/.test(method));
}
function headers(origin: string, method: string, session?: CanonicalFileSession, omitCsrf = false): Record<string, string> {
  return { ...(session ? { cookie: session.cookie } : {}), ...(method === "GET" || method === "HEAD" ? {} : {
    origin, ...(session && !omitCsrf ? { "x-sfw-csrf": session.csrf } : {}),
  }) };
}
export async function workflowCliJson(owner: WorkflowCliOwner, origin: string, pathname: string, method: string,
  input?: unknown, session?: CanonicalFileSession, options: { omitCsrf?: boolean } = {}): Promise<WorkflowCliJsonReply> {
  ensure(options && typeof options === "object" && !Array.isArray(options)
    && Object.keys(options).every(key => key === "omitCsrf")
    && (options.omitCsrf === undefined || typeof options.omitCsrf === "boolean"));
  await requestOwner(owner, origin, pathname, method);
  const delivery = await fetchCanonicalFileClient(owner.clients, `${origin}${pathname}`, { method,
    headers: { ...headers(origin, method, session, options.omitCsrf),
      ...(method === "GET" || method === "HEAD" ? {} : { "content-type": "application/json" }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(5000), redirect: "manual" });
  const text = await consumeCanonicalFileClient(delivery.client, "text"); ensure(typeof text === "string");
  await closeCanonicalFileClient(owner.clients,delivery.client);
  return { response: delivery.response, status: delivery.response.status, headers: delivery.response.headers,
    value: text ? JSON.parse(text) as unknown : null };
}
export async function workflowCliBytes(owner: WorkflowCliOwner, origin: string, pathname: string, method: string,
  bytes?: Uint8Array, session?: CanonicalFileSession): Promise<WorkflowCliBytesReply> {
  await requestOwner(owner, origin, pathname, method);
  ensure(bytes === undefined || bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer && bytes.byteLength <= MAX_ARCHIVE_BYTES);
  const delivery = await fetchCanonicalFileClient(owner.clients, `${origin}${pathname}`, { method,
    headers: { ...headers(origin, method, session), ...(bytes === undefined ? {} : {
      "content-type": "application/zip", "content-length": String(bytes.byteLength),
    }) }, ...(bytes === undefined ? {} : { body: bytes as unknown as RequestInit['body'] }), signal: AbortSignal.timeout(5000), redirect: "manual" });
  const delivered = await consumeCanonicalFileClient(delivery.client, "arrayBuffer"); ensure(delivered instanceof ArrayBuffer);
  ensure(delivered.byteLength <= MAX_ARCHIVE_BYTES, "Workflow CLI response archive exceeds its supported limit");
  await closeCanonicalFileClient(owner.clients,delivery.client);
  return { response: delivery.response, status: delivery.response.status, headers: delivery.response.headers, bytes: new Uint8Array(delivered) };
}
export async function loginWorkflowCli(owner: WorkflowCliOwner, origin: string, username: string,
  password: string): Promise<WorkflowCliSession> {
  const reply = await workflowCliJson(owner, origin, "/api/auth/login", "POST", { username, password });
  expect(reply.status).toBe(200);
  const value = object(reply.value), actual = object(value.principal), capabilities = object(actual.capabilities);
  const cookie = reply.headers.get("set-cookie")?.split(";", 1)[0];
  ensure(typeof cookie === "string" && cookie.startsWith("sfw_dev_session=") && typeof value.csrf === "string"
    && typeof actual.id === "string" && /^local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(actual.id)
    && actual.actor === `local-account:${actual.id}` && typeof capabilities.systemAdministrator === "boolean"
    && typeof capabilities.fileEvidenceOperator === "boolean", "Actual delivered Workflow CLI session is required");
  return Object.freeze({ cookie, csrf: value.csrf, principal: Object.freeze({ ...actual, capabilities: Object.freeze({ ...capabilities }) }),
    principalId: actual.id, actor: actual.actor as string,
    systemAdministrator: capabilities.systemAdministrator, fileEvidenceOperator: capabilities.fileEvidenceOperator });
}
