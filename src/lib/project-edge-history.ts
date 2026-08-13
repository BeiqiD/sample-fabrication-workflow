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

export function projectEdgeHistoryTouchesItem(command: ProjectEdgeHistoryCommand, itemId: string) {
  return command.sourceItemId === itemId || command.targetItemId === itemId;
}
