import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentCard } from "./components/AttachmentCard";

afterEach(cleanup);

describe("shared attachment cards", () => {
  it("keeps filename, contextual title, description and original metadata distinct", () => {
    render(<AttachmentCard filename="scan final.tiff" title="Surface scan" description="Final observation"
      mimeType="image/tiff" byteSize={0} href="/api/attachments/file%2Fone/download"
      actionLabel="Download original" download="scan final.tiff" density="comfortable" />);
    const card = screen.getByRole("group", { name: "Attachment: scan final.tiff" });
    expect(within(card).getByText("Surface scan")).toBeTruthy();
    expect(within(card).getByText("scan final.tiff").getAttribute("title")).toBe("scan final.tiff");
    expect(within(card).getByText("Final observation")).toBeTruthy();
    expect(within(card).getByText("image/tiff")).toBeTruthy();
    expect(within(card).getByText("0 B")).toBeTruthy();
    const link = within(card).getByRole("link", { name: "Download original: scan final.tiff" });
    expect(link.getAttribute("href")).toBe("/api/attachments/file%2Fone/download");
    expect(link.getAttribute("download")).toBe("scan final.tiff");
    expect(link.hasAttribute("target")).toBe(false);
    expect(card.querySelector("img, iframe")).toBeNull();
  });

  it("keeps safe external source links separate from downloads", () => {
    render(<AttachmentCard filename="External dataset" href="https://example.com/data"
      actionLabel="Open source" external density="dense" />);
    const link = screen.getByRole("link", { name: "Open source: External dataset" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.hasAttribute("download")).toBe(false);
  });

  it("preserves an explicit host action name when its surface already provides context", () => {
    render(<AttachmentCard filename="surface.png" href="/api/projects/project-a/contents/image-a/file"
      actionLabel="Open attachment" actionAriaLabel="Open attachment" density="compact" />);
    expect(screen.getByRole("link", { name: "Open attachment" }).getAttribute("href"))
      .toBe("/api/projects/project-a/contents/image-a/file");
  });

  it.each(["pending", "unavailable"] as const)("blocks %s reads while retaining caller recovery actions", (kind) => {
    const retry = vi.fn();
    render(<AttachmentCard filename="measurement.csv" href="/api/attachments/measurement/download"
      status={{ kind, label: kind === "pending" ? "Uploading" : "File unavailable", message: "Keep this occurrence" }}
      actions={<button type="button" onClick={retry}>Retry measurement.csv</button>} density="compact" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Keep this occurrence");
    fireEvent.click(screen.getByRole("button", { name: "Retry measurement.csv" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("keeps a caller-authorized original available after preview failure", () => {
    render(<AttachmentCard filename="surface.png" mimeType="image/png"
      href="/api/projects/project-a/contents/image-a/file" actionLabel="Open attachment"
      status={{ kind: "failed", label: "Image preview unavailable" }} density="comfortable" />);
    expect(screen.getByRole("link", { name: "Open attachment: surface.png" }).getAttribute("href"))
      .toBe("/api/projects/project-a/contents/image-a/file");
    expect(screen.getByRole("status").textContent).toContain("Image preview unavailable");
  });

  it("does not invent a read or ready state for a failed transfer", () => {
    render(<AttachmentCard filename="measurement.dat" status={{ kind: "failed", label: "Upload incomplete" }}
      byteSize={-1} density="dense" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Upload incomplete");
    expect(screen.getByText("Generic file")).toBeTruthy();
    expect(screen.queryByText(/bytes|Ready/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it.each(["javascript:alert(1)", "//example.com/file", "data:text/html,test"])(
    "does not offer an unsafe primary action for %s", (href) => {
      render(<AttachmentCard filename="data.csv" href={href} density="compact" />);
      expect(screen.queryByRole("link")).toBeNull();
      expect(screen.getByText("data.csv")).toBeTruthy();
    },
  );

  it.each(["comfortable", "compact", "dense"] as const)("exposes %s density without hiding full filename", (density) => {
    const filename = `${"long-".repeat(40)}measurement.csv`;
    render(<AttachmentCard filename={filename} title={filename} density={density} className="domain-card" />);
    const card = screen.getByRole("group", { name: `Attachment: ${filename}` });
    expect(card.getAttribute("data-density")).toBe(density);
    expect(card.classList.contains(`attachment-card--${density}`)).toBe(true);
    expect(card.classList.contains("domain-card")).toBe(true);
    expect(within(card).getAllByText(filename)).toHaveLength(1);
    expect(within(card).getByText(filename).getAttribute("title")).toBe(filename);
  });
});
