import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PaginationControls } from "./PaginationControls";

describe("pagination controls", () => {
  it("renders the visible range and disables unavailable directions", () => {
    const markup = renderToStaticMarkup(createElement(PaginationControls, {
      pagination: { page: 3, pageSize: 50, total: 124, totalPages: 3 },
      label: "Sample pages",
      onPageChange: vi.fn(),
    }));

    expect(markup).toContain('aria-label="Sample pages"');
    expect(markup).toContain("<strong>101–124</strong> of 124");
    expect(markup).toContain("Page 3 of 3");
    expect(markup).toMatch(/<button[^>]*>Previous<\/button>/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Next<\/button>/);
  });

  it("does not render pagination chrome for an empty result", () => {
    const markup = renderToStaticMarkup(createElement(PaginationControls, {
      pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 },
      label: "Empty pages",
      onPageChange: vi.fn(),
    }));

    expect(markup).toBe("");
  });
});
