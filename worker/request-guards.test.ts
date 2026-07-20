import { describe, expect, it } from "vitest";
import { contentLengthWithin, escapedLikePattern, sameOriginOrNonBrowser } from "./request-guards";

describe("request guards", () => {
  it("keeps escaped LIKE patterns within D1's 50-byte limit", () => {
    expect(new TextEncoder().encode(escapedLikePattern("%_".repeat(100))).byteLength).toBeLessThanOrEqual(50);
    expect(escapedLikePattern("box_1")).toBe("%box\\_1%");
  });

  it("rejects oversized declared bodies", () => {
    expect(contentLengthWithin(new Request("https://app.test", { headers: { "content-length": "11" } }), 10)).toBe(false);
  });

  it("rejects browser requests from a different origin", () => {
    expect(sameOriginOrNonBrowser(new Request("https://app.test/api", { headers: { origin: "https://evil.test" } }))).toBe(false);
    expect(sameOriginOrNonBrowser(new Request("https://app.test/api"))).toBe(true);
  });
});
