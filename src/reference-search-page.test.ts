import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const navigationIcon = readFileSync(new URL("./components/NavigationIcon.tsx", import.meta.url), "utf8");
const searchPage = readFileSync(new URL("./pages/SearchPage.tsx", import.meta.url), "utf8");
const searchSurface = readFileSync(new URL("./components/ReferenceSearchSurface.tsx", import.meta.url), "utf8");
const searchStyles = readFileSync(new URL("./reference-search.css", import.meta.url), "utf8");

describe("temporary reference Search browser contract", () => {
  it("retains one integration route after Project replaces the placeholder navigation item", () => {
    expect(app).toContain("The standalone Search route remains a development/integration browser.");
    expect(app).toContain("owns the primary navigation destination from Phase 3B onward.");
    expect(app).toContain('const SearchPage = lazy(() => import("./pages/SearchPage")');
    expect(app).not.toContain('{ to: "/search", label: "Search", icon: "search" }');
    expect(app).toContain('{ to: "/projects", label: "Projects", icon: "projects" }');
    expect(app).toContain('<Route path="/search" element={<SearchPage />} />');
    expect(navigationIcon).toContain('"search"');
    expect(navigationIcon).toMatch(/search:\s*<>[\s\S]*?<circle[\s\S]*?<path/);
  });

  it("keeps the temporary page thin and delegates durable behavior to the reusable surface", () => {
    expect(searchPage).toContain("useSearchParams");
    expect(searchPage).toContain("referenceSearchStateFromParams");
    expect(searchPage).toContain("referenceSearchParamsFromState");
    expect(searchPage).toContain("<ReferenceSearchSurface");
    expect(searchSurface).toContain('mode: "select"');
    expect(searchSurface).toContain("onSelect: (target: ReferenceTarget) => void");
    expect(searchSurface).not.toMatch(/Add to project/i);
  });

  it("compacts the theme control while five primary destinations exist", () => {
    expect(app).toContain('import "./reference-search.css"');
    expect(searchStyles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.topbar \.theme-toggle\s*\{[^}]*min-width:\s*40px[^}]*width:\s*40px/);
    expect(searchStyles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.topbar \.theme-toggle small\s*\{[^}]*position:\s*absolute/);
  });
});
