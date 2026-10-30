import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

// Follow the same Vite-generated redirect Wrangler deploy consumes. Never guess
// a Worker name, copy a remote binding, or rebuild the application for this check.
export async function productionWorkerArtifact(root) {
  const redirectPath = resolve(root, ".wrangler/deploy/config.json");
  const redirect = JSON.parse(await readFile(redirectPath, "utf8"));
  assert.equal(redirect.auxiliaryWorkers?.length ?? 0, 0, "Artifact smoke supports the single-Worker runtime");
  const configPath = resolve(dirname(redirectPath), redirect.configPath);
  const withinDist = relative(resolve(root, "dist"), configPath);
  assert(!withinDist.startsWith("..") && !isAbsolute(withinDist), "Deployment redirect must target the built dist artifact");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.no_bundle, true, "Expected a built Worker with no_bundle");
  assert.equal(config.assets?.not_found_handling, "single-page-application");
  assert.deepEqual(config.assets?.run_worker_first, ["/api/*"]);
  return {
    scriptPath: resolve(dirname(configPath), config.main),
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    assets: {
      directory: resolve(dirname(configPath), config.assets.directory),
      routerConfig: { has_user_worker: true, static_routing: { user_worker: config.assets.run_worker_first } },
      assetConfig: { not_found_handling: config.assets.not_found_handling },
    },
  };
}
