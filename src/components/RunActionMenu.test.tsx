import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionIcon } from "./ActionIcon";
import { RunActionMenu } from "./RunActionMenu";

describe("RunActionMenu", () => {
  it("keeps a named trigger icon and its dropdown arrow together", () => {
    const markup = renderToStaticMarkup(<RunActionMenu
      label="Run actions"
      icon={<ActionIcon name="actions" />}
      items={[{
        id: "update",
        label: "Update future plan",
        icon: <ActionIcon name="plan-update" />,
        onSelect: () => undefined,
      }]}
    />);

    expect(markup).toContain('aria-label="Run actions"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("▾");
  });

  it("disables a stable menu trigger when the selected run has no actions", () => {
    const markup = renderToStaticMarkup(<RunActionMenu
      label="Run actions"
      icon={<ActionIcon name="actions" />}
      items={[]}
    />);

    expect(markup).toContain("disabled");
    expect(markup).toContain('title="No run actions available"');
  });
});
