import type { ProjectGeometryCommand } from "./project-map-model";
import type { ProjectEdgeMetadataShape } from "./project-edges";

export type ProjectEdgeHistoryCommand =
  | {
    kind: "edge-create";
    edgeId: string;
    sourceItemId: string;
    targetItemId: string;
  }
  | {
    kind: "edge-delete";
    edgeId: string;
    sourceItemId: string;
    targetItemId: string;
  }
  | {
    kind: "edge-update";
    edgeId: string;
    sourceItemId: string;
    targetItemId: string;
    before: ProjectEdgeMetadataShape;
    after: ProjectEdgeMetadataShape;
  };

export type ProjectSessionHistoryCommand =
  | { kind: "geometry"; command: ProjectGeometryCommand }
  | ProjectEdgeHistoryCommand;

export function projectEdgeHistoryTouchesItem(command: ProjectEdgeHistoryCommand, itemId: string) {
  return command.sourceItemId === itemId || command.targetItemId === itemId;
}

export function projectSessionHistoryTouchesItem(command: ProjectSessionHistoryCommand, itemId: string) {
  return command.kind === "geometry" ? false : projectEdgeHistoryTouchesItem(command, itemId);
}
