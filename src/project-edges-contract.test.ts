import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("Phase 3B4 edge contract", () => {
  it("keeps the bounded edge model and persistence routes explicit", () => {
    const types = fs.readFileSync("shared/project-types.ts", "utf8");
    const api = fs.readFileSync("shared/project-api.ts", "utf8");
    const routes = fs.readFileSync("worker/project-routes.ts", "utf8");
    expect(types).toContain('PROJECT_EDGE_HANDLES = ["top", "right", "bottom", "left"]');
    expect(types).toContain('PROJECT_EDGE_MARKERS = ["none", "arrow"]');
    expect(api).toContain("interface CreateProjectEdgeInput");
    expect(api).toContain("candidate.sourceItemId !== candidate.targetItemId");
    expect(routes).toContain('routes.post("/projects/:projectId/edges"');
    expect(routes).toContain('routes.patch("/projects/:projectId/edges/:edgeId"');
    expect(routes).toContain('routes.delete("/projects/:projectId/edges/:edgeId"');
    expect(routes).toContain('routes.post("/projects/:projectId/edges/:edgeId/restore"');
  });

  it("keeps endpoint reconnection and advanced routing outside the first edge slice", () => {
    const plan = fs.readFileSync("docs/PROJECT_EDGES_IMPLEMENTATION_PLAN.md", "utf8");
    expect(plan).toContain("Changing source/target occurrence or either handle is deliberately **not** an update");
    expect(plan).toContain("ordinary Bezier edges only");
    expect(plan).toContain("No first-version self-loop, obstacle avoidance, draggable control point, relation ontology");
  });

  it("keeps Phase 3B4 in the permanent fail-closed verification chain", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    const workflow = fs.readFileSync(".github/workflows/verify.yml", "utf8");
    expect(pkg.scripts["test:project-edges"]).toContain("src/project-edges-contract.test.ts");
    expect(pkg.scripts["test:project-edges-mounted"]).toContain("src/project-edges.mount.test.tsx");
    expect(pkg.scripts["test:project-edges-mounted"]).toContain("src/project-edge-surface.mount.test.tsx");
    expect(pkg.scripts["verify:project-edges"]).toContain("verify:project-worker");
    expect(pkg.scripts["verify:project-edges"]).toContain("verify-project-map-bundle.mjs");
    expect(pkg.scripts["verify:v3-deployment"]).toContain("verify:project-edges");
    expect(workflow).toContain("Run Project edges contract");
    expect(workflow).toContain('context: "pre-pr/project-edges"');
  });
});
