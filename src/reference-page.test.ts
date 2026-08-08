import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("./pages/ReferencePage.tsx", import.meta.url), "utf8");
const client = readFileSync(new URL("./lib/reference-api.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("./reference-page.css", import.meta.url), "utf8");

describe("reference destination route", () => {
  it("lazy-loads one stable target-type and stable-ID route", () => {
    expect(app).toMatch(/const ReferencePage = lazy/);
    expect(app).toContain('<Route path="/references/:type/:id" element={<ReferencePage />} />');
    expect(page).toMatch(/isReferenceTarget\(target\)/);
  });

  it("uses the existing read-only batch resolver and no source mutation client", () => {
    expect(client).toContain('fetch("/api/references/resolve"');
    expect(client).toMatch(/method:\s*"POST"/);
    expect(client).toContain("targets: [target]");
    expect(page).toContain("resolveReference(target, controller.signal)");
    expect(page).not.toMatch(/api\.(create|update|delete|restore)|method:\s*"(?:PATCH|PUT|DELETE)"/);
  });

  it("renders canonical lifecycle states and positional context destinations", () => {
    expect(page).toContain('label: "Not found"');
    expect(page).toContain('label: "Inconsistent"');
    expect(page).toContain('label: "Tombstoned"');
    expect(page).toContain('label: "Deleted"');
    expect(page).toContain('label: "Archived"');
    expect(page).toContain("resolution.destination.contextOpenSourceUrls[contextIndex]");
    expect(page).toContain(">Open source</Link>");
    expect(page).toContain(">Open context</Link>");
  });

  it("keeps its new layout rules scoped to the reference page", () => {
    expect(styles).toContain(".reference-page");
    expect(styles).toContain(".reference-context-card");
    expect(styles).not.toMatch(/\.(?:run-grid|sample-page|template-page|topbar)\b/);
  });
});
