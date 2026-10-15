// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectReadingSurface } from "./components/project/ProjectReadingSurface";
import { projectReadingNodes } from "./lib/project-map-model";
import { projectTestSnapshotWithAttachment } from "./project-test-fixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Reading details and explicit occurrence focus", () => {
  it("opens details only from its explicit header action for every occurrence kind", () => {
    const nodes = projectReadingNodes(projectTestSnapshotWithAttachment());
    const onDetailsRequest = vi.fn();
    const view = render(<MemoryRouter><ProjectReadingSurface nodes={nodes} inspectedItemId="item-note" onDetailsRequest={onDetailsRequest} /></MemoryRouter>);

    fireEvent.click(screen.getByText("Preserve the occurrence identity."));
    expect(onDetailsRequest).not.toHaveBeenCalled();
    for (const node of nodes) {
      const details = screen.getByRole("button", { name: `Details for ${node.title}` });
      expect(details.closest("header")).not.toBeNull();
      expect(details.getAttribute("aria-expanded")).toBe(String(node.itemId === "item-note"));
      fireEvent.click(details);
      expect(onDetailsRequest).toHaveBeenLastCalledWith(node.itemId);
    }

    view.rerender(<MemoryRouter><ProjectReadingSurface nodes={nodes} interactionDisabled onDetailsRequest={onDetailsRequest} /></MemoryRouter>);
    onDetailsRequest.mockClear();
    for (const details of screen.getAllByRole("button", { name: /^Details for / })) {
      expect((details as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(details);
    }
    expect(onDetailsRequest).not.toHaveBeenCalled();

    view.rerender(<MemoryRouter><ProjectReadingSurface nodes={nodes} attachmentEditor={{ itemId: "item-attachment", contentId: "content-attachment", caption: "Draft", sourceUrl: "", status: "editing", message: null }} onDetailsRequest={onDetailsRequest} /></MemoryRouter>);
    for (const details of screen.getAllByRole("button", { name: /^Details for / })) {
      expect((details as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(details);
    }
    expect(onDetailsRequest).not.toHaveBeenCalled();
  });

  it("preserves control focus for passive item changes and refocuses repeated explicit requests", () => {
    const nodes = projectReadingNodes(projectTestSnapshotWithAttachment());
    const surface = (focusedItemId: string | null, focusRequestSequence = 0) => <MemoryRouter>
      <button type="button">Outside control</button>
      <ProjectReadingSurface nodes={nodes} focusedItemId={focusedItemId} focusRequestSequence={focusRequestSequence} />
    </MemoryRouter>;
    const view = render(surface(null));
    const outside = screen.getByRole("button", { name: "Outside control" });
    outside.focus();
    const note = view.container.querySelector<HTMLElement>('[data-project-item-id="item-note"]')!;
    const reference = view.container.querySelector<HTMLElement>('[data-project-item-id="item-reference"]')!;
    const noteScroll = vi.fn();
    const referenceScroll = vi.fn();
    note.scrollIntoView = noteScroll;
    reference.scrollIntoView = referenceScroll;

    view.rerender(surface("item-note"));
    expect(noteScroll).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(outside);
    view.rerender(surface("item-reference"));
    expect(referenceScroll).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(outside);

    view.rerender(surface("item-reference", 1));
    expect(referenceScroll).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(reference);
    outside.focus();
    view.rerender(surface("item-reference", 1));
    expect(referenceScroll).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(outside);
    view.rerender(surface("item-reference", 2));
    expect(referenceScroll).toHaveBeenCalledTimes(3);
    expect(document.activeElement).toBe(reference);
  });
});
