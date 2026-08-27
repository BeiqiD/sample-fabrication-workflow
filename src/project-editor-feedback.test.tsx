// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectEditorFeedback } from "./components/project/ProjectEditorFeedback";

afterEach(cleanup);

describe("Project owned-content editor feedback", () => {
  it("keeps uncertain outcomes polite and determined failures urgent", () => {
    const { rerender } = render(<ProjectEditorFeedback
      status="uncertain"
      message="The response was lost before confirmation."
    />);

    const uncertain = screen.getByRole("status");
    expect(uncertain.getAttribute("data-project-editor-status")).toBe("uncertain");
    expect(uncertain.classList.contains("warning")).toBe(true);
    expect(uncertain.classList.contains("danger")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();

    rerender(<ProjectEditorFeedback
      status="conflict"
      message="The content changed elsewhere."
    />);

    const conflict = screen.getByRole("alert");
    expect(conflict.getAttribute("data-project-editor-status")).toBe("conflict");
    expect(conflict.classList.contains("danger")).toBe(true);
    expect(conflict.classList.contains("warning")).toBe(false);
  });

  it("keeps summary and server detail inside one live region", () => {
    render(<ProjectEditorFeedback
      status="error"
      summary="The save failed. The local draft is still available."
      message="Validation rejected the update."
    />);

    const feedback = screen.getByRole("alert");
    expect(feedback.textContent).toContain("The save failed.");
    expect(feedback.textContent).toContain("Validation rejected the update.");
    expect(feedback.querySelectorAll("p")).toHaveLength(2);
  });
});
