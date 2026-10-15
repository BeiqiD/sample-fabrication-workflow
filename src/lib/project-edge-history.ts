import type { ProjectEdgeRecord } from "../../shared/project-api";
import type { ProjectGeometryCommand } from "./project-map-model";
import type { ProjectEdgeMetadataShape } from "./project-edges";

export type ProjectEdgeConnection = Pick<ProjectEdgeRecord, "sourceItemId" | "targetItemId" | "sourceHandle" | "targetHandle">;

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
    kind: "edge-reconnect";
    edgeId: string;
    sourceItemId: string;
    targetItemId: string;
    before: ProjectEdgeConnection;
    after: ProjectEdgeConnection;
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
  | { kind: "geometry"; commands: ProjectGeometryCommand[] }
  | ProjectEdgeHistoryCommand;

export function projectEdgeHistoryTouchesItem(command: ProjectEdgeHistoryCommand, itemId: string) {
  return command.sourceItemId === itemId || command.targetItemId === itemId
    || (command.kind === "edge-reconnect"
      && [command.before.sourceItemId, command.before.targetItemId,
        command.after.sourceItemId, command.after.targetItemId].includes(itemId));
}

export function projectSessionHistoryTouchesItem(command: ProjectSessionHistoryCommand, itemId: string) {
  return command.kind === "geometry" ? false : projectEdgeHistoryTouchesItem(command, itemId);
}
