import { describe, expect, it } from "vitest";
import { allowedEmail, normalizedTeamDomain } from "./auth";

describe("Cloudflare Access configuration", () => {
  it("normalizes a team domain without weakening its origin", () => {
    expect(normalizedTeamDomain("https://lab.cloudflareaccess.com/")).toBe("https://lab.cloudflareaccess.com");
  });

  it("supports a case-insensitive optional email allowlist", () => {
    expect(allowedEmail("USER@example.com", "user@example.com, other@example.com")).toBe(true);
    expect(allowedEmail("outsider@example.com", "user@example.com")).toBe(false);
    expect(allowedEmail("anyone@example.com", "")).toBe(true);
  });
});
