import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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

  const deploymentEnvironment = {
    DEPLOY_WORKER_NAME: "example-worker",
    DEPLOY_D1_DATABASE_NAME: "example-database",
    DEPLOY_D1_DATABASE_ID: "12345678-1234-4234-8234-123456789abc",
    DEPLOY_R2_BUCKET_NAME: "example-assets",
    DEPLOY_WORKERS_DEV: "true",
  };

  function generateConfiguration(environment: Record<string, string>, local = false) {
    const directory = mkdtempSync(join(tmpdir(), "sample-workflow-config-"));
    const output = join(directory, "deploy.jsonc");
    const script = fileURLToPath(
      new URL("../scripts/generate-wrangler-config.mjs", import.meta.url),
    );
    try {
      const result = spawnSync(process.execPath, [script, "--output", output, ...(local ? ["--local"] : [])], {
        cwd: projectRoot,
        env: environment,
        encoding: "utf8",
      });
      return {
        ...result,
        output,
        generated: existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : undefined,
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("generates one deployment config from explicit Cloudflare Build Variables", () => {
    const { status, output, generated } = generateConfiguration({
      ...deploymentEnvironment,
      // Build environment values must not become arbitrary runtime variables.
      AUTH_MODE: "disabled",
      SWITCHDRIVE_ROOT: "unpaired-runtime-root",
      SWITCHDRIVE_APP_PASSWORD: "not-a-runtime-binding",
    });
    expect(status).toBe(0);
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
  });

  it("pairs an explicit managed-storage root with remote bindings without replacing other runtime settings", () => {
    const { status, generated } = generateConfiguration({
      ...deploymentEnvironment,
      DEPLOY_SWITCHDRIVE_ROOT: "  integration/s2-originals  ",
      AUTH_MODE: "disabled",
      SWITCHDRIVE_APP_PASSWORD: "not-a-runtime-binding",
    });
    expect(status).toBe(0);
    expect(generated.vars).toEqual({ SWITCHDRIVE_ROOT: "integration/s2-originals" });
    expect(generated.keep_vars).toBe(true);
    expect(generated.d1_databases[0].database_id).toBe(deploymentEnvironment.DEPLOY_D1_DATABASE_ID);
    expect(generated.r2_buckets[0].bucket_name).toBe(deploymentEnvironment.DEPLOY_R2_BUCKET_NAME);
  });

  it.each([undefined, "integration/s2-originals", "../unsafe"])(
    "keeps local configuration isolated from DEPLOY_SWITCHDRIVE_ROOT=%s",
    (root) => {
      const { status, generated } = generateConfiguration(
        root === undefined ? {} : { DEPLOY_SWITCHDRIVE_ROOT: root },
        true,
      );
      expect(status).toBe(0);
      expect(generated.vars).toEqual({ AUTH_MODE: "disabled" });
      expect(generated.name).toBe("sample-fabrication-workflow-local");
      expect(generated.d1_databases[0].database_id).toBe("00000000-0000-4000-8000-000000000000");
      expect(generated.r2_buckets[0].bucket_name).toBe("sample-fabrication-workflow-local-assets");
    },
  );

  it.each(["", "   ", "/", ".", "..", "new/../old", "new/./old", "new\\old"])(
    "rejects unsafe explicit managed-storage root %j before writing deployment configuration",
    (root) => {
      const { status, stderr, generated } = generateConfiguration({
        ...deploymentEnvironment,
        DEPLOY_SWITCHDRIVE_ROOT: root,
      });
      expect(status).not.toBe(0);
      expect(stderr).toContain("DEPLOY_SWITCHDRIVE_ROOT");
      expect(generated).toBeUndefined();
    },
  );

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

    expect(gate).toBe("node scripts/run-verification.mjs --mode deploy");
    expect(packageConfiguration.scripts?.["verify:ci"]).toBe(
      "node scripts/run-verification.mjs --mode ci",
    );
    // Coverage and configuration parity are exercised by verification.test.mjs;
    // this route contract preserves the ordering before any remote side effect.
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
