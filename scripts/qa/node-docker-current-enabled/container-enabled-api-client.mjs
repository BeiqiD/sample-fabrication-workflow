// QA-only current-image client. Never prints IDs, bodies, cookies or credentials.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync } from "node:fs";
import { validateFileUploadResult } from "../../../shared/contracts/r2-upload.ts";
import { checkedFileJobStatus } from "../../../shared/contracts/file-jobs.ts";

const statePath = "/run/qa-state/enabled-state.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROFILE = /^storage-profile:local:[0-9a-f]{64}$/;
const phases = ["file-off", "file-only", "jobs-inert", "upload", "move", "accept-paused", "observe-paused", "resume-move", "disable", "keyring-degraded"];
// The exact same finite bytes enter the actual mounted original upload body.
const bytes = Buffer.from("Current Docker original Local File bytes \u{1f9ea}\n", "utf8");
const digest = createHash("sha256").update(bytes).digest("hex");
const pending = new Set(), failedOwners = new Set(), observations = [];
let privateStateOperations = 0;
let input, cookie, csrf, action = "private-input", observedStatus = null, uploadResponseCode = null;
function observe(value) { assert.ok(observations.length < 1024); observations.push(value); }
function publicRoute(path) {
  return path.replace(/\/[0-9a-f-]{36}(?=\/|$)/g, "/:uuid")
    .replace(/\/api\/file-assets\/[^/]+$/, "/api/file-assets/:assetId")
    .replace(/\/api\/r2-upload-requests\/[^/]+$/, "/api/r2-upload-requests/:uuid");
}
// Classify only the fixed mounted Node POST/assets 503 schemas. The original
// bounded body has already reached EOF/release before this diagnostic runs.
// No response text, IDs, paths, SQL, cookies or credentials enter the receipt.
function classifyUpload503(raw) {
  const unknown = "node_503_unclassified_response";
  if (!raw.length || raw.length > 1024) return unknown;
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { return unknown; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return unknown;
  const keys = Object.keys(value).sort().join(",");
  if (keys === "error" && typeof value.error === "string") {
    const declared = new Map([
      ["This feature is unavailable in the local development runtime.", "node_503_route_unavailable"],
      ["File storage is unavailable", "node_503_file_unavailable"],
      ["The original local upload outcome is unavailable. Check the same request again.", "node_503_upload_outcome_unavailable"],
      ["Installation write admission is unavailable.", "node_503_installation_admission_unavailable"],
      ["File execution is paused on this installation.", "node_503_file_execution_paused"],
      ["Source mutations are paused for system recovery.", "node_503_source_maintenance_paused"],
    ]);
    return declared.get(value.error) ?? unknown;
  }
  if (keys === "expiresAt,ingress,requestId,status" && value.status === "unavailable"
    && value.ingress === "ordinary_image" && typeof value.requestId === "string" && UUID.test(value.requestId)
    && typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt)))
    return "node_503_receipt_state_unavailable";
  return unknown;
}
async function originalBody(response) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), owner = { response, reader, reads: [], closeAttempted: false };
  pending.add(owner); let size = 0, failed = false, reason; const chunks = [];
  try {
    while (true) {
      const original = reader.read(); owner.reads.push(original); original.then(() => undefined, () => undefined);
      const next = await original; if (next.done) break;
      size += next.value.byteLength;
      if (size > 131072) { const cancel = reader.cancel(); owner.cancel = cancel; await cancel; throw new Error("Bounded body"); }
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) { failed = true; reason = error; owner.workError = error; }
  try { owner.closeAttempted = true; reader.releaseLock(); owner.originalCloseAcknowledged = true; }
  catch (error) { owner.closeError = error; failedOwners.add(owner);
    if (failed) throw new AggregateError([reason, error], "Original response and first release failed"); throw error; }
  if (failed) { failedOwners.add(owner); throw reason; }
  pending.delete(owner); return Buffer.concat(chunks);
}
async function request(path, status, method = "GET", value, headers = {}) {
  action = `${method} ${publicRoute(path)}`; observedStatus = null; uploadResponseCode = null;
  const owner = { path: action, original: undefined, response: undefined }; pending.add(owner);
  const original = owner.original = fetch(input.origin + path, {
    method, redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { origin: input.origin, "sec-fetch-site": "same-origin", connection: "close",
      ...(cookie ? { cookie } : {}), ...(csrf ? { "x-sfw-csrf": csrf } : {}),
      ...(value === undefined ? {} : { "content-type": value instanceof Uint8Array ? "image/png" : "application/json" }), ...headers },
    ...(value === undefined ? {} : { body: value instanceof Uint8Array ? value : JSON.stringify(value) }),
  });
  original.then(() => undefined, () => undefined);
  try {
    const response = owner.response = await original; observedStatus = response.status;
    const raw = await originalBody(response); observe({ action, status: response.status });
    if (method === "POST" && path === "/api/assets" && response.status === 503 && response.status !== status)
      uploadResponseCode = classifyUpload503(raw);
    assert.equal(response.status, status);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    const value = contentType === "application/json" && raw.length ? JSON.parse(raw.toString("utf8")) : null;
    pending.delete(owner); return { response, value, raw };
  } catch (error) { owner.reason = error; failedOwners.add(owner); throw error; }
}
function privateState(writeValue) {
  privateStateOperations++;
  const write = writeValue !== undefined;
  let fd, workFailed = false, workError, result;
  const owner = { closeAttempted: false }; pending.add(owner);
  try {
    let flags = write ? constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC : constants.O_RDONLY;
    if (input.phase === "upload" && write) flags |= constants.O_EXCL;
    fd = openSync(statePath, flags | constants.O_NOFOLLOW | constants.O_CLOEXEC, 0o600); owner.fd = fd;
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.uid === 1000 && stat.nlink === 1 && (stat.mode & 4095) === 384 && stat.size <= 32768);
    if (write) {
      assert.ok(JSON.stringify(writeValue).length <= 32768);
      writeFileSync(fd, JSON.stringify(writeValue));
    } else result = JSON.parse(readFileSync(fd, "utf8"));
  } catch (error) { workFailed = true; workError = owner.workError = error; }
  try { if (fd !== undefined) { owner.closeAttempted = true; closeSync(fd); owner.originalCloseAcknowledged = true; } }
  catch (error) { owner.closeError = error; failedOwners.add(owner);
    if (workFailed) throw new AggregateError([workError, error], "Private state and first close failed"); throw error; }
  if (workFailed) { failedOwners.add(owner); throw workError; }
  pending.delete(owner);
  if (!write) {
    assert.ok(result && result.version === 1 && Object.keys(result).every(key =>
      ["version", "asset", "requestId", "profileIds", "forward", "reverse", "pausedStatus", "pausedItems"].includes(key)));
    assert.deepEqual(result.profileIds, input.profileIds); assert.match(result.requestId, UUID);
    const asset = validateFileUploadResult(result.asset); assert.equal(asset.storageKind, "native");
  }
  return result;
}
async function login() {
  const result = await request("/api/auth/login", 200, "POST", { username: input.username, password: input.password });
  const headers = result.response.headers.getSetCookie(); assert.equal(headers.length, 1);
  cookie = headers[0].split(";", 1)[0]; csrf = result.value.csrf;
  assert.ok(cookie.startsWith("sfw_dev_session=") && typeof csrf === "string" && csrf.length > 16);
  assert.ok(headers[0].includes("HttpOnly")); assert.deepEqual((await request("/api/ready", 200)).value, { ok: true });
}
async function executor(enabled) {
  const value = (await request("/api/files/migrations/executor", 200,
    enabled === undefined ? "GET" : "POST", enabled === undefined ? undefined : { enabled })).value;
  assert.equal(value.enabled, enabled ?? false); assert.equal(value.cadenceSeconds, 120);
  assert.equal(value.maxFilesPerStep, 1); assert.equal(value.maxStepMs, 60000); return value;
}
async function inventory(state, profile) {
  const value = (await request("/api/files/migrations/files", 200)).value;
  assert.ok(Array.isArray(value.items) && value.items.length === 1 && value.nextCursor === null);
  const item = value.items[0]; assert.equal(item.fileId, state.asset.fileId);
  assert.equal(item.profileId, profile); assert.equal(item.sha256, digest); assert.equal(item.byteSize, bytes.length); return item;
}
async function download(state) {
  const result = await request(state.asset.url, 200);
  assert.equal(result.response.headers.get("content-type"), "image/png");
  assert.equal(result.raw.length, bytes.length); assert.deepEqual(result.raw, bytes);
  assert.equal(createHash("sha256").update(result.raw).digest("hex"), digest);
}
async function accept(state, target) {
  const selection = { requestId: randomUUID(), fileIds: [state.asset.fileId], target: { profileId: target, configurationRevision: 1 } };
  const plan = (await request("/api/files/migrations/plans", 200, "POST", selection)).value;
  assert.equal(plan.items.length, 1); assert.equal(plan.items[0].fileId, state.asset.fileId);
  assert.equal(plan.items[0].status, "eligible"); assert.equal(plan.items[0].sha256, digest);
  assert.equal(plan.items[0].byteSize, bytes.length); assert.equal(plan.bytesVerified, false);
  const job = checkedFileJobStatus((await request("/api/files/migrations", 202, "POST", selection)).value);
  assert.match(job.id, UUID); assert.ok(job.actor.startsWith("local-account:"));
  assert.equal(job.state, "queued"); assert.equal(job.remaining, 1); assert.equal(job.moved, 0);
  assert.deepEqual(job.target, selection.target); return job;
}
async function jobViews(id) {
  const job = checkedFileJobStatus((await request(`/api/files/migrations/${id}`, 200)).value);
  const items = (await request(`/api/files/migrations/${id}/items`, 200)).value;
  assert.ok(Array.isArray(items.items) && items.items.length === 1 && items.hasMore === false); return { job, items };
}
async function originalSlot(state, job, target, paused) {
  const start = Date.now(), until = start + 150000;
  for (let checks = 0; checks < 150 && Date.now() < until; checks++) {
    const view = await jobViews(job.id); assert.equal(view.job.actor, job.actor);
    assert.equal(view.items.items[0].fileId, state.asset.fileId);
    if (paused) {
      assert.deepEqual(view.job, state.pausedStatus); assert.deepEqual(view.items, state.pausedItems);
      if (Date.now() - start >= 120000) return;
    } else {
      assert.ok(["queued", "running", "completed"].includes(view.job.state));
      assert.equal(view.job.failed, 0);
      if (view.job.state === "completed") {
        assert.equal(view.job.moved, 1); assert.equal(view.job.remaining, 0);
        const item = view.items.items[0]; assert.equal(item.state, "moved");
        assert.equal(item.sha256, digest); assert.equal(item.byteSize, bytes.length);
        assert.equal(item.attemptCount, 1); assert.equal(item.attempt?.settled, true);
        await inventory(state, target); await download(state); return;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Original scheduled observation bound");
}
async function main() {
try {
  let size = 0; const chunks = [];
  for await (const chunk of process.stdin) { size += chunk.length; assert.ok(size <= 16384); chunks.push(chunk); }
  input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.ok(input && Object.keys(input).sort().join(",") === "origin,password,phase,profileIds,username");
  assert.ok(phases.includes(input.phase) && typeof input.username === "string" && typeof input.password === "string");
  assert.ok(input.password.length >= 16 && input.password.length <= 256);
  assert.ok(Array.isArray(input.profileIds) && input.profileIds.length === 2 && input.profileIds[0] !== input.profileIds[1]);
  input.profileIds.forEach(value => assert.match(value, PROFILE));
  const origin = new URL(input.origin); assert.equal(origin.origin, input.origin);
  assert.equal(origin.protocol, "http:"); assert.equal(origin.hostname, "127.0.0.1");
  assert.ok(Number(origin.port) >= 1024);
  const until = Date.now() + 30000; let healthy = false;
  while (Date.now() < until) {
    action = "GET /api/health readiness";
    try {
      const response = await fetch(input.origin + "/api/health", { redirect: "error", signal: AbortSignal.timeout(1000) });
      await originalBody(response); observe({ action, status: response.status });
      assert.equal(response.status, 200); healthy = true; break;
    } catch { observe({ action, status: "unavailable" }); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(healthy); await request("/api/ready", 401); await login();
  const absentAsset = "/api/file-assets/00000000-0000-4000-8000-000000000001";
  if (input.phase === "keyring-degraded") {
    const state = privateState();
    const capability = (await request("/api/storage/configuration/capability", 200)).value;
    assert.equal(capability.canManage, true); assert.equal(capability.credentialEditingAvailable, false);
    await executor(); await inventory(state, input.profileIds[0]); await download(state);
  } else if (input.phase === "file-off") {
    await request(absentAsset, 503); await request("/api/files/migrations/executor", 503);
  } else if (input.phase === "file-only") {
    await request(absentAsset, 404); await request("/api/files/migrations/executor", 503);
  } else if (input.phase === "jobs-inert") {
    await request(absentAsset, 404);
    assert.deepEqual(await executor(), { enabled: false, lastHeartbeatAt: null, stale: true,
      cadenceSeconds: 120, maxFilesPerStep: 1, maxStepMs: 60000 });
  } else if (input.phase === "upload") {
    const requestId = randomUUID(), headers = { "x-upload-request-id": requestId, "x-filename": "current-docker-native-job.png" };
    const asset = validateFileUploadResult((await request("/api/assets", 201, "POST", bytes, headers)).value);
    assert.equal(asset.storageKind, "native"); assert.equal(asset.key, null);
    const replay = validateFileUploadResult((await request("/api/assets", 200, "POST", bytes, headers)).value);
    assert.deepEqual(replay, asset);
    const receipt = (await request(`/api/r2-upload-requests/${requestId}`, 200)).value;
    assert.equal(receipt.requestId, requestId); assert.equal(receipt.status, "ready");
    assert.deepEqual(validateFileUploadResult(receipt.result), asset);
    const state = { version: 1, asset, requestId, profileIds: input.profileIds };
    await inventory(state, input.profileIds[0]); await download(state); privateState(state);
  } else {
    const state = privateState();
    if (input.phase === "move") {
      await executor(true); state.forward = await accept(state, input.profileIds[1]); privateState(state);
      await originalSlot(state, state.forward, input.profileIds[1], false);
    } else if (input.phase === "accept-paused") {
      state.reverse = await accept(state, input.profileIds[0]);
      await executor(false); await executor(true);
      const view = await jobViews(state.reverse.id);
      assert.equal(view.job.state, "paused"); assert.equal(view.job.reason, "executor_reconfigured");
      assert.equal(view.items.items[0].attemptCount, 0);
      state.pausedStatus = view.job; state.pausedItems = view.items; privateState(state);
    } else if (input.phase === "observe-paused") {
      await originalSlot(state, state.reverse, input.profileIds[1], true);
      await inventory(state, input.profileIds[1]); await download(state);
    } else if (input.phase === "resume-move") {
      const resumed = checkedFileJobStatus((await request(`/api/files/migrations/${state.reverse.id}/resume`, 200, "POST", {})).value);
      assert.equal(resumed.id, state.reverse.id); assert.equal(resumed.state, "queued"); assert.equal(resumed.actor, state.reverse.actor);
      await originalSlot(state, state.reverse, input.profileIds[0], false);
    } else if (input.phase === "disable") {
      await executor(false); const jobs = (await request("/api/files/migrations", 200)).value.jobs;
      assert.equal(jobs.length, 2); assert.ok(jobs.every(job => job.state === "completed" && job.moved === 1 && job.remaining === 0));
      await inventory(state, input.profileIds[0]); await download(state);
    }
  }
  await request("/api/auth/logout", 204, "POST"); await request("/api/ready", 401);
  assert.equal(pending.size, 0); assert.equal(failedOwners.size, 0);
  process.stdout.write(JSON.stringify({ status: "PASS", phase: input.phase, observations,
    originalBodiesSettled: true, firstBodyReleaseAcknowledged: true, privateStateOperations,
    privateStateFirstCloseAcknowledged: privateStateOperations > 0 }) + "\n");
} catch {
  process.stdout.write(JSON.stringify({ status: "FAIL", action, observedStatus, observations,
    originalBodiesClosureUnproven: pending.size !== 0 || failedOwners.size !== 0,
    uploadResponseDiagnostic: uploadResponseCode }) + "\n");
  process.exitCode = 1;
} finally { input = cookie = csrf = undefined; }
}
main().catch(() => { process.exitCode = 1; });
