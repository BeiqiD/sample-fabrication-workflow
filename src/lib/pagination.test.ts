import { describe, expect, it } from "vitest";
import { pageFromSearchParam, paginationRange, setPageParam } from "./pagination";

describe("pagination URL state", () => {
  it("accepts only positive integer pages", () => {
    expect(pageFromSearchParam("3")).toBe(3);
    expect(pageFromSearchParam("0")).toBe(1);
    expect(pageFromSearchParam("2.5")).toBe(1);
  });

  it("keeps page one out of the URL and preserves other filters", () => {
    const current = new URLSearchParams("q=afm&page=4");
    expect(setPageParam(current, "page", 1).toString()).toBe("q=afm");
    expect(setPageParam(current, "page", 2).toString()).toBe("q=afm&page=2");
  });

  it("computes visible result ranges", () => {
    expect(paginationRange({ page: 2, pageSize: 50, total: 124, totalPages: 3 })).toEqual({ from: 51, to: 100 });
    expect(paginationRange({ page: 1, pageSize: 50, total: 0, totalPages: 1 })).toEqual({ from: 0, to: 0 });
  });
});
