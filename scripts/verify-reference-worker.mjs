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
  assert(mixedPayload.results.every((result) => (
    result.destination.referenceUrl
      === `/references/${result.target.type}/${encodeURIComponent(result.target.id)}`
  )), "every workerd result must include its canonical reference destination");

  const sample = mixedPayload.results.find((result) => result.target.type === "sample");
  const runResolution = mixedPayload.results.find((result) => result.target.type === "run");
  const step = mixedPayload.results.find((result) => result.target.type === "run_step");
  const comment = mixedPayload.results.find((result) => result.target.type === "comment");
  const commentAttachment = mixedPayload.results.find(
    (result) => result.target.type === "comment_attachment",
  );
  assert(sample, "Sample adapter result must be present");
  assert(runResolution, "Run adapter result must be present");
  assert(step, "Run-step adapter result must be present");
  assert(comment, "common Comment adapter result must be present");
  assert(commentAttachment, "Comment-attachment adapter result must be present");
  assert.equal(sample.destination.openSourceUrl, "/samples/reference-sample-a");
  assert.equal(runResolution.destination.openSourceUrl, "/processing/reference-sample-a?run=reference-run-a");
  assert.equal(
    step.destination.openSourceUrl,
    "/processing/reference-sample-a?run=reference-run-a&step=reference-step-a&reference=run_step%3Areference-step-a",
  );
  assert.equal(comment.contexts.length, 2, "common Comment contexts must be preserved");
  assert.deepEqual(commentAttachment.contexts, comment.contexts);
  assert.equal(comment.destination.openSourceUrl, null, "multi-context Comment must not choose one source");
  assert.equal(comment.destination.contextOpenSourceUrls.length, 2);
  assert(comment.destination.contextOpenSourceUrls.every((url) => url?.startsWith("/processing/")));

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

  console.log("Reference Worker/D1 smoke passed: core middleware, all nine v1 adapters, lifecycle-aware destinations, and 200-target batch.");
} finally {
  if (miniflare) await miniflare.dispose();
  await delay(500);
  await rm(scratch, { recursive: true, force: true });
}
