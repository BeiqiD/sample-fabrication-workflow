export interface AnchoredMenuPosition {
  left: number;
  top: number;
  placement: "above" | "below";
}

interface AnchorRect {
  top: number;
  right: number;
  bottom: number;
}

interface MenuSize {
  width: number;
  height: number;
}

interface ViewportSize {
  width: number;
  height: number;
}

export function anchoredMenuPosition(
  anchor: AnchorRect,
  menu: MenuSize,
  viewport: ViewportSize,
  gap = 6,
  gutter = 8,
): AnchoredMenuPosition {
  const availableAbove = anchor.top - gap - gutter;
  const availableBelow = viewport.height - anchor.bottom - gap - gutter;
  const placement = menu.height > availableBelow && availableAbove > availableBelow ? "above" : "below";
  const desiredTop = placement === "above"
    ? anchor.top - gap - menu.height
    : anchor.bottom + gap;
  const maximumTop = Math.max(gutter, viewport.height - menu.height - gutter);
  const maximumLeft = Math.max(gutter, viewport.width - menu.width - gutter);

  return {
    left: Math.min(Math.max(anchor.right - menu.width, gutter), maximumLeft),
    top: Math.min(Math.max(desiredTop, gutter), maximumTop),
    placement,
  };
}
