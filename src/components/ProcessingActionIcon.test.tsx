import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProcessingActionIcon, type ProcessingActionIconName } from "./ProcessingActionIcon";

const names: ProcessingActionIconName[] = ["done", "comment"];

describe("ProcessingActionIcon", () => {
  it("keeps both actions on the same SVG canvas", () => {
    for (const name of names) {
      const markup = renderToStaticMarkup(<ProcessingActionIcon name={name} />);
      expect(markup).toContain('width="18"');
      expect(markup).toContain('height="18"');
      expect(markup).toContain('viewBox="0 0 24 24"');
    }
  });

  it("leaves accessible naming to the parent button", () => {
    for (const name of names) {
      const markup = renderToStaticMarkup(<ProcessingActionIcon name={name} />);
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain('focusable="false"');
    }
  });
});
