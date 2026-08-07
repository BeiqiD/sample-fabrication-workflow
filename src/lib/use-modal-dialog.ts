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

const modalStack: HTMLElement[] = [];
let bodyOverflowBeforeFirstModal: string | null = null;

function registerModal(dialog: HTMLElement) {
  const previousIndex = modalStack.indexOf(dialog);
  if (previousIndex >= 0) modalStack.splice(previousIndex, 1);
  if (modalStack.length === 0) bodyOverflowBeforeFirstModal = document.body.style.overflow;
  modalStack.push(dialog);
  document.body.style.overflow = "hidden";
}

function unregisterModal(dialog: HTMLElement) {
  const index = modalStack.lastIndexOf(dialog);
  if (index >= 0) modalStack.splice(index, 1);
  if (modalStack.length > 0) {
    document.body.style.overflow = "hidden";
    return;
  }
  document.body.style.overflow = bodyOverflowBeforeFirstModal ?? "";
  bodyOverflowBeforeFirstModal = null;
}

function hasLaterUnregisteredModal(dialog: HTMLElement) {
  const openModals = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')];
  const dialogIndex = openModals.indexOf(dialog);
  if (dialogIndex < 0) return false;
  return openModals.slice(dialogIndex + 1).some((candidate) => !modalStack.includes(candidate));
}

function isTopModal(dialog: HTMLElement) {
  return modalStack[modalStack.length - 1] === dialog && !hasLaterUnregisteredModal(dialog);
}

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
    const dialogElement = dialogRef.current;
    if (!dialogElement) return;
    const dialog: HTMLElement = dialogElement;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    registerModal(dialog);

    function focusInside() {
      if (!isTopModal(dialog)) return;
      const preferred = initialFocusRef?.current;
      const fallback = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? null;
      (preferred ?? fallback)?.focus();
    }

    focusInside();

    function onKeyDown(event: KeyboardEvent) {
      if (!isTopModal(dialog) || event.key !== "Escape" || blockedRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onCloseRef.current();
    }

    function keepFocusInside(event: FocusEvent) {
      if (!isTopModal(dialog)) return;
      const target = event.target;
      if (!(target instanceof Node) || dialog.contains(target)) return;
      focusInside();
    }

    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", keepFocusInside, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", keepFocusInside, true);
      unregisterModal(dialog);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [dialogRef, initialFocusRef]);
}
