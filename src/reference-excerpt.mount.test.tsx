// @vitest-environment jsdom
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReferenceExcerpt } from "./components/ReferenceExcerpt";

afterEach(cleanup);

describe("safe Reference excerpts", () => {
  it("keeps unmarked legacy summaries plain and escaped", () => {
    const source = "**Plain label** $x$ <img src=x onerror=alert(1)>";
    const { container } = render(<ReferenceExcerpt source={source} className="reference-excerpt" />);
    expect(container.textContent).toBe(source);
    expect(container.querySelector("p.reference-excerpt")).not.toBeNull();
    expect(container.querySelector("strong, math, img")).toBeNull();
  });

  it("renders explicit Comment previews with inline and block math after lazy loading", async () => {
    const source = String.raw`**Diffusion** has $L=\sqrt{2Dt}$.

$$
D=D_0 e^{-E_a/(k_B T)}
$$`;
    const { container } = render(<ReferenceExcerpt source={source} format="markdown" className="reference-excerpt" />);
    await waitFor(() => expect(container.querySelectorAll("math")).toHaveLength(2));
    expect(container.querySelector("msqrt")).not.toBeNull();
    expect(container.querySelector(".rich-text-math-block math")).not.toBeNull();
    expect(container.querySelector(".rich-text-comment strong")?.textContent).toBe("Diffusion");
    expect(container.querySelector("p > .rich-text")).toBeNull();
  });

  it("uses Comment link and image rules without executing embedded HTML", async () => {
    const source = '<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))\n\n![Evidence](https://example.com/image.png)';
    const { container } = render(<ReferenceExcerpt source={source} format="markdown" />);
    const imageLink = await within(container).findByRole("link", { name: "Image: Evidence" });
    expect(imageLink.getAttribute("href")).toBe("https://example.com/image.png");
    expect(container.querySelector("script, img, a[href^='javascript:']")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("omits unavailable previews and can switch a rich source back to an explicit plain summary", async () => {
    const { container, rerender } = render(<ReferenceExcerpt source="$x$" format="markdown" />);
    await waitFor(() => expect(container.querySelector("math")).not.toBeNull());
    rerender(<ReferenceExcerpt source="$x$" format="plain" />);
    expect(container.textContent).toBe("$x$");
    expect(container.querySelector("math")).toBeNull();
    rerender(<ReferenceExcerpt source={null} format="markdown" />);
    expect(container.childElementCount).toBe(0);
  });
});
