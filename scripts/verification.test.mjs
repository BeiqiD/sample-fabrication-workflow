import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { contextOutcome, executeVerification, verificationPlan } from "./verification-plan.mjs";

const { scripts } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("CI and deployment cover the same unique leaves; only deployment build uses remote configuration", () => {
  const ci = verificationPlan("ci");
  const deploy = verificationPlan("deploy");
  assert.deepEqual(ci.leaves.map(({ id }) => id), deploy.leaves.map(({ id }) => id));
  assert.deepEqual(ci.contexts, deploy.contexts);
  for (const plan of [ci, deploy]) {
    assert.equal(new Set(plan.leaves.map(({ id }) => id)).size, plan.leaves.length);
    assert.equal(plan.leaves.filter(({ id }) => id === "build").length, 1);
    assert(plan.leaves.some(({ script }) => script === "typecheck:export-contract"));
    assert(plan.leaves.some(({ script }) => script === "verify:project-worker-artifact"));
    for (const { script } of plan.leaves) assert.equal(typeof scripts[script], "string", script);
    for (const ids of Object.values(plan.contexts)) for (const id of ids) assert(plan.leaves.some((leaf) => leaf.id === id), id);
    assert(plan.leaves.findIndex(({ id }) => id === "build") < plan.leaves.findIndex(({ id }) => id === "project-worker"));
  }
  assert.equal(ci.leaves.find(({ id }) => id === "build").script, "build");
  assert.equal(deploy.leaves.find(({ id }) => id === "build").script, "build:deploy");
  assert(!deploy.leaves.some(({ script }) => /deploy:remote|migrate:remote/.test(script)));
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
