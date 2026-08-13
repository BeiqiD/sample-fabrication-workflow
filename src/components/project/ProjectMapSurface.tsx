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
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  NodeResizer,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
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
import type { ProjectEdgeRecord } from "../../../shared/project-api";
import type { ProjectEdgeHandle, ProjectMapGeometry } from "../../../shared/project-types";
import type { ProjectPendingEdgePreview } from "../../lib/project-edges";
import {
  projectAttachmentCanPreviewImage,
  type ProjectMapMarkdownEditorState,
  type ProjectPendingAttachmentPlacement,
} from "../../lib/project-owned-content";
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
  pendingAttachment: ProjectPendingAttachmentPlacement | null;
  markdownEditor: ProjectMapMarkdownEditorState | null;
  geometryInteractionDisabled: boolean;
  onResizeStart: (descriptor: ProjectNodeDescriptor, params: ResizeParams) => void;
  onResizeEnd: (descriptor: ProjectNodeDescriptor, params: ResizeParams) => void;
  onMarkdownEditRequest: (itemId: string) => void;
  onMarkdownChange: (value: string) => void;
  onMarkdownSave: () => void;
  onMarkdownCancel: () => void;
};

type ProjectFlowNode = Node<ProjectFlowNodeData, "projectItem">;
type ProjectFlowEdge = Edge;

export interface ProjectMapSurfaceHandle {
  getViewportCenter: () => { x: number; y: number } | null;
}

export interface ProjectMapSurfaceProps {
  nodes: ProjectNodeDescriptor[];
  edges?: ProjectEdgeRecord[];
  pendingEdge?: ProjectPendingEdgePreview | null;
  pendingReference?: ProjectPendingReferencePlacement | null;
  pendingAttachment?: ProjectPendingAttachmentPlacement | null;
  markdownEditor?: ProjectMapMarkdownEditorState | null;
  selectedItemId: string | null;
  selectedEdgeId?: string | null;
  geometryInteractionDisabled?: boolean;
  onSelect: (itemId: string | null) => void;
  onEdgeSelect?: (edgeId: string | null) => void;
  onEdgeConnect?: (connection: {
    sourceItemId: string;
    targetItemId: string;
    sourceHandle: ProjectEdgeHandle;
    targetHandle: ProjectEdgeHandle;
  }) => void;
  onGeometryCommit: (command: ProjectGeometryCommand) => void;
  onReferenceDrop?: (
    payload: ProjectReferenceDragPayload,
    point: { x: number; y: number },
  ) => void;
  onMarkdownCreateRequest?: (point: { x: number; y: number }) => void;
  onMarkdownEditRequest?: (itemId: string) => void;
  onMarkdownChange?: (value: string) => void;
  onMarkdownSave?: () => void;
  onMarkdownCancel?: () => void;
  onAttachmentRequest?: (point: { x: number; y: number }) => void;
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

function pendingLabel(status: string) {
  if (status === "uploading") return "Uploading…";
  if (status === "saving") return "Saving…";
  if (status === "uncertain") return "Outcome uncertain";
  if (status === "conflict") return "Conflict";
  if (status === "error") return "Action failed";
  return status;
}

function ProjectItemNode({ data, selected }: NodeProps<ProjectFlowNode>) {
  const {
    descriptor,
    pendingReference,
    pendingAttachment,
    markdownEditor,
    geometryInteractionDisabled,
  } = data;
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null);
  const previewUrl = descriptor.kind === "attachment"
    && descriptor.fileUrl
    && projectAttachmentCanPreviewImage(descriptor.mimeType)
    && failedPreviewUrl !== descriptor.fileUrl
    ? descriptor.fileUrl
    : null;
  if (pendingReference) {
    return <article className={`project-map-node project-map-node-reference pending ${pendingReference.status}`}>
      <header>
        <span>reference</span>
        <small>{pendingReference.status === "placing"
          ? "Placing…"
          : pendingReference.status === "reconciling"
            ? "Reconciling…"
            : pendingReference.status === "uncertain"
              ? "Outcome uncertain"
              : pendingReference.status === "conflict"
                ? "Conflict"
                : "Retry required"}</small>
      </header>
      <h2>{pendingReference.preview.title}</h2>
      {pendingReference.preview.subtitle && <p className="project-node-subtitle">{pendingReference.preview.subtitle}</p>}
      {pendingReference.message && <p className="project-node-excerpt">{pendingReference.message}</p>}
    </article>;
  }

  if (pendingAttachment) {
    return <article className={`project-map-node project-map-node-attachment pending ${pendingAttachment.status}`}>
      <header><span>attachment</span><small>{pendingLabel(pendingAttachment.status)}</small></header>
      <h2>{pendingAttachment.filename}</h2>
      <p className="project-node-subtitle">{pendingAttachment.mimeType || "File"}</p>
      {pendingAttachment.message && <p className="project-node-excerpt">{pendingAttachment.message}</p>}
    </article>;
  }

  const editing = Boolean(markdownEditor);
  return <article
    className={`project-map-node project-map-node-${descriptor.kind}${editing ? " editing" : ""}`}
    onDoubleClick={(event) => {
      if (descriptor.kind !== "markdown" || editing) return;
      event.stopPropagation();
      data.onMarkdownEditRequest(descriptor.itemId);
    }}
  >
    <Handle type="source" id="top" position={Position.Top} className="project-edge-handle nodrag nopan" isConnectable={!geometryInteractionDisabled && !editing} />
    <Handle type="source" id="right" position={Position.Right} className="project-edge-handle nodrag nopan" isConnectable={!geometryInteractionDisabled && !editing} />
    <Handle type="source" id="bottom" position={Position.Bottom} className="project-edge-handle nodrag nopan" isConnectable={!geometryInteractionDisabled && !editing} />
    <Handle type="source" id="left" position={Position.Left} className="project-edge-handle nodrag nopan" isConnectable={!geometryInteractionDisabled && !editing} />
    <NodeResizer
      isVisible={selected && !geometryInteractionDisabled && !editing}
      minWidth={180}
      minHeight={110}
      maxWidth={1_200}
      maxHeight={1_000}
      lineClassName="project-node-resize-line nodrag nopan"
      handleClassName="project-node-resize-handle nodrag nopan"
      onResizeStart={(_event, params) => {
        if (!geometryInteractionDisabled && !editing) data.onResizeStart(descriptor, params);
      }}
      onResizeEnd={(_event, params) => {
        if (!geometryInteractionDisabled && !editing) data.onResizeEnd(descriptor, params);
      }}
    />
    <header>
      <span>{descriptor.kind}</span>
      <small>{markdownEditor?.isNew ? "draft" : `#${descriptor.createdSequence}`}</small>
    </header>
    {markdownEditor ? <div className="project-markdown-editor nodrag nopan">
      <textarea
        autoFocus
        aria-label={markdownEditor.isNew ? "New Project Markdown" : "Edit Project Markdown"}
        value={markdownEditor.value}
        disabled={markdownEditor.status !== "editing"}
        onChange={(event) => data.onMarkdownChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          if (markdownEditor.isNew && !markdownEditor.value.trim()) data.onMarkdownCancel();
        }}
      />
      {markdownEditor.message && <p className={`project-markdown-editor-message ${markdownEditor.status}`}>{markdownEditor.message}</p>}
      <div className="project-markdown-editor-actions">
        {markdownEditor.status !== "error" && markdownEditor.status !== "conflict" && <button type="button" className="button primary compact-button" disabled={markdownEditor.status === "saving" || !markdownEditor.value.trim()} onClick={data.onMarkdownSave}>
          {markdownEditor.status === "saving" ? "Saving…" : markdownEditor.status === "uncertain" ? "Retry exact save" : "Save Markdown"}
        </button>}
        {(markdownEditor.status === "editing" || markdownEditor.status === "error" || markdownEditor.status === "conflict") && <button type="button" className="button compact-button" onClick={data.onMarkdownCancel}>Cancel</button>}
      </div>
    </div> : <>
      <h2>{descriptor.title}</h2>
      {descriptor.subtitle && <p className="project-node-subtitle">{descriptor.subtitle}</p>}
      {previewUrl && <img
        className="project-node-image"
        src={previewUrl}
        alt={descriptor.attachmentCaption || descriptor.title}
        onError={() => setFailedPreviewUrl(previewUrl)}
      />}
      {descriptor.kind === "attachment" && descriptor.fileUrl && !previewUrl && <a
        className="project-node-open-reference nodrag nopan"
        href={descriptor.fileUrl}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >Open attachment</a>}
      {descriptor.excerpt && <p className="project-node-excerpt">{descriptor.excerpt}</p>}
      {descriptor.openReferenceUrl && <a
        className="project-node-open-reference nodrag nopan"
        href={descriptor.openReferenceUrl}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >Open reference</a>}
    </>}
  </article>;
}

const PROJECT_NODE_TYPES = { projectItem: ProjectItemNode } as const;
const PROJECT_FIT_VIEW_OPTIONS = { padding: 0.22, maxZoom: 1 } as const;
const PROJECT_PRO_OPTIONS = { hideAttribution: true } as const;
const NOOP_MARKDOWN_EDIT = (_itemId: string) => undefined;
const NOOP_MARKDOWN_CHANGE = (_value: string) => undefined;
const NOOP_ACTION = () => undefined;
const NOOP_EDGE_SELECT = (_edgeId: string | null) => undefined;

function isProjectEdgeHandle(value: string | null | undefined): value is ProjectEdgeHandle {
  return value === "top" || value === "right" || value === "bottom" || value === "left";
}

function projectFlowMarker(marker: "none" | "arrow") {
  return marker === "arrow" ? { type: MarkerType.ArrowClosed } : undefined;
}

function buildFlowEdge(edge: ProjectEdgeRecord, selected: boolean): ProjectFlowEdge {
  return {
    id: edge.id,
    source: edge.sourceItemId,
    target: edge.targetItemId,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    type: "default",
    label: edge.label ?? undefined,
    markerStart: projectFlowMarker(edge.markerStart),
    markerEnd: projectFlowMarker(edge.markerEnd),
    selected,
    selectable: true,
    deletable: false,
  };
}

function buildPendingFlowEdge(edge: ProjectPendingEdgePreview): ProjectFlowEdge {
  return {
    id: edge.edgeId,
    source: edge.sourceItemId,
    target: edge.targetItemId,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    type: "default",
    label: edge.label ?? undefined,
    markerStart: projectFlowMarker(edge.markerStart),
    markerEnd: projectFlowMarker(edge.markerEnd),
    selectable: false,
    deletable: false,
    animated: edge.status === "saving",
    className: `project-edge-pending ${edge.status}`,
  };
}

function emptyDescriptor(
  itemId: string,
  placementId: string,
  kind: ProjectNodeDescriptor["kind"],
  title: string,
  geometry: ProjectMapGeometry,
): ProjectNodeDescriptor {
  return {
    itemId,
    placementId,
    kind,
    title,
    subtitle: null,
    excerpt: null,
    geometry,
    createdSequence: 0,
    contentId: null,
    markdownSource: null,
    attachmentCaption: null,
    attachmentSourceUrl: null,
    mimeType: null,
    fileUrl: null,
    openReferenceUrl: null,
  };
}

function buildFlowNode(
  descriptor: ProjectNodeDescriptor,
  geometryInteractionDisabled: boolean,
  markdownEditor: ProjectMapMarkdownEditorState | null,
  callbacks: Pick<ProjectFlowNodeData, "onResizeStart" | "onResizeEnd" | "onMarkdownEditRequest" | "onMarkdownChange" | "onMarkdownSave" | "onMarkdownCancel">,
): ProjectFlowNode {
  const editing = Boolean(markdownEditor);
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
    data: {
      descriptor,
      pendingReference: null,
      pendingAttachment: null,
      markdownEditor,
      geometryInteractionDisabled,
      ...callbacks,
    },
    draggable: !geometryInteractionDisabled && !editing,
    selectable: true,
    connectable: false,
    deletable: false,
    focusable: !geometryInteractionDisabled,
    ariaLabel: `${descriptor.kind}: ${descriptor.title}`,
  };
}

function buildPendingReferenceFlowNode(
  pendingReference: ProjectPendingReferencePlacement,
  callbacks: Pick<ProjectFlowNodeData, "onResizeStart" | "onResizeEnd" | "onMarkdownEditRequest" | "onMarkdownChange" | "onMarkdownSave" | "onMarkdownCancel">,
): ProjectFlowNode {
  const descriptor = emptyDescriptor(
    pendingReference.localId,
    pendingReference.localId,
    "reference",
    pendingReference.preview.title,
    pendingReference.geometry,
  );
  return {
    ...buildFlowNode(descriptor, true, null, callbacks),
    data: {
      ...buildFlowNode(descriptor, true, null, callbacks).data,
      pendingReference,
    },
    selectable: false,
    focusable: false,
  };
}

function buildPendingAttachmentFlowNode(
  pendingAttachment: ProjectPendingAttachmentPlacement,
  callbacks: Pick<ProjectFlowNodeData, "onResizeStart" | "onResizeEnd" | "onMarkdownEditRequest" | "onMarkdownChange" | "onMarkdownSave" | "onMarkdownCancel">,
): ProjectFlowNode {
  const descriptor = emptyDescriptor(
    pendingAttachment.localId,
    pendingAttachment.localId,
    "attachment",
    pendingAttachment.filename,
    pendingAttachment.geometry,
  );
  return {
    ...buildFlowNode(descriptor, true, null, callbacks),
    data: {
      ...buildFlowNode(descriptor, true, null, callbacks).data,
      pendingAttachment,
    },
    selectable: false,
    focusable: false,
  };
}

function buildMarkdownDraftFlowNode(
  editor: ProjectMapMarkdownEditorState,
  callbacks: Pick<ProjectFlowNodeData, "onResizeStart" | "onResizeEnd" | "onMarkdownEditRequest" | "onMarkdownChange" | "onMarkdownSave" | "onMarkdownCancel">,
): ProjectFlowNode | null {
  if (!editor.isNew || !editor.geometry) return null;
  const descriptor = emptyDescriptor(editor.itemId, editor.itemId, "markdown", "New Markdown", editor.geometry);
  return {
    ...buildFlowNode(descriptor, true, editor, callbacks),
    selectable: true,
  };
}

export const ProjectMapSurface = forwardRef<ProjectMapSurfaceHandle, ProjectMapSurfaceProps>(function ProjectMapSurface({
  nodes: descriptors,
  edges = [],
  pendingEdge = null,
  pendingReference = null,
  pendingAttachment = null,
  markdownEditor = null,
  selectedItemId,
  selectedEdgeId = null,
  geometryInteractionDisabled = false,
  onSelect,
  onEdgeSelect = NOOP_EDGE_SELECT,
  onEdgeConnect,
  onGeometryCommit,
  onReferenceDrop,
  onMarkdownCreateRequest,
  onMarkdownEditRequest = NOOP_MARKDOWN_EDIT,
  onMarkdownChange = NOOP_MARKDOWN_CHANGE,
  onMarkdownSave = NOOP_ACTION,
  onMarkdownCancel = NOOP_ACTION,
  onAttachmentRequest,
}, ref) {
  const interactionStarts = useMemo(() => new Map<string, ProjectMapGeometry>(), []);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const flowInstanceRef = useRef<ReactFlowInstance<ProjectFlowNode> | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    left: number;
    top: number;
    point: { x: number; y: number };
  } | null>(null);

  const handleResizeStart = useCallback((descriptor: ProjectNodeDescriptor, params: ResizeParams) => {
    if (geometryInteractionDisabled) return;
    interactionStarts.set(descriptor.placementId, geometryFromResize(descriptor, params));
  }, [geometryInteractionDisabled, interactionStarts]);

  const handleResizeEnd = useCallback((descriptor: ProjectNodeDescriptor, params: ResizeParams) => {
    if (geometryInteractionDisabled) return;
    const after = geometryFromResize(descriptor, params);
    const before = interactionStarts.get(descriptor.placementId) ?? descriptor.geometry;
    interactionStarts.delete(descriptor.placementId);
    onGeometryCommit({ placementId: descriptor.placementId, before, after });
  }, [geometryInteractionDisabled, interactionStarts, onGeometryCommit]);

  const callbacks = useMemo(() => ({
    onResizeStart: handleResizeStart,
    onResizeEnd: handleResizeEnd,
    onMarkdownEditRequest,
    onMarkdownChange,
    onMarkdownSave,
    onMarkdownCancel,
  }), [handleResizeEnd, handleResizeStart, onMarkdownCancel, onMarkdownChange, onMarkdownEditRequest, onMarkdownSave]);

  const projectedNodes = useMemo(() => {
    const active = descriptors.map((descriptor) => buildFlowNode(
      descriptor,
      geometryInteractionDisabled,
      markdownEditor?.itemId === descriptor.itemId ? markdownEditor : null,
      callbacks,
    ));
    const draft = markdownEditor ? buildMarkdownDraftFlowNode(markdownEditor, callbacks) : null;
    if (draft) active.push(draft);
    if (pendingReference) active.push(buildPendingReferenceFlowNode(pendingReference, callbacks));
    if (pendingAttachment) active.push(buildPendingAttachmentFlowNode(pendingAttachment, callbacks));
    return active;
  }, [callbacks, descriptors, geometryInteractionDisabled, markdownEditor, pendingAttachment, pendingReference]);
  const [flowNodes, setFlowNodes] = useState<ProjectFlowNode[]>(projectedNodes);
  const flowNodesRef = useRef<ProjectFlowNode[]>(projectedNodes);
  const projectedEdges = useMemo(() => {
    const active = edges.map((edge) => buildFlowEdge(edge, edge.id === selectedEdgeId));
    if (pendingEdge && !active.some((edge) => edge.id === pendingEdge.edgeId)) active.push(buildPendingFlowEdge(pendingEdge));
    return active;
  }, [edges, pendingEdge, selectedEdgeId]);

  useEffect(() => {
    setFlowNodes((current) => {
      const next = projectedNodes.map((projected) => ({
        ...projected,
        selected: projected.data.pendingReference || projected.data.pendingAttachment
          ? false
          : current.find((candidate) => candidate.id === projected.id)?.selected ?? projected.id === selectedItemId,
      }));
      flowNodesRef.current = next;
      return next;
    });
  }, [projectedNodes, selectedItemId]);

  useEffect(() => {
    setFlowNodes((current) => {
      const selectionChanged = current.some((node) => (
        !node.data.pendingReference && !node.data.pendingAttachment && node.selected !== (node.id === selectedItemId)
      ));
      if (!selectionChanged) return current;
      const next = current.map((node) => ({
        ...node,
        selected: !node.data.pendingReference && !node.data.pendingAttachment && node.id === selectedItemId,
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
    const effectiveChanges = geometryInteractionDisabled
      ? changes.filter((change) => change.type !== "position")
      : changes;
    const current = flowNodesRef.current;
    const next = applyNodeChanges(effectiveChanges, current);
    flowNodesRef.current = next;
    setFlowNodes(next);

    if (geometryInteractionDisabled) return;
    for (const change of effectiveChanges) {
      if (change.type !== "position" || change.dragging || !change.position) continue;
      const beforeNode = current.find((candidate) => candidate.id === change.id);
      const afterNode = next.find((candidate) => candidate.id === change.id);
      if (!beforeNode || !afterNode || afterNode.data.pendingReference || afterNode.data.pendingAttachment || afterNode.data.markdownEditor) continue;
      const placementId = afterNode.data.descriptor.placementId;
      if (interactionStarts.has(placementId)) continue;
      const before = nodeGeometry(beforeNode);
      const after = nodeGeometry(afterNode);
      if (projectGeometryEquals(before, after)) continue;
      onGeometryCommit({ placementId, before, after });
    }
  }, [geometryInteractionDisabled, interactionStarts, onGeometryCommit]);

  const handleNodeClick = useCallback<NodeMouseHandler<ProjectFlowNode>>((_event, node) => {
    if (!node.data.pendingReference && !node.data.pendingAttachment) {
      onSelect(node.id);
      onEdgeSelect(null);
    }
    setContextMenu(null);
  }, [onEdgeSelect, onSelect]);
  const handleEdgeClick = useCallback((_event: React.MouseEvent, edge: ProjectFlowEdge) => {
    if (pendingEdge?.edgeId === edge.id) return;
    onEdgeSelect(edge.id);
    onSelect(null);
    setContextMenu(null);
  }, [onEdgeSelect, onSelect, pendingEdge]);
  const handlePaneClick = useCallback(() => {
    onSelect(null);
    onEdgeSelect(null);
    setContextMenu(null);
  }, [onEdgeSelect, onSelect]);
  const handleSelectionChange = useCallback<OnSelectionChangeFunc<ProjectFlowNode>>(({ nodes }) => {
    const selected = [...nodes].reverse().find((node) => !node.data.pendingReference && !node.data.pendingAttachment);
    if (selected) {
      onSelect(selected.id);
      onEdgeSelect(null);
    }
  }, [onEdgeSelect, onSelect]);
  const handleConnect = useCallback((connection: Connection) => {
    if (geometryInteractionDisabled || !onEdgeConnect || !connection.source || !connection.target
      || !isProjectEdgeHandle(connection.sourceHandle) || !isProjectEdgeHandle(connection.targetHandle)) return;
    onEdgeConnect({
      sourceItemId: connection.source,
      targetItemId: connection.target,
      sourceHandle: connection.sourceHandle,
      targetHandle: connection.targetHandle,
    });
  }, [geometryInteractionDisabled, onEdgeConnect]);
  const handleNodeDragStart = useCallback<OnNodeDrag<ProjectFlowNode>>((_event, node) => {
    if (geometryInteractionDisabled || node.data.pendingReference || node.data.pendingAttachment || node.data.markdownEditor) return;
    interactionStarts.set(node.data.descriptor.placementId, nodeGeometry(node));
  }, [geometryInteractionDisabled, interactionStarts]);
  const handleNodeDragStop = useCallback<OnNodeDrag<ProjectFlowNode>>((_event, node) => {
    if (geometryInteractionDisabled || node.data.pendingReference || node.data.pendingAttachment || node.data.markdownEditor) return;
    const placementId = node.data.descriptor.placementId;
    const before = interactionStarts.get(placementId) ?? node.data.descriptor.geometry;
    interactionStarts.delete(placementId);
    onGeometryCommit({ placementId, before, after: nodeGeometry(node) });
  }, [geometryInteractionDisabled, interactionStarts, onGeometryCommit]);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (geometryInteractionDisabled) return;
    const types = Array.from(event.dataTransfer.types ?? []);
    if (!types.includes(PROJECT_REFERENCE_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, [geometryInteractionDisabled]);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (geometryInteractionDisabled) return;
    const payload = readProjectReferenceDragPayload(event.dataTransfer);
    if (!payload || !onReferenceDrop) return;
    const point = flowPointFromClient(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    onReferenceDrop(payload, point);
  }, [flowPointFromClient, geometryInteractionDisabled, onReferenceDrop]);

  const handleDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (geometryInteractionDisabled || !onMarkdownCreateRequest) return;
    const target = event.target as HTMLElement;
    if (!target.classList.contains("react-flow__pane")) return;
    const point = flowPointFromClient(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    onMarkdownCreateRequest(point);
  }, [flowPointFromClient, geometryInteractionDisabled, onMarkdownCreateRequest]);

  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (geometryInteractionDisabled || !onAttachmentRequest) return;
    const target = event.target as HTMLElement;
    if (!target.classList.contains("react-flow__pane")) return;
    const point = flowPointFromClient(event.clientX, event.clientY);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!point || !rect) return;
    event.preventDefault();
    setContextMenu({
      left: Math.max(8, Math.min(rect.width - 180, event.clientX - rect.left)),
      top: Math.max(8, Math.min(rect.height - 58, event.clientY - rect.top)),
      point,
    });
  }, [flowPointFromClient, geometryInteractionDisabled, onAttachmentRequest]);

  return <div
    ref={canvasRef}
    className="project-flow-canvas"
    data-testid="project-flow-canvas"
    onDoubleClick={handleDoubleClick}
    onContextMenu={handleContextMenu}
    onDragOver={handleDragOver}
    onDrop={handleDrop}
  >
    <ReactFlow<ProjectFlowNode, ProjectFlowEdge>
      nodes={flowNodes}
      edges={projectedEdges}
      nodeTypes={PROJECT_NODE_TYPES}
      onInit={(instance) => { flowInstanceRef.current = instance; }}
      onNodesChange={onNodesChange}
      onNodeClick={handleNodeClick}
      onEdgeClick={handleEdgeClick}
      onConnect={handleConnect}
      onSelectionChange={handleSelectionChange}
      onPaneClick={handlePaneClick}
      onNodeDragStart={handleNodeDragStart}
      onNodeDragStop={handleNodeDragStop}
      nodesDraggable={!geometryInteractionDisabled}
      nodesConnectable={!geometryInteractionDisabled}
      edgesReconnectable={false}
      connectionMode={ConnectionMode.Loose}
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
    {contextMenu && <div className="project-map-context-menu" style={{ left: contextMenu.left, top: contextMenu.top }} role="menu">
      <button type="button" role="menuitem" onClick={() => {
        const point = contextMenu.point;
        setContextMenu(null);
        onAttachmentRequest?.(point);
      }}>Add attachment here</button>
    </div>}
  </div>;
});
