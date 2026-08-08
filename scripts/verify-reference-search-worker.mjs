import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";

const root = process.cwd();
const scratchRoot = resolve(root, ".wrangler");
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(resolve(scratchRoot, "reference-search-worker-check-"));
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

async function postSearch(miniflare, input, headers = {}) {
  return miniflare.dispatchFetch("https://app.test/api/references/search", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(input),
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
  runWrangler([
    "d1",
    "execute",
    "DB",
    "--command",
    `UPDATE template_versions
     SET archived_at = '2026-08-08T00:00:00.000Z'
     WHERE id IN ('reference-process-template', 'reference-metrology-template')`,
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

  const database = await miniflare.getD1Database("DB");
  const insertSample = database.prepare(`
    INSERT INTO samples
      (id, code, title, description, status, location, pinned, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'stored', 'Matcher box', 0,
            '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z')
  `);
  const longToken = "a".repeat(60);
  const multibyteToken = "实验".repeat(30);
  for (const row of [
    ["id\\path", "ESCAPE-ID", "Escaped identity", "literal marker"],
    ["literal-special", "ESCAPE-TEXT", "Literal matcher", "literal 100%_ready\\path"],
    ["short-pattern", "SHORT-48", "Short pattern", "a".repeat(48)],
    ["long-pattern", "LONG-60", "Long pattern", longToken],
    ["multibyte-pattern", "WIDE-60", "Multibyte pattern", multibyteToken],
    ["ÄBC", "UNICODE-ID", "Épitaxy", "Accented exact-case content"],
    ["unicode-nfd", "UNICODE-NFD", "E\u0301pitaxy", "Decomposed title"],
  ]) {
    await insertSample.bind(...row).run();
  }

  const crossOrigin = await postSearch(
    miniflare,
    { query: "Reference" },
    { origin: "https://other.test" },
  );
  assert.equal(crossOrigin.status, 403, "search must inherit the core same-origin guard");

  const exactResponse = await postSearch(miniflare, {
    query: "REF-A",
    types: ["sample", "run", "run_step"],
    limit: 10,
  });
  const exactPayload = await exactResponse.json();
  assert.equal(exactResponse.status, 200, JSON.stringify(exactPayload));
  assert.equal(exactPayload.results[0].target.type, "sample");
  assert.equal(exactPayload.results[0].target.id, "reference-sample-a");
  assert.equal(exactPayload.results[0].match.tier, "exact_primary");
  assert.match(
    exactPayload.results[0].resolution.destination.referenceUrl,
    /^\/references\/sample\/r1_[A-Za-z0-9_-]+$/,
  );

  const escapedIdResponse = await postSearch(miniflare, {
    query: "id\\path",
    types: ["sample"],
  });
  const escapedIdPayload = await escapedIdResponse.json();
  assert.equal(escapedIdResponse.status, 200, JSON.stringify(escapedIdPayload));
  assert.equal(escapedIdPayload.results[0].target.id, "id\\path");
  assert.equal(escapedIdPayload.results[0].match.tier, "exact_id");

  const literalResponse = await postSearch(miniflare, {
    query: "%_ready\\path",
    types: ["sample"],
  });
  const literalPayload = await literalResponse.json();
  assert.deepEqual(literalPayload.results.map((result) => result.target.id), ["literal-special"]);

  const longResponse = await postSearch(miniflare, {
    query: longToken,
    types: ["sample"],
  });
  const longPayload = await longResponse.json();
  assert.deepEqual(longPayload.results.map((result) => result.target.id), ["long-pattern"]);

  const multibyteResponse = await postSearch(miniflare, {
    query: multibyteToken,
    types: ["sample"],
  });
  const multibytePayload = await multibyteResponse.json();
  assert.deepEqual(multibytePayload.results.map((result) => result.target.id), ["multibyte-pattern"]);

  const unicodeIdResponse = await postSearch(miniflare, {
    query: "ÄBC",
    types: ["sample"],
  });
  const unicodeIdPayload = await unicodeIdResponse.json();
  assert.equal(unicodeIdPayload.results[0].target.id, "ÄBC");
  assert.equal(unicodeIdPayload.results[0].match.tier, "exact_id");

  const unicodeTitleResponse = await postSearch(miniflare, {
    query: "ÉPITAXY",
    types: ["sample"],
  });
  const unicodeTitlePayload = await unicodeTitleResponse.json();
  assert.equal(unicodeTitlePayload.results[0].target.id, "ÄBC");
  assert.equal(unicodeTitlePayload.results[0].match.tier, "exact_primary");

  const differentUnicodeCaseResponse = await postSearch(miniflare, {
    query: "épitaxy",
    types: ["sample"],
  });
  const differentUnicodeCasePayload = await differentUnicodeCaseResponse.json();
  assert(!differentUnicodeCasePayload.results.some((result) => result.target.id === "ÄBC"));

  const nfdResponse = await postSearch(miniflare, {
    query: "E\u0301PITAXY",
    types: ["sample"],
  });
  const nfdPayload = await nfdResponse.json();
  assert.equal(nfdPayload.results[0].target.id, "unicode-nfd");

  const commentResponse = await postSearch(miniflare, {
    query: "Shared reference Comment body",
    types: ["comment", "comment_occurrence"],
  });
  const commentPayload = await commentResponse.json();
  assert.equal(commentResponse.status, 200, JSON.stringify(commentPayload));
  assert.deepEqual(commentPayload.results.map((result) => result.target), [
    { type: "comment", id: "reference-comment" },
  ]);

  const sampleResponse = await postSearch(miniflare, {
    query: "Reference",
    sampleId: "reference-sample-b",
    limit: 50,
  });
  const samplePayload = await sampleResponse.json();
  assert.equal(sampleResponse.status, 200, JSON.stringify(samplePayload));
  const sampleTargets = samplePayload.results.map((result) => result.target);
  assert(sampleTargets.some((target) => target.id === "reference-sample-b"));
  assert(sampleTargets.some((target) => target.id === "reference-run-b"));
  assert(sampleTargets.some((target) => target.id === "reference-step-b"));
  assert(sampleTargets.some((target) => target.id === "reference-comment"));
  assert(!sampleTargets.some((target) => target.id === "reference-sample-a"));
  assert(!sampleTargets.some((target) => target.type === "recipe_revision"));
  assert(!sampleTargets.some((target) => target.type === "metrology_reference"));

  const archivedResponse = await postSearch(miniflare, {
    query: "Reference",
    types: ["recipe_revision", "metrology_reference"],
    limit: 50,
  });
  const archivedPayload = await archivedResponse.json();
  assert.equal(archivedResponse.status, 200, JSON.stringify(archivedPayload));
  assert(archivedPayload.results.some(
    (result) => result.target.id === "reference-process-template",
  ));
  assert(archivedPayload.results.some(
    (result) => result.target.id === "reference-metrology-reference",
  ));

  const timeResponse = await postSearch(miniflare, {
    query: "Reference",
    from: "2026-08-01T04:45:00.000Z",
    limit: 50,
  });
  const timePayload = await timeResponse.json();
  assert.equal(timeResponse.status, 200, JSON.stringify(timePayload));
  assert.deepEqual(
    new Set(timePayload.results.map((result) => result.target.type)),
    new Set(["execution_image", "metrology_reference"]),
  );

  const invalidResponse = await postSearch(miniflare, {
    query: "Reference",
    types: ["unknown"],
  });
  assert.equal(invalidResponse.status, 400);
  for (const from of [
    "August 1, 2026",
    "2026-02-30",
    "2026-08-01T12:00:00",
  ]) {
    const invalidTimeResponse = await postSearch(miniflare, { query: "Reference", from });
    assert.equal(invalidTimeResponse.status, 400, `expected invalid time rejection for ${from}`);
  }

  const registryCount = await database.prepare(
    "SELECT COUNT(*) AS count FROM reference_targets",
  ).first();
  assert.equal(Number(registryCount?.count ?? -1), 0, "search must not register targets");

  const serialized = JSON.stringify({ exactPayload, commentPayload, samplePayload, archivedPayload });
  assert(!serialized.includes("reference/private/"));
  assert(!serialized.includes("r2_key"));
  assert(!serialized.includes("object_key"));

  console.log("Reference search Worker/D1 smoke passed: portable literal matching, Unicode policy, strict timestamps, deterministic ranking, lifecycle filters, read-only behavior, and locator non-disclosure.");
} finally {
  if (miniflare) await miniflare.dispose();
  await delay(500);
  await rm(scratch, { recursive: true, force: true });
}
