import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  NodeResizer,
  Position,
  ReactFlow,
  SelectionMode,
  ViewportPortal,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node as ReactFlowNode,
  type NodeChange,
  type NodeProps,
  type OnMove,
  type OnNodeDrag,
  type ReactFlowInstance,
  type ResizeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ProjectEdgeRecord } from "../../../shared/project-api";
import type { ProjectEdgeHandle, ProjectMapGeometry } from "../../../shared/project-types";
import { projectEdgeDirection, type ProjectPendingEdgePreview } from "../../lib/project-edges";
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
  normalizeProjectGeometryCommands,
  projectGeometryEquals,
  projectNodeKindLabel,
  type ProjectGeometryCommand,
  type ProjectNodeDescriptor,
} from "../../lib/project-map-model";
import { projectMarkdownSafeHref, projectMarkdownSafeImageSrc } from "../../lib/project-markdown";
import {
  projectMapDetailLevelForZoom,
  projectMapPerformancePolicy,
  type ProjectMapDetailLevel,
} from "../../lib/project-map-performance";
import { ProjectEditorFeedback } from "./ProjectEditorFeedback";
import {
  normalizeProjectItemSelection,
  PROJECT_CANVAS_GUIDE_COORDINATE_LIMIT,
  projectCanvasAlignmentGuides,
  projectCanvasKeyboardShortcutFromEvent,
  type ProjectCanvasAlignment,
  type ProjectCanvasAlignmentGuides,
  type ProjectCanvasZOrderAction,
  type ProjectItemSelection,
} from "../../lib/project-canvas-productivity";
import "./project-map-surface.css";

type ProjectFlowNodeData = {
  descriptor: ProjectNodeDescriptor;
  pendingReference: ProjectPendingReferencePlacement | null;
  pendingAttachment: ProjectPendingAttachmentPlacement | null;
  markdownEditor: ProjectMapMarkdownEditorState | null;
  geometryInteractionDisabled: boolean;
  edgeInteractionDisabled: boolean;
  primarySelected: boolean;
  detailLevel: ProjectMapDetailLevel;
  onResizeStart: (descriptor: ProjectNodeDescriptor, params: ResizeParams) => void;
  onResizeEnd: (descriptor: ProjectNodeDescriptor, params: ResizeParams) => void;
  onMarkdownEditRequest: (itemId: string) => void;
  onMarkdownChange: (value: string) => void;
  onMarkdownSave: () => void;
  onMarkdownCancel: () => void;
};

type ProjectFlowNode = ReactFlowNode<ProjectFlowNodeData, "projectItem">;
type ProjectFlowEdge = Edge;

export interface ProjectMapSurfaceHandle {
  getViewportCenter: () => { x: number; y: number } | null;
}

export interface ProjectMapContextCommands {
  createDisabled: boolean;
  selectAllDisabled: boolean;
  clearSelectionDisabled: boolean;
  copyDisabled: boolean;
  pasteDisabled: boolean;
  editDisabled: boolean;
  removeDisabled: boolean;
  edgeInspectDisabled: boolean;
  edgeEditDisabled: boolean;
  edgeDeleteDisabled: boolean;
  panelCommandsDisabled: boolean;
  alignmentDisabled: (alignment: ProjectCanvasAlignment) => boolean;
  zOrderDisabled: (action: ProjectCanvasZOrderAction) => boolean;
  inspectItem: (itemId: string) => void;
  editItem: (itemId: string) => void;
  copyItemLink: (itemId: string) => void | Promise<void>;
  copySelection: () => void;
  pasteSelection: () => void;
  selectAll: () => void;
  clearSelection: () => void;
  alignSelection: (alignment: ProjectCanvasAlignment) => void;
  changeZOrder: (action: ProjectCanvasZOrderAction) => void;
  removeItem: (itemId: string) => void;
  inspectEdge: (edgeId: string) => void;
  editEdge: () => void;
  deleteEdge: () => void;
  openReferences: () => void;
  openInspector: () => void;
}

export interface ProjectMapSurfaceProps {
  nodes: ProjectNodeDescriptor[];
  edges?: ProjectEdgeRecord[];
  pendingEdge?: ProjectPendingEdgePreview | null;
  pendingReference?: ProjectPendingReferencePlacement | null;
  pendingAttachment?: ProjectPendingAttachmentPlacement | null;
  markdownEditor?: ProjectMapMarkdownEditorState | null;
  selectedItemId: string | null;
  selectedItemIds?: readonly string[];
  focusedItemId?: string | null;
  selectedEdgeId?: string | null;
  geometryInteractionDisabled?: boolean;
  edgeInteractionDisabled?: boolean;
  onSelect: (itemId: string | null) => boolean | void;
  onSelectionChange?: (selection: ProjectItemSelection) => boolean | void;
  onEdgeSelect?: (edgeId: string | null) => boolean | void;
  onEdgeConnect?: (connection: {
    sourceItemId: string;
    targetItemId: string;
    sourceHandle: ProjectEdgeHandle;
    targetHandle: ProjectEdgeHandle;
  }) => void;
  onGeometryCommit: (command: ProjectGeometryCommand) => void;
  onGeometryBatchCommit?: (commands: ProjectGeometryCommand[]) => void;
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
  contextCommands?: ProjectMapContextCommands;
}

type ProjectMapContextMenu =
  | { target: "pane"; left: number; top: number; point: { x: number; y: number } }
  | { target: "node"; left: number; top: number; itemId: string }
  | { target: "selection"; left: number; top: number; itemId: string }
  | { target: "edge"; left: number; top: number; edgeId: string };

type ProjectMapMenuItem = {
  label: string;
  section: string;
  disabled?: boolean;
  danger?: boolean;
  href?: string;
  action?: () => void | Promise<void>;
};

const PROJECT_CONTEXT_MENU_INTERACTIVE_SELECTOR = [
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[role='textbox']",
].join(",");

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

const ProjectItemNode = memo(function ProjectItemNode({ data, selected }: NodeProps<ProjectFlowNode>) {
  const {
    descriptor,
    pendingReference,
    pendingAttachment,
    markdownEditor,
    geometryInteractionDisabled,
    edgeInteractionDisabled,
  } = data;
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null);
  const editing = Boolean(markdownEditor);
  const detailLevel = editing ? "full" : data.detailLevel;
  const showHeaderMeta = detailLevel !== "overview" || data.primarySelected;
  const showSubtitle = detailLevel !== "overview" || data.primarySelected;
  const showRichContent = detailLevel === "full";
  const showAction = showRichContent || data.primarySelected;
  const showHandles = showRichContent || data.primarySelected;
  const handleClassName = `project-edge-handle nodrag nopan${showHandles ? "" : " contextual-hidden"}`;
  const previewUrl = showRichContent && descriptor.kind === "attachment"
    && descriptor.fileUrl
    && projectAttachmentCanPreviewImage(descriptor.mimeType)
    && failedPreviewUrl !== descriptor.fileUrl
    ? descriptor.fileUrl
    : null;
  if (pendingReference) {
    return <article className={`project-map-node project-map-node-reference pending ${pendingReference.status}`}>
      <header>
        <span>{projectNodeKindLabel("reference")}</span>
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
      <header><span>{projectNodeKindLabel("attachment")}</span><small>{pendingLabel(pendingAttachment.status)}</small></header>
      <h2>{pendingAttachment.filename}</h2>
      <p className="project-node-subtitle">{pendingAttachment.mimeType || "File"}</p>
      {pendingAttachment.message && <p className="project-node-excerpt">{pendingAttachment.message}</p>}
    </article>;
  }

  return <article
    className={`project-map-node project-map-node-${descriptor.kind}${editing ? " editing" : ""}`}
    data-detail-level={detailLevel}
    onDoubleClick={(event) => {
      if (descriptor.kind !== "markdown" || editing) return;
      event.stopPropagation();
      data.onMarkdownEditRequest(descriptor.itemId);
    }}
  >
    <>
      <Handle type="source" id="top" position={Position.Top} className={handleClassName} isConnectable={showHandles && !edgeInteractionDisabled && !editing} />
      <Handle type="source" id="right" position={Position.Right} className={handleClassName} isConnectable={showHandles && !edgeInteractionDisabled && !editing} />
      <Handle type="source" id="bottom" position={Position.Bottom} className={handleClassName} isConnectable={showHandles && !edgeInteractionDisabled && !editing} />
      <Handle type="source" id="left" position={Position.Left} className={handleClassName} isConnectable={showHandles && !edgeInteractionDisabled && !editing} />
    </>
    <NodeResizer
      isVisible={selected && data.primarySelected && !geometryInteractionDisabled && !editing}
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
      <span>{projectNodeKindLabel(descriptor.kind)}</span>
      {showHeaderMeta && <small>{markdownEditor?.isNew ? "draft" : `#${descriptor.createdSequence}`}</small>}
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
      {markdownEditor.message && <ProjectEditorFeedback
        status={markdownEditor.status}
        message={markdownEditor.message}
        className="project-markdown-editor-feedback"
      />}
      <div className="project-markdown-editor-actions">
        {markdownEditor.status !== "error" && markdownEditor.status !== "conflict" && <button type="button" className="button primary compact-button" disabled={markdownEditor.status === "saving" || !markdownEditor.value.trim()} onClick={data.onMarkdownSave}>
          {markdownEditor.status === "saving" ? "Saving…" : markdownEditor.status === "uncertain" ? "Retry exact save" : "Save Markdown"}
        </button>}
        {(markdownEditor.status === "editing" || markdownEditor.status === "error" || markdownEditor.status === "conflict") && <button type="button" className="button compact-button" onClick={data.onMarkdownCancel}>Cancel</button>}
      </div>
    </div> : <>
      <h2>{descriptor.title}</h2>
      {showSubtitle && descriptor.subtitle && <p className="project-node-subtitle">{descriptor.subtitle}</p>}
      {previewUrl && <img
        className="project-node-image"
        src={previewUrl}
        alt={descriptor.attachmentCaption || descriptor.title}
        onError={() => setFailedPreviewUrl(previewUrl)}
      />}
      {showAction && descriptor.kind === "attachment" && descriptor.fileUrl && !previewUrl && <a
        className="project-node-open-reference nodrag nopan"
        href={descriptor.fileUrl}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >Open attachment</a>}
      {showRichContent && descriptor.excerpt && <p className="project-node-excerpt">{descriptor.excerpt}</p>}
      {showAction && descriptor.openReferenceUrl && <a
        className="project-node-open-reference nodrag nopan"
        href={descriptor.openReferenceUrl}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >Open reference</a>}
    </>}
  </article>;
});

const PROJECT_NODE_TYPES = { projectItem: ProjectItemNode } as const;
const PROJECT_FIT_VIEW_OPTIONS = { padding: 0.22, maxZoom: 1 } as const;
const PROJECT_PRO_OPTIONS = { hideAttribution: true } as const;
const NOOP_MARKDOWN_EDIT = (_itemId: string) => undefined;
const NOOP_MARKDOWN_CHANGE = (_value: string) => undefined;
const NOOP_ACTION = () => undefined;
const NOOP_EDGE_SELECT = (_edgeId: string | null) => undefined;
const NO_PROJECT_ALIGNMENT_GUIDES: ProjectCanvasAlignmentGuides = {
  vertical: null,
  horizontal: null,
};

function isProjectEdgeHandle(value: string | null | undefined): value is ProjectEdgeHandle {
  return value === "top" || value === "right" || value === "bottom" || value === "left";
}

function projectFlowMarker(marker: "none" | "arrow", color: string) {
  return marker === "arrow" ? { type: MarkerType.ArrowClosed, color } : undefined;
}

function projectPendingEdgeColor(status: ProjectPendingEdgePreview["status"]) {
  return status === "error" || status === "conflict"
    ? "var(--danger)"
    : "var(--line-strong)";
}

function projectFlowEdgeAriaLabel(edge: ProjectEdgeRecord, sourceLabel: string, targetLabel: string) {
  const label = edge.label ? `; label: ${edge.label}` : "";
  switch (projectEdgeDirection(edge.markerStart, edge.markerEnd)) {
    case "undirected": return `Undirected edge between ${sourceLabel} and ${targetLabel}${label}`;
    case "forward": return `Directed edge from ${sourceLabel} to ${targetLabel}${label}`;
    case "reverse": return `Directed edge from ${targetLabel} to ${sourceLabel}${label}`;
    case "bidirectional": return `Bidirectional edge between ${sourceLabel} and ${targetLabel}${label}`;
  }
}

function buildFlowEdge(
  edge: ProjectEdgeRecord,
  selected: boolean,
  sourceLabel: string,
  targetLabel: string,
  detailLevel: ProjectMapDetailLevel,
): ProjectFlowEdge {
  const markerColor = selected ? "var(--accent)" : "var(--line-strong)";
  return {
    id: edge.id,
    source: edge.sourceItemId,
    target: edge.targetItemId,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    type: "default",
    label: selected || detailLevel === "full" ? edge.label ?? undefined : undefined,
    markerStart: projectFlowMarker(edge.markerStart, markerColor),
    markerEnd: projectFlowMarker(edge.markerEnd, markerColor),
    selected,
    selectable: true,
    deletable: false,
    ariaLabel: projectFlowEdgeAriaLabel(edge, sourceLabel, targetLabel),
  };
}

function buildPendingFlowEdge(edge: ProjectPendingEdgePreview): ProjectFlowEdge {
  const markerColor = projectPendingEdgeColor(edge.status);
  return {
    id: edge.edgeId,
    source: edge.sourceItemId,
    target: edge.targetItemId,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    type: "default",
    label: edge.label ?? undefined,
    markerStart: projectFlowMarker(edge.markerStart, markerColor),
    markerEnd: projectFlowMarker(edge.markerEnd, markerColor),
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
    attachmentByteSize: null,
    fileUrl: null,
    openReferenceUrl: null,
  };
}

function buildFlowNode(
  descriptor: ProjectNodeDescriptor,
  geometryInteractionDisabled: boolean,
  edgeInteractionDisabled: boolean,
  primarySelected: boolean,
  detailLevel: ProjectMapDetailLevel,
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
      edgeInteractionDisabled,
      primarySelected,
      detailLevel,
      ...callbacks,
    },
    draggable: !geometryInteractionDisabled && !editing,
    selectable: true,
    connectable: !edgeInteractionDisabled && !editing,
    deletable: false,
    focusable: !geometryInteractionDisabled,
    ariaLabel: `${projectNodeKindLabel(descriptor.kind)}: ${descriptor.title}`,
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
    ...buildFlowNode(descriptor, true, true, false, "full", null, callbacks),
    data: {
      ...buildFlowNode(descriptor, true, true, false, "full", null, callbacks).data,
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
    ...buildFlowNode(descriptor, true, true, false, "full", null, callbacks),
    data: {
      ...buildFlowNode(descriptor, true, true, false, "full", null, callbacks).data,
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
    ...buildFlowNode(descriptor, true, true, true, "full", editor, callbacks),
    selectable: false,
  };
}

function applyAuthoritativeSelection(
  nodes: ProjectFlowNode[],
  selectedItemIds: readonly string[],
  primaryItemId: string | null,
) {
  const selected = new Set(selectedItemIds);
  return nodes.map((node) => {
    const nextSelected = !node.data.pendingReference
      && !node.data.pendingAttachment
      && selected.has(node.id);
    const nextPrimarySelected = nextSelected && node.id === primaryItemId;
    if (node.selected === nextSelected
      && node.data.primarySelected === nextPrimarySelected) return node;
    return {
      ...node,
      selected: nextSelected,
      data: node.data.primarySelected === nextPrimarySelected
        ? node.data
        : { ...node.data, primarySelected: nextPrimarySelected },
    };
  });
}

export const ProjectMapSurface = forwardRef<ProjectMapSurfaceHandle, ProjectMapSurfaceProps>(function ProjectMapSurface({
  nodes: descriptors,
  edges = [],
  pendingEdge = null,
  pendingReference = null,
  pendingAttachment = null,
  markdownEditor = null,
  selectedItemId,
  selectedItemIds: controlledSelectedItemIds,
  focusedItemId = null,
  selectedEdgeId = null,
  geometryInteractionDisabled = false,
  edgeInteractionDisabled = false,
  onSelect,
  onSelectionChange,
  onEdgeSelect = NOOP_EDGE_SELECT,
  onEdgeConnect,
  onGeometryCommit,
  onGeometryBatchCommit,
  onReferenceDrop,
  onMarkdownCreateRequest,
  onMarkdownEditRequest = NOOP_MARKDOWN_EDIT,
  onMarkdownChange = NOOP_MARKDOWN_CHANGE,
  onMarkdownSave = NOOP_ACTION,
  onMarkdownCancel = NOOP_ACTION,
  onAttachmentRequest,
  contextCommands,
}, ref) {
  const selectedItemIds = useMemo<readonly string[]>(() => (
    controlledSelectedItemIds ?? (selectedItemId ? [selectedItemId] : [])
  ), [controlledSelectedItemIds, selectedItemId]);
  const performancePolicy = useMemo(() => projectMapPerformancePolicy(
    descriptors.length,
    edges.length,
  ), [descriptors.length, edges.length]);
  const [detailLevel, setDetailLevel] = useState<ProjectMapDetailLevel>(
    performancePolicy.initialDetailLevel,
  );
  const performanceScaleRef = useRef(performancePolicy.scale);
  const interactionStarts = useMemo(() => new Map<string, ProjectMapGeometry>(), []);
  const dragStarts = useMemo(() => new Map<string, ProjectMapGeometry>(), []);
  const recentDragCommitsRef = useRef(new Set<string>());
  const recentDragCommitTimerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const flowInstanceRef = useRef<ReactFlowInstance<ProjectFlowNode> | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<ProjectFlowNode> | null>(null);
  const lastFocusedItemIdRef = useRef<string | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = useState<ProjectMapContextMenu | null>(null);
  const closeContextMenu = useCallback((restoreFocus: boolean) => {
    setContextMenu(null);
    if (!restoreFocus) return;
    window.requestAnimationFrame(() => {
      const nextActiveElement = document.activeElement;
      if (!nextActiveElement
        || nextActiveElement === document.body
        || !document.contains(nextActiveElement)) {
        canvasRef.current?.focus();
      }
    });
  }, []);
  const [alignmentGuides, setAlignmentGuides] = useState<ProjectCanvasAlignmentGuides>(
    NO_PROJECT_ALIGNMENT_GUIDES,
  );
  const clearAlignmentGuides = useCallback(() => {
    setAlignmentGuides((current) => (
      current.vertical === null && current.horizontal === null
        ? current
        : NO_PROJECT_ALIGNMENT_GUIDES
    ));
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const frame = window.requestAnimationFrame(() => {
      const menu = contextMenuRef.current;
      const canvas = canvasRef.current;
      if (!menu || !canvas) return;
      const menuRect = menu.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const left = Math.max(8, Math.min(
        contextMenu.left,
        Math.max(8, canvasRect.width - menuRect.width - 8),
      ));
      const top = Math.max(8, Math.min(
        contextMenu.top,
        Math.max(8, canvasRect.height - menuRect.height - 8),
      ));
      if (left !== contextMenu.left || top !== contextMenu.top) {
        setContextMenu((current) => current ? { ...current, left, top } : current);
        return;
      }
      menu.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    });
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOnPointerDown);
    };
  }, [contextMenu]);

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

  // Node data stores these callbacks. Route volatile parent identities through
  // stable dispatchers so selection-only parent renders cannot rebuild the full
  // React Flow node projection.
  const markdownCallbacksRef = useRef({
    onMarkdownEditRequest,
    onMarkdownChange,
    onMarkdownSave,
    onMarkdownCancel,
  });
  markdownCallbacksRef.current = {
    onMarkdownEditRequest,
    onMarkdownChange,
    onMarkdownSave,
    onMarkdownCancel,
  };
  const handleMarkdownEditRequest = useCallback((itemId: string) => {
    markdownCallbacksRef.current.onMarkdownEditRequest(itemId);
  }, []);
  const handleMarkdownChange = useCallback((value: string) => {
    markdownCallbacksRef.current.onMarkdownChange(value);
  }, []);
  const handleMarkdownSave = useCallback(() => {
    markdownCallbacksRef.current.onMarkdownSave();
  }, []);
  const handleMarkdownCancel = useCallback(() => {
    markdownCallbacksRef.current.onMarkdownCancel();
  }, []);

  const callbacks = useMemo(() => ({
    onResizeStart: handleResizeStart,
    onResizeEnd: handleResizeEnd,
    onMarkdownEditRequest: handleMarkdownEditRequest,
    onMarkdownChange: handleMarkdownChange,
    onMarkdownSave: handleMarkdownSave,
    onMarkdownCancel: handleMarkdownCancel,
  }), [
    handleMarkdownCancel,
    handleMarkdownChange,
    handleMarkdownEditRequest,
    handleMarkdownSave,
    handleResizeEnd,
    handleResizeStart,
  ]);

  const projectedNodes = useMemo(() => {
    const active = descriptors.map((descriptor) => buildFlowNode(
      descriptor,
      geometryInteractionDisabled,
      edgeInteractionDisabled,
      false,
      detailLevel,
      markdownEditor?.itemId === descriptor.itemId ? markdownEditor : null,
      callbacks,
    ));
    const draft = markdownEditor ? buildMarkdownDraftFlowNode(markdownEditor, callbacks) : null;
    if (draft) active.push(draft);
    if (pendingReference) active.push(buildPendingReferenceFlowNode(pendingReference, callbacks));
    if (pendingAttachment) active.push(buildPendingAttachmentFlowNode(pendingAttachment, callbacks));
    return active;
  }, [callbacks, descriptors, detailLevel, edgeInteractionDisabled, geometryInteractionDisabled, markdownEditor, pendingAttachment, pendingReference]);
  const [flowNodes, setFlowNodes] = useState<ProjectFlowNode[]>(projectedNodes);
  const flowNodesRef = useRef<ProjectFlowNode[]>(projectedNodes);
  const selectedItemIdRef = useRef(selectedItemId);
  const selectedItemIdsRef = useRef<readonly string[]>(selectedItemIds);
  const selectedEdgeIdRef = useRef(selectedEdgeId);
  selectedItemIdRef.current = selectedItemId;
  selectedItemIdsRef.current = selectedItemIds;
  selectedEdgeIdRef.current = selectedEdgeId;
  const projectedEdges = useMemo(() => {
    const labels = new Map(descriptors.map((descriptor) => [descriptor.itemId, descriptor.title]));
    const active = edges.map((edge) => buildFlowEdge(
      edge,
      edge.id === selectedEdgeId,
      labels.get(edge.sourceItemId) ?? edge.sourceItemId,
      labels.get(edge.targetItemId) ?? edge.targetItemId,
      detailLevel,
    ));
    if (pendingEdge && !active.some((edge) => edge.id === pendingEdge.edgeId)) active.push(buildPendingFlowEdge(pendingEdge));
    return active;
  }, [descriptors, detailLevel, edges, pendingEdge, selectedEdgeId]);

  // Descriptor/detail projection and controlled selection are intentionally split.
  // Ordinary selection changes reuse every untouched React Flow node object instead
  // of rebuilding the full large-map projection.
  useEffect(() => {
    setFlowNodes(() => {
      const next = applyAuthoritativeSelection(
        projectedNodes,
        selectedItemIdsRef.current,
        selectedItemIdRef.current,
      );
      flowNodesRef.current = next;
      return next;
    });
  }, [projectedNodes]);

  useEffect(() => {
    setFlowNodes((current) => {
      const next = applyAuthoritativeSelection(current, selectedItemIds, selectedItemId);
      flowNodesRef.current = next;
      return next;
    });
  }, [selectedItemId, selectedItemIds]);

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

  useEffect(() => {
    if (!focusedItemId) {
      lastFocusedItemIdRef.current = null;
      return;
    }
    if (!flowInstance || lastFocusedItemIdRef.current === focusedItemId) return;
    const timer = window.setTimeout(() => {
      const node = flowInstance.getNode(focusedItemId);
      if (!node || node.data.pendingReference || node.data.pendingAttachment) return;
      const geometry = nodeGeometry(node);
      const currentZoom = flowInstance.getZoom();
      const focusZoom = currentZoom < 0.85 ? 0.85 : Math.min(currentZoom, 1.25);
      lastFocusedItemIdRef.current = focusedItemId;
      void flowInstance.setCenter(
        geometry.x + geometry.width / 2,
        geometry.y + geometry.height / 2,
        { zoom: focusZoom, duration: 0 },
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [flowInstance, flowNodes, focusedItemId]);

  const emitGeometryCommands = useCallback((commands: readonly ProjectGeometryCommand[]) => {
    const normalized = normalizeProjectGeometryCommands(commands);
    if (normalized.length === 0) return;
    if (normalized.length === 1 || !onGeometryBatchCommit) {
      for (const command of normalized) onGeometryCommit(command);
      return;
    }
    onGeometryBatchCommit(normalized);
  }, [onGeometryBatchCommit, onGeometryCommit]);

  const onNodesChange = useCallback((changes: NodeChange<ProjectFlowNode>[]) => {
    const effectiveChanges = geometryInteractionDisabled
      ? changes.filter((change) => change.type !== "position")
      : changes;
    const current = flowNodesRef.current;
    let next = applyNodeChanges(effectiveChanges, current);

    const selectionChanges = effectiveChanges.filter((change) => change.type === "select");
    if (selectionChanges.length > 0) {
      const candidateItemIds = next.filter((candidate) => (
        candidate.selected
        && !candidate.data.pendingReference
        && !candidate.data.pendingAttachment
        && !candidate.data.markdownEditor
      )).map((candidate) => candidate.id);
      const selectedChange = [...selectionChanges].reverse().find((change) => (
        change.type === "select" && change.selected && candidateItemIds.includes(change.id)
      ));
      const currentPrimary = selectedItemIdRef.current;
      const preferredPrimary = selectedChange?.type === "select"
        ? selectedChange.id
        : currentPrimary && candidateItemIds.includes(currentPrimary)
          ? currentPrimary
          : null;
      const selection = normalizeProjectItemSelection(candidateItemIds, preferredPrimary);
      const accepted = onSelectionChange
        ? onSelectionChange(selection) !== false
        : onSelect(selection.primaryItemId) !== false;
      if (!accepted) next = applyAuthoritativeSelection(
        next,
        selectedItemIdsRef.current,
        selectedItemIdRef.current,
      );
      setContextMenu(null);
    }

    flowNodesRef.current = next;
    setFlowNodes(next);

    if (geometryInteractionDisabled) return;
    const commands: ProjectGeometryCommand[] = [];
    for (const change of effectiveChanges) {
      if (change.type !== "position" || change.dragging || !change.position) continue;
      const beforeNode = current.find((candidate) => candidate.id === change.id);
      const afterNode = next.find((candidate) => candidate.id === change.id);
      if (!beforeNode || !afterNode || afterNode.data.pendingReference || afterNode.data.pendingAttachment || afterNode.data.markdownEditor) continue;
      const placementId = afterNode.data.descriptor.placementId;
      if (interactionStarts.has(placementId) || dragStarts.has(placementId)
        || recentDragCommitsRef.current.has(placementId)) continue;
      const before = nodeGeometry(beforeNode);
      const after = nodeGeometry(afterNode);
      if (!projectGeometryEquals(before, after)) commands.push({ placementId, before, after });
    }
    emitGeometryCommands(commands);
  }, [dragStarts, emitGeometryCommands, geometryInteractionDisabled, interactionStarts, onSelect, onSelectionChange]);

  const handleElementClick = useCallback(() => {
    setContextMenu(null);
  }, []);
  const handlePaneClick = useCallback(() => {
    setContextMenu(null);
  }, []);
  const handleEdgesChange = useCallback((changes: EdgeChange<ProjectFlowEdge>[]) => {
    const selected = [...changes].reverse().find((change) => (
      change.type === "select" && change.selected && change.id !== pendingEdge?.edgeId
    ));
    if (selected?.type === "select") {
      onEdgeSelect(selected.id);
      setContextMenu(null);
      return;
    }
    const selectedEdgeId = selectedEdgeIdRef.current;
    if (selectedEdgeId !== null && changes.some((change) => (
      change.type === "select" && !change.selected && change.id === selectedEdgeId
    ))) onEdgeSelect(null);
  }, [onEdgeSelect, pendingEdge]);
  const handleConnect = useCallback((connection: Connection) => {
    if (edgeInteractionDisabled || !onEdgeConnect || !connection.source || !connection.target
      || !isProjectEdgeHandle(connection.sourceHandle) || !isProjectEdgeHandle(connection.targetHandle)) return;
    onEdgeConnect({
      sourceItemId: connection.source,
      targetItemId: connection.target,
      sourceHandle: connection.sourceHandle,
      targetHandle: connection.targetHandle,
    });
  }, [edgeInteractionDisabled, onEdgeConnect]);
  const handleNodeDragStart = useCallback<OnNodeDrag<ProjectFlowNode>>((_event, node, selectedNodes) => {
    clearAlignmentGuides();
    if (geometryInteractionDisabled || node.data.pendingReference || node.data.pendingAttachment || node.data.markdownEditor) return;
    dragStarts.clear();
    const movingNodes = selectedNodes.length > 0 ? selectedNodes : [node];
    for (const movingNode of movingNodes) {
      if (movingNode.data.pendingReference || movingNode.data.pendingAttachment || movingNode.data.markdownEditor) continue;
      dragStarts.set(movingNode.data.descriptor.placementId, nodeGeometry(movingNode));
    }
  }, [clearAlignmentGuides, dragStarts, geometryInteractionDisabled]);
  const handleNodeDrag = useCallback<OnNodeDrag<ProjectFlowNode>>((_event, node, selectedNodes) => {
    if (geometryInteractionDisabled || node.data.pendingReference || node.data.pendingAttachment || node.data.markdownEditor) {
      clearAlignmentGuides();
      return;
    }
    const movingNodes = (selectedNodes.length > 0 ? selectedNodes : [node]).filter((candidate) => (
      !candidate.data.pendingReference
      && !candidate.data.pendingAttachment
      && !candidate.data.markdownEditor
    ));
    const movingPlacementIds = new Set(movingNodes.map((candidate) => (
      candidate.data.descriptor.placementId
    )));
    const stationaryNodes = flowNodesRef.current.filter((candidate) => (
      !movingPlacementIds.has(candidate.data.descriptor.placementId)
      && !candidate.data.pendingReference
      && !candidate.data.pendingAttachment
      && !candidate.data.markdownEditor
    ));
    const zoom = Math.max(flowInstanceRef.current?.getZoom() ?? 1, 0.1);
    const next = projectCanvasAlignmentGuides(
      movingNodes.map(nodeGeometry),
      stationaryNodes.map(nodeGeometry),
      8 / zoom,
    );
    setAlignmentGuides((current) => (
      current.vertical === next.vertical && current.horizontal === next.horizontal
        ? current
        : next
    ));
  }, [clearAlignmentGuides, geometryInteractionDisabled]);
  const handleNodeDragStop = useCallback<OnNodeDrag<ProjectFlowNode>>((_event, node, selectedNodes) => {
    clearAlignmentGuides();
    if (geometryInteractionDisabled || dragStarts.size === 0) return;
    const latestNodes = new Map((selectedNodes.length > 0 ? selectedNodes : [node]).map((candidate) => [
      candidate.data.descriptor.placementId,
      candidate,
    ]));
    const commands: ProjectGeometryCommand[] = [];
    for (const [placementId, before] of dragStarts) {
      const latest = latestNodes.get(placementId)
        ?? flowNodesRef.current.find((candidate) => candidate.data.descriptor.placementId === placementId);
      if (!latest || latest.data.pendingReference || latest.data.pendingAttachment || latest.data.markdownEditor) continue;
      commands.push({ placementId, before, after: nodeGeometry(latest) });
    }
    dragStarts.clear();
    const normalized = normalizeProjectGeometryCommands(commands);
    recentDragCommitsRef.current = new Set(normalized.map((command) => command.placementId));
    if (recentDragCommitTimerRef.current !== null) window.clearTimeout(recentDragCommitTimerRef.current);
    recentDragCommitTimerRef.current = window.setTimeout(() => {
      recentDragCommitsRef.current.clear();
      recentDragCommitTimerRef.current = null;
    }, 0);
    emitGeometryCommands(normalized);
  }, [clearAlignmentGuides, dragStarts, emitGeometryCommands, geometryInteractionDisabled]);

  useEffect(() => () => {
    flowInstanceRef.current = null;
    if (recentDragCommitTimerRef.current !== null) {
      window.clearTimeout(recentDragCommitTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (geometryInteractionDisabled) clearAlignmentGuides();
  }, [clearAlignmentGuides, geometryInteractionDisabled]);

  const synchronizeDetailLevel = useCallback((zoom: number) => {
    setDetailLevel((current) => projectMapDetailLevelForZoom(
      zoom,
      current,
      performancePolicy.scale,
    ));
  }, [performancePolicy.scale]);

  const handleViewportMove = useCallback<OnMove>((_event, viewport) => {
    synchronizeDetailLevel(viewport.zoom);
  }, [synchronizeDetailLevel]);

  useEffect(() => {
    if (performanceScaleRef.current === performancePolicy.scale) return;
    performanceScaleRef.current = performancePolicy.scale;
    const zoom = flowInstanceRef.current?.getZoom()
      ?? (performancePolicy.scale === "ordinary" ? 1 : 0.6);
    synchronizeDetailLevel(zoom);
  }, [performancePolicy.scale, synchronizeDetailLevel]);

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

  const contextMenuPosition = useCallback((event: MouseEvent | React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      left: Math.max(8, event.clientX - rect.left),
      top: Math.max(8, event.clientY - rect.top),
    };
  }, []);

  const handlePaneContextMenu = useCallback((event: MouseEvent | React.MouseEvent) => {
    if (!onMarkdownCreateRequest && !onAttachmentRequest && !contextCommands) return;
    const point = flowPointFromClient(event.clientX, event.clientY);
    const position = contextMenuPosition(event);
    if (!point || !position) return;
    event.preventDefault();
    setContextMenu({ target: "pane", ...position, point });
  }, [
    contextCommands,
    contextMenuPosition,
    flowPointFromClient,
    onAttachmentRequest,
    onMarkdownCreateRequest,
  ]);

  const handleNodeContextMenu = useCallback((
    event: MouseEvent | React.MouseEvent,
    node: ProjectFlowNode,
  ) => {
    if (node.data.pendingReference || node.data.pendingAttachment || node.data.markdownEditor) return;
    const target = event.target;
    if (target instanceof Element && target.closest(PROJECT_CONTEXT_MENU_INTERACTIVE_SELECTOR)) return;
    const position = contextMenuPosition(event);
    if (!position) return;
    const inCurrentSelection = selectedItemIds.includes(node.id);
    const opensSelectionMenu = inCurrentSelection && selectedItemIds.length > 1;
    if (!opensSelectionMenu) {
      const selection = { itemIds: [node.id], primaryItemId: node.id };
      const accepted = onSelectionChange
        ? onSelectionChange(selection) !== false
        : onSelect(node.id) !== false;
      if (!accepted) return;
    }
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      target: opensSelectionMenu ? "selection" : "node",
      ...position,
      itemId: node.id,
    });
  }, [
    contextMenuPosition,
    onSelect,
    onSelectionChange,
    selectedItemIds,
  ]);

  const handleEdgeContextMenu = useCallback((
    event: MouseEvent | React.MouseEvent,
    edge: ProjectFlowEdge,
  ) => {
    if (edge.id === pendingEdge?.edgeId || !contextCommands) return;
    const position = contextMenuPosition(event);
    if (!position) return;
    event.preventDefault();
    event.stopPropagation();
    if (onEdgeSelect(edge.id) === false) return;
    setContextMenu({ target: "edge", ...position, edgeId: edge.id });
  }, [contextCommands, contextMenuPosition, onEdgeSelect, pendingEdge?.edgeId]);

  const contextMenuItems = useMemo<ProjectMapMenuItem[]>(() => {
    if (!contextMenu) return [];
    if (contextMenu.target === "pane") {
      const items: ProjectMapMenuItem[] = [];
      if (onMarkdownCreateRequest) items.push({
        label: "Add Markdown here",
        section: "Create",
        disabled: contextCommands?.createDisabled ?? geometryInteractionDisabled,
        action: () => onMarkdownCreateRequest(contextMenu.point),
      });
      if (onAttachmentRequest) items.push({
        label: "Add attachment here",
        section: "Create",
        disabled: contextCommands?.createDisabled ?? geometryInteractionDisabled,
        action: () => onAttachmentRequest(contextMenu.point),
      });
      if (contextCommands) {
        items.push(
          {
            label: "Paste copied selection",
            section: "Canvas",
            disabled: contextCommands.pasteDisabled,
            action: contextCommands.pasteSelection,
          },
          {
            label: "Select all",
            section: "Canvas",
            disabled: contextCommands.selectAllDisabled,
            action: contextCommands.selectAll,
          },
          {
            label: "Fit all content",
            section: "Canvas",
            disabled: !flowInstance,
            action: () => {
              if (flowInstance) void flowInstance.fitView(PROJECT_FIT_VIEW_OPTIONS);
            },
          },
          {
            label: "Open References",
            section: "Panels",
            disabled: contextCommands.panelCommandsDisabled,
            action: contextCommands.openReferences,
          },
          {
            label: "Open Inspector",
            section: "Panels",
            disabled: contextCommands.panelCommandsDisabled,
            action: contextCommands.openInspector,
          },
        );
      }
      return items;
    }

    if (contextMenu.target === "selection") {
      if (!contextCommands) return [];
      return [
        {
          label: "Open selection in Inspector",
          section: "Selection",
          disabled: contextCommands.panelCommandsDisabled,
          action: contextCommands.openInspector,
        },
        {
          label: "Copy selected occurrences",
          section: "Selection",
          disabled: contextCommands.copyDisabled,
          action: contextCommands.copySelection,
        },
        { label: "Align left", section: "Align", disabled: contextCommands.alignmentDisabled("left"), action: () => contextCommands.alignSelection("left") },
        { label: "Align horizontal centers", section: "Align", disabled: contextCommands.alignmentDisabled("center-x"), action: () => contextCommands.alignSelection("center-x") },
        { label: "Align right", section: "Align", disabled: contextCommands.alignmentDisabled("right"), action: () => contextCommands.alignSelection("right") },
        { label: "Align top", section: "Align", disabled: contextCommands.alignmentDisabled("top"), action: () => contextCommands.alignSelection("top") },
        { label: "Align vertical centers", section: "Align", disabled: contextCommands.alignmentDisabled("center-y"), action: () => contextCommands.alignSelection("center-y") },
        { label: "Align bottom", section: "Align", disabled: contextCommands.alignmentDisabled("bottom"), action: () => contextCommands.alignSelection("bottom") },
        { label: "Bring to front", section: "Layer", disabled: contextCommands.zOrderDisabled("bring-to-front"), action: () => contextCommands.changeZOrder("bring-to-front") },
        { label: "Bring forward", section: "Layer", disabled: contextCommands.zOrderDisabled("bring-forward"), action: () => contextCommands.changeZOrder("bring-forward") },
        { label: "Send backward", section: "Layer", disabled: contextCommands.zOrderDisabled("send-backward"), action: () => contextCommands.changeZOrder("send-backward") },
        { label: "Send to back", section: "Layer", disabled: contextCommands.zOrderDisabled("send-to-back"), action: () => contextCommands.changeZOrder("send-to-back") },
        {
          label: "Clear selection",
          section: "Selection state",
          disabled: contextCommands.clearSelectionDisabled,
          action: contextCommands.clearSelection,
        },
      ];
    }

    if (contextMenu.target === "edge") {
      if (!contextCommands) return [];
      return [
        {
          label: "Inspect edge",
          section: "Edge",
          disabled: contextCommands.edgeInspectDisabled,
          action: () => contextCommands.inspectEdge(contextMenu.edgeId),
        },
        {
          label: "Edit edge",
          section: "Edge",
          disabled: contextCommands.edgeEditDisabled,
          action: contextCommands.editEdge,
        },
        {
          label: "Delete edge",
          section: "Edge",
          danger: true,
          disabled: contextCommands.edgeDeleteDisabled,
          action: contextCommands.deleteEdge,
        },
      ];
    }

    const descriptor = descriptors.find((candidate) => candidate.itemId === contextMenu.itemId);
    if (!descriptor) return [];
    const referenceHref = descriptor.kind === "reference" && descriptor.openReferenceUrl
      ? projectMarkdownSafeHref(descriptor.openReferenceUrl)
      : null;
    const attachmentFileHref = descriptor.kind === "attachment" && descriptor.fileUrl
      ? projectMarkdownSafeImageSrc(descriptor.fileUrl)
      : null;
    const attachmentSourceHref = descriptor.kind === "attachment" && descriptor.attachmentSourceUrl
      ? projectMarkdownSafeHref(descriptor.attachmentSourceUrl)
      : null;
    const items: ProjectMapMenuItem[] = [];
    if (contextCommands) {
      items.push({
        label: "Inspect occurrence",
        section: "Occurrence",
        action: () => contextCommands.inspectItem(descriptor.itemId),
      });
      if (descriptor.kind === "markdown" || descriptor.kind === "attachment") items.push({
        label: descriptor.kind === "markdown" ? "Edit Markdown" : "Edit attachment metadata",
        section: "Occurrence",
        disabled: contextCommands.editDisabled,
        action: () => contextCommands.editItem(descriptor.itemId),
      });
    }
    if (referenceHref) items.push({
      label: "Open Reference",
      section: "Occurrence",
      href: referenceHref,
    });
    if (attachmentFileHref) items.push({
      label: "Open attachment",
      section: "Occurrence",
      href: attachmentFileHref,
    });
    if (attachmentSourceHref) items.push({
      label: "Open source URL",
      section: "Occurrence",
      href: attachmentSourceHref,
    });
    if (contextCommands) {
      items.push(
        {
          label: "Copy stable link",
          section: "Copy",
          action: () => contextCommands.copyItemLink(descriptor.itemId),
        },
        {
          label: "Copy occurrence",
          section: "Copy",
          disabled: contextCommands.copyDisabled,
          action: contextCommands.copySelection,
        },
        { label: "Bring to front", section: "Layer", disabled: contextCommands.zOrderDisabled("bring-to-front"), action: () => contextCommands.changeZOrder("bring-to-front") },
        { label: "Bring forward", section: "Layer", disabled: contextCommands.zOrderDisabled("bring-forward"), action: () => contextCommands.changeZOrder("bring-forward") },
        { label: "Send backward", section: "Layer", disabled: contextCommands.zOrderDisabled("send-backward"), action: () => contextCommands.changeZOrder("send-backward") },
        { label: "Send to back", section: "Layer", disabled: contextCommands.zOrderDisabled("send-to-back"), action: () => contextCommands.changeZOrder("send-to-back") },
        {
          label: descriptor.kind === "reference" ? "Remove from Project" : "Move to trash",
          section: "Remove",
          danger: true,
          disabled: contextCommands.removeDisabled,
          action: () => contextCommands.removeItem(descriptor.itemId),
        },
      );
    }
    return items;
  }, [
    contextCommands,
    contextMenu,
    descriptors,
    flowInstance,
    geometryInteractionDisabled,
    onAttachmentRequest,
    onMarkdownCreateRequest,
  ]);

  const contextMenuPortalTarget = contextMenu
    ? canvasRef.current?.closest<HTMLElement>(".project-desktop-workspace") ?? null
    : null;
  const contextMenuElement = contextMenu && contextMenuItems.length > 0 ? <div
      ref={contextMenuRef}
      className="project-map-context-menu"
      style={{ left: contextMenu.left, top: contextMenu.top }}
      role="menu"
      aria-label={contextMenu.target === "pane"
        ? "Canvas actions"
        : contextMenu.target === "edge"
          ? "Edge actions"
          : contextMenu.target === "selection"
            ? "Selection actions"
            : "Occurrence actions"}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          '[role="menuitem"]:not([disabled])',
        ));
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeContextMenu(false);
          canvasRef.current?.focus();
          return;
        }
        if (projectCanvasKeyboardShortcutFromEvent(event.nativeEvent)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (items.length === 0) return;
        const currentIndex = items.indexOf(document.activeElement as HTMLElement);
        let nextIndex = currentIndex;
        if (event.key === "ArrowDown") nextIndex = (currentIndex + 1 + items.length) % items.length;
        else if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
        else if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = items.length - 1;
        else return;
        event.preventDefault();
        items[nextIndex]?.focus();
      }}
    >
      {contextMenuItems.map((item, index) => <div
        className="project-map-context-menu-entry"
        key={item.label}
      >
        {(index === 0 || contextMenuItems[index - 1]?.section !== item.section) && <p
          className="project-map-context-menu-label"
          role="presentation"
        >{item.section}</p>}
        {item.href ? <a
          role="menuitem"
          tabIndex={-1}
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => closeContextMenu(true)}
        >{item.label}</a> : <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={item.danger ? "danger" : undefined}
          disabled={item.disabled}
          onClick={() => {
            const result = item.action?.();
            closeContextMenu(true);
            void result;
          }}
        >{item.label}</button>}
      </div>)}
  </div> : null;

  return <div
    ref={canvasRef}
    className="project-flow-canvas"
    data-testid="project-flow-canvas"
    data-project-map-detail={detailLevel}
    data-project-map-scale={performancePolicy.scale}
    data-project-map-culling={performancePolicy.onlyRenderVisibleElements ? "visible-elements" : "all-elements"}
    data-project-map-node-count={performancePolicy.nodeCount}
    data-project-map-edge-count={performancePolicy.edgeCount}
    tabIndex={-1}
    onDoubleClick={handleDoubleClick}
    onDragOver={handleDragOver}
    onDrop={handleDrop}
  >
    <ReactFlow<ProjectFlowNode, ProjectFlowEdge>
      nodes={flowNodes}
      edges={projectedEdges}
      nodeTypes={PROJECT_NODE_TYPES}
      onInit={(instance) => {
        flowInstanceRef.current = instance;
        setFlowInstance(instance);
        void instance.fitView(PROJECT_FIT_VIEW_OPTIONS).then(() => {
          if (flowInstanceRef.current !== instance || !canvasRef.current) return;
          synchronizeDetailLevel(instance.getZoom());
        });
      }}
      onNodesChange={onNodesChange}
      onEdgesChange={handleEdgesChange}
      onNodeClick={handleElementClick}
      onEdgeClick={handleElementClick}
      onNodeContextMenu={handleNodeContextMenu}
      onEdgeContextMenu={handleEdgeContextMenu}
      onPaneContextMenu={handlePaneContextMenu}
      onConnect={handleConnect}
      onPaneClick={handlePaneClick}
      onMove={handleViewportMove}
      onNodeDragStart={handleNodeDragStart}
      onNodeDrag={handleNodeDrag}
      onNodeDragStop={handleNodeDragStop}
      nodesDraggable={!geometryInteractionDisabled}
      nodesConnectable={!edgeInteractionDisabled}
      edgesReconnectable={false}
      connectionMode={ConnectionMode.Loose}
      elementsSelectable
      onlyRenderVisibleElements={performancePolicy.onlyRenderVisibleElements}
      elevateNodesOnSelect={false}
      selectionKeyCode="Shift"
      multiSelectionKeyCode={["Shift", "Meta", "Control"]}
      selectionMode={SelectionMode.Partial}
      minZoom={0.1}
      maxZoom={2.5}
      zoomOnDoubleClick={false}
      deleteKeyCode={null}
      proOptions={PROJECT_PRO_OPTIONS}
    >
      <ViewportPortal>
        {alignmentGuides.vertical !== null && <div
          aria-hidden
          className="project-alignment-guide vertical"
          data-testid="project-alignment-guide-vertical"
          style={{
            left: alignmentGuides.vertical,
            top: -PROJECT_CANVAS_GUIDE_COORDINATE_LIMIT,
            height: PROJECT_CANVAS_GUIDE_COORDINATE_LIMIT * 2,
          }}
        />}
        {alignmentGuides.horizontal !== null && <div
          aria-hidden
          className="project-alignment-guide horizontal"
          data-testid="project-alignment-guide-horizontal"
          style={{
            left: -PROJECT_CANVAS_GUIDE_COORDINATE_LIMIT,
            top: alignmentGuides.horizontal,
            width: PROJECT_CANVAS_GUIDE_COORDINATE_LIMIT * 2,
          }}
        />}
      </ViewportPortal>
      <Background gap={22} size={1.2} />
      <Controls showInteractive={false} />
    </ReactFlow>
    {contextMenuElement && (contextMenuPortalTarget
      ? createPortal(contextMenuElement, contextMenuPortalTarget)
      : contextMenuElement)}
  </div>;
});
