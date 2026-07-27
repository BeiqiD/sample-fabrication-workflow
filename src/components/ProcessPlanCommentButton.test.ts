import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProcessPlanCommentButton } from "./ProcessPlanCommentButton";

describe("ProcessPlanCommentButton", () => {
  it("marks existing comments with state styling and no visible count", () => {
    const markup = renderToStaticMarkup(createElement(ProcessPlanCommentButton, {
      commentCount: 3,
      expanded: false,
      disabled: false,
      onClick: () => undefined,
    }));

    expect(markup).toContain("recipe-comment-action has-comments");
    expect(markup).toContain('aria-label="Open comments on selected samples, 3 existing comments"');
    expect(markup).not.toContain(">3<");
  });

  it("keeps an empty comment entry visually neutral", () => {
    const markup = renderToStaticMarkup(createElement(ProcessPlanCommentButton, {
      commentCount: 0,
      expanded: false,
      disabled: true,
      onClick: () => undefined,
    }));

    expect(markup).toContain("recipe-comment-action");
    expect(markup).not.toContain("has-comments");
    expect(markup).toContain('aria-label="Comment on selected samples"');
    expect(markup).toContain("disabled");
  });
});
