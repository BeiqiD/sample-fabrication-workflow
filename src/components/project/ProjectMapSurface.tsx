import {
  forwardRef,
  lazy,
  Suspense,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ActionIcon } from "../ActionIcon";
import { ReferenceExcerpt } from "../ReferenceExcerpt";
import { ProjectEdgeDirectionControl } from "./ProjectEdgeDirectionControl";
import {
  Background,
  ConnectionMode,
  Controls,
  EdgeToolbar,
  Handle,
  MarkerType,
  NodeResizeControl,
  NodeToolbar,
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
import type { ProjectEdgeEditorState } from "../../lib/use-project-edge-controller";
import type { ProjectEdgeConnection } from "../../lib/project-edge-history";
import { projectEdgeToolbarPosition } from "../../lib/project-edge-toolbar";
import { projectMapInteractionProjection } from "../../lib/project-map-interaction-projection";
import { ProjectMarkdownPreview } from "./ProjectMarkdownPreview";
import {
  normalizeProjectItemSelection,
  PROJECT_CANVAS_GUIDE_COORDINATE_LIMIT,
  projectCanvasAlignmentGuides,
  projectCanvasKeyboardShortcutFromEvent,
  projectCanvasKeyboardTargetIsReading,
  type ProjectCanvasAlignment,
  type ProjectCanvasAlignmentGuides,
  type ProjectCanvasZOrderAction,
  type ProjectItemSelection,
} from "../../lib/project-canvas-productivity";
import "./project-map-surface.css";

const ProjectMarkdownEditor = lazy(() => import("./ProjectMarkdownEditor"));

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
  ensureGeometryVisible?: (geometry: ProjectMapGeometry) => void;
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
  pasteSelection: (point?: { x: number; y: number }) => void;
  selectAll: () => void;
  clearSelection: () => void;
  alignSelection: (alignment: ProjectCanvasAlignment) => void;
  changeZOrder: (action: ProjectCanvasZOrderAction) => void;
  removeItem: (itemId: string) => void;
  removeSelection?: () => void;
  removeSelectionDisabled?: boolean;
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
  onEdgeReconnect?: (edgeId: string, connection: ProjectEdgeConnection) => void;
  edgeEditor?: ProjectEdgeEditorState | null;
  onEdgeEditChange?: (field: "label" | "direction", value: string) => void;
  onEdgeEditSave?: () => void;
  onEdgeEditCancel?: () => void;
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
  children?: ProjectMapMenuItem[];
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

const PROJECT_CARD_INTERACTIVE_SELECTOR = `${PROJECT_CONTEXT_MENU_INTERACTIVE_SELECTOR},.nodrag,[role='button'],[role='link'],summary`;

function cardTargetIsInteractive(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(PROJECT_CARD_INTERACTIVE_SELECTOR));
}

function cardPointerIsOnScrollbar(target: EventTarget | null, clientX: number, clientY: number) {
  if (!(target instanceof HTMLElement) || !target.closest("[data-project-card-content]")) return false;
  const rect = target.getBoundingClientRect();
  // Use the rendered scale so the scrollbar still owns its gutter when zoomed.
  const scaleX = target.offsetWidth ? rect.width / target.offsetWidth : 1;
  const scaleY = target.offsetHeight ? rect.height / target.offsetHeight : 1;
  return (target.clientWidth > 0 && target.offsetWidth > target.clientWidth
      && clientX >= rect.left + target.clientWidth * scaleX)
    || (target.clientHeight > 0 && target.offsetHeight > target.clientHeight
      && clientY >= rect.top + target.clientHeight * scaleY);
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

const ProjectItemNode = memo(function ProjectItemNode({ data }: NodeProps<ProjectFlowNode>) {
  const {
    descriptor,
    pendingReference,
    pendingAttachment,
    markdownEditor,
    geometryInteractionDisabled,
    edgeInteractionDisabled,
  } = data;
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null);
  // XYFlow rebuilds the native resizer when callback identities change. Keep
  // touch gestures alive across live dimensions and unrelated projection updates.
  const resizeDataRef = useRef(data);
  resizeDataRef.current = data;
  const handleControlResizeStart = useCallback((_event: unknown, params: ResizeParams) => {
    const current = resizeDataRef.current;
    if (!current.geometryInteractionDisabled && !current.markdownEditor) {
      current.onResizeStart(current.descriptor, params);
    }
  }, []);
  const handleControlResizeEnd = useCallback((_event: unknown, params: ResizeParams) => {
    const current = resizeDataRef.current;
    if (!current.geometryInteractionDisabled && !current.markdownEditor) {
      current.onResizeEnd(current.descriptor, params);
    }
  }, []);
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

  const canResize = !geometryInteractionDisabled && !editing;
  return <><article
    className={`project-map-node project-map-node-${descriptor.kind}${editing ? " editing" : " resizable"}`}
    data-detail-level={detailLevel}
    onMouseDownCapture={(event) => {
      // React Flow already filters nodrag descendants. Let their own handlers
      // receive the event (especially resize handles, connections and editors).
      if (event.target instanceof Element && event.target.closest(".nodrag")) return;
      if (cardTargetIsInteractive(event.target)
        || cardPointerIsOnScrollbar(event.target, event.clientX, event.clientY)) event.stopPropagation();
    }}
    onTouchStartCapture={(event) => {
      if (event.target instanceof Element && event.target.closest(".nodrag")) return;
      if (cardTargetIsInteractive(event.target)) event.stopPropagation();
    }}
  >
    <header
      className="project-node-drag-handle"
      title={descriptor.kind === "markdown" ? "Drag to move · Double-click to edit Markdown" : "Drag to move · Double-click for details"}
    >
      <span><ActionIcon name={descriptor.kind === "reference" ? "link" : descriptor.kind === "markdown" ? "note" : "attachment"} />{projectNodeKindLabel(descriptor.kind)}</span>
      {showHeaderMeta && markdownEditor?.isNew && <small>draft</small>}
    </header>
    {markdownEditor ? <div className="project-markdown-editor nodrag nopan nowheel">
      <Suspense fallback={<p role="status">Opening editor…</p>}><ProjectMarkdownEditor
        compact
        editor={markdownEditor}
        ariaLabel={markdownEditor.isNew ? "New Project Markdown" : "Edit Project Markdown"}
        onChange={data.onMarkdownChange}
        onSave={data.onMarkdownSave}
        onCancel={data.onMarkdownCancel}
      /></Suspense>
    </div> : <>
      {!(showRichContent && descriptor.kind === "markdown") && <h2 title={descriptor.title}>{descriptor.title}</h2>}
      {showSubtitle && descriptor.subtitle && <p className="project-node-subtitle">{descriptor.subtitle}</p>}
      {previewUrl && <img
        className="project-node-image"
        src={previewUrl}
        alt={descriptor.attachmentCaption || descriptor.title}
        draggable={false}
        onError={() => setFailedPreviewUrl(previewUrl)}
      />}
      {showAction && descriptor.kind === "attachment" && descriptor.fileUrl && !previewUrl && <a
        className="project-node-open-reference nodrag nopan"
        href={descriptor.fileUrl}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >Open attachment</a>}
      {showRichContent && (descriptor.kind === "markdown" ? <div
        className="project-node-markdown nopan nowheel"
        data-project-card-content="true"
        tabIndex={0}
        role="region"
        aria-label="Markdown content"
        onKeyDown={(event) => {
          // Arrow/Page keys scroll the note, rather than moving its canvas node.
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) {
            event.stopPropagation();
          }
        }}
      >
        <ProjectMarkdownPreview source={descriptor.markdownSource || ""} />
      </div> : descriptor.excerpt && <div className="project-node-excerpt" data-project-card-content="true">
        <ReferenceExcerpt source={descriptor.excerpt} format={descriptor.excerptFormat} />
      </div>)}
      {showAction && (descriptor.openSourceUrl || descriptor.openReferenceUrl) && <a
        className="project-node-open-reference nodrag nopan"
        href={descriptor.openSourceUrl ?? descriptor.openReferenceUrl!}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >{descriptor.openSourceUrl ? "Open source" : "Reference details"}</a>}
    </>}
  </article>
    {/* Keep connection ports outside the article's content and resize-corner clipping. */}
    <Handle type="source" id="top" position={Position.Top} className={handleClassName} isConnectable={showHandles && !edgeInteractionDisabled && !editing} />
    <Handle type="source" id="right" position={Position.Right} className={handleClassName} isConnectable={showHandles && !edgeInteractionDisabled && !editing} />
    <Handle type="source" id="bottom" position={Position.Bottom} className={handleClassName} isConnectable={showHandles && !edgeInteractionDisabled && !editing} />
    <Handle type="source" id="left" position={Position.Left} className={handleClassName} isConnectable={showHandles && !edgeInteractionDisabled && !editing} />
    {canResize && <NodeResizeControl
      position="bottom-right"
      minWidth={180}
      minHeight={110}
      maxWidth={1_200}
      maxHeight={1_000}
      autoScale={false}
      className="project-node-resize-handle nodrag nopan"
      onResizeStart={handleControlResizeStart}
      onResizeEnd={handleControlResizeEnd}
    >
      <button
        type="button"
        className="project-node-resize-grip"
        aria-label="Resize card"
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
        title="Drag to resize · Arrow keys adjust size · Shift for larger steps"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          const arrowKey = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key);
          if (!arrowKey && event.key !== "Enter" && event.key !== " ") return;
          // React Flow also handles descendant button keys as node movement/selection.
          event.stopPropagation();
          if (!canResize || !arrowKey || event.altKey || event.ctrlKey || event.metaKey) return;
          event.preventDefault();
          const before = descriptor.geometry;
          const step = event.shiftKey ? 20 : 5;
          const after = {
            ...before,
            width: Math.max(180, Math.min(1_200, before.width
              + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0))),
            height: Math.max(110, Math.min(1_000, before.height
              + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0))),
          };
          if (before.width === after.width && before.height === after.height) return;
          data.onResizeStart(descriptor, before);
          data.onResizeEnd(descriptor, after);
        }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
          <path className="project-node-resize-corner" d="M.5 17.5 17.5 .5V6A11.5 11.5 0 0 1 6 17.5Z" />
          <path d="M8.5 13 13 8.5M11 14 14 11" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
    </NodeResizeControl>}
  </>;
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
    dragHandle: ".project-map-node",
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
  onEdgeReconnect,
  edgeEditor = null,
  onEdgeEditChange,
  onEdgeEditSave,
  onEdgeEditCancel,
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
  const cancelledGestureNodeIds = useMemo(() => new Set<string>(), []);
  const gestureGenerationRef = useRef(0);
  const cancelledTouchGestureRef = useRef(false);
  const recentDragCommitsRef = useRef(new Set<string>());
  const recentDragCommitTimerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const flowInstanceRef = useRef<ReactFlowInstance<ProjectFlowNode> | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<ProjectFlowNode> | null>(null);
  const lastFocusedItemIdRef = useRef<string | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = useState<ProjectMapContextMenu | null>(null);
  const [edgeToolbarViewport, setEdgeToolbarViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [edgeToolbarMetrics, setEdgeToolbarMetrics] = useState({ width: 360, height: 44, canvasWidth: window.innerWidth, canvasHeight: window.innerHeight });
  const [contextSubmenu, setContextSubmenu] = useState<string | null>(null);
  const submenuFocusRef = useRef<string | null>(null);
  const closeContextMenu = useCallback((restoreFocus: boolean) => {
    setContextMenu(null);
    setContextSubmenu(null);
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
      const candidates = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));
      const preferred = submenuFocusRef.current;
      submenuFocusRef.current = null;
      (candidates.find((item) => item.dataset.menuLabel === preferred) ?? candidates[0])?.focus();
    });
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOnPointerDown);
    };
  }, [contextMenu, contextSubmenu]);

  const handleResizeStart = useCallback((descriptor: ProjectNodeDescriptor, params: ResizeParams) => {
    if (geometryInteractionDisabled) return;
    gestureGenerationRef.current += 1;
    cancelledGestureNodeIds.delete(descriptor.itemId);
    interactionStarts.set(descriptor.placementId, geometryFromResize(descriptor, params));
  }, [cancelledGestureNodeIds, geometryInteractionDisabled, interactionStarts]);

  const handleResizeEnd = useCallback((descriptor: ProjectNodeDescriptor, params: ResizeParams) => {
    const before = interactionStarts.get(descriptor.placementId);
    interactionStarts.delete(descriptor.placementId);
    if (geometryInteractionDisabled || !before || cancelledGestureNodeIds.has(descriptor.itemId)) return;
    const after = geometryFromResize(descriptor, params);
    onGeometryCommit({ placementId: descriptor.placementId, before, after });
  }, [cancelledGestureNodeIds, geometryInteractionDisabled, interactionStarts, onGeometryCommit]);

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
    if (!markdownEditor) return active;
    // Keep the active editor's controls reachable across overlapping cards. This
    // is a visual lift only: descriptor geometry retains the user's saved order.
    const editorZIndex = active.reduce((highest, node) => Math.max(highest, node.data.descriptor.geometry.zIndex), 0) + 1;
    return active.map((node) => node.data.markdownEditor ? {
      ...node,
      style: { ...node.style, zIndex: editorZIndex },
    } : node);
  }, [callbacks, descriptors, detailLevel, edgeInteractionDisabled, geometryInteractionDisabled, markdownEditor, pendingAttachment, pendingReference]);
  const [flowNodes, setFlowNodes] = useState<ProjectFlowNode[]>(projectedNodes);
  const flowNodesRef = useRef<ProjectFlowNode[]>(projectedNodes);
  const projectedNodesRef = useRef(projectedNodes);
  projectedNodesRef.current = projectedNodes;
  const selectedItemIdRef = useRef(selectedItemId);
  const selectedItemIdsRef = useRef<readonly string[]>(selectedItemIds);
  const selectedEdgeIdRef = useRef(selectedEdgeId);
  selectedItemIdRef.current = selectedItemId;
  selectedItemIdsRef.current = selectedItemIds;
  selectedEdgeIdRef.current = selectedEdgeId;
  const cancelTrackedGestures = useCallback(() => {
    if (dragStarts.size === 0 && interactionStarts.size === 0) return;
    for (const node of flowNodesRef.current) {
      const placementId = node.data.descriptor.placementId;
      if (dragStarts.has(placementId) || interactionStarts.has(placementId)) cancelledGestureNodeIds.add(node.id);
    }
    dragStarts.clear();
    interactionStarts.clear();
    clearAlignmentGuides();
    const next = applyAuthoritativeSelection(projectedNodesRef.current,
      selectedItemIdsRef.current, selectedItemIdRef.current);
    flowNodesRef.current = next;
    setFlowNodes(next);
  }, [cancelledGestureNodeIds, clearAlignmentGuides, dragStarts, interactionStarts]);

  useEffect(() => {
    let mounted = true;
    const finishTimers = new Set<number>();
    const finishPointerGesture = (event: MouseEvent | TouchEvent) => {
      if (event instanceof MouseEvent && event.button !== 0) return;
      if (event.type === "touchcancel") cancelTrackedGestures();
      if ("touches" in event && event.touches.length > 0) return;
      if (dragStarts.size === 0 && interactionStarts.size === 0
        && cancelledGestureNodeIds.size === 0 && !cancelledTouchGestureRef.current) return;
      const generation = gestureGenerationRef.current;
      // Wait for the complete native event dispatch, including React Flow stop
      // listeners. Microtasks can run between native listeners and cancel an
      // ordinary drag before its stop callback gets to commit it.
      const timer = window.setTimeout(() => {
        finishTimers.delete(timer);
        if (!mounted || generation !== gestureGenerationRef.current) return;
        // A resize-control click with no movement or cancelled gesture can end
        // without a normal stop callback; restore only that leftover state.
        cancelTrackedGestures();
        cancelledGestureNodeIds.clear();
        cancelledTouchGestureRef.current = false;
      }, 0);
      finishTimers.add(timer);
    };
    window.addEventListener("mouseup", finishPointerGesture, true);
    window.addEventListener("touchend", finishPointerGesture, true);
    window.addEventListener("touchcancel", finishPointerGesture, true);
    return () => {
      mounted = false;
      for (const timer of finishTimers) window.clearTimeout(timer);
      window.removeEventListener("mouseup", finishPointerGesture, true);
      window.removeEventListener("touchend", finishPointerGesture, true);
      window.removeEventListener("touchcancel", finishPointerGesture, true);
    };
  }, [cancelTrackedGestures, cancelledGestureNodeIds, dragStarts, interactionStarts]);
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
    setFlowNodes((current) => {
      const projectedById = new Map(projectedNodes.map((node) => [node.id, node]));
      for (const node of current) {
        const placementId = node.data.descriptor.placementId;
        if (!dragStarts.has(placementId) && !interactionStarts.has(placementId)) continue;
        const projected = projectedById.get(node.id);
        if (projected?.data.descriptor.placementId === placementId && projected.draggable !== false) continue;
        dragStarts.delete(placementId);
        interactionStarts.delete(placementId);
        cancelledGestureNodeIds.add(node.id);
      }
      const next = applyAuthoritativeSelection(
        projectMapInteractionProjection(projectedNodes, current, dragStarts, interactionStarts),
        selectedItemIdsRef.current,
        selectedItemIdRef.current,
      );
      flowNodesRef.current = next;
      return next;
    });
  }, [projectedNodes, cancelledGestureNodeIds, dragStarts, interactionStarts]);

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
    ensureGeometryVisible(geometry) {
      const instance = flowInstanceRef.current;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!instance || !rect || rect.width <= 0 || rect.height <= 0) return;
      const topLeft = instance.screenToFlowPosition({ x: rect.left + 24, y: rect.top + 24 });
      const bottomRight = instance.screenToFlowPosition({ x: rect.right - 24, y: rect.bottom - 24 });
      if (geometry.x >= topLeft.x && geometry.y >= topLeft.y
        && geometry.x + geometry.width <= bottomRight.x
        && geometry.y + geometry.height <= bottomRight.y) return;
      // Reveal the new card without changing the user's zoom or any placement.
      void instance.setCenter(geometry.x + geometry.width / 2, geometry.y + geometry.height / 2, {
        zoom: instance.getZoom(), duration: 0,
      });
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
    const effectiveChanges = changes.filter((change) => {
      if (change.type !== "position" && !(change.type === "dimensions" && change.resizing !== undefined)) return true;
      return !geometryInteractionDisabled && !cancelledGestureNodeIds.has(change.id);
    });
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
  }, [cancelledGestureNodeIds, dragStarts, emitGeometryCommands, geometryInteractionDisabled, interactionStarts, onSelect, onSelectionChange]);

  const handleElementClick = useCallback(() => {
    setContextMenu(null);
  }, []);
  const handlePaneClick = useCallback(() => {
    setContextMenu(null);
  }, []);
  const handleCardTouchCapture = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length > 1 && (dragStarts.size > 0 || interactionStarts.size > 0)) {
      cancelledTouchGestureRef.current = true;
      cancelTrackedGestures();
    }
    // Do not feed the second touch to XYDrag: its multitouch abort skips its
    // normal stop cleanup. The original touchend still releases that gesture.
    if (cancelledTouchGestureRef.current) event.stopPropagation();
  }, [cancelTrackedGestures, dragStarts, interactionStarts]);
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
  const handleReconnect = useCallback((edge: ProjectFlowEdge, connection: Connection) => {
    if (edgeInteractionDisabled || !onEdgeReconnect || edge.id === pendingEdge?.edgeId
      || !connection.source || !connection.target
      || !isProjectEdgeHandle(connection.sourceHandle) || !isProjectEdgeHandle(connection.targetHandle)) return;
    onEdgeReconnect(edge.id, {
      sourceItemId: connection.source, targetItemId: connection.target,
      sourceHandle: connection.sourceHandle, targetHandle: connection.targetHandle,
    });
  }, [edgeInteractionDisabled, onEdgeReconnect, pendingEdge?.edgeId]);
  const handleNodeDragStart = useCallback<OnNodeDrag<ProjectFlowNode>>((_event, node, selectedNodes) => {
    clearAlignmentGuides();
    if (geometryInteractionDisabled || node.data.pendingReference || node.data.pendingAttachment || node.data.markdownEditor) return;
    gestureGenerationRef.current += 1;
    dragStarts.clear();
    const movingNodes = selectedNodes.length > 0 ? selectedNodes : [node];
    for (const movingNode of movingNodes) {
      if (movingNode.data.pendingReference || movingNode.data.pendingAttachment || movingNode.data.markdownEditor) continue;
      cancelledGestureNodeIds.delete(movingNode.id);
      dragStarts.set(movingNode.data.descriptor.placementId, nodeGeometry(movingNode));
    }
  }, [cancelledGestureNodeIds, clearAlignmentGuides, dragStarts, geometryInteractionDisabled]);
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
    if (selectedEdgeIdRef.current) setEdgeToolbarViewport(viewport);
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
    setContextSubmenu(null);
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
    setContextSubmenu(null);
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
    setContextSubmenu(null);
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
            label: "Paste here",
            section: "Canvas",
            disabled: contextCommands.pasteDisabled,
            action: () => contextCommands.pasteSelection(contextMenu.point),
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
        ...(contextCommands.removeSelection ? [{
          label: "Remove selected cards", section: "Remove", danger: true,
          disabled: contextCommands.removeSelectionDisabled ?? contextCommands.removeDisabled,
          action: contextCommands.removeSelection,
        }] : []),
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
      ? projectMarkdownSafeHref(descriptor.openSourceUrl ?? descriptor.openReferenceUrl)
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
      label: descriptor.openSourceUrl ? "Open source" : "Reference details",
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

  const groupedMenuItems = useMemo(() => {
    const groups = new Map<string, ProjectMapMenuItem>();
    const result: ProjectMapMenuItem[] = [];
    for (const item of contextMenuItems) {
      if (item.section !== "Align" && item.section !== "Layer") {
        result.push(item);
        continue;
      }
      let group = groups.get(item.section);
      if (!group) {
        group = { label: item.section, section: "Arrange", children: [] };
        groups.set(item.section, group);
        result.push(group);
      }
      group.children!.push(item);
    }
    return result;
  }, [contextMenuItems]);
  const activeSubmenu = groupedMenuItems.find((item) => item.label === contextSubmenu && item.children);
  const menuItems = activeSubmenu?.children
    ? [{ label: "Back to actions", section: activeSubmenu.label, action: () => {
      submenuFocusRef.current = activeSubmenu.label;
      setContextSubmenu(null);
    } }, ...activeSubmenu.children]
    : groupedMenuItems;
  const primaryDescriptor = descriptors.find((descriptor) => descriptor.itemId === selectedItemId) ?? null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  useLayoutEffect(() => {
    if (!selectedEdgeId || !flowInstance) return;
    setEdgeToolbarViewport(flowInstance.getViewport());
    const canvas = canvasRef.current;
    const toolbar = canvas?.querySelector<HTMLElement>(".project-edge-toolbar");
    if (!canvas || !toolbar) return;
    const measure = () => {
      const canvasRect = canvas.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();
      const next = {
        width: toolbarRect.width || (edgeEditor ? 500 : 360),
        height: toolbarRect.height || (edgeEditor ? 120 : 44),
        canvasWidth: canvasRect.width || window.innerWidth,
        canvasHeight: canvasRect.height || window.innerHeight,
      };
      setEdgeToolbarMetrics((current) => current.width === next.width && current.height === next.height
        && current.canvasWidth === next.canvasWidth && current.canvasHeight === next.canvasHeight ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [selectedEdgeId, Boolean(edgeEditor), flowInstance]);
  const edgeToolbarPoint = useMemo(() => {
    if (!selectedEdge) return null;
    const source = flowNodes.find((node) => node.id === selectedEdge.sourceItemId);
    const target = flowNodes.find((node) => node.id === selectedEdge.targetItemId);
    if (!source || !target) return null;
    const handlePoint = (node: ProjectFlowNode, handle: ProjectEdgeHandle) => {
      const geometry = nodeGeometry(node);
      return {
        x: geometry.x + (handle === "left" ? 0 : handle === "right" ? geometry.width : geometry.width / 2),
        y: geometry.y + (handle === "top" ? 0 : handle === "bottom" ? geometry.height : geometry.height / 2),
      };
    };
    const from = handlePoint(source, selectedEdge.sourceHandle);
    const to = handlePoint(target, selectedEdge.targetHandle);
    const viewport = edgeToolbarViewport;
    const screenPoint = (point: { x: number; y: number }) => ({
      x: point.x * viewport.zoom + viewport.x,
      y: point.y * viewport.zoom + viewport.y,
    });
    const position = projectEdgeToolbarPosition(screenPoint(from), screenPoint(to), {
      width: edgeToolbarMetrics.canvasWidth, height: edgeToolbarMetrics.canvasHeight,
    }, edgeToolbarMetrics);
    return { x: (position.x - viewport.x) / viewport.zoom, y: (position.y - viewport.y) / viewport.zoom };
  }, [flowNodes, selectedEdge, edgeToolbarViewport, edgeToolbarMetrics]);
  const openToolbarMenu = (event: React.MouseEvent<HTMLButtonElement>, target: "node" | "edge") => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const position = contextMenuPosition({ clientX: rect.left, clientY: rect.bottom } as MouseEvent);
    if (!position) return;
    setContextSubmenu(null);
    if (target === "edge" && selectedEdge) setContextMenu({ target: "edge", ...position, edgeId: selectedEdge.id });
    else if (primaryDescriptor) setContextMenu({
      target: selectedItemIds.length > 1 ? "selection" : "node", ...position, itemId: primaryDescriptor.itemId,
    });
  };
  const primaryOpenUrl = primaryDescriptor
    ? primaryDescriptor.kind === "attachment" ? primaryDescriptor.fileUrl
      : primaryDescriptor.openSourceUrl ?? primaryDescriptor.openReferenceUrl
    : null;
  const safePrimaryOpenUrl = primaryOpenUrl ? projectMarkdownSafeHref(primaryOpenUrl) : null;

  const contextMenuPortalTarget = contextMenu
    ? canvasRef.current?.closest<HTMLElement>(".project-desktop-workspace") ?? null
    : null;
  const contextMenuElement = contextMenu && contextMenuItems.length > 0 ? <div
      ref={contextMenuRef}
      className="project-map-context-menu"
      style={{ left: contextMenu.left, top: contextMenu.top }}
      role="menu"
      aria-label={activeSubmenu ? `${activeSubmenu.label} actions` : contextMenu.target === "pane"
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
        if (event.key === "Tab") {
          closeContextMenu(false);
          return;
        }
        if (event.key === "ArrowLeft" && activeSubmenu || event.key === "Escape" && activeSubmenu) {
          event.preventDefault();
          event.stopPropagation();
          submenuFocusRef.current = activeSubmenu!.label;
          setContextSubmenu(null);
          return;
        }
        if (event.key === "ArrowRight") {
          const label = (document.activeElement as HTMLElement | null)?.dataset.menuLabel;
          const item = menuItems.find((candidate) => candidate.label === label);
          if (item?.children) {
            event.preventDefault();
            event.stopPropagation();
            setContextSubmenu(item.label);
          }
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeContextMenu(false);
          canvasRef.current?.focus();
          return;
        }
        if (projectCanvasKeyboardShortcutFromEvent(event.nativeEvent)
          || event.key === "Delete" || event.key === "Backspace") {
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
      {menuItems.map((item, index) => <div
        className="project-map-context-menu-entry"
        key={item.label}
      >
        {(index === 0 || menuItems[index - 1]?.section !== item.section) && <p
          className="project-map-context-menu-label"
          role="presentation"
        >{item.section}</p>}
        {item.href ? <a
          role="menuitem"
          tabIndex={-1}
          data-menu-label={item.label}
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => closeContextMenu(true)}
        >{item.label}</a> : <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={item.danger ? "danger" : undefined}
          data-menu-label={item.label}
          aria-haspopup={item.children ? "menu" : undefined}
          aria-expanded={item.children ? false : undefined}
          disabled={item.disabled}
          onClick={() => {
            if (item.children) { setContextSubmenu(item.label); return; }
            const result = item.action?.();
            if (item.label !== "Back to actions") closeContextMenu(true);
            void result;
          }}
        >{item.label}{item.children && <span aria-hidden="true">›</span>}</button>}
      </div>)}
  </div> : null;

  return <div
    ref={canvasRef}
    className="project-flow-canvas"
    data-testid="project-flow-canvas"
    data-project-selection-tools={contextCommands ? "true" : "false"}
    data-project-map-detail={detailLevel}
    data-project-map-scale={performancePolicy.scale}
    data-project-map-culling={performancePolicy.onlyRenderVisibleElements ? "visible-elements" : "all-elements"}
    data-project-map-node-count={performancePolicy.nodeCount}
    data-project-map-edge-count={performancePolicy.edgeCount}
    tabIndex={-1}
    onDoubleClick={handleDoubleClick}
    onTouchStartCapture={handleCardTouchCapture}
    onTouchMoveCapture={handleCardTouchCapture}
    onDragOver={handleDragOver}
    onDrop={handleDrop}
    onKeyDown={(event) => {
      if (!contextCommands || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey
        || (event.key !== "Delete" && event.key !== "Backspace")) return;
      const target = event.target;
      if (projectCanvasKeyboardTargetIsReading(target)
        || (target instanceof Element && target.closest(`${PROJECT_CONTEXT_MENU_INTERACTIVE_SELECTOR}, [role='menu'], [role='dialog']`))) return;
      if (selectedEdgeId && !contextCommands.edgeDeleteDisabled) {
        event.preventDefault(); event.stopPropagation(); contextCommands.deleteEdge();
      } else if (selectedItemIds.length && !(contextCommands.removeSelectionDisabled ?? contextCommands.removeDisabled)) {
        if (!contextCommands.removeSelection && selectedItemIds.length !== 1) return;
        event.preventDefault(); event.stopPropagation();
        if (contextCommands.removeSelection) contextCommands.removeSelection();
        else contextCommands.removeItem(selectedItemIds[0]);
      }
    }}
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
      onNodeDoubleClick={(event, node) => {
        event.stopPropagation();
        if (cardTargetIsInteractive(event.target) || node.data.markdownEditor
          || node.data.pendingReference || node.data.pendingAttachment) return;
        if (node.data.descriptor.kind === "markdown") {
          if (!geometryInteractionDisabled) onMarkdownEditRequest(node.id);
        } else if (contextCommands && !contextCommands.panelCommandsDisabled) {
          contextCommands.inspectItem(node.id);
        }
      }}
      onEdgeClick={handleElementClick}
      onNodeContextMenu={handleNodeContextMenu}
      onEdgeContextMenu={handleEdgeContextMenu}
      onPaneContextMenu={handlePaneContextMenu}
      onConnect={handleConnect}
      onReconnect={handleReconnect}
      onPaneClick={handlePaneClick}
      onMove={handleViewportMove}
      onNodeDragStart={handleNodeDragStart}
      onNodeDrag={handleNodeDrag}
      onNodeDragStop={handleNodeDragStop}
      nodesDraggable={!geometryInteractionDisabled}
      nodesConnectable={!edgeInteractionDisabled}
      edgesReconnectable={!edgeInteractionDisabled && Boolean(onEdgeReconnect)}
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
      {contextCommands && primaryDescriptor && selectedItemIds.length > 0 && !selectedEdgeId && !markdownEditor && !geometryInteractionDisabled && <NodeToolbar
        nodeId={[...selectedItemIds]}
        isVisible
        position={Position.Top}
        className="project-selection-toolbar nodrag nopan"
        role="toolbar"
        aria-label={selectedItemIds.length > 1 ? "Selected cards actions" : "Selected card actions"}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {selectedItemIds.length > 1 ? <><span>{selectedItemIds.length} cards</span><button type="button" disabled={contextCommands.copyDisabled} onClick={contextCommands.copySelection}>Copy</button></>
          : <>
            {(primaryDescriptor.kind === "markdown" || primaryDescriptor.kind === "attachment") && <button
              type="button" disabled={contextCommands.editDisabled}
              onClick={() => contextCommands.editItem(primaryDescriptor.itemId)}
            ><ActionIcon name="plan-update" />Edit</button>}
            {safePrimaryOpenUrl && <a href={safePrimaryOpenUrl} target="_blank" rel="noopener noreferrer"><ActionIcon name="open" />{primaryDescriptor.kind === "reference" ? primaryDescriptor.openSourceUrl ? "Open source" : "Reference details" : "Open"}</a>}
          </>}
        <button type="button" disabled={contextCommands.panelCommandsDisabled} onClick={() => selectedItemIds.length > 1
          ? contextCommands.openInspector() : contextCommands.inspectItem(primaryDescriptor.itemId)}><ActionIcon name="inspector" />Details</button>
        <button type="button" aria-label="More card actions" aria-haspopup="menu" onClick={(event) => openToolbarMenu(event, "node")}><ActionIcon name="more" /></button>
      </NodeToolbar>}
      {contextCommands && selectedEdge && edgeToolbarPoint && <EdgeToolbar
        edgeId={selectedEdge.id} x={edgeToolbarPoint.x} y={edgeToolbarPoint.y} isVisible
        alignX="left" alignY="top"
        style={{ zIndex: 1_000_002, maxWidth: Math.max(1, edgeToolbarMetrics.canvasWidth - 24) }}
        className={`project-selection-toolbar project-edge-toolbar nodrag nopan${edgeEditor ? " editing" : ""}`}
        role={edgeEditor ? "group" : "toolbar"} aria-label={edgeEditor ? "Edit selected edge" : "Selected edge actions"}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (!edgeEditor) return;
          if (event.key === "Escape" && !event.nativeEvent.isComposing
            && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
            event.preventDefault(); event.stopPropagation();
            if (["editing", "error"].includes(edgeEditor.status)) onEdgeEditCancel?.();
            return;
          }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
            event.preventDefault(); event.stopPropagation();
            if (["editing", "error", "uncertain"].includes(edgeEditor.status)) onEdgeEditSave?.();
          }
        }}
      >
        {edgeEditor ? <>
          <label>Label<input autoFocus aria-label="Edge label" value={edgeEditor.label}
            disabled={!["editing", "error"].includes(edgeEditor.status)}
            onChange={(event) => onEdgeEditChange?.("label", event.currentTarget.value)} /></label>
          <div className="project-edge-direction-field"><span>Direction</span><ProjectEdgeDirectionControl value={edgeEditor.direction}
            disabled={!["editing", "error"].includes(edgeEditor.status)}
            onChange={(direction) => onEdgeEditChange?.("direction", direction)}
          /></div>
          <button type="button" disabled={!["editing", "error", "uncertain"].includes(edgeEditor.status)} onClick={onEdgeEditSave}>
            {edgeEditor.status === "saving" ? "Saving…" : edgeEditor.status === "uncertain" ? "Retry exact save" : "Save edge"}
          </button>
          <button type="button" disabled={["saving", "uncertain", "conflict"].includes(edgeEditor.status)} aria-keyshortcuts="Escape" onClick={onEdgeEditCancel}>Cancel <kbd aria-hidden="true">Esc</kbd></button>
          {edgeEditor.message && <p role="status">{edgeEditor.message}</p>}
        </> : <>
          <button type="button" disabled={contextCommands.edgeEditDisabled} onClick={contextCommands.editEdge}><ActionIcon name="plan-update" />Edit label / direction</button>
          <button type="button" disabled={contextCommands.edgeInspectDisabled} onClick={() => contextCommands.inspectEdge(selectedEdge.id)}><ActionIcon name="inspector" />Details</button>
          <button type="button" aria-label="More edge actions" aria-haspopup="menu" onClick={(event) => openToolbarMenu(event, "edge")}><ActionIcon name="more" /></button>
        </>}
      </EdgeToolbar>}
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
