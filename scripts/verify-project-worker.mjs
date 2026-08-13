import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";

const root = process.cwd();
const scratchRoot = resolve(root, ".wrangler");
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(resolve(scratchRoot, "project-worker-check-"));
const bundlePath = resolve(scratch, "worker.mjs");
const configPath = resolve(scratch, "deploy.jsonc");
const persistPath = resolve(scratch, "state");
const fixturePath = resolve(root, "worker/fixtures/reference-graph.sql");
const wranglerPath = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const commandEnvironment = {
  ...process.env,
  CI: process.env.CI ?? "true",
  NO_COLOR: "1",
  WRANGLER_SEND_METRICS: "false",
  XDG_CONFIG_HOME: resolve(scratch, "config"),
};

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: commandEnvironment,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} exited with status ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
}

function runWrangler(args) {
  run(process.execPath, [wranglerPath, ...args]);
}

function delay(milliseconds) {
  return new Promise((accept) => setTimeout(accept, milliseconds));
}

async function jsonRequest(miniflare, path, method, body, headers = {}) {
  const response = await miniflare.dispatchFetch(`https://app.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

const geometry = { x: 0, y: 0, width: 320, height: 180, zIndex: 0 };
let miniflare;
try {
  run(process.execPath, [
    "scripts/generate-wrangler-config.mjs",
    "--local",
    "--output",
    configPath,
  ]);

  const localDatabaseArgs = [
    "--local",
    "--config",
    configPath,
    "--persist-to",
    persistPath,
  ];
  runWrangler(["d1", "migrations", "apply", "DB", ...localDatabaseArgs]);
  runWrangler(["d1", "execute", "DB", "--file", fixturePath, "--yes", ...localDatabaseArgs]);
  await delay(500);

  await build({
    entryPoints: [resolve(root, "worker/index.ts")],
    outfile: bundlePath,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    logLevel: "silent",
  });

  miniflare = new Miniflare({
    compatibilityDate: "2026-07-20",
    modules: true,
    scriptPath: bundlePath,
    bindings: { AUTH_MODE: "disabled" },
    d1Databases: { DB: "00000000-0000-4000-8000-000000000000" },
    d1Persist: resolve(persistPath, "v3/d1"),
    r2Buckets: ["ASSETS"],
    log: new Log(LogLevel.ERROR),
  });

  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const blankAsset = await miniflare.dispatchFetch("https://app.test/api/project-assets", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-project-filename-uri": encodeURIComponent("   "),
    },
    body: bytes,
  });
  assert.equal(blankAsset.status, 400, "Whitespace-only Project attachment names must fail before storage");

  const assetUpload = await miniflare.dispatchFetch("https://app.test/api/project-assets", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-project-filename-uri": encodeURIComponent("smoke.bin"),
    },
    body: bytes,
  });
  const uploadedAsset = await assetUpload.json();
  assert.equal(assetUpload.status, 201, JSON.stringify(uploadedAsset));
  assert.equal(uploadedAsset.deduplicated, false);
  assert.equal(typeof uploadedAsset.id, "string");

  const duplicateUpload = await miniflare.dispatchFetch("https://app.test/api/project-assets", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-project-filename-uri": encodeURIComponent("smoke.bin"),
    },
    body: bytes,
  });
  const duplicateAsset = await duplicateUpload.json();
  assert.equal(duplicateUpload.status, 200, JSON.stringify(duplicateAsset));
  assert.equal(duplicateAsset.id, uploadedAsset.id);
  assert.equal(duplicateAsset.deduplicated, true);

  const projectInput = {
    id: "project-smoke",
    title: "Project smoke",
    operationId: "create-project-smoke",
  };
  const crossOrigin = await jsonRequest(
    miniflare,
    "/api/projects",
    "POST",
    projectInput,
    { origin: "https://other.test" },
  );
  assert.equal(crossOrigin.response.status, 403, "Project writes must inherit same-origin middleware");

  const created = await jsonRequest(miniflare, "/api/projects", "POST", projectInput);
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.project.revision, 1);
  const projectReplay = await jsonRequest(miniflare, "/api/projects", "POST", projectInput);
  assert.equal(projectReplay.response.status, 200, JSON.stringify(projectReplay.payload));
  assert.equal(projectReplay.payload.replayed, true);

  const markdownInput = {
    contentId: "content-smoke-markdown",
    itemId: "item-smoke-markdown",
    placementId: "placement-smoke-markdown",
    markdownSource: "# Smoke note",
    geometry,
    expectedProjectRevision: 1,
    operationId: "create-smoke-markdown",
  };
  const markdown = await jsonRequest(
    miniflare,
    "/api/projects/project-smoke/items/markdown",
    "POST",
    markdownInput,
  );
  assert.equal(markdown.response.status, 201, JSON.stringify(markdown.payload));
  assert.equal(markdown.payload.item.createdSequence, 1);

  const stale = await jsonRequest(
    miniflare,
    "/api/projects/project-smoke/items/markdown",
    "POST",
    {
      ...markdownInput,
      contentId: "content-smoke-stale",
      itemId: "item-smoke-stale",
      placementId: "placement-smoke-stale",
      operationId: "create-smoke-stale",
    },
  );
  assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));

  const referenceInput = {
    itemId: "item-smoke-reference",
    placementId: "placement-smoke-reference",
    target: { type: "sample", id: "reference-sample-a" },
    geometry: { ...geometry, x: 400 },
    expectedProjectRevision: 2,
    operationId: "insert-smoke-reference",
  };
  const reference = await jsonRequest(
    miniflare,
    "/api/projects/project-smoke/items/reference",
    "POST",
    referenceInput,
  );
  assert.equal(reference.response.status, 201, JSON.stringify(reference.payload));
  assert.equal(reference.payload.item.createdSequence, 2);
  const referenceReplay = await jsonRequest(
    miniflare,
    "/api/projects/project-smoke/items/reference",
    "POST",
    referenceInput,
  );
  assert.equal(referenceReplay.response.status, 200, JSON.stringify(referenceReplay.payload));
  assert.equal(referenceReplay.payload.replayed, true);

  const attachment = await jsonRequest(
    miniflare,
    "/api/projects/project-smoke/items/attachment",
    "POST",
    {
      contentId: "content-smoke-attachment",
      itemId: "item-smoke-attachment",
      placementId: "placement-smoke-attachment",
      locator: { assetId: uploadedAsset.id },
      caption: "Smoke file",
      sourceUrl: null,
      geometry: { ...geometry, x: 800 },
      expectedProjectRevision: 3,
      operationId: "create-smoke-attachment",
    },
  );
  assert.equal(attachment.response.status, 201, JSON.stringify(attachment.payload));
  assert.equal(
    attachment.payload.attachment.fileUrl,
    "/api/projects/project-smoke/contents/content-smoke-attachment/file",
  );

  const edge = await jsonRequest(
    miniflare,
    "/api/projects/project-smoke/edges",
    "POST",
    {
      edgeId: "edge-smoke",
      sourceItemId: "item-smoke-markdown",
      targetItemId: "item-smoke-reference",
      sourceHandle: "right",
      targetHandle: "left",
      markerStart: "none",
      markerEnd: "arrow",
      label: "supports",
      expectedSourceItemRevision: 1,
      expectedTargetItemRevision: 1,
      operationId: "create-smoke-edge",
    },
  );
  assert.equal(edge.response.status, 201, JSON.stringify(edge.payload));

  const snapshotResponse = await miniflare.dispatchFetch(
    "https://app.test/api/projects/project-smoke",
  );
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshotResponse.status, 200, JSON.stringify(snapshot));
  assert.equal(snapshot.project.revision, 4);
  assert.deepEqual(snapshot.items.map((item) => item.createdSequence), [1, 2, 3]);
  assert.equal(snapshot.references.length, 1);
  assert.equal(snapshot.references[0].resolution.resolution, "resolved");
  assert.equal(snapshot.edges.length, 1);
  const serialized = JSON.stringify(snapshot);
  assert(!serialized.includes(uploadedAsset.key));
  assert(!serialized.includes("r2_key"));
  assert(!serialized.includes("object_key"));

  const media = await miniflare.dispatchFetch(
    "https://app.test/api/projects/project-smoke/contents/content-smoke-attachment/file",
  );
  assert.equal(media.status, 200);
  assert.equal(media.headers.get("cache-control"), "private, no-store");
  assert.match(media.headers.get("content-disposition") ?? "", /smoke\.bin/);
  assert.deepEqual(new Uint8Array(await media.arrayBuffer()), bytes);

  const removed = await jsonRequest(
    miniflare,
    "/api/projects/project-smoke/items/item-smoke-markdown",
    "DELETE",
    {
      expectedItemRevision: 1,
      expectedContentRevision: 1,
      operationId: "remove-smoke-markdown",
    },
  );
  assert.equal(removed.response.status, 200, JSON.stringify(removed.payload));
  assert(removed.payload.item.deletedAt);
  const afterRemovalResponse = await miniflare.dispatchFetch(
    "https://app.test/api/projects/project-smoke",
  );
  const afterRemoval = await afterRemovalResponse.json();
  assert.deepEqual(afterRemoval.items.map((item) => item.id), [
    "item-smoke-reference",
    "item-smoke-attachment",
  ]);
  assert.equal(afterRemoval.edges.length, 0);

  const staleRename = await jsonRequest(
    miniflare,
    "/api/projects/project-smoke",
    "PATCH",
    {
      title: "Stale title",
      expectedRevision: 1,
      operationId: "stale-smoke-rename",
    },
  );
  assert.equal(staleRename.response.status, 409, JSON.stringify(staleRename.payload));

  const deleted = await jsonRequest(
    miniflare,
    "/api/projects/project-smoke",
    "DELETE",
    { expectedRevision: 4, operationId: "delete-project-smoke" },
  );
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.payload));
  assert.equal(deleted.payload.project.revision, 5);
  const hidden = await miniflare.dispatchFetch("https://app.test/api/projects/project-smoke");
  assert.equal(hidden.status, 404);
  const deletedSnapshot = await miniflare.dispatchFetch(
    "https://app.test/api/projects/project-smoke?includeDeleted=1",
  );
  assert.equal(deletedSnapshot.status, 200);

  const restored = await jsonRequest(
    miniflare,
    "/api/projects/project-smoke/restore",
    "POST",
    { expectedRevision: 5, operationId: "restore-project-smoke" },
  );
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.project.revision, 6);

  console.log("Project Worker/D1 smoke passed: middleware, generic asset upload/deduplication, retry idempotency, rollback, reference registration, attachment media, snapshot, conflict, and lifecycle.");
} finally {
  if (miniflare) await miniflare.dispose();
  await delay(500);
  await rm(scratch, { recursive: true, force: true });
}
