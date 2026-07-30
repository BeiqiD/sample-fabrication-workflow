import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("deployment routing", () => {
  it("routes browser navigations under /api through the Worker before the SPA fallback", () => {
    const configuration = JSON.parse(
      readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    ) as {
      assets?: {
        not_found_handling?: string;
        run_worker_first?: string[];
      };
    };

    expect(configuration.assets?.not_found_handling).toBe("single-page-application");
    expect(configuration.assets?.run_worker_first).toContain("/api/*");
  });
});
