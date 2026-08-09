import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const navigationIcon = readFileSync(new URL("./components/NavigationIcon.tsx", import.meta.url), "utf8");
const searchPage = readFileSync(new URL("./pages/SearchPage.tsx", import.meta.url), "utf8");
const searchSurface = readFileSync(new URL("./components/ReferenceSearchSurface.tsx", import.meta.url), "utf8");
const searchStyles = readFileSync(new URL("./reference-search.css", import.meta.url), "utf8");

describe("temporary reference Search browser contract", () => {
  it("registers one removable integration route and placeholder navigation item", () => {
    expect(app).toContain("Temporary integration browser. Phase 3 mounts the reusable surface inside Project.");
    expect(app).toContain("Phase 3 replaces this temporary destination with Project.");
    expect(app).toContain('const SearchPage = lazy(() => import("./pages/SearchPage")');
    expect(app).toContain('{ to: "/search", label: "Search", icon: "search" }');
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

  it("compacts the theme control while the temporary fifth destination exists", () => {
    expect(app).toContain('import "./reference-search.css"');
    expect(searchStyles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.topbar \.theme-toggle\s*\{[^}]*min-width:\s*40px[^}]*width:\s*40px/);
    expect(searchStyles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.topbar \.theme-toggle small\s*\{[^}]*position:\s*absolute/);
  });
});
