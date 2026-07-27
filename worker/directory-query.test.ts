import { describe, expect, it } from "vitest";
import {
  likeBindings,
  paginationMeta,
  processingDirectoryFilter,
  readPagination,
  repeatedLikeSql,
  sampleDirectorySort,
  searchTokens,
} from "./directory-query";

describe("directory pagination", () => {
  it("uses bounded positive page values", () => {
    expect(readPagination(null, null)).toEqual({ page: 1, pageSize: 50, offset: 0 });
    expect(readPagination("3", "25")).toEqual({ page: 3, pageSize: 25, offset: 50 });
    expect(readPagination("-2", "500")).toEqual({ page: 1, pageSize: 100, offset: 0 });
  });

  it("returns stable metadata for empty and populated directories", () => {
    expect(paginationMeta(0, 1, 50)).toEqual({ page: 1, pageSize: 50, total: 0, totalPages: 1 });
    expect(paginationMeta(124, 2, 50)).toEqual({ page: 2, pageSize: 50, total: 124, totalPages: 3 });
  });
});

describe("directory filtering", () => {
  it("normalizes bounded unique search terms and LIKE bindings", () => {
    const tokens = searchTokens(" AFM  tapping afm profile tool result extra eighth ninth ");
    expect(tokens).toEqual(["afm", "tapping", "profile", "tool", "result", "extra", "eighth", "ninth"]);
    expect(likeBindings(["box_1", "10%"])).toEqual(["%box\\_1%", "%10\\%%"]);
    expect(repeatedLikeSql("LOWER(name)", ["afm", "tip"])).toBe(
      "LOWER(name) LIKE ? ESCAPE '\\' AND LOWER(name) LIKE ? ESCAPE '\\'",
    );
  });

  it("defaults unknown processing filters to active", () => {
    expect(processingDirectoryFilter("complete")).toBe("complete");
    expect(processingDirectoryFilter("unknown")).toBe("active");
  });

  it("defaults sample sorting according to whether a search is active", () => {
    expect(sampleDirectorySort(null, false)).toBe("active-updated-desc");
    expect(sampleDirectorySort(null, true)).toBe("relevance");
    expect(sampleDirectorySort("created-asc", true)).toBe("created-asc");
    expect(sampleDirectorySort("relevance", false)).toBe("active-updated-desc");
  });
});
