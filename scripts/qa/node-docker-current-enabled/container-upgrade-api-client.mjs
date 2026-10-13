// QA-only actual HTTP observations after the same stopped V25→V26 upgrade.
// No identifiers, domain bodies, passwords, cookies or CSRF reach stdout.
import assert from "node:assert/strict";

const pending = new Set(), failed = new Set(), rejectedRequests = new Set(), observations = [];
let input, cookie, csrf, action = "private-input", status = null;
function publicRoute(path) { return /^\/api\/samples\/[^/?]+$/.test(path) ? "/api/samples/:uuid" : path; }
async function originalBody(response) {
  if (!response.body) return Buffer.alloc(0);
  const owner = { response, reads: [], closeAttempted: false };
  pending.add(owner);
  try { owner.reader = response.body.getReader(); }
  catch (error) { owner.readerError = error; failed.add(owner); throw error; }
  let reason, workFailed = false, size = 0; const chunks = [];
  try {
    while (true) {
      const original = owner.reader.read(); owner.reads.push(original); original.then(() => undefined, () => undefined);
      const next = await original; if (next.done) break;
      size += next.value.byteLength; assert.ok(size <= 131072); chunks.push(Buffer.from(next.value));
    }
  } catch (error) { workFailed = true; reason = owner.workError = error; }
  const cleanup = [];
  if (workFailed) {
    owner.cancelAttempted = true;
    try { owner.cancel = owner.reader.cancel(); owner.cancel.then(() => undefined, () => undefined); await owner.cancel; owner.cancelAcknowledged = true; }
    catch (error) { owner.cancelError = error; cleanup.push(error); }
  }
  try { owner.closeAttempted = true; owner.reader.releaseLock(); owner.firstReleaseAcknowledged = true; }
  catch (error) { owner.closeError = error; cleanup.push(error); }
  if (cleanup.length) { failed.add(owner); if (workFailed) throw new AggregateError([reason, ...cleanup], "Original body and first cancel/release failed"); throw cleanup[0]; }
  pending.delete(owner);
  if (workFailed) { failed.add(owner); throw reason; }
  return Buffer.concat(chunks);
}
async function request(path, expected, method = "GET", value) {
  action = method + " " + publicRoute(path); status = null;
  const owner = { action }; pending.add(owner);
  try {
    owner.original = fetch(input.origin + path, { method, redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { origin: input.origin, "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}), ...(csrf ? { "x-sfw-csrf": csrf } : {}),
        ...(value === undefined ? {} : { "content-type": "application/json" }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    owner.original.then(() => undefined, () => undefined);
    const response = await owner.original; status = response.status;
    const raw = await originalBody(response); pending.delete(owner);
    assert.ok(observations.length < 128); observations.push({ action, status }); assert.equal(status, expected);
    return { response, value: raw.length ? JSON.parse(raw.toString("utf8")) : null };
  } catch (error) {
    if (owner.original) await owner.original.then(() => undefined, () => undefined);
    pending.delete(owner); owner.error = error; rejectedRequests.add(owner); // Strong exact original record, never serialized.
    throw error;
  }
}
async function main() {
  try {
    let size = 0; const chunks = [];
    for await (const chunk of process.stdin) { size += chunk.length; assert.ok(size <= 16384); chunks.push(chunk); }
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.ok(input && Object.keys(input).sort().join(",") === "origin,password,username");
    assert.equal(typeof input.username, "string"); assert.equal(typeof input.password, "string");
    assert.ok(input.password.length >= 16 && input.password.length <= 256);
    const origin = new URL(input.origin); assert.equal(origin.origin, input.origin);
    assert.equal(origin.protocol, "http:"); assert.equal(origin.hostname, "127.0.0.1"); assert.equal(origin.port, "14227");
    const until = Date.now() + 30000; let ready = false;
    while (Date.now() < until) {
      try { await request("/api/health", 200); ready = true; break; } catch { /* Read-only readiness only; no login retry. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready); await request("/api/ready", 401);
    const login = await request("/api/auth/login", 200, "POST", { username: input.username, password: input.password });
    const setCookies = login.response.headers.getSetCookie(); assert.equal(setCookies.length, 1); assert.ok(setCookies[0].includes("HttpOnly"));
    cookie = setCookies[0].split(";", 1)[0]; csrf = login.value.csrf;
    assert.ok(cookie.startsWith("sfw_dev_session=") && typeof csrf === "string" && csrf.length > 16);
    assert.deepEqual((await request("/api/ready", 200)).value, { ok: true });
    const samples = (await request("/api/samples", 200)).value.samples;
    assert.ok(Array.isArray(samples)); const originalSamples = samples.filter(sample => sample.title === "Historical upgrade persisted Sample");
    assert.equal(originalSamples.length, 1); const sample = originalSamples[0]; assert.match(sample.code, /^V25-[0-9A-F]{8}$/);
    assert.match(sample.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const detail = (await request("/api/samples/" + encodeURIComponent(sample.id), 200)).value;
    assert.equal(detail.code, sample.code); assert.equal(detail.title, sample.title);
    const projects = (await request("/api/projects", 200)).value.projects;
    assert.ok(Array.isArray(projects)); const originalProjects = projects.filter(project => project.title === "Historical upgrade persisted Project");
    assert.equal(originalProjects.length, 1); assert.equal(originalProjects[0].revision, 1);
    await request("/api/auth/logout", 204, "POST"); await request("/api/ready", 401);
    assert.equal(pending.size, 0); assert.equal(failed.size, 0);
    process.stdout.write(JSON.stringify({ status: "PASS", originalMetadataAuthenticated: true, sampleOriginalView: true,
      projectOriginalView: true, originalBodiesSettled: true, firstBodyReleaseAcknowledged: true, observations }) + "\n");
  } catch {
    process.stdout.write(JSON.stringify({ status: "FAIL", action, observedStatus: status,
      originalBodyCloseUnproven: pending.size !== 0 || failed.size !== 0, observations }) + "\n"); process.exitCode = 1;
  } finally { if (input) input.password = ""; input = cookie = csrf = undefined; }
}
main();
