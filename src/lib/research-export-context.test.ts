import { describe, expect, it } from "vitest";
import { readResearchExportContext, researchExportContextKey, researchExportHref, researchExportScopeMatches } from "./research-export-context";

const read = (query: string) => readResearchExportContext(new URLSearchParams(query));

describe("research export source context", () => {
  it("keeps legacy links and builds only local source paths for opaque IDs", () => {
    expect(researchExportHref({ type: "sample", id: "sample:1" }, "report"))
      .toBe("/settings/data?rootType=sample&rootId=sample%3A1&kind=report");
    const root = { type: "project" as const, id: "source:/研究?#%", label: "Research notebook" };
    const href = researchExportHref(root, "data_package")!;
    const context = read(new URL(href, "https://app.test").search)!;
    expect(context.root).toEqual(root);
    expect(context.sourcePath).toBe(`/projects/${encodeURIComponent(root.id)}`);
    expect(new URL(context.sourcePath, "https://app.test").origin).toBe("https://app.test");
    expect(context.processingPath).toBeNull();
  });

  it.each([
    "rootType=run&rootId=a", "rootType=&rootId=a", "rootType=sample&rootId=", "rootType=sample",
    "rootType=sample&rootId=a&rootId=b", "rootType=sample&rootType=project&rootId=a",
    "rootType=sample&rootId=a&kind=unknown", "rootType=sample&rootId=a&kind=report&kind=data_package",
    "rootType=sample&rootId=.", "rootType=sample&rootId=..", "rootType=sample&rootId=bad%00id",
    "rootType=sample&rootId=two+ids", `rootType=sample&rootId=${"x".repeat(257)}`,
  ])("rejects ambiguous or invalid context %s without inventing a root", query => {
    expect(read(query)).toBeNull();
  });

  it("bounds display labels without using them or arbitrary return URLs as routing authority", () => {
    const href = researchExportHref({ type: "sample", id: "safe", label: `${"研究🙂".repeat(100)} end` }, "report")!;
    const context = read(new URL(href, "https://app.test").search)!;
    expect(context.root.label!.length).toBeLessThanOrEqual(200);
    expect(context.root.label).toMatch(/…$/u);
    expect(context.sourcePath).toBe("/samples/safe");
    const manipulated = read(`rootType=sample&rootId=safe&sourceLabel=${encodeURIComponent("<img src=x>")}&returnTo=https%3A%2F%2Fevil.test&from=unknown`)!;
    expect(manipulated.root.label).toBe("<img src=x>");
    expect(manipulated.sourcePath).toBe("/samples/safe");
    expect(manipulated.processingPath).toBeNull();
    expect(read(`rootType=sample&rootId=safe&sourceLabel=${"x".repeat(201)}`)?.root.label).toBeUndefined();
  });

  it("preserves a Processing run and up to seven distinct additional views without exporting them", () => {
    const href = researchExportHref({ type: "sample", id: "primary", label: "Primary sample" }, "report", {
      type: "processing", sampleId: "primary", runId: "restored run /?#",
      additionalSampleIds: ["primary", "extra:1", "extra:1", "bad,codec", "bad\u0000id", ...Array.from({ length: 10 }, (_, i) => `extra:${i + 2}`)],
    })!;
    const query = new URL(href, "https://app.test").searchParams;
    expect(query.getAll("sourceWith")).toEqual(Array.from({ length: 7 }, (_, i) => `extra:${i + 1}`));
    const context = readResearchExportContext(query)!;
    const back = new URL(context.processingPath!, "https://app.test");
    expect(back.pathname).toBe("/processing/primary");
    expect(back.searchParams.get("run")).toBe("restored run /?#");
    expect(back.searchParams.get("with")).toBe(Array.from({ length: 7 }, (_, i) => `extra:${i + 1}`).join(","));
    expect(context.root.id).toBe("primary");
    expect(researchExportScopeMatches(context, "sample:primary")).toBe(true);
    expect(researchExportScopeMatches(context, "sample:primary\nsample:extra:1")).toBe(false);
    const opaque = read("rootType=sample&rootId=primary&from=processing&sourceWith=extra+sample&sourceWith=%20extra+sample%20")!;
    expect(new URL(opaque.processingPath!, "https://app.test").searchParams.get("with")).toBe("extra sample");
    expect(opaque.root.id).toBe("primary");
  });

  it("does not attach a Processing return path to a mismatched root or malformed run", () => {
    const wrong = researchExportHref({ type: "sample", id: "a" }, "report", { type: "processing", sampleId: "b", runId: "run:1" })!;
    expect(read(new URL(wrong, "https://app.test").search)?.processingPath).toBeNull();
    expect(read("rootType=project&rootId=a&from=processing&runId=run%3A1")?.processingPath).toBeNull();
    expect(read("rootType=sample&rootId=a&from=processing&runId=")?.processingPath).toBeNull();
    expect(read("rootType=sample&rootId=a&from=processing&runId=x&runId=y")?.processingPath).toBeNull();
    expect(read("rootType=sample&rootId=a&from=processing&runId=bad%00id")?.processingPath).toBeNull();
    const opaque = new URL(read("rootType=sample&rootId=a&from=processing&runId=..")!.processingPath!, "https://app.test");
    expect(opaque.pathname).toBe("/processing/a"); expect(opaque.searchParams.get("run")).toBe("..");
  });

  it("recognizes only the original single root as an unchanged scope", () => {
    const context = read("rootType=sample&rootId=sample%3A1&kind=report")!;
    expect(researchExportScopeMatches(context, "\n sample:sample:1 \n")).toBe(true);
    for (const text of ["", "project:sample:1", "sample:sample:2", "sample:sample:1\nsample:sample:1"])
      expect(researchExportScopeMatches(context, text)).toBe(false);
    expect(researchExportContextKey(context)).toBe(researchExportContextKey(read("kind=report&rootId=sample%3A1&rootType=sample&returnTo=//evil")));
    expect(researchExportContextKey(context)).not.toBe(researchExportContextKey(read("kind=report&rootId=sample%3A2&rootType=sample")));
  });
});
