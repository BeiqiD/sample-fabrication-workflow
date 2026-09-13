import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { productionWorkerArtifact } from "./production-worker-artifact.mjs";

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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
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

  const artifact = process.argv.includes("--production-artifact") ? await productionWorkerArtifact(root) : null;
  if (!artifact) await build({
    entryPoints: [resolve(root, "worker/index.ts")],
    outfile: bundlePath,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    logLevel: "silent",
  });

  const miniflareOptions = {
    compatibilityDate: "2026-07-20",
    modules: true,
    scriptPath: bundlePath,
    bindings: { AUTH_MODE: "disabled" },
    d1Databases: { DB: "00000000-0000-4000-8000-000000000000" },
    d1Persist: resolve(persistPath, "v3/d1"),
    r2Buckets: ["ASSETS"],
    log: new Log(LogLevel.ERROR),
    ...(artifact ?? {}),
  };
  miniflare = new Miniflare(miniflareOptions);

  // Exercise the actual Worker/D1 adapter's schema SELECT and table-valued
  // PRAGMAs used in the negotiated full-export snapshot, in both smoke modes.
  const oldExport = await miniflare.dispatchFetch("https://app.test/api/exports/all");
  assert.equal(oldExport.status, 409);
  assert.match((await oldExport.json()).error, /Refresh the page/);
  const exportResponse = await miniflare.dispatchFetch("https://app.test/api/exports/all?archiveSchema=10&archiveWriter=1");
  const fullExport = await exportResponse.json();
  assert.equal(exportResponse.status, 200, JSON.stringify(fullExport));
  assert.equal(fullExport.schemaVersion, 10);
  assert.equal(fullExport.archiveProfile, "fp1-import-acceptance");
  assert.equal(fullExport.archiveWriter, 1);
  assert(fullExport.tables.samples.some((row) => row.id === "reference-sample-a"));
  const sourceSchema = fullExport.artifacts.sourceSchema.value;
  assert(sourceSchema.objects.some((entry) => entry.type === "table" && entry.name === "samples"));
  assert(!sourceSchema.compatibilityColumns.samples.includes("process_revision"));
  assert(!sourceSchema.compatibilityColumns.run_step_comments.includes("body"));
  assert(sourceSchema.compatibilityColumns.run_step_comments.includes("legacy_body"));
  for (const artifact of Object.values(fullExport.artifacts)) {
    const bytes = Buffer.from(`${canonicalJson(artifact.value)}\n`);
    assert.equal(bytes.length, artifact.byteSize);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  }
  assert.deepEqual(fullExport.artifacts.retiredFields.value.samplesProcessRevision, { presentInSourceSchema: false, complete: false, sourceRowCount: fullExport.tables.samples.length, values: [] });
  assert.deepEqual(fullExport.artifacts.retiredFields.value.runStepCommentsBody, { presentInSourceSchema: false, complete: false, sourceRowCount: fullExport.tables.run_step_comments.length, values: [] });

  if (artifact) {
    const health = await miniflare.dispatchFetch("https://app.test/api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    const html = await readFile(resolve(artifact.assets.directory, "index.html"), "utf8");
    const spa = await miniflare.dispatchFetch("https://app.test/projects/artifact-smoke", { headers: { accept: "text/html" } });
    assert.equal(spa.status, 200);
    assert.equal(await spa.text(), html);
    const entry = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
    assert(entry, "The production HTML must name a JavaScript entry");
    const javascript = await miniflare.dispatchFetch(new URL(entry, "https://app.test").href);
    assert.equal(javascript.status, 200);
    assert.match(javascript.headers.get("content-type") ?? "", /javascript/);
  }

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

  // Exercise aggregation past the public resolver batch limit through the real
  // Worker endpoint. Seed only source rows; create Project occurrences via HTTP.
  const scaleProject = await jsonRequest(miniflare, "/api/projects", "POST", {
    id: "project-scale-smoke", title: "Reference scale smoke", operationId: "create-scale-smoke",
  });
  assert.equal(scaleProject.response.status, 201, JSON.stringify(scaleProject.payload));
  const database = await miniflare.getD1Database("DB");
  await database.batch(Array.from({ length: 201 }, (_, index) => database.prepare(
    `INSERT INTO samples (id, code, title, status, created_at, updated_at)
     VALUES (?, ?, ?, 'stored', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z')`,
  ).bind(`scale-sample-${index}`, `SCALE-${index}`, `Scale sample ${index}`)));
  for (let index = 0; index < 201; index += 1) {
    const inserted = await jsonRequest(miniflare, "/api/projects/project-scale-smoke/items/reference", "POST", {
      itemId: `scale-item-${index}`,
      placementId: `scale-placement-${index}`,
      target: { type: "sample", id: `scale-sample-${index}` },
      geometry: { ...geometry, x: index * 340 },
      expectedProjectRevision: index + 1,
      operationId: `scale-insert-${index}`,
    });
    assert.equal(inserted.response.status, 201, JSON.stringify(inserted.payload));
  }
  const scaleResponse = await miniflare.dispatchFetch("https://app.test/api/projects/project-scale-smoke");
  const scaleSnapshot = await scaleResponse.json();
  assert.equal(scaleResponse.status, 200, JSON.stringify(scaleSnapshot));
  assert.equal(scaleSnapshot.items.length, 201);
  assert.equal(scaleSnapshot.references.length, 201);
  assert(scaleSnapshot.references.every((reference) => reference.resolution.resolution === "resolved"));

  if (artifact) {
    // Runtime bindings are deliberately local; never reuse deployment secrets or
    // resource IDs. Verify the built API still enforces the Access boundary.
    await miniflare.setOptions({ ...miniflareOptions, bindings: {
      AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: "https://access.invalid", ACCESS_AUD: "artifact-smoke",
    } });
    const unauthenticated = await miniflare.dispatchFetch("https://app.test/api/projects/project-scale-smoke");
    assert.equal(unauthenticated.status, 403);
    console.log("Production Worker + assets passed: API health, SPA fallback, JavaScript asset, Access rejection, and 201 distinct references.");
  }

  console.log("Project Worker/D1 smoke passed: middleware, generic asset upload/deduplication, retry idempotency, rollback, reference registration, attachment media, snapshot, conflict, and lifecycle.");
} finally {
  if (miniflare) await miniflare.dispose();
  await delay(500);
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
