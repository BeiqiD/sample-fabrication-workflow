import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NavigationIcon, type NavigationIconName } from "./NavigationIcon";

const iconNames: NavigationIconName[] = ["brand", "processing", "samples", "templates", "export"];

describe("NavigationIcon", () => {
  it("uses exactly the same SVG dimensions for every navigation icon", () => {
    for (const name of iconNames) {
      const markup = renderToStaticMarkup(<NavigationIcon name={name} />);
      expect(markup).toContain('width="20"');
      expect(markup).toContain('height="20"');
      expect(markup).toContain('viewBox="0 0 24 24"');
      expect(markup).toContain('aria-hidden="true"');
    }
  });
});
