import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProcessPlanCommentButton, processPlanCommentButtonLabel } from "./ProcessPlanCommentButton";

describe("ProcessPlanCommentButton", () => {
  it("marks existing comments with state styling and no visible count", () => {
    const markup = renderToStaticMarkup(createElement(ProcessPlanCommentButton, {
      commentCount: 3,
      expanded: false,
      disabled: false,
      onClick: () => undefined,
    }));

    expect(markup).toContain("recipe-comment-action has-comments");
    expect(markup).toContain('aria-label="Open process-plan comments, 3 existing comments"');
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
    expect(markup).toContain('aria-label="Add a comment to checked samples"');
    expect(markup).toContain("disabled");
  });

  it("describes incomplete uploads separately from ready comments", () => {
    expect(processPlanCommentButtonLabel(0, true)).toBe("Open process-plan comments, incomplete upload available");
    expect(processPlanCommentButtonLabel(1, true)).toBe("Open process-plan comments, 1 existing comment");
  });
});
