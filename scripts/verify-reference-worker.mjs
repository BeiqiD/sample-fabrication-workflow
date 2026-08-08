import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";

const root = process.cwd();
const scratchRoot = resolve(root, ".wrangler");
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(resolve(scratchRoot, "reference-worker-check-"));
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

function batchSampleId(index) {
  return `reference-workerd-batch-${String(index).padStart(3, "0")}`;
}

const batchSampleSql = `
WITH RECURSIVE counter(value) AS (
  SELECT 1
  UNION ALL
  SELECT value + 1 FROM counter WHERE value < 200
)
INSERT INTO samples
  (id, code, title, description, status, location, pinned, created_at, updated_at)
SELECT
  printf('reference-workerd-batch-%03d', value),
  printf('WB-%03d', value),
  printf('Workerd batch sample %03d', value),
  'Reference Worker/D1 200-target fixture',
  'stored',
  'Smoke test',
  0,
  '2026-08-08T00:00:00.000Z',
  '2026-08-08T00:00:00.000Z'
FROM counter;
`;

async function postReferences(miniflare, targets, headers = {}) {
  return miniflare.dispatchFetch("https://app.test/api/references/resolve", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ targets }),
  });
}

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
  runWrangler(["d1", "execute", "DB", "--command", batchSampleSql, "--yes", ...localDatabaseArgs]);
  runWrangler([
    "d1",
    "execute",
    "DB",
    "--command",
    "SELECT COUNT(*) AS registry_count FROM reference_targets",
    "--yes",
    ...localDatabaseArgs,
  ]);
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

  const executionImageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const assets = await miniflare.getR2Bucket("ASSETS");
  await assets.put("reference/private/execution.png", executionImageBytes, {
    httpMetadata: { contentType: "image/png" },
  });

  const mixedTargets = [
    { type: "sample", id: "reference-sample-a" },
    { type: "run", id: "reference-run-a" },
    { type: "run_step", id: "reference-step-a" },
    { type: "comment", id: "reference-comment" },
    { type: "comment_occurrence", id: "reference-comment-occurrence-a" },
    { type: "comment_attachment", id: "reference-comment-attachment" },
    { type: "execution_image", id: "reference-execution-image" },
    { type: "metrology_reference", id: "reference-metrology-reference" },
    { type: "recipe_revision", id: "reference-process-template" },
  ];

  const crossOrigin = await postReferences(miniflare, mixedTargets, { origin: "https://other.test" });
  assert.equal(crossOrigin.status, 403, "reference writes must inherit the core same-origin guard");

  const mixedResponse = await postReferences(miniflare, mixedTargets);
  const mixedPayload = await mixedResponse.json();
  assert.equal(mixedResponse.status, 200, JSON.stringify(mixedPayload));
  assert.deepEqual(mixedPayload.results.map((result) => result.target), mixedTargets);
  assert(mixedPayload.results.every((result) => result.resolution === "resolved"));
  const mixedReferenceUrls = mixedPayload.results.map((result) => result.destination.referenceUrl);
  assert.equal(new Set(mixedReferenceUrls).size, mixedTargets.length);
  assert(mixedPayload.results.every((result) => (
    new RegExp(`^/references/${result.target.type}/r1_[A-Za-z0-9_-]*$`)
      .test(result.destination.referenceUrl)
  )), "every workerd result must include an opaque canonical reference destination");

  const sample = mixedPayload.results.find((result) => result.target.type === "sample");
  const runResolution = mixedPayload.results.find((result) => result.target.type === "run");
  const step = mixedPayload.results.find((result) => result.target.type === "run_step");
  const comment = mixedPayload.results.find((result) => result.target.type === "comment");
  const commentAttachment = mixedPayload.results.find(
    (result) => result.target.type === "comment_attachment",
  );
  const executionImage = mixedPayload.results.find(
    (result) => result.target.type === "execution_image",
  );
  assert(sample, "Sample adapter result must be present");
  assert(runResolution, "Run adapter result must be present");
  assert(step, "Run-step adapter result must be present");
  assert(comment, "common Comment adapter result must be present");
  assert(commentAttachment, "Comment-attachment adapter result must be present");
  assert(executionImage, "Execution-image adapter result must be present");
  assert.equal(sample.destination.openSourceUrl, "/samples/reference-sample-a");
  assert.equal(runResolution.destination.openSourceUrl, "/processing/reference-sample-a?run=reference-run-a");
  const stepSource = new URL(step.destination.openSourceUrl, "https://app.test");
  assert.equal(stepSource.pathname, "/processing/reference-sample-a");
  assert.equal(stepSource.searchParams.get("run"), "reference-run-a");
  assert.equal(stepSource.searchParams.get("step"), "reference-step-a");
  assert.match(stepSource.searchParams.get("focus") ?? "", /^run_step:r1_[A-Za-z0-9_-]+$/);
  assert.equal(comment.contexts.length, 2, "common Comment contexts must be preserved");
  assert.deepEqual(commentAttachment.contexts, comment.contexts);
  assert.equal(comment.destination.openSourceUrl, null, "multi-context Comment must not choose one source");
  assert.equal(comment.destination.contextOpenSourceUrls.length, 2);
  assert(comment.destination.contextOpenSourceUrls.every((url) => {
    if (!url) return false;
    const parsed = new URL(url, "https://app.test");
    return parsed.pathname.startsWith("/processing/")
      && /^comment:r1_[A-Za-z0-9_-]+$/.test(parsed.searchParams.get("focus") ?? "");
  }));

  const executionEncodedId = executionImage.destination.referenceUrl.split("/").at(-1);
  assert(executionEncodedId, "Execution-image canonical ID must be present");
  const mediaResponse = await miniflare.dispatchFetch(
    `https://app.test/api/references/media/execution_image/${executionEncodedId}?step=reference-step-a`,
  );
  assert.equal(mediaResponse.status, 200);
  assert.equal(mediaResponse.headers.get("content-type"), "image/png");
  assert.match(mediaResponse.headers.get("content-disposition") ?? "", /execution\.png/);
  assert.deepEqual(
    new Uint8Array(await mediaResponse.arrayBuffer()),
    executionImageBytes,
  );
  const missingMedia = await miniflare.dispatchFetch(
    "https://app.test/api/references/media/execution_image/r1_AAAA?step=reference-step-a",
  );
  assert.equal(missingMedia.status, 404);

  const opaqueTargets = [
    ".",
    "..",
    "/",
    "%2F",
    "?",
    "#",
    "id with space",
    "样品/α",
    "id%2Fencoded",
    "id/encoded",
  ].map((id) => ({ type: "sample", id }));
  const opaqueResponse = await postReferences(miniflare, opaqueTargets);
  const opaquePayload = await opaqueResponse.json();
  assert.equal(opaqueResponse.status, 200, JSON.stringify(opaquePayload));
  assert.deepEqual(opaquePayload.results.map((result) => result.target), opaqueTargets);
  assert(opaquePayload.results.every((result) => result.resolution === "not_found"));
  const opaqueUrls = opaquePayload.results.map((result) => result.destination.referenceUrl);
  assert.equal(new Set(opaqueUrls).size, opaqueTargets.length, "distinct stable IDs must not collide");
  assert(opaqueUrls.every((url) => /^\/references\/sample\/r1_[A-Za-z0-9_-]*$/.test(url)));

  const serialized = JSON.stringify(mixedPayload);
  assert(!serialized.includes("reference/private/"));
  assert(!serialized.includes("r2_key"));
  assert(!serialized.includes("object_key"));

  const batchTargets = Array.from({ length: 200 }, (_, index) => ({
    type: "sample",
    id: batchSampleId(index + 1),
  }));
  const batchResponse = await postReferences(miniflare, batchTargets);
  const batchPayload = await batchResponse.json();
  assert.equal(batchResponse.status, 200, JSON.stringify(batchPayload));
  assert.equal(batchPayload.results.length, 200);
  assert.deepEqual(batchPayload.results.map((result) => result.target), batchTargets);
  assert(batchPayload.results.every((result) => result.resolution === "resolved"));
  assert(batchPayload.results.every((result) => result.destination.mode === "source"));
  assert(batchPayload.results.every((result) => (
    result.destination.openSourceUrl === `/samples/${result.target.id}`
  )));

  console.log("Reference Worker/D1 smoke passed: core middleware, all nine v1 adapters, typed source focus, stable execution-image media, opaque canonical IDs, lifecycle-aware destinations, and 200-target batch.");
} finally {
  if (miniflare) await miniflare.dispose();
  await delay(500);
  await rm(scratch, { recursive: true, force: true });
}
