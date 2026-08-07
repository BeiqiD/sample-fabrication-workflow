import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

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

for (const key of ["name", "workers_dev", "vars", "d1_databases", "r2_buckets", "routes"]) {
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

const generated = {
  ...base,
  $schema: relativeToOutput(base.$schema),
  main: relativeToOutput(base.main),
  name: values.workerName,
  workers_dev: values.workersDev,
  ...(local ? { vars: { AUTH_MODE: "disabled" } } : {}),
  d1_databases: [
    {
      binding: "DB",
      database_name: values.databaseName,
      database_id: values.databaseId,
    },
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
