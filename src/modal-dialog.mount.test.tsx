// @vitest-environment jsdom
import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useModalDialog } from "./lib/use-modal-dialog";

type FocusRef = { current: HTMLElement | null };

function Dialog({
  name = "Sheet", enabled = true, blocked = false, inertBackground = true, hidden = false,
  initialFocusRef, returnFocusRef, onClose = () => {}, children,
}: {
  name?: string; enabled?: boolean; blocked?: boolean; inertBackground?: boolean; hidden?: boolean;
  initialFocusRef?: FocusRef; returnFocusRef?: FocusRef; onClose?: () => void;
  children?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const { requestClose } = useModalDialog({ dialogRef, initialFocusRef, returnFocusRef, onClose, enabled, blocked, inertBackground });
  return createPortal(<div data-testid={`${name}-backdrop`} hidden={hidden} onClick={(event) => {
    if (event.target === event.currentTarget) requestClose();
  }}>
    <div ref={dialogRef} role={enabled ? "dialog" : "region"} aria-modal={enabled || undefined} aria-label={name}>
      {children ?? <><button>{name} first</button><button>{name} last</button></>}
    </div>
  </div>, document.body);
}

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

describe("shared modal dialog behavior", () => {
  it("dismisses only the unblocked top backdrop, including direct event dispatch", () => {
    const lowerClose = vi.fn();
    const upperClose = vi.fn();
    const view = render(<><Dialog onClose={lowerClose} /><Dialog name="Upper" onClose={upperClose} /></>);
    fireEvent.click(screen.getByTestId("Sheet-backdrop"));
    expect(lowerClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("Upper-backdrop"));
    expect(upperClose).toHaveBeenCalledTimes(1);
    view.rerender(<><Dialog onClose={lowerClose} /><Dialog name="Upper" blocked onClose={upperClose} /></>);
    fireEvent.click(screen.getByTestId("Upper-backdrop"));
    expect(upperClose).toHaveBeenCalledTimes(1);
  });

  it("cycles Tab in both directions while skipping hidden, inert, disabled, and negative-tabindex controls", () => {
    render(<Dialog>
      <div hidden><button>Hidden ancestor</button></div>
      <div style={{ display: "none" }}><button>CSS hidden ancestor</button></div>
      <button>First</button>
      <fieldset disabled><button>Disabled fieldset</button></fieldset>
      <div inert><button>Inert ancestor</button></div>
      <button tabIndex={-1}>Programmatic only</button>
      <details><summary>Disclosure</summary><button>Collapsed detail</button></details>
      <button>Last</button>
      <button disabled>Disabled trailing control</button>
      <div hidden><button>Hidden trailing control</button></div>
    </Dialog>);
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    last.focus();
    fireEvent.keyDown(last, { key: "Tab", shiftKey: true });
    // Native traversal remains responsible for intermediate controls.
    expect(document.activeElement).toBe(last);
  });

  it("uses the dialog itself when all controls are disabled, including a disabled preferred focus", () => {
    function BusyDialog() {
      const initialFocusRef = useRef<HTMLButtonElement>(null);
      return <Dialog initialFocusRef={initialFocusRef} blocked><button ref={initialFocusRef} disabled>Saving</button></Dialog>;
    }
    render(<BusyDialog />);
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(dialog);
  });

  it("consumes a blocked Escape before underlying listeners and picks up a changed close callback", () => {
    const firstClose = vi.fn();
    const nextClose = vi.fn();
    const underlyingEscape = vi.fn();
    const view = render(<Dialog blocked onClose={firstClose} />);
    window.addEventListener("keydown", underlyingEscape);
    try {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(firstClose).not.toHaveBeenCalled();
      expect(underlyingEscape).not.toHaveBeenCalled();
      view.rerender(<Dialog onClose={nextClose} />);
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(firstClose).not.toHaveBeenCalled();
      expect(nextClose).toHaveBeenCalledOnce();
      expect(underlyingEscape).not.toHaveBeenCalled();
    } finally { window.removeEventListener("keydown", underlyingEscape); }
  });

  it("registers only while enabled and releases background/scroll locks across responsive presentation changes", () => {
    const outside = document.createElement("button");
    outside.textContent = "Responsive opener";
    document.body.append(outside);
    document.body.style.overflow = "clip";
    outside.focus();
    const view = render(<Dialog enabled={false} />);
    expect(document.body.style.overflow).toBe("clip");
    expect(document.activeElement).toBe(outside);
    expect(outside.hasAttribute("inert")).toBe(false);
    view.rerender(<Dialog />);
    expect(document.body.style.overflow).toBe("hidden");
    expect(outside.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Sheet first" }));
    view.rerender(<Dialog enabled={false} />);
    expect(document.body.style.overflow).toBe("clip");
    expect(outside.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("restores original inert state and does not alter background inert for existing opt-out dialogs", () => {
    const original = document.createElement("div");
    original.inert = true;
    original.setAttribute("inert", "original");
    const background = document.createElement("div");
    document.body.append(original, background);
    const optOut = render(<Dialog inertBackground={false} />);
    expect(background.hasAttribute("inert")).toBe(false);
    optOut.unmount();
    const optIn = render(<Dialog />);
    expect(background.inert).toBe(true);
    optIn.unmount();
    expect(background.inert).toBe(false);
    expect(background.hasAttribute("inert")).toBe(false);
    expect(original.inert).toBe(true);
    expect(original.getAttribute("inert")).toBe("original");
    original.remove();
    background.remove();
  });

  it("keeps a nested registered editor active and returns focus through the layer stack", () => {
    document.body.style.overflow = "scroll";
    function Harness() {
      const [open, setOpen] = useState(false);
      const [childOpen, setChildOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open sheet</button>
        {open && <Dialog onClose={() => setOpen(false)}>
          <button onClick={() => setChildOpen(true)}>Open editor</button>
          <button>Parent end</button>
        </Dialog>}
        {childOpen && <Dialog name="Editor" inertBackground={false} onClose={() => setChildOpen(false)} />}
      </>;
    }
    render(<Harness />);
    const origin = screen.getByRole("button", { name: "Open sheet" });
    origin.focus();
    fireEvent.click(origin);
    const childOrigin = screen.getByRole("button", { name: "Open editor" });
    childOrigin.focus();
    fireEvent.click(childOrigin);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Editor first" }));
    expect(screen.getByTestId("Sheet-backdrop").inert).toBe(true);
    expect(screen.getByTestId("Editor-backdrop").inert ?? false).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Editor" })).toBeNull();
    expect(document.activeElement).toBe(childOrigin);
    expect(screen.getByTestId("Sheet-backdrop").inert).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(origin);
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("does not steal focus or release inherited inert when an underlying sheet disappears first", () => {
    const view = render(<><Dialog /><Dialog name="Editor" inertBackground={false}><input aria-label="Editor draft" /><button>Save</button></Dialog></>);
    const editor = screen.getByRole("textbox", { name: "Editor draft" }) as HTMLInputElement;
    editor.focus();
    editor.value = "Preserve caret";
    editor.setSelectionRange(2, 5);
    view.rerender(<><Dialog enabled={false} /><Dialog name="Editor" inertBackground={false}><input aria-label="Editor draft" /><button>Save</button></Dialog></>);
    expect(document.activeElement).toBe(editor);
    expect(editor.selectionStart).toBe(2);
    expect(editor.selectionEnd).toBe(5);
    expect(screen.getByTestId("Sheet-backdrop").inert).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("allows a later unregistered image lightbox and excludes hidden stale modal markup", async () => {
    const onClose = vi.fn();
    const view = render(<><Dialog onClose={onClose} />
      {createPortal(<div role="dialog" aria-modal="true" aria-label="Stale" hidden><button>Stale close</button></div>, document.body)}
    </>);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    const lightbox = document.createElement("div");
    lightbox.setAttribute("role", "dialog");
    lightbox.setAttribute("aria-modal", "true");
    const close = document.createElement("button");
    close.textContent = "Close legacy image";
    lightbox.append(close);
    document.body.append(lightbox);
    await waitFor(() => expect(screen.getByTestId("Sheet-backdrop").inert).toBe(true));
    expect(lightbox.inert ?? false).toBe(false);
    close.focus();
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    lightbox.remove();
    await waitFor(() => expect(screen.getByTestId("Sheet-backdrop").inert).toBe(false));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("keeps top ownership with the visible layer when a registered successor is hidden", () => {
    const closeSheet = vi.fn();
    const closeHidden = vi.fn();
    render(<><Dialog onClose={closeSheet} /><Dialog name="Hidden editor" hidden onClose={closeHidden} /></>);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Sheet first" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeSheet).toHaveBeenCalledOnce();
    expect(closeHidden).not.toHaveBeenCalled();
    expect(screen.getByTestId("Sheet-backdrop").inert ?? false).toBe(false);
  });

  it("does not restore focus from a hidden layer that never became active", () => {
    function Harness({ hiddenOpen }: { hiddenOpen: boolean }) {
      return <><Dialog><button>First visible control</button><input aria-label="Visible draft" /></Dialog>
        {hiddenOpen && <Dialog name="Hidden editor" hidden />}
      </>;
    }
    const view = render(<Harness hiddenOpen />);
    const input = screen.getByRole("textbox", { name: "Visible draft" }) as HTMLInputElement;
    input.focus();
    input.value = "Keep cursor";
    input.setSelectionRange(3, 6);
    view.rerender(<Harness hiddenOpen={false} />);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(3);
    expect(input.selectionEnd).toBe(6);
  });

  it("unlocks an inline nested dialog inside a previously inert application root", () => {
    function Harness({ childOpen }: { childOpen: boolean }) {
      const dialogRef = useRef<HTMLDivElement>(null);
      useModalDialog({ dialogRef, enabled: childOpen, onClose: () => {} });
      return <><button>Background action</button><Dialog />
        {childOpen && <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Inline confirmation"><button>Confirm</button></div>}
      </>;
    }
    const view = render(<Harness childOpen={false} />);
    expect(view.container.inert).toBe(true);
    view.rerender(<Harness childOpen />);
    const confirm = within(screen.getByRole("dialog", { name: "Inline confirmation" })).getByRole("button");
    expect(view.container.inert).toBe(false);
    expect(document.activeElement).toBe(confirm);
    expect(screen.getByRole("button", { name: "Background action" }).inert).toBe(true);
    expect(screen.getByTestId("Sheet-backdrop").inert).toBe(true);
  });

  it("uses the latest fallback trigger after the original trigger is hidden or removed", () => {
    function Harness({ open, hideOriginal = false }: { open: boolean; hideOriginal?: boolean }) {
      const fallback = useRef<HTMLButtonElement>(null);
      return <><button hidden={hideOriginal}>Old desktop trigger</button><button ref={fallback}>Reading Details</button>
        {open && <Dialog returnFocusRef={fallback} />}
      </>;
    }
    const view = render(<Harness open={false} />);
    screen.getByRole("button", { name: "Old desktop trigger" }).focus();
    view.rerender(<Harness open />);
    view.rerender(<Harness open={false} hideOriginal />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reading Details" }));
  });
});
