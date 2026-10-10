import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createNodeHttpServer } from "./http.ts";
import { createStaticAssetsHandler } from "./static-assets.ts";

test("real disk static/SPA routing preserves API rejection, assets, HEAD and safe paths", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "rt1-static-http-")), directory = join(temporary, "public");
  await mkdir(directory); await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "index.html"), "<!doctype html><p>Reviewed SPA</p>");
  await writeFile(join(directory, "assets", "page.js"), "export const page=1;");
  await writeFile(join(directory, "assets", "with space.css"), "body { color: red; }");
  await writeFile(join(temporary, "secret.txt"), "private-secret");
  await symlink(join(temporary, "secret.txt"), join(directory, "assets", "escape.txt"));
  await symlink(temporary, join(directory, "outside"));
  await writeFile(join(directory, "denied.txt"), "private"); await chmod(join(directory, "denied.txt"), 0);
  const calls: string[] = [];
  const handler = await createStaticAssetsHandler({ directory, isSpaPath: path => /^\/projects\/(?:owner|new|project-01\.uuid_like~value)$/.test(path),
    api: request => { calls.push(new URL(request.url).pathname); return new Response("Authentication required", { status: 401 }); } });
  const server = createNodeHttpServer(handler, { publicOrigin: "http://qualified.example" });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of ["/api", "/api/missing", "/api/assets/page.js", "/%61pi/health"]) {
      const result = await fetch(base + path, { headers: { accept: "text/html" } }); assert.equal(result.status, 401); assert.equal(await result.text(), "Authentication required");
    }
    assert.deepEqual(calls, ["/api", "/api/missing", "/api/assets/page.js", "/%61pi/health"]);
    const html = await fetch(base + "/projects/owner?retained=1", { headers: { accept: "text/html" } });
    assert.equal(html.status, 200); assert.equal(await html.text(), "<!doctype html><p>Reviewed SPA</p>");
    assert.match(html.headers.get("content-type")!, /text\/html/);
    const dottedProject = await fetch(base + "/projects/project-01.uuid_like~value", { headers: { accept: "text/html" } });
    assert.equal(dottedProject.status, 200); assert.equal(await dottedProject.text(), "<!doctype html><p>Reviewed SPA</p>");
    assert.equal((await fetch(base + "/projects/owner", { headers: { accept: "application/json" } })).status, 404);
    const script = await fetch(base + "/assets/page.js"); assert.equal(await script.text(), "export const page=1;"); assert.match(script.headers.get("content-type")!, /text\/javascript/);
    assert.equal(await (await fetch(base + "/assets/with%20space.css")).text(), "body { color: red; }");
    const head = await fetch(base + "/assets/page.js", { method: "HEAD" }); assert.equal(await head.text(), ""); assert.equal(head.headers.get("content-length"), "20");
    for (const path of ["/assets/missing.js", "/assets/missing", "/missing.css", "/unknown", "/unknown.js"]) assert.equal((await fetch(base + path, { headers: { accept: "text/html" } })).status, 404);
    for (const path of ["/assets/escape.txt", "/outside/secret.txt"]) { const response = await fetch(base + path); assert.equal(response.status, 403); assert.doesNotMatch(await response.text(), /private-secret/); }
    assert.equal((await fetch(base + "/denied.txt")).status, process.getuid?.() === 0 ? 200 : 403);
    assert.equal((await fetch(base + "/.env")).status, 400);
    assert.equal((await fetch(base + "/assets/%252e%252e/secret.txt")).status, 404);
    assert.equal((await fetch(base + "/projects/new", { method: "POST" })).status, 405);
    assert.equal(await readFile(join(temporary, "secret.txt"), "utf8"), "private-secret");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await chmod(join(directory, "denied.txt"), 0o600); await rm(temporary, { recursive: true }); }
});

test("missing SPA index stays an actual 404 and noncanonical/symlink build roots reject", async () => {
  const root = await mkdtemp(join(tmpdir(), "rt1-static-config-")); await mkdir(join(root, "public")); await symlink(join(root, "public"), join(root, "linked"));
  try {
    await assert.rejects(createStaticAssetsHandler({ directory: join(root, "linked"), api: () => new Response(), isSpaPath: () => true }), /canonical/);
    const handler = await createStaticAssetsHandler({ directory: join(root, "public"), api: () => new Response(), isSpaPath: () => true });
    assert.equal((await handler(new Request("http://example.test/route", { headers: { accept: "text/html" } }))).status, 404);
  } finally { await rm(root, { recursive: true }); }
});
