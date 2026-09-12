// @vitest-environment jsdom
import { StrictMode, useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDeleteDialog } from "./components/ConfirmDeleteDialog";
import ProjectMarkdownEditor from "./components/project/ProjectMarkdownEditor";
import { ProjectPanelSurface } from "./components/project/ProjectPanelSurface";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

function click(element: HTMLElement) {
  element.focus();
  fireEvent.click(element);
}

// jsdom lacks native PointerEvent. Dispatch its public pointer properties without
// pretending to synthesize the browser's pointer-to-click event pipeline.
function pointer(target: HTMLElement, type: "pointerdown" | "pointerup" | "pointercancel", init: {
  button?: number; pointerId?: number; isPrimary?: boolean;
} = {}) {
  const event = new MouseEvent(type, { bubbles: true, button: init.button ?? 0 });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    isPrimary: { value: init.isPrimary ?? true },
  });
  fireEvent(target, event);
}

describe("cross-consumer modal boundary review", () => {
  it.each(["inside", "outside"])("does not dismiss when a pointer starts %s and ends across the panel boundary", (start) => {
    const close = vi.fn();
    render(<ProjectPanelSurface modal label="Boundary sheet" onClose={close}><p>Selectable note</p></ProjectPanelSurface>);
    const note = screen.getByText("Selectable note");
    const backdrop = screen.getByRole("dialog").parentElement!;
    pointer(start === "inside" ? note : backdrop, "pointerdown");
    pointer(start === "inside" ? backdrop : note, "pointerup");
    // Pointer Events §4.2.12.3 assigns an uncaptured click to the nearest common
    // inclusive ancestor of pointerdown and pointerup targets: here, the backdrop.
    // https://www.w3.org/TR/pointerevents3/#event-dispatch
    fireEvent.click(backdrop, { detail: 1, button: 0 });
    expect(close).not.toHaveBeenCalled();
    pointer(backdrop, "pointerdown");
    pointer(backdrop, "pointerup");
    fireEvent.click(backdrop, { detail: 1, button: 0 });
    expect(close).toHaveBeenCalledOnce();
  });

  it("ignores canceled, secondary-button and mismatched pointer gestures before accepting a deliberate backdrop tap", () => {
    const close = vi.fn();
    render(<ProjectPanelSurface modal label="Pointer sheet" onClose={close}><button>Sheet action</button></ProjectPanelSurface>);
    const backdrop = screen.getByRole("dialog").parentElement!;
    pointer(backdrop, "pointerdown");
    pointer(backdrop, "pointercancel");
    fireEvent.click(backdrop, { detail: 1, button: 0 });
    expect(close).not.toHaveBeenCalled();
    pointer(backdrop, "pointerdown", { button: 2 });
    pointer(backdrop, "pointerup", { button: 2 });
    fireEvent.click(backdrop, { detail: 1, button: 2 });
    expect(close).not.toHaveBeenCalled();
    pointer(backdrop, "pointerdown", { isPrimary: false });
    pointer(backdrop, "pointerup", { isPrimary: false });
    fireEvent.click(backdrop, { detail: 1, button: 0 });
    expect(close).not.toHaveBeenCalled();
    pointer(backdrop, "pointerdown", { pointerId: 7 });
    pointer(backdrop, "pointerup", { pointerId: 8 });
    fireEvent.click(backdrop, { detail: 1, button: 0 });
    expect(close).not.toHaveBeenCalled();
    pointer(backdrop, "pointerdown");
    pointer(backdrop, "pointerup");
    fireEvent.click(backdrop, { detail: 1, button: 0 });
    expect(close).toHaveBeenCalledOnce();
  });

  it("retains top-modal and pending-operation ownership for deliberate taps and click-only activation", () => {
    const lowerClose = vi.fn();
    const upperClose = vi.fn();
    function Panels({ blocked = false }: { blocked?: boolean }) {
      return <><ProjectPanelSurface modal label="Lower pointer sheet" onClose={lowerClose}><button>Lower action</button></ProjectPanelSurface>
        <ProjectPanelSurface modal alert label="Upper pointer sheet" blocked={blocked} onClose={upperClose}><button>Upper action</button></ProjectPanelSurface></>;
    }
    const view = render(<Panels />);
    const lower = screen.getByRole("dialog").parentElement!;
    const upper = screen.getByRole("alertdialog").parentElement!;
    pointer(lower, "pointerdown");
    pointer(lower, "pointerup");
    fireEvent.click(lower, { detail: 1 });
    fireEvent.click(lower);
    expect(lowerClose).not.toHaveBeenCalled();
    fireEvent.click(upper);
    expect(upperClose).toHaveBeenCalledOnce();
    view.rerender(<Panels blocked />);
    pointer(upper, "pointerdown");
    pointer(upper, "pointerup");
    fireEvent.click(upper, { detail: 1 });
    fireEvent.click(upper);
    expect(upperClose).toHaveBeenCalledOnce();
  });

  it("keeps an inline legacy confirmation operable above a mobile sheet and restores its opener after failure", async () => {
    function Harness() {
      const [confirmation, setConfirmation] = useState(false);
      const [deleting, setDeleting] = useState(false);
      const [error, setError] = useState("");
      return <><button>Background action</button>
        <ProjectPanelSurface modal label="Review sheet" onClose={() => {}}>
          <button onClick={() => setConfirmation(true)}>Open confirmation</button>
          <button>Sheet last</button>
        </ProjectPanelSurface>
        {confirmation && <ConfirmDeleteDialog title="Review deletion" description="Delete the review fixture?"
          summary="Review fixture" deleting={deleting} error={error}
          onCancel={() => setConfirmation(false)} onConfirm={() => {
            setDeleting(true);
            void Promise.resolve().then(() => { setDeleting(false); setError("Rejected review operation"); });
          }} />}
      </>;
    }
    const view = render(<Harness />);
    const sheet = screen.getByRole("dialog", { name: "Review sheet" });
    const opener = within(sheet).getByRole("button", { name: "Open confirmation" });
    click(opener);
    const confirmation = screen.getByRole("alertdialog", { name: "Review deletion" });
    expect(view.container.hasAttribute("inert")).toBe(false);
    expect(sheet.closest(".project-panel-backdrop")?.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(within(confirmation).getByRole("button", { name: "Cancel" }));
    click(within(confirmation).getByRole("button", { name: "Delete" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBe(confirmation);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(confirmation);
    await within(confirmation).findByText("Rejected review operation");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(view.container.hasAttribute("inert")).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("keeps a leave confirmation focused when discarding its underlying expanded editor", () => {
    function Harness() {
      const [editorOpen, setEditorOpen] = useState(true);
      const [confirmOpen, setConfirmOpen] = useState(false);
      const fallback = useRef<HTMLButtonElement>(null);
      return <><button ref={fallback}>Project actions</button>
        {editorOpen && <ProjectMarkdownEditor editor={{ itemId: "review-note", value: "Keep this draft", isNew: false,
          geometry: null, status: "editing", message: null }} onChange={() => {}} onSave={() => setConfirmOpen(true)} onCancel={() => {}} />}
        {confirmOpen && <ProjectPanelSurface modal alert label="Leave review" returnFocusRef={fallback} onClose={() => setConfirmOpen(false)}>
          <button onClick={() => setConfirmOpen(false)}>Stay here</button>
          <button onClick={() => setEditorOpen(false)}>Discard underlying editor</button>
        </ProjectPanelSurface>}
      </>;
    }
    const view = render(<Harness />);
    click(screen.getByRole("button", { name: "Expand editor" }));
    click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save Markdown" }));
    const alert = screen.getByRole("alertdialog", { name: "Leave review" });
    const discard = within(alert).getByRole("button", { name: "Discard underlying editor" });
    click(discard);
    expect(screen.queryByRole("dialog", { name: "Expanded Markdown editor" })).toBeNull();
    expect(document.activeElement).toBe(discard);
    expect(view.container.hasAttribute("inert")).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Project actions" }));
    expect(view.container.hasAttribute("inert")).toBe(false);
    expect(document.body.style.overflow).toBe("");
  });

  it("releases every route background lock under StrictMode and starts the next modal session cleanly", async () => {
    document.body.style.overflow = "clip";
    const external = document.createElement("div");
    external.inert = true;
    external.setAttribute("inert", "preserve-original");
    document.body.append(external);
    const close = vi.fn();
    const view = render(<StrictMode><ProjectPanelSurface modal label="Leaving route" onClose={close}>
      <button>First route control</button>
    </ProjectPanelSurface></StrictMode>);
    expect(view.container.hasAttribute("inert")).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    view.rerender(<StrictMode><button>Next route</button></StrictMode>);
    await waitFor(() => expect(view.container.hasAttribute("inert")).toBe(false));
    expect(document.body.style.overflow).toBe("clip");
    expect(external.inert).toBe(true);
    expect(external.getAttribute("inert")).toBe("preserve-original");
    view.rerender(<StrictMode><ProjectPanelSurface modal label="Next route modal" onClose={close}>
      <button>Next first</button><button>Next last</button>
    </ProjectPanelSurface></StrictMode>);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Next first" }));
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Next last" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.body.style.overflow).toBe("clip");
    external.remove();
  });
});
