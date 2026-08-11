import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const searchPage = readFileSync(new URL("./pages/SearchPage.tsx", import.meta.url), "utf8");
const searchSurface = readFileSync(new URL("./components/ReferenceSearchSurface.tsx", import.meta.url), "utf8");
const searchStyles = readFileSync(new URL("./reference-search.css", import.meta.url), "utf8");

describe("reference Search handoff to Project", () => {
  it("removes the temporary standalone Search destination when Project navigation becomes real", () => {
    expect(app).not.toContain('const SearchPage = lazy(() => import("./pages/SearchPage")');
    expect(app).not.toContain('{ to: "/search", label: "Search"');
    expect(app).not.toContain('<Route path="/search" element={<SearchPage />} />');
    expect(app).toContain('{ to: "/projects", label: "Projects", icon: "projects" }');
  });

  it("keeps the reusable reference search surface intact for Phase 3B2 embedding", () => {
    expect(searchPage).toContain("<ReferenceSearchSurface");
    expect(searchSurface).toContain('mode: "select"');
    expect(searchSurface).toContain("onSelect: (target: ReferenceTarget) => void");
    expect(searchSurface).not.toMatch(/Add to project/i);
  });

  it("retains the compact mobile topbar behavior with five primary destinations", () => {
    expect(app).toContain('import "./reference-search.css"');
    expect(searchStyles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.topbar \.theme-toggle\s*\{[^}]*min-width:\s*40px[^}]*width:\s*40px/);
  });
});
