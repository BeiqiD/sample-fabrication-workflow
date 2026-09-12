import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { staticImports, verifyProjectMapBundle } from "./verify-project-map-bundle.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "map-bundle-"));
  try {
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), '<script type="module" src="/assets/index-a.js"></script>');
    await writeFile(join(root, "assets/index-a.js"), 'import "./bridge.js"; export const map = () => import("./ProjectMapSurface-a.js");');
    await writeFile(join(root, "assets/bridge.js"), 'export const helper = 1;');
    await writeFile(join(root, "assets/ProjectMapSurface-a.js"), 'export { flow } from "./flow.js";');
    await writeFile(join(root, "assets/flow.js"), 'export const flow = "react-flow__node";');
    await run(root);
  } finally { await rm(root, { force: true, recursive: true }); }
}

test("static import parsing includes re-exports and ignores comments, strings and dynamic imports", () => {
  assert.deepEqual(staticImports('import "./a.js"; export * from "./b.js"; export { x } from "./c.js"; import("./dynamic.js"); /* import "./fake.js" */'), ["./a.js", "./b.js", "./c.js"]);
});

test("lazy Map may own its runtime through a split vendor chunk", () => fixture(verifyProjectMapBundle));

test("indirect eager imports fail even if the entry contains no runtime markers", () => fixture(async (root) => {
  await writeFile(join(root, "assets/bridge.js"), 'export { flow } from "./flow.js";');
  await assert.rejects(() => verifyProjectMapBundle(root), /initial static dependency graph/);
}));

test("HTML module preload cannot eagerly load the otherwise lazy Map", () => fixture(async (root) => {
  await writeFile(join(root, "index.html"), '<script type="module" src="/assets/index-a.js"></script><link rel="modulepreload" href="/assets/ProjectMapSurface-a.js">');
  await assert.rejects(() => verifyProjectMapBundle(root), /statically reachable/);
}));
