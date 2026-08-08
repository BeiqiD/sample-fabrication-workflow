import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspace = readFileSync(new URL("./pages/ProcessingWorkspacePage.tsx", import.meta.url), "utf8");
const samplePage = readFileSync(new URL("./pages/SamplePage.tsx", import.meta.url), "utf8");
const processTemplatePage = readFileSync(new URL("./pages/TemplatePage.tsx", import.meta.url), "utf8");
const metrologyPage = readFileSync(new URL("./pages/MetrologyTemplatePage.tsx", import.meta.url), "utf8");
const focusComponent = readFileSync(new URL("./components/ReferenceSourceFocus.tsx", import.meta.url), "utf8");
const focusStyles = readFileSync(new URL("./reference-source-focus.css", import.meta.url), "utf8");
const plan = readFileSync(new URL("../docs/REFERENCE_SOURCE_FOCUS_IMPLEMENTATION_PLAN.md", import.meta.url), "utf8");

describe("reference source-focus integration", () => {
  it("keeps Processing focus URL-owned and clears stale focus on manual Run changes", () => {
    expect(workspace).toContain('const requestedStepId = searchParams.get("step") || "";');
    expect(workspace).toContain('const requestedFocus = searchParams.get("focus");');
    expect(workspace).toContain("<ProcessingReferenceSourceFocus");
    expect(workspace).toContain("focusValue={requestedFocus}");
    expect(workspace).toContain("stepId={requestedStepId}");
    expect(workspace).toContain("columns={gridColumns}");
    expect(workspace).toMatch(/if \(updates\.run !== undefined\)[\s\S]*next\.delete\("step"\);[\s\S]*next\.delete\("focus"\);/);
  });

  it("connects Sample and metrology focus without adding source mutation authority", () => {
    expect(samplePage).toContain('const requestedFocus = searchParams.get("focus");');
    expect(samplePage).toContain("<SampleReferenceSourceFocus focusValue={requestedFocus} sample={sample} />");
    expect(metrologyPage).toContain('const requestedFocus = searchParams.get("focus");');
    expect(metrologyPage).toContain("<MetrologyReferenceSourceFocus focusValue={requestedFocus} template={template} />");
    expect(focusComponent).not.toMatch(/api\.(?:create|update|delete|restore)|method:\s*"(?:POST|PATCH|PUT|DELETE)"/);
  });

  it("preserves the focus query through process/metrology route correction", () => {
    expect(processTemplatePage).toContain('`${templateDetailPath(templateId, "metrology")}${location.search}`');
    expect(metrologyPage).toContain('`${templateDetailPath(templateId, "process")}${location.search}`');
  });

  it("uses stable occurrence media rather than exposing a physical locator", () => {
    expect(focusComponent).toContain('/api/references/media/execution_image/${encodeReferenceRouteId(preview.id)}');
    expect(focusComponent).toContain("step: preview.stepId");
    expect(focusComponent).not.toMatch(/r2_key|object_key|provider locator/i);
  });

  it("keeps focus styling scoped and records the no-production-data assumption", () => {
    expect(focusStyles).toContain(".reference-source-focus");
    expect(focusStyles).toContain('content: "Referenced"');
    expect(focusStyles).not.toMatch(/\.(?:topbar|run-grid|sample-page|template-page)\b/);
    expect(plan).toContain("The current database contains no production data.");
    expect(plan).toContain("no compatibility shim is required");
    expect(plan).toContain("No remote D1 migration or Worker deployment is run");
  });
});
