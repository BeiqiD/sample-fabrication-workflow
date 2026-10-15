// Trusted finite Docker qualification client. Credentials enter stdin only.
// Every call uses the actual packaged loopback application; no SQL or provider.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

let input, cookie, csrf, action = "stdin";
const observations = [];
async function body(response) {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > 131072) { await reader.cancel(); throw new Error("Bounded response exceeded"); }
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { reader.releaseLock(); }
}
async function request(path, status, method = "GET", value, extra = {}) {
  action = `${method} ${path}`;
  const response = await fetch(input.origin + path, {
    method, redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { origin: input.origin, "sec-fetch-site": "same-origin",
      ...(cookie ? { cookie } : {}), ...(csrf ? { "x-sfw-csrf": csrf } : {}),
      ...(value === undefined ? {} : { "content-type": "application/json" }), ...extra },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const text = await body(response);
  observations.push({ action, status: response.status });
  assert.equal(response.status, status, "Exact native response status");
  return { response, json: text ? JSON.parse(text) : null };
}
try {
  let count = 0; const chunks = [];
  for await (const chunk of process.stdin) {
    count += chunk.length; assert.ok(count <= 16384, "Bounded private input"); chunks.push(chunk);
  }
  input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.ok(input && !Array.isArray(input) && Object.keys(input).every(key =>
    ["origin", "username", "password", "phase", "expected"].includes(key)));
  assert.ok(["exercise", "verify", "unavailable-keyring"].includes(input.phase));
  const origin = new URL(input.origin);
  assert.equal(origin.origin, input.origin); assert.equal(origin.protocol, "http:");
  assert.equal(origin.hostname, "127.0.0.1"); assert.ok(Number(origin.port) >= 1024);
  assert.equal(typeof input.username, "string"); assert.equal(typeof input.password, "string");
  assert.ok(input.password.length >= 16 && input.password.length <= 256);
  // Poll only the original read-only health endpoint before any login/domain write.
  const until = Date.now() + 30000;
  let healthy = false;
  while (Date.now() < until) {
    action = "GET /api/health readiness";
    try {
      const response = await fetch(input.origin + "/api/health", { redirect: "error", signal: AbortSignal.timeout(1000) });
      await body(response); observations.push({ action, status: response.status });
      assert.equal(response.status, 200); healthy = true; break;
    } catch { observations.push({ action, status: "unavailable" }); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(healthy, "Actual main health did not become available");
  await request("/api/ready", 401);
  const login = await request("/api/auth/login", 200, "POST", {
    username: input.username, password: input.password,
  });
  const setCookies = login.response.headers.getSetCookie(); assert.equal(setCookies.length, 1);
  cookie = setCookies[0].split(";", 1)[0]; csrf = login.json.csrf;
  assert.ok(cookie.includes("=")); assert.equal(typeof csrf, "string");
  assert.ok(csrf.length > 16); assert.ok(setCookies[0].includes("HttpOnly"));
  assert.deepEqual((await request("/api/ready", 200)).json, { ok: true });
  const capability = (await request("/api/storage/configuration/capability", 200)).json;
  assert.equal(capability.canManage, true);
  assert.equal(capability.credentialEditingAvailable, input.phase !== "unavailable-keyring");
  let saved = input.expected;
  if (input.phase === "exercise") {
    const code = `CQA-${randomUUID().slice(0, 8).toUpperCase()}`;
    const created = await request("/api/samples", 201, "POST", { code, title: "Container initial sample" });
    const sampleId = created.json.id; assert.equal(typeof sampleId, "string");
    const detail = (await request(`/api/samples/${encodeURIComponent(sampleId)}`, 200)).json;
    assert.equal(detail.code, code); assert.equal(detail.title, "Container initial sample");
    await request(`/api/samples/${encodeURIComponent(sampleId)}`, 200, "PATCH", {
      expectedUpdatedAt: detail.updatedAt, title: "Container persisted sample",
    });
    const list = await request("/api/projects", 200);
    const witness = list.response.headers.get("x-sfw-project-creation-subject");
    assert.match(witness, /^[a-f0-9]{64}$/);
    const project = { id: `container-${randomUUID()}`, title: "Container persisted project", operationId: randomUUID() };
    const headers = { "x-sfw-project-creation-subject": witness };
    const accepted = (await request("/api/projects", 201, "POST", project, headers)).json;
    assert.equal(accepted.replayed, false); assert.equal(accepted.project.id, project.id);
    assert.equal(accepted.project.title, project.title); assert.equal(accepted.project.revision, 1);
    const replay = (await request("/api/projects", 200, "POST", project, headers)).json;
    assert.equal(replay.replayed, true); assert.deepEqual(replay.project, accepted.project);
    saved = { sampleId, code, sampleTitle: "Container persisted sample", project };
  }
  if (input.phase !== "unavailable-keyring") {
    assert.ok(saved && Object.keys(saved).length === 4);
    const sample = (await request(`/api/samples/${encodeURIComponent(saved.sampleId)}`, 200)).json;
    assert.equal(sample.code, saved.code); assert.equal(sample.title, saved.sampleTitle);
    const projects = (await request("/api/projects", 200)).json.projects;
    const project = projects.find(value => value.id === saved.project.id);
    assert.ok(project); assert.equal(project.title, saved.project.title); assert.equal(project.revision, 1);
  }
  await request("/api/files/fixture", 503);
  await request("/api/file-jobs", 503, "POST", {});
  await request("/api/auth/logout", 204, "POST");
  await request("/api/ready", 401); // Same original now-revoked cookie retained.
  process.stdout.write(JSON.stringify({ status: "PASS", phase: input.phase,
    observations, ...(saved ? { persisted: saved } : {}) }) + "\n");
} catch {
  // Never print input, token, CSRF, auth bodies, raw error or private password.
  process.stdout.write(JSON.stringify({ status: "FAIL", action, observations }) + "\n");
  process.exitCode = 1;
} finally { input = cookie = csrf = undefined; }
