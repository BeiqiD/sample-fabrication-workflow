import { describe, expect, it } from "vitest";
import { ProjectApiError } from "./lib/project-client";
import { projectReferenceRemovalNeedsReconciliation } from "./lib/project-reference-removal";

describe("Project reference removal failure classification", () => {
  it("treats deterministic 4xx removal responses as reconciliation candidates", () => {
    expect(projectReferenceRemovalNeedsReconciliation(new ProjectApiError("revision conflict", 409))).toBe(true);
    expect(projectReferenceRemovalNeedsReconciliation(new ProjectApiError("not found", 404))).toBe(true);
  });

  it("keeps timeout, rate-limit, server, and transport outcomes in the uncertain replay path", () => {
    expect(projectReferenceRemovalNeedsReconciliation(new ProjectApiError("timeout", 408))).toBe(false);
    expect(projectReferenceRemovalNeedsReconciliation(new ProjectApiError("rate limited", 429))).toBe(false);
    expect(projectReferenceRemovalNeedsReconciliation(new ProjectApiError("server error", 500))).toBe(false);
    expect(projectReferenceRemovalNeedsReconciliation(new TypeError("fetch failed"))).toBe(false);
  });
});
