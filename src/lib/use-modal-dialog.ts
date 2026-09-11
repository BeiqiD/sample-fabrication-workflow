import { useEffect, useRef } from "react";

type ElementRef<T extends HTMLElement> = { current: T | null };

const FOCUSABLE_SELECTOR = [
  "button",
  "a[href]",
  "area[href]",
  "input:not([type=\"hidden\"])",
  "select",
  "textarea",
  "summary",
  "iframe",
  "[contenteditable]:not([contenteditable=\"false\"])",
  "[tabindex]",
].join(",");

const modalStack: HTMLElement[] = [];
let inertSessionActive = false;
let bodyOverflowBeforeFirstModal: string | null = null;
let modalObserver: MutationObserver | null = null;
const backgroundInert = new Map<HTMLElement, { inert: boolean; attribute: string | null }>();

function isVisible(element: HTMLElement, checkInert = true) {
  if (!element.isConnected) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || (checkInert && (current.inert || current.hasAttribute("inert")))) return false;
    const style = getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (current.tagName === "DETAILS" && !current.hasAttribute("open")) {
      const summary = current.querySelector(":scope > summary");
      if (!summary?.contains(element)) return false;
    }
  }
  return true;
}

function canFocus(element: HTMLElement | null): element is HTMLElement {
  return element !== null && isVisible(element) && !element.matches(":disabled");
}

function tabbableElements(dialog: HTMLElement) {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => canFocus(element) && (element.tabIndex >= 0
      || (!element.hasAttribute("tabindex") && element.hasAttribute("contenteditable"))))
    .sort((left, right) => (left.tabIndex > 0 ? left.tabIndex : Infinity)
      - (right.tabIndex > 0 ? right.tabIndex : Infinity));
}

function openModals() {
  // Inert is intentionally ignored here: a newly opened modal may still be
  // inside a branch locked for its predecessor until the manager refreshes it.
  return [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')]
    .filter((dialog) => isVisible(dialog, false));
}

function hasLaterUnregisteredModal(dialog: HTMLElement) {
  const modals = openModals();
  const dialogIndex = modals.indexOf(dialog);
  if (dialogIndex < 0) return false;
  return modals.slice(dialogIndex + 1).some((candidate) => !modalStack.includes(candidate));
}

function isTopModal(dialog: HTMLElement) {
  return isVisible(dialog, false)
    && (modalStack[modalStack.length - 1] === dialog || topRegisteredModal() === dialog)
    && !hasLaterUnregisteredModal(dialog);
}

function topRegisteredModal() {
  return modalStack.filter((dialog) => isVisible(dialog, false)).at(-1) ?? null;
}

function effectiveTopModal() {
  const registered = topRegisteredModal();
  if (!registered) return null;
  const modals = openModals();
  const index = modals.indexOf(registered);
  return modals.slice(index + 1).filter((candidate) => !modalStack.includes(candidate)).at(-1) ?? registered;
}

function restoreInert(element: HTMLElement, previous: { inert: boolean; attribute: string | null }) {
  element.inert = previous.inert;
  if (previous.attribute === null) element.removeAttribute("inert");
  else element.setAttribute("inert", previous.attribute);
}

function refreshBackgroundInert() {
  const desired = new Set<HTMLElement>();
  const active = inertSessionActive ? effectiveTopModal() : null;
  if (active?.isConnected) {
    // Lock siblings along the ancestor path, not the application root blindly:
    // some existing dialogs render in that root instead of using a portal.
    for (let branch: HTMLElement | null = active; branch?.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement
          && !["SCRIPT", "STYLE", "LINK"].includes(sibling.tagName)) desired.add(sibling);
      }
      if (branch.parentElement === document.body) break;
    }
  }
  for (const [element, previous] of backgroundInert) {
    if (desired.has(element)) continue;
    restoreInert(element, previous);
    backgroundInert.delete(element);
  }
  for (const element of desired) {
    if (!backgroundInert.has(element)) backgroundInert.set(element, {
      inert: Boolean(element.inert), attribute: element.getAttribute("inert"),
    });
    element.inert = true;
    element.setAttribute("inert", "");
  }
}

function registerModal(dialog: HTMLElement, inertBackground: boolean) {
  const previousIndex = modalStack.indexOf(dialog);
  if (previousIndex >= 0) modalStack.splice(previousIndex, 1);
  if (modalStack.length === 0) bodyOverflowBeforeFirstModal = document.body.style.overflow;
  modalStack.push(dialog);
  if (inertBackground) inertSessionActive = true;
  document.body.style.overflow = "hidden";
  refreshBackgroundInert();
  if (inertSessionActive && !modalObserver) {
    modalObserver = new MutationObserver(refreshBackgroundInert);
    modalObserver.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["aria-modal", "hidden", "style", "class"],
    });
  }
}

function unregisterModal(dialog: HTMLElement) {
  const index = modalStack.lastIndexOf(dialog);
  if (index >= 0) modalStack.splice(index, 1);
  if (modalStack.length === 0) inertSessionActive = false;
  refreshBackgroundInert();
  if (!inertSessionActive) {
    modalObserver?.disconnect();
    modalObserver = null;
  }
  if (modalStack.length > 0) {
    document.body.style.overflow = "hidden";
    return;
  }
  document.body.style.overflow = bodyOverflowBeforeFirstModal ?? "";
  bodyOverflowBeforeFirstModal = null;
}

export function useModalDialog({
  dialogRef,
  initialFocusRef,
  returnFocusRef,
  onClose,
  blocked = false,
  enabled = true,
  inertBackground = false,
}: {
  dialogRef: ElementRef<HTMLElement>;
  initialFocusRef?: ElementRef<HTMLElement>;
  /** Fallback when the original trigger was removed, hidden, or disabled. */
  returnFocusRef?: ElementRef<HTMLElement>;
  onClose: () => void;
  blocked?: boolean;
  enabled?: boolean;
  /** Project mobile sheets opt in; existing desktop dialogs keep their behavior. */
  inertBackground?: boolean;
}) {
  const onCloseRef = useRef(onClose);
  const blockedRef = useRef(blocked);
  const fallbackFocusRef = useRef(returnFocusRef);
  onCloseRef.current = onClose;
  blockedRef.current = blocked;
  fallbackFocusRef.current = returnFocusRef;

  useEffect(() => {
    if (!enabled) return;
    const dialogElement = dialogRef.current;
    if (!dialogElement) return;
    const dialog: HTMLElement = dialogElement;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousTabIndex = dialog.getAttribute("tabindex");
    if (previousTabIndex === null) dialog.setAttribute("tabindex", "-1");
    registerModal(dialog, inertBackground);
    let hasOwnedFocus = false;

    function focusInside() {
      if (!isTopModal(dialog)) return;
      const preferred = initialFocusRef?.current ?? null;
      const fallback = tabbableElements(dialog)[0] ?? dialog;
      (canFocus(preferred) && dialog.contains(preferred) ? preferred : fallback).focus({ preventScroll: true });
      hasOwnedFocus = dialog.contains(document.activeElement);
    }

    focusInside();

    function onKeyDown(event: KeyboardEvent) {
      if (!isTopModal(dialog)) return;
      if (event.key !== "Escape" && event.key !== "Tab") return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!blockedRef.current) onCloseRef.current();
        return;
      }
      const focusable = tabbableElements(dialog);
      const first = focusable[0];
      const last = focusable.at(-1);
      const current = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        event.stopImmediatePropagation();
        dialog.focus({ preventScroll: true });
      } else if (!current || !focusable.includes(current as HTMLElement)
        || (event.shiftKey ? current === first : current === last)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      }
    }

    function keepFocusInside(event: FocusEvent) {
      if (!isTopModal(dialog)) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (dialog.contains(target)) { hasOwnedFocus = true; return; }
      focusInside();
    }

    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", keepFocusInside, true);
    return () => {
      // React removes portal DOM before passive-effect cleanup, so a detached
      // top layer still owns its return focus even though it is no longer visible.
      const ownedFocus = dialog.isConnected ? isTopModal(dialog)
        : hasOwnedFocus && modalStack[modalStack.length - 1] === dialog
          && !openModals().some((candidate) => !modalStack.includes(candidate));
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", keepFocusInside, true);
      unregisterModal(dialog);
      if (previousTabIndex === null) dialog.removeAttribute("tabindex");
      // Removing an underlying layer must not reset a still-open upper editor.
      if (!ownedFocus) return;
      const target = previouslyFocused?.isConnected && canFocus(previouslyFocused)
        && !dialog.contains(previouslyFocused) && previouslyFocused !== document.body
        ? previouslyFocused : fallbackFocusRef.current?.current ?? null;
      const remainingModal = effectiveTopModal();
      if (canFocus(target) && (!remainingModal || remainingModal.contains(target))) target.focus({ preventScroll: true });
    };
  }, [dialogRef, initialFocusRef, enabled, inertBackground]);

  return {
    requestClose: () => {
      const dialog = dialogRef.current;
      if (enabled && dialog && isTopModal(dialog) && !blockedRef.current) onCloseRef.current();
    },
  };
}
