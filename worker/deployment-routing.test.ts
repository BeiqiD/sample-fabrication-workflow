import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("deployment routing", () => {
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const configuration = JSON.parse(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ) as {
    main?: string;
    keep_vars?: boolean;
    routes?: unknown[];
    vars?: Record<string, string>;
    assets?: {
      not_found_handling?: string;
      run_worker_first?: string[];
    };
    d1_databases?: Array<{
      binding?: string;
      database_name?: string;
      database_id?: string;
      migrations_dir?: string;
    }>;
    r2_buckets?: Array<{
      binding?: string;
      bucket_name?: string;
    }>;
  };

  it("routes browser navigations under /api through the unified core Worker", () => {
    expect(configuration.main).toBe("./worker/index.ts");
    expect(configuration.assets?.not_found_handling).toBe("single-page-application");
    expect(configuration.assets?.run_worker_first).toContain("/api/*");
  });

  it("keeps installation-specific deployment values out of version control", () => {
    expect(configuration).not.toHaveProperty("name");
    expect(configuration).not.toHaveProperty("workers_dev");
    expect(configuration.routes).toBeUndefined();
    expect(configuration.vars).toBeUndefined();
    expect(configuration.d1_databases).toBeUndefined();
    expect(configuration.r2_buckets).toBeUndefined();
    expect(configuration.keep_vars).toBe(true);
  });

  it("generates one deployment config from explicit Cloudflare Build Variables", () => {
    const directory = mkdtempSync(join(tmpdir(), "sample-workflow-config-"));
    const output = join(directory, "deploy.jsonc");
    const script = fileURLToPath(
      new URL("../scripts/generate-wrangler-config.mjs", import.meta.url),
    );

    try {
      execFileSync(process.execPath, [script, "--output", output], {
        cwd: projectRoot,
        env: {
          DEPLOY_WORKER_NAME: "example-worker",
          DEPLOY_D1_DATABASE_NAME: "example-database",
          DEPLOY_D1_DATABASE_ID: "12345678-1234-4234-8234-123456789abc",
          DEPLOY_R2_BUCKET_NAME: "example-assets",
          DEPLOY_WORKERS_DEV: "true",
        },
      });

      const generated = JSON.parse(readFileSync(output, "utf8"));
      expect(resolve(dirname(output), generated.main)).toBe(resolve(projectRoot, "worker/index.ts"));
      expect(generated.name).toBe("example-worker");
      expect(generated.workers_dev).toBe(true);
      expect(generated.keep_vars).toBe(true);
      expect(generated.vars).toBeUndefined();
      expect(generated.d1_databases).toMatchObject([
        {
          binding: "DB",
          database_name: "example-database",
          database_id: "12345678-1234-4234-8234-123456789abc",
        },
      ]);
      expect(
        resolve(dirname(output), generated.d1_databases[0].migrations_dir),
      ).toBe(resolve(projectRoot, "migrations"));
      expect(generated.r2_buckets).toEqual([
        { binding: "ASSETS", bucket_name: "example-assets" },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a required deployment value is missing", () => {
    const script = fileURLToPath(
      new URL("../scripts/generate-wrangler-config.mjs", import.meta.url),
    );
    const result = spawnSync(process.execPath, [script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {},
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DEPLOY_WORKER_NAME");
  });

  it("gates remote migration and deployment before touching Cloudflare resources", () => {
    const packageConfiguration = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };
    const deployCommand = packageConfiguration.scripts?.["deploy:remote"];
    const migrateCommand = packageConfiguration.scripts?.["db:migrate:remote"];
    const internalMigrate = packageConfiguration.scripts?.["internal:db:migrate:remote"];
    const gate = packageConfiguration.scripts?.["verify:v3-deployment"];

    expect(gate).toBe(
      "npm run test:blob-lifecycle && npm run test:reference-foundation && npm run verify:d1-migrations && npm run verify:reference-worker && npm run verify:reference-search-worker && npm test && npm run build:deploy",
    );
    expect(migrateCommand).toBe(
      "npm run verify:v3-deployment && npm run internal:db:migrate:remote",
    );
    expect(internalMigrate).toContain(
      "wrangler d1 migrations apply DB --remote --config .wrangler/deploy.jsonc",
    );
    expect(deployCommand).toBe(
      "npm run verify:v3-deployment && npm run internal:db:migrate:remote && wrangler deploy",
    );
    expect(deployCommand).not.toContain(
      "wrangler deploy --config .wrangler/deploy.jsonc",
    );
  });
});
