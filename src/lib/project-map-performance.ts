export type ProjectMapDetailLevel = "overview" | "compact" | "full";
export type ProjectMapScale = "ordinary" | "target" | "envelope";

export interface ProjectMapPerformancePolicy {
  nodeCount: number;
  edgeCount: number;
  scale: ProjectMapScale;
  onlyRenderVisibleElements: boolean;
  initialDetailLevel: ProjectMapDetailLevel;
}

export const PROJECT_MAP_TARGET_NODE_COUNT = 200;
export const PROJECT_MAP_TARGET_EDGE_COUNT = 300;
export const PROJECT_MAP_ENVELOPE_NODE_COUNT = 500;
export const PROJECT_MAP_ENVELOPE_EDGE_COUNT = 800;

const PROJECT_MAP_OVERVIEW_ENTER_ZOOM = 0.3;
const PROJECT_MAP_OVERVIEW_EXIT_ZOOM = 0.4;
const PROJECT_MAP_FULL_ENTER_ZOOM = 0.78;
const PROJECT_MAP_FULL_EXIT_ZOOM = 0.66;

function finiteCount(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function projectMapPerformancePolicy(
  nodeCountInput: number,
  edgeCountInput: number,
): ProjectMapPerformancePolicy {
  const nodeCount = finiteCount(nodeCountInput);
  const edgeCount = finiteCount(edgeCountInput);
  const scale: ProjectMapScale = nodeCount >= PROJECT_MAP_ENVELOPE_NODE_COUNT
    || edgeCount >= PROJECT_MAP_ENVELOPE_EDGE_COUNT
    ? "envelope"
    : nodeCount >= PROJECT_MAP_TARGET_NODE_COUNT
      || edgeCount >= PROJECT_MAP_TARGET_EDGE_COUNT
      ? "target"
      : "ordinary";
  return {
    nodeCount,
    edgeCount,
    scale,
    onlyRenderVisibleElements: scale !== "ordinary",
    initialDetailLevel: scale === "ordinary" ? "full" : "compact",
  };
}

export function projectMapDetailLevelForZoom(
  zoomInput: number,
  current: ProjectMapDetailLevel,
  scale: ProjectMapScale,
): ProjectMapDetailLevel {
  if (scale === "ordinary") return "full";
  if (!Number.isFinite(zoomInput) || zoomInput <= 0) return current;
  const zoom = zoomInput;
  if (current === "overview") {
    if (zoom >= PROJECT_MAP_FULL_ENTER_ZOOM) return "full";
    return zoom >= PROJECT_MAP_OVERVIEW_EXIT_ZOOM ? "compact" : "overview";
  }
  if (current === "full") {
    if (zoom <= PROJECT_MAP_OVERVIEW_ENTER_ZOOM) return "overview";
    return zoom <= PROJECT_MAP_FULL_EXIT_ZOOM ? "compact" : "full";
  }
  if (zoom <= PROJECT_MAP_OVERVIEW_ENTER_ZOOM) return "overview";
  if (zoom >= PROJECT_MAP_FULL_ENTER_ZOOM) return "full";
  return "compact";
}
