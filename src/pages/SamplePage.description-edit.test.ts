import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./SamplePage.tsx", import.meta.url), "utf8");

describe("sample description editing", () => {
  it("includes Description in the Sample details edit form and update payload", () => {
    expect(source).toContain('description: String(form.get("description"))');
    expect(source).toContain('name="description"');
    expect(source).toContain('defaultValue={sample.description || ""}');
    expect(source).toContain('maxLength={10_000}');
  });
});
