import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { cloudflareR2Namespace, localInstallationId, localR2Namespace, resolveCloudflareAccountId } from "./lib/cloudflare-bootstrap.mjs";

const root = process.cwd();
const basePath = resolve(root, "wrangler.jsonc");

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required Cloudflare Build Variable: ${name}`);
  }
  return value;
}

function parseBoolean(name, value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be exactly "true" or "false"`);
}

function assertDeploymentValues(values) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(values.workerName)) {
    throw new Error("DEPLOY_WORKER_NAME must contain only lowercase letters, numbers, and hyphens");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(values.databaseId)) {
    throw new Error("DEPLOY_D1_DATABASE_ID must be a valid UUID");
  }
}

const local = process.argv.includes("--local");
const outputPath = resolve(
  root,
  argumentValue("--output") ?? ".wrangler/deploy.jsonc",
);
const base = JSON.parse(await readFile(basePath, "utf8"));

function relativeToOutput(path) {
  const value = relative(dirname(outputPath), resolve(root, path)).split(sep).join("/");
  return value.startsWith(".") ? value : `./${value}`;
}

for (const key of ["name", "account_id", "workers_dev", "vars", "d1_databases", "r2_buckets", "routes"]) {
  if (key in base) {
    throw new Error(`wrangler.jsonc must not contain environment-specific key: ${key}`);
  }
}

const values = local
  ? {
      workerName: "sample-fabrication-workflow-local",
      databaseName: "sample-fabrication-workflow-local",
      databaseId: "00000000-0000-4000-8000-000000000000",
      bucketName: "sample-fabrication-workflow-local-assets",
      workersDev: false,
    }
  : {
      workerName: required("DEPLOY_WORKER_NAME"),
      databaseName: required("DEPLOY_D1_DATABASE_NAME"),
      databaseId: required("DEPLOY_D1_DATABASE_ID"),
      bucketName: required("DEPLOY_R2_BUCKET_NAME"),
      workersDev: parseBoolean("DEPLOY_WORKERS_DEV", required("DEPLOY_WORKERS_DEV")),
    };

assertDeploymentValues(values);

// Opt in to a separately provisioned, initially empty recovery database. This
// only generates bindings; it never creates or deploys a remote resource.
const localRecoveryId = argumentValue("--local-recovery-target");
if (process.argv.includes("--local-recovery-target") && !localRecoveryId) throw new Error("--local-recovery-target requires an explicit target ID");
if (localRecoveryId && !local) throw new Error("--local-recovery-target requires --local");
const recoveryNames = ["DEPLOY_RECOVERY_D1_DATABASE_NAME", "DEPLOY_RECOVERY_D1_DATABASE_ID", "DEPLOY_RECOVERY_TARGET_ID"];
const recoveryConfigured = !local && recoveryNames.some(name => Boolean(process.env[name]?.trim()));
const recovery = local && localRecoveryId
  ? { databaseName: `${values.databaseName}-recovery`, databaseId: "00000000-0000-4000-8000-000000000001", targetId: localRecoveryId }
  : recoveryConfigured ? { databaseName: required(recoveryNames[0]), databaseId: required(recoveryNames[1]), targetId: required(recoveryNames[2]) } : null;
if (recovery) {
  assertDeploymentValues({ workerName: values.workerName, databaseId: recovery.databaseId });
  if (recovery.databaseId.toLowerCase() === values.databaseId.toLowerCase() || recovery.databaseName === values.databaseName) throw new Error("Recovery database must be separate from the source database");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(recovery.targetId)) throw new Error("Recovery target ID must contain 1–128 ASCII letters, numbers, underscores or hyphens");
}

const accountId = local ? undefined : await resolveCloudflareAccountId({ root });
const namespace = local
  ? localR2Namespace(await localInstallationId(root, argumentValue("--local-installation-id")), values.bucketName)
  : cloudflareR2Namespace(accountId, values.bucketName);

const generated = {
  ...base,
  $schema: relativeToOutput(base.$schema),
  main: relativeToOutput(base.main),
  name: values.workerName,
  ...(local ? {} : { account_id: accountId }),
  workers_dev: values.workersDev,
  vars: { ...(local ? { AUTH_MODE: "disabled" } : {}), R2_BOOTSTRAP_NAMESPACE: namespace,
    ...(recovery ? { RECOVERY_TARGET_ID: recovery.targetId } : {}) },
  d1_databases: [
    {
      binding: "DB",
      database_name: values.databaseName,
      database_id: values.databaseId,
      migrations_dir: relativeToOutput("migrations"),
    },
    ...(recovery ? [{ binding: "RECOVERY_DB", database_name: recovery.databaseName, database_id: recovery.databaseId }] : []),
  ],
  r2_buckets: [
    {
      binding: "ASSETS",
      bucket_name: values.bucketName,
    },
  ],
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(generated, null, 2)}\n`, "utf8");
console.log(`Generated ${outputPath}`);
