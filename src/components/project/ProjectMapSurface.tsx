import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
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
  type ReactFlowInstance,
  type ResizeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ProjectMapGeometry } from "../../../shared/project-types";
import {
  PROJECT_REFERENCE_DRAG_MIME,
  readProjectReferenceDragPayload,
  type ProjectPendingReferencePlacement,
  type ProjectReferenceDragPayload,
} from "../../lib/project-reference-placement";
import {
  projectGeometryEquals,
  type ProjectGeometryCommand,
  type ProjectNodeDescriptor,
} from "../../lib/project-map-model";
import "./project-map-surface.css";

type ProjectFlowNodeData = {
  descriptor: ProjectNodeDescriptor;
  pendingReference: ProjectPendingReferencePlacement | null;
  onResizeStart: (descriptor: ProjectNodeDescriptor, params: ResizeParams) => void;
  onResizeEnd: (descriptor: ProjectNodeDescriptor, params: ResizeParams) => void;
};

type ProjectFlowNode = Node<ProjectFlowNodeData, "projectItem">;

export interface ProjectMapSurfaceHandle {
  getViewportCenter: () => { x: number; y: number } | null;
}

export interface ProjectMapSurfaceProps {
  nodes: ProjectNodeDescriptor[];
  pendingReference?: ProjectPendingReferencePlacement | null;
  selectedItemId: string | null;
  onSelect: (itemId: string | null) => void;
  onGeometryCommit: (command: ProjectGeometryCommand) => void;
  onReferenceDrop?: (
    payload: ProjectReferenceDragPayload,
    point: { x: number; y: number },
  ) => void;
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
  const { descriptor, pendingReference } = data;
  if (pendingReference) {
    return <article className={`project-map-node project-map-node-reference pending ${pendingReference.status}`}>
      <header>
        <span>reference</span>
        <small>{pendingReference.status === "placing"
          ? "Placing…"
          : pendingReference.status === "conflict"
            ? "Conflict"
            : "Retry required"}</small>
      </header>
      <h2>{pendingReference.preview.title}</h2>
      {pendingReference.preview.subtitle && <p className="project-node-subtitle">{pendingReference.preview.subtitle}</p>}
      {pendingReference.message && <p className="project-node-excerpt">{pendingReference.message}</p>}
    </article>;
  }

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
    {descriptor.openReferenceUrl && <a
      className="project-node-open-reference nodrag nopan"
      href={descriptor.openReferenceUrl}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >Open reference</a>}
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
    data: { descriptor, pendingReference: null, onResizeStart, onResizeEnd },
    draggable: true,
    selectable: true,
    connectable: false,
    deletable: false,
    focusable: true,
    ariaLabel: `${descriptor.kind}: ${descriptor.title}`,
  };
}

function buildPendingFlowNode(
  pendingReference: ProjectPendingReferencePlacement,
  onResizeStart: ProjectFlowNodeData["onResizeStart"],
  onResizeEnd: ProjectFlowNodeData["onResizeEnd"],
): ProjectFlowNode {
  const descriptor: ProjectNodeDescriptor = {
    itemId: pendingReference.localId,
    placementId: pendingReference.localId,
    kind: "reference",
    title: pendingReference.preview.title,
    subtitle: pendingReference.preview.subtitle,
    excerpt: pendingReference.preview.excerpt,
    geometry: pendingReference.geometry,
    createdSequence: 0,
    fileUrl: null,
    openReferenceUrl: null,
  };
  return {
    id: pendingReference.localId,
    type: "projectItem",
    position: { x: descriptor.geometry.x, y: descriptor.geometry.y },
    width: descriptor.geometry.width,
    height: descriptor.geometry.height,
    style: {
      width: descriptor.geometry.width,
      height: descriptor.geometry.height,
      zIndex: descriptor.geometry.zIndex,
    },
    data: { descriptor, pendingReference, onResizeStart, onResizeEnd },
    draggable: false,
    selectable: false,
    connectable: false,
    deletable: false,
    focusable: false,
    ariaLabel: `Pending reference: ${descriptor.title}`,
  };
}

export const ProjectMapSurface = forwardRef<ProjectMapSurfaceHandle, ProjectMapSurfaceProps>(function ProjectMapSurface({
  nodes: descriptors,
  pendingReference = null,
  selectedItemId,
  onSelect,
  onGeometryCommit,
  onReferenceDrop,
}, ref) {
  const interactionStarts = useMemo(() => new Map<string, ProjectMapGeometry>(), []);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const flowInstanceRef = useRef<ReactFlowInstance<ProjectFlowNode> | null>(null);

  const handleResizeStart = useCallback((descriptor: ProjectNodeDescriptor, params: ResizeParams) => {
    interactionStarts.set(descriptor.placementId, geometryFromResize(descriptor, params));
  }, [interactionStarts]);

  const handleResizeEnd = useCallback((descriptor: ProjectNodeDescriptor, params: ResizeParams) => {
    const after = geometryFromResize(descriptor, params);
    const before = interactionStarts.get(descriptor.placementId) ?? descriptor.geometry;
    interactionStarts.delete(descriptor.placementId);
    onGeometryCommit({ placementId: descriptor.placementId, before, after });
  }, [interactionStarts, onGeometryCommit]);

  const projectedNodes = useMemo(() => {
    const active = descriptors.map((descriptor) => buildFlowNode(
      descriptor,
      handleResizeStart,
      handleResizeEnd,
    ));
    return pendingReference
      ? [...active, buildPendingFlowNode(pendingReference, handleResizeStart, handleResizeEnd)]
      : active;
  }, [descriptors, handleResizeEnd, handleResizeStart, pendingReference]);
  const [flowNodes, setFlowNodes] = useState<ProjectFlowNode[]>(projectedNodes);
  const flowNodesRef = useRef<ProjectFlowNode[]>(projectedNodes);

  useEffect(() => {
    setFlowNodes((current) => {
      const next = projectedNodes.map((projected) => ({
        ...projected,
        selected: projected.data.pendingReference
          ? false
          : current.find((candidate) => candidate.id === projected.id)?.selected ?? false,
      }));
      flowNodesRef.current = next;
      return next;
    });
  }, [projectedNodes]);

  useEffect(() => {
    setFlowNodes((current) => {
      const selectionChanged = current.some((node) => (
        !node.data.pendingReference && node.selected !== (node.id === selectedItemId)
      ));
      if (!selectionChanged) return current;
      const next = current.map((node) => ({
        ...node,
        selected: !node.data.pendingReference && node.id === selectedItemId,
      }));
      flowNodesRef.current = next;
      return next;
    });
  }, [selectedItemId]);

  const flowPointFromClient = useCallback((clientX: number, clientY: number) => {
    const instance = flowInstanceRef.current;
    if (!instance) return null;
    return instance.screenToFlowPosition({ x: clientX, y: clientY });
  }, []);

  useImperativeHandle(ref, () => ({
    getViewportCenter() {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return null;
      return flowPointFromClient(rect.left + rect.width / 2, rect.top + rect.height / 2);
    },
  }), [flowPointFromClient]);

  const onNodesChange = useCallback((changes: NodeChange<ProjectFlowNode>[]) => {
    const current = flowNodesRef.current;
    const next = applyNodeChanges(changes, current);
    flowNodesRef.current = next;
    setFlowNodes(next);

    for (const change of changes) {
      if (change.type !== "position" || change.dragging || !change.position) continue;
      const beforeNode = current.find((candidate) => candidate.id === change.id);
      const afterNode = next.find((candidate) => candidate.id === change.id);
      if (!beforeNode || !afterNode || afterNode.data.pendingReference) continue;
      const placementId = afterNode.data.descriptor.placementId;
      if (interactionStarts.has(placementId)) continue;
      const before = nodeGeometry(beforeNode);
      const after = nodeGeometry(afterNode);
      if (projectGeometryEquals(before, after)) continue;
      onGeometryCommit({ placementId, before, after });
    }
  }, [interactionStarts, onGeometryCommit]);

  const handleNodeClick = useCallback<NodeMouseHandler<ProjectFlowNode>>((_event, node) => {
    if (!node.data.pendingReference) onSelect(node.id);
  }, [onSelect]);
  const handlePaneClick = useCallback(() => onSelect(null), [onSelect]);
  const handleSelectionChange = useCallback<OnSelectionChangeFunc<ProjectFlowNode>>(({ nodes }) => {
    const selected = [...nodes].reverse().find((node) => !node.data.pendingReference);
    onSelect(selected?.id ?? null);
  }, [onSelect]);
  const handleNodeDragStart = useCallback<OnNodeDrag<ProjectFlowNode>>((_event, node) => {
    if (node.data.pendingReference) return;
    interactionStarts.set(node.data.descriptor.placementId, nodeGeometry(node));
  }, [interactionStarts]);
  const handleNodeDragStop = useCallback<OnNodeDrag<ProjectFlowNode>>((_event, node) => {
    if (node.data.pendingReference) return;
    const placementId = node.data.descriptor.placementId;
    const before = interactionStarts.get(placementId) ?? node.data.descriptor.geometry;
    interactionStarts.delete(placementId);
    onGeometryCommit({ placementId, before, after: nodeGeometry(node) });
  }, [interactionStarts, onGeometryCommit]);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const types = Array.from(event.dataTransfer.types ?? []);
    if (!types.includes(PROJECT_REFERENCE_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const payload = readProjectReferenceDragPayload(event.dataTransfer);
    if (!payload || !onReferenceDrop) return;
    const point = flowPointFromClient(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    onReferenceDrop(payload, point);
  }, [flowPointFromClient, onReferenceDrop]);

  return <div
    ref={canvasRef}
    className="project-flow-canvas"
    data-testid="project-flow-canvas"
    onDragOver={handleDragOver}
    onDrop={handleDrop}
  >
    <ReactFlow<ProjectFlowNode>
      nodes={flowNodes}
      edges={PROJECT_EDGES}
      nodeTypes={PROJECT_NODE_TYPES}
      onInit={(instance) => { flowInstanceRef.current = instance; }}
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
});
