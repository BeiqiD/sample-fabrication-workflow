export interface ProjectEdgeToolbarPoint { x: number; y: number }

/** Place the toolbar in canvas pixels, keeping both reconnect targets clear. */
export function projectEdgeToolbarPosition(
  source: ProjectEdgeToolbarPoint,
  target: ProjectEdgeToolbarPoint,
  canvas: { width: number; height: number },
  toolbar: { width: number; height: number },
) {
  const margin = 12;
  const clearance = 28;
  const width = Math.min(toolbar.width, Math.max(1, canvas.width - margin * 2));
  const height = Math.min(toolbar.height, Math.max(1, canvas.height - margin * 2));
  const centerX = (source.x + target.x) / 2;
  const centerY = (source.y + target.y) / 2;
  const candidates = [
    { x: centerX - width / 2, y: Math.min(source.y, target.y) - height - clearance },
    { x: centerX - width / 2, y: Math.max(source.y, target.y) + clearance },
    { x: Math.min(source.x, target.x) - width - clearance, y: centerY - height / 2 },
    { x: Math.max(source.x, target.x) + clearance, y: centerY - height / 2 },
    { x: margin, y: margin },
    { x: canvas.width - width - margin, y: margin },
    { x: margin, y: canvas.height - height - margin },
    { x: canvas.width - width - margin, y: canvas.height - height - margin },
  ].map((point) => ({
    x: Math.max(margin, Math.min(point.x, canvas.width - width - margin)),
    y: Math.max(margin, Math.min(point.y, canvas.height - height - margin)),
  }));
  const overlap = (point: ProjectEdgeToolbarPoint) => [source, target].reduce((total, endpoint) => {
    const intersectionWidth = Math.max(0, Math.min(point.x + width, endpoint.x + clearance) - Math.max(point.x, endpoint.x - clearance));
    const intersectionHeight = Math.max(0, Math.min(point.y + height, endpoint.y + clearance) - Math.max(point.y, endpoint.y - clearance));
    return total + intersectionWidth * intersectionHeight;
  }, 0);
  return candidates.find((point) => overlap(point) === 0)
    ?? candidates.reduce((best, point) => overlap(point) < overlap(best) ? point : best);
}
