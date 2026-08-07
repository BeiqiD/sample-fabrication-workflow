import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const newSample = readFileSync(new URL("./pages/NewSamplePage.tsx", import.meta.url), "utf8");
const samplePage = readFileSync(new URL("./pages/SamplePage.tsx", import.meta.url), "utf8");
const splitDialog = readFileSync(new URL("./components/SplitSampleDialog.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("./sample-identity-form.css", import.meta.url), "utf8");

function expectOrder(source: string, markers: string[]) {
  const positions = markers.map((marker) => source.indexOf(marker));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

describe("sample identity form normalization", () => {
  it("uses the canonical field order and Location naming when creating a sample", () => {
    const form = newSample.slice(newSample.indexOf('<form className="card form-grid sample-identity-form"'));
    expectOrder(form, ['name="code"', 'name="title"', 'name="status"', 'name="location"', 'name="description"']);
    expect(form).not.toContain("Current location");
  });

  it("uses the same identity order in Sample details before the extra Pinned field", () => {
    const start = samplePage.indexOf('<form className="detail-form sample-identity-form sample-details-edit-form"');
    const form = samplePage.slice(start, samplePage.indexOf("</form>", start));
    expectOrder(form, ['value={sample.code}', 'name="title"', 'name="status"', 'name="location"', 'name="description"', 'name="pinned"']);
  });

  it("keeps split-piece identity fields in the same order", () => {
    const start = splitDialog.indexOf('className="split-piece-fields sample-identity-form"');
    const fields = splitDialog.slice(start);
    expectOrder(fields, ['updatePiece(index, "code"', 'updatePiece(index, "title"', 'updatePiece(index, "status"', 'updatePiece(index, "location"', 'updatePiece(index, "description"']);
  });

  it("shares field typography without changing established spacing or buttons", () => {
    expect(layout).toMatch(/\.sample-identity-form label:not\(\.checkbox-label\)[^{]*\{[^}]*font-size:\s*12px[^}]*font-weight:\s*650/s);
    expect(layout).toMatch(/\.sample-identity-form input:not\(\[type="checkbox"\]\),[\s\S]*\.sample-identity-form select\s*\{[^}]*font-size:\s*14px[^}]*line-height:\s*1\.45/s);
    expect(layout).not.toMatch(/gap\s*:/);
    expect(layout).not.toMatch(/\.button|button\s*\{/);
  });
});
