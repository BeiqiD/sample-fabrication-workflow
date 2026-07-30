import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DialogCloseIcon } from "./DialogCloseIcon";

describe("DialogCloseIcon", () => {
  it("uses a symmetric SVG canvas and leaves naming to the button", () => {
    const markup = renderToStaticMarkup(<DialogCloseIcon />);

    expect(markup).toContain('width="20"');
    expect(markup).toContain('height="20"');
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('focusable="false"');
  });
});
