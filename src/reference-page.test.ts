import { readFileSync } from "node:fs";
import { matchRoutes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  decodeReferenceRouteId,
  REFERENCE_ROUTE_PATTERN,
  referenceUrlForTarget,
} from "../shared/reference-destinations";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("./pages/ReferencePage.tsx", import.meta.url), "utf8");
const client = readFileSync(new URL("./lib/reference-api.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("./reference-page.css", import.meta.url), "utf8");

const routeIdentityCases = [
  ".",
  "..",
  "/",
  "%2F",
  "?",
  "#",
  "id with space",
  "样品/α",
  "id%2Fencoded",
  "id/encoded",
];

describe("reference destination route", () => {
  it("lazy-loads one versioned opaque target route", () => {
    expect(app).toMatch(/const ReferencePage = lazy/);
    expect(app).toContain("path={REFERENCE_ROUTE_PATTERN}");
    expect(page).toContain("decodeReferenceRouteId(encodedId)");
    expect(page).toMatch(/isReferenceTarget\(target\)/);
  });

  it("round-trips allowed stable IDs through browser normalization and real React Router matching", () => {
    const urls = routeIdentityCases.map((id) => referenceUrlForTarget({
      type: "sample",
      id,
    }));
    expect(new Set(urls).size).toBe(routeIdentityCases.length);

    routeIdentityCases.forEach((id, index) => {
      const url = urls[index];
      const normalizedPath = new URL(url, "https://app.test").pathname;
      expect(normalizedPath).toBe(url);

      const matches = matchRoutes([{ path: REFERENCE_ROUTE_PATTERN }], normalizedPath);
      expect(matches).not.toBeNull();
      const params = matches!.at(-1)!.params;
      expect(params.type).toBe("sample");
      expect(params.encodedId).toMatch(/^r1_[A-Za-z0-9_-]*$/);
      expect(decodeReferenceRouteId(params.encodedId!)).toBe(id);
    });

    expect(urls[routeIdentityCases.indexOf("%2F")])
      .not.toBe(urls[routeIdentityCases.indexOf("/")]);
    expect(urls[routeIdentityCases.indexOf("id%2Fencoded")])
      .not.toBe(urls[routeIdentityCases.indexOf("id/encoded")]);
  });

  it("uses the existing read-only batch resolver and no source mutation client", () => {
    expect(client).toContain('fetch("/api/references/resolve"');
    expect(client).toMatch(/method:\s*"POST"/);
    expect(client).toContain("targets: [target]");
    expect(page).toContain("resolveReference(target, controller.signal)");
    expect(page).not.toMatch(/api\.(create|update|delete|restore)|method:\s*"(?:PATCH|PUT|DELETE)"/);
  });

  it("renders canonical lifecycle states and positional multi-context destinations", () => {
    expect(page).toContain('label: "Not found"');
    expect(page).toContain('label: "Inconsistent"');
    expect(page).toContain('label: "Tombstoned"');
    expect(page).toContain('label: "Deleted"');
    expect(page).toContain('label: "Archived"');
    expect(page).toContain('label: "Read-only context"');
    expect(page).toContain("resolution.destination.contextOpenSourceUrls[contextIndex]");
    expect(page).toContain(">Open source</Link>");
    expect(page).toContain("resolution.contexts.length > 1 && contextUrl");
    expect(page).toContain(">Open context</Link>");
  });

  it("keeps its new layout rules scoped to the reference page and documented narrow breakpoint", () => {
    const maxWidthQueries = Array.from(
      styles.matchAll(/@media \(max-width:\s*(\d+)px\)/g),
      (match) => Number(match[1]),
    );
    expect(maxWidthQueries).toEqual([720]);
    expect(styles).toContain(".reference-page");
    expect(styles).toContain(".reference-context-card");
    expect(styles).not.toMatch(/\.(?:run-grid|sample-page|template-page|topbar)\b/);
  });
});
