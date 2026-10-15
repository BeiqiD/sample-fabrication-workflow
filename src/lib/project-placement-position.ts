import { isProjectMapGeometry, type ProjectMapGeometry } from "../../shared/project-types";

/**
 * Button placement starts near the viewport center but never covers an existing
 * card. Drag/drop keeps using the exact user-specified point. Candidate checks
 * are bounded to the nearest 64 obstacles plus the complete occupied extent.
 */
export function findAvailableProjectPlacementPoint(
  preferred: { x: number; y: number },
  occupied: readonly ProjectMapGeometry[],
  geometryAtPoint: (point: { x: number; y: number }) => ProjectMapGeometry | null,
): { x: number; y: number } | null {
  if (!Number.isFinite(preferred.x) || !Number.isFinite(preferred.y)) return null;
  const initial = geometryAtPoint(preferred);
  if (!initial || !isProjectMapGeometry(initial)) return null;
  // Owned content anchors its top section at the requested point, while
  // reference cards use their center. Preserve each factory's real anchor.
  const anchorX = preferred.x - initial.x;
  const anchorY = preferred.y - initial.y;
  const gap = 24;
  const tolerance = 1e-7; // Fractional top anchors must not reject an exact gap after roundoff.
  const obstacles = occupied.filter(isProjectMapGeometry);
  const isAvailable = (point: { x: number; y: number }) => {
    const candidate = geometryAtPoint(point);
    return candidate !== null && obstacles.every((obstacle) => (
      candidate.x + candidate.width + gap <= obstacle.x + tolerance
      || obstacle.x + obstacle.width + gap <= candidate.x + tolerance
      || candidate.y + candidate.height + gap <= obstacle.y + tolerance
      || obstacle.y + obstacle.height + gap <= candidate.y + tolerance
    ));
  };
  if (isAvailable(preferred)) return preferred;

  const distance = (point: { x: number; y: number }) => (
    (point.x - preferred.x) ** 2 + (point.y - preferred.y) ** 2
  );
  const nearby = [...obstacles].sort((left, right) => (
    distance({ x: left.x + left.width / 2, y: left.y + left.height / 2 })
      - distance({ x: right.x + right.width / 2, y: right.y + right.height / 2 })
  )).slice(0, 64);
  const candidates: Array<{ x: number; y: number }> = [];
  const addSides = (left: number, top: number, right: number, bottom: number) => {
    const xBefore = left - (initial.width - anchorX) - gap;
    const xAfter = right + anchorX + gap;
    const yBefore = top - (initial.height - anchorY) - gap;
    const yAfter = bottom + anchorY + gap;
    candidates.push(
      { x: xAfter, y: preferred.y },
      { x: xBefore, y: preferred.y },
      { x: preferred.x, y: yAfter },
      { x: preferred.x, y: yBefore },
      { x: xAfter, y: yAfter },
      { x: xBefore, y: yAfter },
      { x: xAfter, y: yBefore },
      { x: xBefore, y: yBefore },
    );
  };
  for (const obstacle of nearby) {
    addSides(obstacle.x, obstacle.y, obstacle.x + obstacle.width, obstacle.y + obstacle.height);
  }
  // The extent supplies a free edge even when a dense cluster exceeds the
  // nearby candidate budget. No existing card is moved to make room.
  const extent = obstacles.reduce((bounds, obstacle) => ({
    left: Math.min(bounds.left, obstacle.x),
    top: Math.min(bounds.top, obstacle.y),
    right: Math.max(bounds.right, obstacle.x + obstacle.width),
    bottom: Math.max(bounds.bottom, obstacle.y + obstacle.height),
  }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  addSides(extent.left, extent.top, extent.right, extent.bottom);
  return candidates.sort((left, right) => distance(left) - distance(right))
    .find(isAvailable) ?? null;
}
