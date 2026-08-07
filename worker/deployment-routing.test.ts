import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("deployment routing", () => {
  const configuration = JSON.parse(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ) as {
    name?: string;
    workers_dev?: boolean;
    routes?: unknown[];
    assets?: {
      not_found_handling?: string;
      run_worker_first?: string[];
    };
    d1_databases?: Array<{
      binding?: string;
      database_name?: string;
      database_id?: string;
    }>;
    r2_buckets?: Array<{
      binding?: string;
      bucket_name?: string;
    }>;
  };

  it("routes browser navigations under /api through the Worker before the SPA fallback", () => {
    expect(configuration.assets?.not_found_handling).toBe("single-page-application");
    expect(configuration.assets?.run_worker_first).toContain("/api/*");
  });

  it("keeps the v3 foundation deployment isolated from the current production environment", () => {
    expect(configuration.name).toBe("sample-workflow-v3");
    expect(configuration.workers_dev).toBe(true);
    expect(configuration.routes).toBeUndefined();
    expect(configuration.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: "sample-workflow-db-v3",
        database_id: "b12527ac-e422-47ce-aca3-c34be8b6c6a6",
      },
    ]);
    expect(configuration.r2_buckets).toEqual([
      {
        binding: "ASSETS",
        bucket_name: "sample-workflow-assets-v3",
      },
    ]);
  });
});
