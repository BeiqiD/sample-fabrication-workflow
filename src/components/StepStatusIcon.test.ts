import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StepStatus } from "../../shared/types";
import { StepStatusIcon } from "./StepStatusIcon";

const statuses: StepStatus[] = ["pending", "in_progress", "done", "skipped", "blocked"];

describe("StepStatusIcon", () => {
  it("keeps every status on the same fixed SVG canvas", () => {
    for (const status of statuses) {
      const markup = renderToStaticMarkup(StepStatusIcon({ status }));
      expect(markup).toContain('width="14"');
      expect(markup).toContain('height="14"');
      expect(markup).toContain('viewBox="0 0 24 24"');
    }
  });

  it("renders pending as SVG geometry instead of a font glyph", () => {
    const markup = renderToStaticMarkup(StepStatusIcon({ status: "pending" }));
    expect(markup).toContain("<circle");
    expect(markup).not.toContain("○");
  });
});
