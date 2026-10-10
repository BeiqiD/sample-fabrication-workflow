import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { nativeTestArguments } from "./run-native-tests.mjs";
import { contextOutcome, executeVerification, verificationPlan } from "./verification-plan.mjs";

const { scripts } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("native qualification uses both CPUs only on two-CPU builders and preserves explicit files", () => {
  const files = ["first test.mjs", "second.test.mjs"];
  assert.deepEqual(nativeTestArguments(files, 2), ["--test", "--test-concurrency=2", ...files]);
  for (const cpus of [1, 4, 8]) assert.deepEqual(nativeTestArguments(files, cpus), ["--test", ...files]);
});

test("native runner executes every selected file in isolation and propagates failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-runner-"));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = (files) => spawnSync(process.execPath,
    [fileURLToPath(new URL("./run-native-tests.mjs", import.meta.url)), ...files],
    { env, encoding: "utf8", timeout: 10_000 });
  try {
    const files = [join(directory, "first test.mjs"), join(directory, "second.test.mjs")];
    for (const [index, file] of files.entries()) await writeFile(file, `
      import assert from 'node:assert/strict';
      import { test } from 'node:test';
      test('isolated fixture ${index}', () => {
        assert.equal(globalThis.nativeRunnerFixture, undefined);
        globalThis.nativeRunnerFixture = true;
      });
    `);
    const passed = run(files);
    assert.equal(passed.status, 0, passed.stderr + passed.stdout);
    for (const index of [0, 1]) assert.match(passed.stdout, new RegExp('isolated fixture ' + index));
    await writeFile(files[1], `import { test } from 'node:test'; test('expected failure', () => { throw new Error('runner failure fixture'); });`);
    const failed = run(files);
    assert.equal(failed.status, 1, failed.stderr + failed.stdout);
    assert.match(failed.stdout, /runner failure fixture/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CI and deployment cover the same unique leaves; only deployment build uses remote configuration", () => {
  const ci = verificationPlan("ci");
  const deploy = verificationPlan("deploy");
  assert.deepEqual(ci.leaves.map(({ id }) => id), deploy.leaves.map(({ id }) => id));
  assert.deepEqual(ci.contexts, deploy.contexts);
  for (const plan of [ci, deploy]) {
    assert.equal(new Set(plan.leaves.map(({ id }) => id)).size, plan.leaves.length);
    assert.equal(plan.leaves.filter(({ id }) => id === "build").length, 1);
    assert(plan.leaves.some(({ script }) => script === "typecheck:export-contract"));
    assert(plan.leaves.some(({ script }) => script === "typecheck:file-jobs-node"));
    assert(plan.leaves.some(({ script }) => script === "typecheck:server"));
    assert(plan.leaves.some(({ script }) => script === "test:node-http"));
    assert(plan.leaves.some(({ script }) => script === "verify:node-client"));
    assert(plan.leaves.some(({ script }) => script === "verify:project-worker-artifact"));
    for (const { script } of plan.leaves) assert.equal(typeof scripts[script], "string", script);
    for (const ids of Object.values(plan.contexts)) for (const id of ids) assert(plan.leaves.some((leaf) => leaf.id === id), id);
    assert(plan.leaves.findIndex(({ id }) => id === "build") < plan.leaves.findIndex(({ id }) => id === "project-worker"));
  }
  assert.equal(ci.leaves.find(({ id }) => id === "build").script, "build");
  assert.equal(deploy.leaves.find(({ id }) => id === "build").script, "build:deploy");
  assert(!deploy.leaves.some(({ script }) => /deploy:remote|migrate:remote/.test(script)));
});

test("required verification includes both FP3 native fixtures and a platform-independent Node runner typecheck", async () => {
  for (const file of ["scripts/fp3-transfer-spike.test.mjs", "scripts/fp3-node-runner.test.mjs"]) {
    assert.equal(scripts["test:verification-scripts"].split(/\s+/).filter(token => token === file).length, 1, file);
  }
  assert.equal(scripts["typecheck:file-jobs-node"], "tsc -p tsconfig.file-jobs-node.json");
  const configuration = JSON.parse(await readFile(new URL("../tsconfig.file-jobs-node.json", import.meta.url), "utf8"));
  assert.deepEqual(configuration.compilerOptions.types, ["node"]);
  assert.deepEqual(configuration.files, ["scripts/lib/file-job-node-runtime.ts"]);
  const plan = verificationPlan("ci");
  assert(plan.contexts["pre-pr/file-jobs"].includes("file-jobs-node"));
  assert.equal(plan.leaves.filter(leaf => leaf.id === "file-jobs-node").length, 1);
  for (const id of ["node-http", "server-types"]) {
    assert.equal(plan.leaves.filter(leaf => leaf.id === id).length, 1);
    assert(plan.contexts["pre-pr/tests"].includes(id));
  }
  for (const file of ["server/http.test.mts", "server/static-assets.test.mts"]) {
    assert.equal(scripts["test:node-http"].split(/\s+/).filter(token => token === file).length, 1, file);
  }
  const serverConfiguration = JSON.parse(await readFile(new URL("../tsconfig.server.json", import.meta.url), "utf8"));
  assert.deepEqual(serverConfiguration.compilerOptions.types, ["node"]);
  assert.deepEqual(serverConfiguration.compilerOptions.lib, ["ES2022"]);
});

test("complete test leaves discover every explicit file from preserved local domain commands", async () => {
  // A domain gate cannot silently acquire a focused test outside the full-suite
  // discovery rules when CI switches to a shared leaf list.
  const sourceConfig = await readFile(new URL("../vitest.config.ts", import.meta.url), "utf8");
  const mountedConfig = await readFile(new URL("../vitest.mounted.config.ts", import.meta.url), "utf8");
  assert(sourceConfig.includes('"**/*.test.ts"'));
  assert(mountedConfig.includes('"src/*.mount.test.tsx"') || mountedConfig.includes('"src/**/*.mount.test.tsx"'));
  for (const [name, command] of Object.entries(scripts).filter(([name]) => name.startsWith("test:"))) {
    for (const filename of command.match(/(?:src|worker|shared)\/[\w./-]+\.test\.[jt]sx?/g) ?? []) {
      assert(filename.endsWith(".test.ts") || /^src\/[^/]+\.mount\.test\.tsx$/.test(filename), `${name}: ${filename} is outside complete test discovery`);
    }
  }
});

test("failing a leaf stops later checks and marks dependent contexts as failure or unverified", async () => {
  const plan = verificationPlan("ci");
  const visited = [];
  const result = await executeVerification(plan, async ({ id }) => {
    visited.push(id);
    if (id === "source") throw new Error("fixture failure");
  });
  assert.deepEqual(visited, ["verification-scripts", "source"]);
  assert.equal(result.success, false);
  assert.equal(contextOutcome(plan.contexts["pre-pr/tests"], result.outcomes), "failure");
  assert.equal(contextOutcome(plan.contexts["pre-pr/build"], result.outcomes), "skipped");
  const recovered = await executeVerification(plan, async () => {});
  assert.equal(recovered.success, true);
  for (const dependencies of Object.values(plan.contexts)) assert.equal(contextOutcome(dependencies, recovered.outcomes), "success");
});
