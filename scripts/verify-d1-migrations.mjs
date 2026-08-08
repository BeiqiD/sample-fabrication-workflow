import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const scratch = resolve(root, ".wrangler/d1-migration-check");
const configPath = resolve(scratch, "deploy.jsonc");
const persistPath = resolve(scratch, "state");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });

try {
  run(process.execPath, [
    "scripts/generate-wrangler-config.mjs",
    "--local",
    "--output",
    configPath,
  ]);

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  run(npmCommand, [
    "exec",
    "--",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    configPath,
    "--persist-to",
    persistPath,
  ]);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
