import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const ACCOUNT = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const unavailable = () => new Error("Cloudflare deployment account could not be resolved safely");

function accountId(value) {
  if (typeof value !== "string" || !ACCOUNT.test(value)) throw unavailable();
  return value;
}

export async function installedWranglerWhoami({ root, env, executeCommand = execute }) {
  // Run the installed CLI entry directly so the bounded subprocess owns all its
  // work. No login, token extraction, shell, or credential-bearing output.
  const { stdout } = await executeCommand(process.execPath, [require.resolve("wrangler"),
    "whoami", "--json", "--config", resolve(root, "wrangler.jsonc")], {
    cwd: root, env: { ...env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "utf8",
  });
  return stdout;
}

export async function resolveCloudflareAccountId({ root, env = process.env, whoami = installedWranglerWhoami }) {
  try {
    // Match Wrangler's standard environment precedence. An invalid explicit
    // value is an error, never permission to pick a different account.
    if (env.CLOUDFLARE_ACCOUNT_ID !== undefined) return accountId(env.CLOUDFLARE_ACCOUNT_ID);
    if (env.CF_ACCOUNT_ID !== undefined) return accountId(env.CF_ACCOUNT_ID);
    const identity = JSON.parse(await whoami({ root, env }));
    if (identity?.loggedIn !== true || !Array.isArray(identity.accounts) || identity.accounts.length !== 1) throw unavailable();
    return accountId(identity.accounts[0]?.id);
  } catch {
    throw unavailable();
  }
}

export function cloudflareR2Namespace(account, bucketName) {
  accountId(account);
  if (!BUCKET.test(bucketName)) throw new Error("DEPLOY_R2_BUCKET_NAME must be a valid R2 bucket name");
  return JSON.stringify({ kind: "cloudflare-r2", accountId: account, bucketName });
}

export function localR2Namespace(installationId, bucketName) {
  if (!UUID.test(installationId) || !BUCKET.test(bucketName)) throw new Error("Local R2 installation identity is invalid");
  return JSON.stringify({ kind: "local-r2", installationId, bucketName });
}

export async function localInstallationId(root, explicitId) {
  if (explicitId !== undefined) {
    if (!UUID.test(explicitId)) throw new Error("Local R2 installation identity is invalid");
    return explicitId;
  }
  const path = resolve(root, ".wrangler/local-installation.json");
  const candidatePath = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    // Publish only a completely written file. An exclusive link makes concurrent
    // first use converge without exposing a partially written JSON document.
    await writeFile(candidatePath, `${JSON.stringify({ installationId: randomUUID() })}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await link(candidatePath, path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const value = JSON.parse(await readFile(path, "utf8"));
    if (Object.keys(value).join() !== "installationId" || !UUID.test(value.installationId)) throw new Error();
    return value.installationId;
  } catch {
    throw new Error("Local R2 installation identity could not be loaded safely");
  } finally {
    await rm(candidatePath, { force: true });
  }
}

function deploymentIdentity(config) {
  const account = accountId(config.account_id);
  if (config.r2_buckets?.length !== 1 || config.r2_buckets[0]?.binding !== "ASSETS"
    || config.r2_buckets[0].jurisdiction !== undefined || config.r2_buckets[0].remote !== undefined
    || config.r2_buckets[0].preview_bucket_name !== undefined) throw new Error();
  const namespace = cloudflareR2Namespace(account, config.r2_buckets[0].bucket_name);
  if (config.vars?.R2_BOOTSTRAP_NAMESPACE !== namespace) throw new Error();
  if (config.d1_databases?.length !== 1 || config.d1_databases[0].binding !== "DB") throw new Error();
  return JSON.stringify({ account, namespace, workerName: config.name,
    databaseId: config.d1_databases[0].database_id, databaseName: config.d1_databases[0].database_name });
}

export function assertDeploymentBootstrapAgreement(migrationConfig, builtConfig) {
  try {
    if (deploymentIdentity(migrationConfig) !== deploymentIdentity(builtConfig)) throw new Error();
  } catch {
    throw new Error("Built Worker and migration deployment identities do not agree");
  }
}

export async function verifyDeploymentBootstrap(root) {
  try {
    const migrationConfig = JSON.parse(await readFile(resolve(root, ".wrangler/deploy.jsonc"), "utf8"));
    const redirectPath = resolve(root, ".wrangler/deploy/config.json");
    const redirect = JSON.parse(await readFile(redirectPath, "utf8"));
    if (typeof redirect.configPath !== "string" || (redirect.auxiliaryWorkers?.length ?? 0) !== 0) throw new Error();
    const builtPath = resolve(dirname(redirectPath), redirect.configPath);
    const withinDist = relative(resolve(root, "dist"), builtPath);
    if (withinDist.startsWith("..") || isAbsolute(withinDist)) throw new Error();
    const builtConfig = JSON.parse(await readFile(builtPath, "utf8"));
    if (builtConfig.no_bundle !== true) throw new Error();
    assertDeploymentBootstrapAgreement(migrationConfig, builtConfig);
  } catch {
    throw new Error("Built Worker and migration deployment identities do not agree");
  }
}
