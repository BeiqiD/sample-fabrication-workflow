// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SampleEvent } from "../shared/types";
import { CommentBody } from "./components/CommentBody";
import { SampleTimeline } from "./components/SampleTimeline";

afterEach(cleanup);

function event(input: Partial<SampleEvent> & Pick<SampleEvent, "id" | "kind" | "body">): SampleEvent {
  return {
    sampleId: "sample-a",
    assetKey: null,
    metadata: {},
    actorEmail: "researcher@example.com",
    createdAt: "2026-08-16T12:00:00.000Z",
    ...input,
  };
}

describe("mounted Comment rich text", () => {
  it("renders line breaks, compact headings, TeX, and safe image links lazily", async () => {
    const view = render(<CommentBody source={`# Observation
First line
Second line with $R_a = 0.239\\,\\mathrm{nm}$.

![AFM](https://example.com/afm.png)`} />);

    await waitFor(() => expect(view.container.querySelector('[data-rich-text="comment"]')).not.toBeNull());
    const rich = view.container.querySelector('[data-rich-text="comment"]');
    expect(rich?.querySelector("h1")).toBeNull();
    expect(rich?.querySelector(".rich-text-comment-heading")?.textContent).toBe("Observation");
    expect(rich?.innerHTML).toMatch(/First line<br>\s*Second line/);
    expect(rich?.querySelector(".rich-text-math-inline math")).not.toBeNull();
    expect(rich?.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "Image: AFM" }).getAttribute("href"))
      .toBe("https://example.com/afm.png");
  });

  it("renders only Comment and image-note timeline bodies as rich text", async () => {
    const view = render(<SampleTimeline events={[
      event({ id: "comment", kind: "comment", body: "**Measured** $R_a$" }),
      event({ id: "status", kind: "status", body: "Status *stored*" }),
    ]} />);

    await waitFor(() => expect(view.container.querySelector('[data-rich-text="comment"]')).not.toBeNull());
    expect(screen.getByText("Measured").tagName).toBe("STRONG");
    expect(view.container.querySelector(".rich-text-math-inline math")).not.toBeNull();
    expect(screen.getByText("Status *stored*").tagName).toBe("P");
  });

  it("never executes raw HTML from a Comment body", async () => {
    const view = render(<CommentBody source={'<script>alert("x")</script>'} />);
    await waitFor(() => expect(view.container.querySelector('[data-rich-text="comment"]')).not.toBeNull());
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.textContent).toContain('<script>alert("x")</script>');
  });
});
