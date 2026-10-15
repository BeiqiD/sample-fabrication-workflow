// @vitest-environment jsdom
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReferenceSearchSurface } from "./components/ReferenceSearchSurface";
import { ProjectInspectorDetails } from "./components/project/ProjectInspectorDetails";
import { ProjectReadingSurface } from "./components/project/ProjectReadingSurface";
import { projectTestSnapshot } from "./project-test-fixture";
import { projectMapNodes, projectReadingNodes } from "./lib/project-map-model";
import { projectCanvasKeyboardTargetIsReading } from "./lib/project-canvas-productivity";
import { defaultReferenceSearchUiState } from "./lib/reference-search-ui";

// Read the real styles without enabling CSS processing for every mounted test
// or adding Node globals to the browser application's type environment.
const { readFileSync } = await vi.importActual<{
  readFileSync(path: string, encoding: "utf8"): string;
}>("node:fs");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.querySelectorAll("style[data-excerpt-contract]").forEach((style) => style.remove());
});

function installExcerptStyleContract() {
  // Apply the production selector rules to the actual mounted surfaces. jsdom
  // resolves these declarations but does not measure layout or scrolling.
  const style = document.createElement("style");
  style.dataset.excerptContract = "true";
  const projectStyles = readFileSync("src/project.css", "utf8");
  const searchStyles = readFileSync("src/reference-search.css", "utf8");
  style.textContent = [
    projectStyles.match(/\.project-inspector-excerpt\s*\{[^}]+\}/)?.[0],
    searchStyles.match(/\.reference-search-result-excerpt\s*\{[^}]+\}/)?.[0],
  ].join("\n");
  document.head.append(style);
}

function commentSnapshot(excerpt: string | null, excerptFormat?: "plain" | "markdown") {
  const snapshot = projectTestSnapshot();
  snapshot.references[0].resolution.target = { type: "comment", id: "comment-a" };
  snapshot.references[0].resolution.source = {
    ...snapshot.references[0].resolution.source!, title: "Diffusion observation", excerpt, excerptFormat,
  };
  return snapshot;
}

describe("Reference excerpt surface contracts", () => {
  it.each(["reading", "inspector"])("renders the API descriptor and protects native reading ownership in %s", async (surface) => {
    const snapshot = commentSnapshot(String.raw`Diffusion $L=\sqrt{2Dt}$.

$$
D=D_0e^{-E_a/(k_BT)}
$$

[source](https://example.com/source)`, "markdown");
    const descriptor = projectMapNodes(snapshot).find((node) => node.kind === "reference")!;
    const { container } = render(<MemoryRouter>{surface === "reading"
      ? <ProjectReadingSurface nodes={projectReadingNodes(snapshot).filter((node) => node.kind === "reference")} />
      : <ProjectInspectorDetails snapshot={snapshot} descriptor={descriptor} />}</MemoryRouter>);
    await waitFor(() => expect(container.querySelectorAll("math")).toHaveLength(2));
    const body = container.querySelector("[data-rich-text='comment']")!;
    expect(projectCanvasKeyboardTargetIsReading(body)).toBe(true);
    expect(projectCanvasKeyboardTargetIsReading(body.querySelector("mi"))).toBe(true);
    if (surface === "inspector") {
      const region = within(container).getByRole("region", { name: "Inspector content preview" });
      region.focus();
      expect(document.activeElement).toBe(region);
      expect(projectCanvasKeyboardTargetIsReading(region)).toBe(true);
    }
    expect(container.querySelector("p > div, button .rich-text, a .rich-text")).toBeNull();
    const link = body.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://example.com/source");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("switches one Inspector occurrence from Markdown to legacy plain then unavailable without leaving stale math", async () => {
    const snapshot = commentSnapshot("$x$", "markdown");
    const inspect = () => <MemoryRouter><ProjectInspectorDetails snapshot={snapshot}
      descriptor={projectMapNodes(snapshot).find((node) => node.kind === "reference")!} /></MemoryRouter>;
    const { container, rerender } = render(inspect());
    await waitFor(() => expect(container.querySelector("math")).not.toBeNull());
    snapshot.references[0].resolution.source!.excerptFormat = undefined;
    rerender(inspect());
    expect(container.querySelector("math")).toBeNull();
    expect(container.querySelector(".project-inspector-excerpt")?.textContent).toBe("$x$");
    expect(projectCanvasKeyboardTargetIsReading(
      within(container).getByRole("region", { name: "Inspector content preview" }),
    )).toBe(true);
    snapshot.references[0].resolution.source!.excerpt = null;
    rerender(inspect());
    expect(container.querySelector(".project-inspector-excerpt")).toBeNull();
    expect(within(container).queryByRole("region", { name: "Inspector content preview" })).toBeNull();
  });

  it("keeps many short paragraphs inside the Inspector scroll region without limiting Reading", async () => {
    installExcerptStyleContract();
    const snapshot = commentSnapshot("x\n\n".repeat(70), "markdown");
    const descriptor = projectMapNodes(snapshot).find((node) => node.kind === "reference")!;
    const { container } = render(<MemoryRouter>
      <ProjectInspectorDetails snapshot={snapshot} descriptor={descriptor} />
      <ProjectReadingSurface nodes={[descriptor]} />
    </MemoryRouter>);
    await waitFor(() => expect(container.querySelectorAll(".project-inspector-excerpt .rich-text p")).toHaveLength(70));
    expect(container.querySelectorAll(".project-reading-excerpt .rich-text p")).toHaveLength(70);
    const inspector = within(container).getByRole("region", { name: "Inspector content preview" });
    expect(getComputedStyle(inspector).maxHeight).toBe("240px");
    expect(getComputedStyle(inspector).overflow).toBe("auto");
    expect(getComputedStyle(container.querySelector(".project-reading-excerpt")!).maxHeight).toBe("");
  });

  it.each(["markdown", "plain"] as const)("makes the bounded %s search excerpt keyboard accessible", async (format) => {
    installExcerptStyleContract();
    const snapshot = commentSnapshot("x\n\n".repeat(70), format);
    const resolution = snapshot.references[0].resolution;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      query: "observation", truncated: false,
      results: [{ target: resolution.target, resolution, match: { tier: "exact_id", matchedAt: null } }],
    }), { headers: { "content-type": "application/json" } })));
    const { container } = render(<MemoryRouter><ReferenceSearchSurface
      value={{ ...defaultReferenceSearchUiState(), query: "observation" }} onChange={() => {}}
    /></MemoryRouter>);
    const region = await within(container).findByRole("region", { name: "Preview of Diffusion observation" });
    if (format === "markdown") await waitFor(() => expect(region.querySelectorAll(".rich-text p")).toHaveLength(70));
    expect(getComputedStyle(region).maxHeight).toBe("240px");
    expect(getComputedStyle(region).overflow).toBe("auto");
    region.focus();
    expect(document.activeElement).toBe(region);
    expect(projectCanvasKeyboardTargetIsReading(region)).toBe(true);
    expect(container.querySelector("button .rich-text, a .rich-text, p > div")).toBeNull();
  });
});
