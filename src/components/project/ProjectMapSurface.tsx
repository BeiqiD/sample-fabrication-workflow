import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  NodeResizer,
  ReactFlow,
  applyNodeChanges,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type NodeProps,
  type OnNodeDrag,
  type OnSelectionChangeFunc,
  type ResizeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ProjectMapGeometry } from "../../../shared/project-types";
import type {
  ProjectGeometryCommand,
  ProjectNodeDescriptor,
} from "../../lib/project-map-model";
import "./project-map-surface.css";

type ProjectFlowNodeData = {
  descriptor: ProjectNodeDescriptor;
  onResizeStart: (descriptor: ProjectNodeDescriptor, params: ResizeParams) => void;
  onResizeEnd: (descriptor: ProjectNodeDescriptor, params: ResizeParams) => void;
};

type ProjectFlowNode = Node<ProjectFlowNodeData, "projectItem">;

export interface ProjectMapSurfaceProps {
  nodes: ProjectNodeDescriptor[];
  selectedItemId: string | null;
  onSelect: (itemId: string | null) => void;
  onGeometryCommit: (command: ProjectGeometryCommand) => void;
}

function nodeGeometry(node: ProjectFlowNode): ProjectMapGeometry {
  const fallback = node.data.descriptor.geometry;
  const width = node.measured?.width ?? node.width ?? fallback.width;
  const height = node.measured?.height ?? node.height ?? fallback.height;
  return {
    x: node.position.x,
    y: node.position.y,
    width,
    height,
    zIndex: fallback.zIndex,
  };
}

function geometryFromResize(
  descriptor: ProjectNodeDescriptor,
  params: ResizeParams,
): ProjectMapGeometry {
  return {
    x: params.x,
    y: params.y,
    width: params.width,
    height: params.height,
    zIndex: descriptor.geometry.zIndex,
  };
}

function ProjectItemNode({ data, selected }: NodeProps<ProjectFlowNode>) {
  const { descriptor } = data;
  return <article className={`project-map-node project-map-node-${descriptor.kind}`}>
    <NodeResizer
      isVisible={selected}
      minWidth={180}
      minHeight={110}
      maxWidth={1_200}
      maxHeight={1_000}
      lineClassName="project-node-resize-line nodrag nopan"
      handleClassName="project-node-resize-handle nodrag nopan"
      onResizeStart={(_event, params) => data.onResizeStart(descriptor, params)}
      onResizeEnd={(_event, params) => data.onResizeEnd(descriptor, params)}
    />
    <header>
      <span>{descriptor.kind}</span>
      <small>#{descriptor.createdSequence}</small>
    </header>
    <h2>{descriptor.title}</h2>
    {descriptor.subtitle && <p className="project-node-subtitle">{descriptor.subtitle}</p>}
    {descriptor.excerpt && <p className="project-node-excerpt">{descriptor.excerpt}</p>}
  </article>;
}

const PROJECT_NODE_TYPES = { projectItem: ProjectItemNode } as const;
const PROJECT_EDGES: [] = [];
const PROJECT_FIT_VIEW_OPTIONS = { padding: 0.22, maxZoom: 1 } as const;
const PROJECT_PRO_OPTIONS = { hideAttribution: true } as const;

function buildFlowNode(
  descriptor: ProjectNodeDescriptor,
  onResizeStart: ProjectFlowNodeData["onResizeStart"],
  onResizeEnd: ProjectFlowNodeData["onResizeEnd"],
): ProjectFlowNode {
  return {
    id: descriptor.itemId,
    type: "projectItem",
    position: { x: descriptor.geometry.x, y: descriptor.geometry.y },
    width: descriptor.geometry.width,
    height: descriptor.geometry.height,
    style: {
      width: descriptor.geometry.width,
      height: descriptor.geometry.height,
      zIndex: descriptor.geometry.zIndex,
    },
    data: { descriptor, onResizeStart, onResizeEnd },
    draggable: true,
    selectable: true,
    connectable: false,
    deletable: false,
    focusable: true,
    ariaLabel: `${descriptor.kind}: ${descriptor.title}`,
  };
}

export function ProjectMapSurface({
  nodes: descriptors,
  selectedItemId,
  onSelect,
  onGeometryCommit,
}: ProjectMapSurfaceProps) {
  const interactionStarts = useMemo(() => new Map<string, ProjectMapGeometry>(), []);

  const handleResizeStart = useCallback((descriptor: ProjectNodeDescriptor, params: ResizeParams) => {
    interactionStarts.set(descriptor.placementId, geometryFromResize(descriptor, params));
  }, [interactionStarts]);

  const handleResizeEnd = useCallback((descriptor: ProjectNodeDescriptor, params: ResizeParams) => {
    const after = geometryFromResize(descriptor, params);
    const before = interactionStarts.get(descriptor.placementId) ?? descriptor.geometry;
    interactionStarts.delete(descriptor.placementId);
    onGeometryCommit({ placementId: descriptor.placementId, before, after });
  }, [interactionStarts, onGeometryCommit]);

  const projectedNodes = useMemo(() => descriptors.map((descriptor) => buildFlowNode(
    descriptor,
    handleResizeStart,
    handleResizeEnd,
  )), [descriptors, handleResizeEnd, handleResizeStart]);
  const [flowNodes, setFlowNodes] = useState<ProjectFlowNode[]>(projectedNodes);

  useEffect(() => {
    setFlowNodes((current) => projectedNodes.map((projected) => ({
      ...projected,
      selected: current.find((candidate) => candidate.id === projected.id)?.selected ?? false,
    })));
  }, [projectedNodes]);

  useEffect(() => {
    setFlowNodes((current) => {
      const selectionChanged = current.some((node) => node.selected !== (node.id === selectedItemId));
      if (!selectionChanged) return current;
      return current.map((node) => ({ ...node, selected: node.id === selectedItemId }));
    });
  }, [selectedItemId]);

  const onNodesChange = useCallback((changes: NodeChange<ProjectFlowNode>[]) => {
    setFlowNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const handleNodeClick = useCallback<NodeMouseHandler<ProjectFlowNode>>((_event, node) => {
    onSelect(node.id);
  }, [onSelect]);
  const handlePaneClick = useCallback(() => onSelect(null), [onSelect]);
  const handleSelectionChange = useCallback<OnSelectionChangeFunc<ProjectFlowNode>>(({ nodes }) => {
    onSelect(nodes.at(-1)?.id ?? null);
  }, [onSelect]);
  const handleNodeDragStart = useCallback<OnNodeDrag<ProjectFlowNode>>((_event, node) => {
    interactionStarts.set(node.data.descriptor.placementId, nodeGeometry(node));
  }, [interactionStarts]);
  const handleNodeDragStop = useCallback<OnNodeDrag<ProjectFlowNode>>((_event, node) => {
    const placementId = node.data.descriptor.placementId;
    const before = interactionStarts.get(placementId) ?? node.data.descriptor.geometry;
    interactionStarts.delete(placementId);
    onGeometryCommit({ placementId, before, after: nodeGeometry(node) });
  }, [interactionStarts, onGeometryCommit]);

  return <div className="project-flow-canvas" data-testid="project-flow-canvas">
    <ReactFlow<ProjectFlowNode>
      nodes={flowNodes}
      edges={PROJECT_EDGES}
      nodeTypes={PROJECT_NODE_TYPES}
      onNodesChange={onNodesChange}
      onNodeClick={handleNodeClick}
      onSelectionChange={handleSelectionChange}
      onPaneClick={handlePaneClick}
      onNodeDragStart={handleNodeDragStart}
      onNodeDragStop={handleNodeDragStop}
      nodesConnectable={false}
      elementsSelectable
      fitView
      fitViewOptions={PROJECT_FIT_VIEW_OPTIONS}
      minZoom={0.1}
      maxZoom={2.5}
      deleteKeyCode={null}
      proOptions={PROJECT_PRO_OPTIONS}
    >
      <Background gap={22} size={1.2} />
      <Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}
