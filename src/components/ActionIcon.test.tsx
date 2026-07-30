import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionIcon, type ActionIconName } from "./ActionIcon";

const names: ActionIconName[] = ["actions", "delete", "export", "metrology", "moon", "plan-update", "process", "split", "start", "sun"];

describe("ActionIcon", () => {
  it("keeps every action on the same SVG canvas and stroke system", () => {
    for (const name of names) {
      const markup = renderToStaticMarkup(<ActionIcon name={name} />);
      expect(markup).toContain('width="20"');
      expect(markup).toContain('height="20"');
      expect(markup).toContain('viewBox="0 0 24 24"');
      expect(markup).toContain('stroke-width="1.8"');
    }
  });

  it("leaves accessible naming to the parent control", () => {
    for (const name of names) {
      const markup = renderToStaticMarkup(<ActionIcon name={name} />);
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain('focusable="false"');
    }
  });
});
