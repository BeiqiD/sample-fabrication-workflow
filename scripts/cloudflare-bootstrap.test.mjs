import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { assertDeploymentBootstrapAgreement, cloudflareR2Namespace, installedWranglerWhoami, localInstallationId,
  localR2Namespace, resolveCloudflareAccountId, verifyDeploymentBootstrap } from "./lib/cloudflare-bootstrap.mjs";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const ACCOUNT = "a".repeat(32);
const UUID = "ed52e1b3-bc58-4bad-9aab-c803cfa6f14c";
const ENV = { DEPLOY_WORKER_NAME: "test-worker", DEPLOY_D1_DATABASE_NAME: "test-database",
  DEPLOY_D1_DATABASE_ID: UUID, DEPLOY_R2_BUCKET_NAME: "test-bucket", DEPLOY_WORKERS_DEV: "false", CLOUDFLARE_ACCOUNT_ID: ACCOUNT };

test("deployment account selection reuses explicit Wrangler precedence without queries", async () => {
  const whoami = () => { throw new Error("must not query"); };
  assert.equal(await resolveCloudflareAccountId({ env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CF_ACCOUNT_ID: "b".repeat(32) }, whoami }), ACCOUNT);
  assert.equal(await resolveCloudflareAccountId({ env: { CF_ACCOUNT_ID: ACCOUNT }, whoami }), ACCOUNT);
  for (const value of ["", "unknown", "A".repeat(32), ` ${ACCOUNT}`, null]) {
    await assert.rejects(resolveCloudflareAccountId({ env: { CLOUDFLARE_ACCOUNT_ID: value, CF_ACCOUNT_ID: ACCOUNT }, whoami }), /could not be resolved safely/);
  }
});

test("account lookup accepts only a sole authenticated account and redacts every failure", async () => {
  const resolveIdentity = (value) => resolveCloudflareAccountId({ env: {}, whoami: async () => value });
  assert.equal(await resolveIdentity(JSON.stringify({ loggedIn: true, accounts: [{ id: ACCOUNT, name: "private name" }] })), ACCOUNT);
  for (const value of ["private token not json", "null", JSON.stringify({ loggedIn: false, accounts: [{ id: ACCOUNT }] }),
    JSON.stringify({ loggedIn: true, accounts: [] }), JSON.stringify({ loggedIn: true, accounts: [{ id: ACCOUNT }, { id: ACCOUNT }] }),
    JSON.stringify({ loggedIn: true, accounts: [{ id: "not an account" }] })]) {
    await assert.rejects(resolveIdentity(value), (error) => error.message === "Cloudflare deployment account could not be resolved safely");
  }
  for (const cause of [new Error("token=private; authentication denied"), Object.assign(new Error("timeout private token"), { killed: true, code: "ETIMEDOUT" })]) {
    await assert.rejects(resolveCloudflareAccountId({ env: {}, whoami: async () => { throw cause; } }),
      (error) => error.message === "Cloudflare deployment account could not be resolved safely" && error.cause === undefined);
  }
});

test("installed whoami invocation is noninteractive, bounded, and never extracts a token", async () => {
  let calls = 0;
  const value = await installedWranglerWhoami({ root: ROOT, env: { CI: "false", WRANGLER_SEND_METRICS: "true" },
    executeCommand: async (command, args, options) => {
      calls += 1;
      assert.equal(command, process.execPath);
      assert.match(args[0], /wrangler-dist\/cli\.js$/);
      assert.deepEqual(args.slice(1), ["whoami", "--json", "--config", resolve(ROOT, "wrangler.jsonc")]);
      assert.equal(options.timeout, 30_000);
      assert.equal(options.maxBuffer, 1024 * 1024);
      assert.equal(options.env.CI, "true");
      assert.equal(options.env.WRANGLER_SEND_METRICS, "false");
      assert.equal(options.shell, undefined);
      return { stdout: "safe-json", stderr: "private diagnostics" };
    } });
  assert.equal(value, "safe-json");
  assert.equal(calls, 1);
});

test("local identity survives concurrency and corruption is never replaced", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "r2-installation-"));
  try {
    const ids = await Promise.all(Array.from({ length: 10 }, () => localInstallationId(root)));
    assert.equal(new Set(ids).size, 1);
    assert.equal(await localInstallationId(root), ids[0]);
    assert.equal(await localInstallationId(root, UUID), UUID);
    assert.match(localR2Namespace(ids[0], "local-bucket"), /^\{"kind":"local-r2","installationId":/);
    assert.notEqual(localR2Namespace(ids[0], "local-bucket"), cloudflareR2Namespace(ACCOUNT, "local-bucket"));
    await writeFile(resolve(root, ".wrangler/local-installation.json"), "private malformed data");
    await assert.rejects(localInstallationId(root), /could not be loaded safely/);
    assert.equal(await readFile(resolve(root, ".wrangler/local-installation.json"), "utf8"), "private malformed data");
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "r2-config-"));
  await mkdir(resolve(root, "scripts/lib"), { recursive: true });
  for (const file of ["wrangler.jsonc", "scripts/generate-wrangler-config.mjs", "scripts/lib/cloudflare-bootstrap.mjs"]) await cp(resolve(ROOT, file), resolve(root, file));
  await symlink(resolve(ROOT, "node_modules"), resolve(root, "node_modules"), "dir");
  return root;
}

test("generator pins the same cloud account and bucket into config and namespace without copying other environment values", async () => {
  const root = await fixture();
  try {
    await run(process.execPath, ["scripts/generate-wrangler-config.mjs"], { cwd: root, env: { ...ENV, AUTH_MODE: "access", SWITCHDRIVE_APP_PASSWORD: "never-copy-private" } });
    const config = JSON.parse(await readFile(resolve(root, ".wrangler/deploy.jsonc"), "utf8"));
    assert.equal(config.account_id, ACCOUNT);
    assert.deepEqual(config.vars, { R2_BOOTSTRAP_NAMESPACE: cloudflareR2Namespace(ACCOUNT, "test-bucket") });
    assert.equal(config.r2_buckets[0].bucket_name, "test-bucket");
    assert.equal(config.keep_vars, true);
    assert.equal(JSON.stringify(config).includes("never-copy-private"), false);
    const base = JSON.parse(await readFile(resolve(root, "wrangler.jsonc"), "utf8"));
    await writeFile(resolve(root, "wrangler.jsonc"), JSON.stringify({ ...base, account_id: ACCOUNT }));
    await assert.rejects(run(process.execPath, ["scripts/generate-wrangler-config.mjs"], { cwd: root, env: ENV }), /must not contain environment-specific key: account_id/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local generator needs no cloud credentials and has no cloud account", async () => {
  const root = await fixture();
  try {
    await run(process.execPath, ["scripts/generate-wrangler-config.mjs", "--local", "--local-installation-id", UUID], { cwd: root, env: {} });
    const config = JSON.parse(await readFile(resolve(root, ".wrangler/deploy.jsonc"), "utf8"));
    assert.equal(config.account_id, undefined);
    assert.equal(config.vars.AUTH_MODE, "disabled");
    assert.equal(config.vars.R2_BOOTSTRAP_NAMESPACE, localR2Namespace(UUID, "sample-fabrication-workflow-local-assets"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pre-migration guard follows deploy's dist redirect and rejects any physical or database drift", async () => {
  const root = await fixture();
  try {
    await run(process.execPath, ["scripts/generate-wrangler-config.mjs"], { cwd: root, env: ENV });
    const config = JSON.parse(await readFile(resolve(root, ".wrangler/deploy.jsonc"), "utf8"));
    await mkdir(resolve(root, ".wrangler/deploy"), { recursive: true });
    await mkdir(resolve(root, "dist/test-worker"), { recursive: true });
    await writeFile(resolve(root, ".wrangler/deploy/config.json"), JSON.stringify({ configPath: "../../dist/test-worker/wrangler.json" }));
    const built = { ...config, no_bundle: true };
    await writeFile(resolve(root, "dist/test-worker/wrangler.json"), JSON.stringify(built));
    await verifyDeploymentBootstrap(root);
    for (const mutation of [
      { account_id: "b".repeat(32) }, { vars: {} }, { vars: { R2_BOOTSTRAP_NAMESPACE: localR2Namespace(UUID, "test-bucket") } },
      { r2_buckets: [{ binding: "ASSETS", bucket_name: "different" }] },
      { r2_buckets: [{ binding: "ASSETS", bucket_name: "test-bucket", jurisdiction: "eu" }] },
      { d1_databases: [{ ...config.d1_databases[0], database_id: "different" }] }, { name: "other-worker" },
    ]) assert.throws(() => assertDeploymentBootstrapAgreement(config, { ...built, ...mutation }), /do not agree/);
    await writeFile(resolve(root, ".wrangler/deploy/config.json"), JSON.stringify({ configPath: "../deploy.jsonc" }));
    await assert.rejects(verifyDeploymentBootstrap(root), /do not agree/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
