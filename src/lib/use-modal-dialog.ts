import { useEffect, useRef } from "react";

type ElementRef<T extends HTMLElement> = { current: T | null };

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

export function useModalDialog({
  dialogRef,
  initialFocusRef,
  onClose,
  blocked = false,
}: {
  dialogRef: ElementRef<HTMLElement>;
  initialFocusRef?: ElementRef<HTMLElement>;
  onClose: () => void;
  blocked?: boolean;
}) {
  const onCloseRef = useRef(onClose);
  const blockedRef = useRef(blocked);
  onCloseRef.current = onClose;
  blockedRef.current = blocked;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";

    function focusInside() {
      const preferred = initialFocusRef?.current;
      const fallback = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? null;
      (preferred ?? fallback)?.focus();
    }

    focusInside();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || blockedRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onCloseRef.current();
    }

    function keepFocusInside(event: FocusEvent) {
      const target = event.target;
      if (!(target instanceof Node) || dialogRef.current?.contains(target)) return;
      focusInside();
    }

    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", keepFocusInside, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", keepFocusInside, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [dialogRef, initialFocusRef]);
}
