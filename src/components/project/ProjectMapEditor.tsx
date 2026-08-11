import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  NodeResizer,
  ReactFlow,
  useNodesState,
  type Node,
  type NodeProps,
  type OnNodesChange,
  type ResizeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectSnapshot } from "../../../shared/project-api";
import type { ProjectMapGeometry } from "../../../shared/project-types";
import { ProjectApiError, projectApi } from "../../lib/project-api";
import {
  dirtyPlacementDrafts,
  geometryCopy,
  newProjectOperationId,
  placementDrafts,
  projectMapNodes,
  sameGeometry,
  type ProjectMapCommand,
  type ProjectMapNodeModel,
  type ProjectPlacementDraft,
} from "../../lib/project-map";
import { ProjectInspector } from "./ProjectInspector";

type SaveState = "saved" | "unsaved" | "saving" | "conflict" | "error";

type ProjectNodeData = Record<string, unknown> & {
  model: ProjectMapNodeModel;
  onResizeStart: (itemId: string) => void;
  onResizeEnd: (itemId: string, params: ResizeParams) => void;
};

type ProjectFlowNode = Node<ProjectNodeData, "project">;

function ProjectNodeCard({ id, data, selected }: NodeProps<ProjectFlowNode>) {
  const model = data.model;
  return <article className={`project-map-node project-map-node-${model.kind}${selected ? " selected" : ""}`}>
    <NodeResizer
      isVisible={selected}
      minWidth={160}
      minHeight={90}
      maxWidth={100_000}
      maxHeight={100_000}
      lineClassName="project-node-resize-line"
      handleClassName="project-node-resize-handle"
      onResizeStart={() => data.onResizeStart(id)}
      onResizeEnd={(_event, params) => data.onResizeEnd(id, params)}
    />
    {model.imageUrl && <img className="project-node-image nodrag" src={model.imageUrl} alt="" loading="lazy" />}
    <div className="project-node-copy">
      <p className="card-label">{model.kind}</p>
      <h3>{model.title}</h3>
      {model.meta && <p className="card-meta">{model.meta}</p>}
      {model.excerpt && <p className="project-node-excerpt">{model.excerpt}</p>}
    </div>
    {model.openUrl && <a
      className="project-node-open nodrag nopan"
      href={model.openUrl}
      onClick={(event) => event.stopPropagation()}
    >Open</a>}
  </article>;
}

const MemoProjectNodeCard = memo(ProjectNodeCard);
const NODE_TYPES = { project: MemoProjectNodeCard } as const;
const AUTOSAVE_DELAY_MS = 1_600;

function flowNode(
  model: ProjectMapNodeModel,
  onResizeStart: ProjectNodeData["onResizeStart"],
  onResizeEnd: ProjectNodeData["onResizeEnd"],
): ProjectFlowNode {
  return {
    id: model.itemId,
    type: "project",
    position: { x: model.geometry.x, y: model.geometry.y },
    data: { model, onResizeStart, onResizeEnd },
    style: { width: model.geometry.width, height: model.geometry.height, zIndex: model.geometry.zIndex },
    zIndex: model.geometry.zIndex,
  };
}

function geometryFromNode(node: ProjectFlowNode, fallback: ProjectMapGeometry): ProjectMapGeometry {
  const styleWidth = typeof node.style?.width === "number" ? node.style.width : undefined;
  const styleHeight = typeof node.style?.height === "number" ? node.style.height : undefined;
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.measured?.width ?? styleWidth ?? fallback.width,
    height: node.measured?.height ?? styleHeight ?? fallback.height,
    zIndex: node.zIndex ?? fallback.zIndex,
  };
}

export function ProjectMapEditor({
  snapshot,
  onReload,
}: {
  snapshot: ProjectSnapshot;
  onReload: () => void;
}) {
  const models = useMemo(() => projectMapNodes(snapshot), [snapshot]);
  const modelsById = useMemo(() => new Map(models.map((model) => [model.itemId, model])), [models]);
  const [drafts, setDrafts] = useState<Record<string, ProjectPlacementDraft>>(() => placementDrafts(models));
  const draftsRef = useRef(drafts);
  const interactionStartRef = useRef<Record<string, ProjectMapGeometry>>({});
  const [past, setPast] = useState<ProjectMapCommand[]>([]);
  const [future, setFuture] = useState<ProjectMapCommand[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveMessage, setSaveMessage] = useState("");
  const savingRef = useRef(false);

  const applyNodeGeometryRef = useRef<(itemId: string, geometry: ProjectMapGeometry) => void>(() => undefined);

  const beginResize = useCallback((itemId: string) => {
    const draft = draftsRef.current[itemId];
    if (draft) interactionStartRef.current[itemId] = geometryCopy(draft.geometry);
  }, []);

  const completeGeometryChange = useCallback((itemId: string, next: ProjectMapGeometry) => {
    const current = draftsRef.current[itemId];
    if (!current) return;
    const before = interactionStartRef.current[itemId] ?? geometryCopy(current.geometry);
    delete interactionStartRef.current[itemId];
    if (sameGeometry(before, next)) return;
    const nextDrafts = {
      ...draftsRef.current,
      [itemId]: { ...current, geometry: geometryCopy(next) },
    };
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
    setPast((commands) => [...commands, { itemId, before, after: geometryCopy(next) }]);
    setFuture([]);
    setSaveState("unsaved");
    setSaveMessage("");
    applyNodeGeometryRef.current(itemId, next);
  }, []);

  const endResize = useCallback((itemId: string, params: ResizeParams) => {
    const draft = draftsRef.current[itemId];
    if (!draft) return;
    completeGeometryChange(itemId, {
      x: params.x,
      y: params.y,
      width: params.width,
      height: params.height,
      zIndex: draft.geometry.zIndex,
    });
  }, [completeGeometryChange]);

  const [nodes, setNodes, onNodesChange] = useNodesState<ProjectFlowNode>(
    models.map((model) => flowNode(model, beginResize, endResize)),
  );

  applyNodeGeometryRef.current = (itemId, geometry) => {
    setNodes((current) => current.map((node) => node.id === itemId ? {
      ...node,
      position: { x: geometry.x, y: geometry.y },
      style: { ...node.style, width: geometry.width, height: geometry.height, zIndex: geometry.zIndex },
      zIndex: geometry.zIndex,
    } : node));
  };

  useEffect(() => {
    const nextDrafts = placementDrafts(models);
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
    setNodes(models.map((model) => flowNode(model, beginResize, endResize)));
    setPast([]);
    setFuture([]);
    setSelectedItemId(null);
    setSaveState("saved");
    setSaveMessage("");
  }, [beginResize, endResize, models, setNodes]);

  const flushPlacements = useCallback(async () => {
    if (savingRef.current || saveState === "conflict") return;
    const pending = dirtyPlacementDrafts(draftsRef.current);
    if (!pending.length) {
      setSaveState("saved");
      setSaveMessage("");
      return;
    }
    savingRef.current = true;
    setSaveState("saving");
    setSaveMessage("");
    try {
      for (const submitted of pending) {
        const submittedGeometry = geometryCopy(submitted.geometry);
        const result = await projectApi.updatePlacement(snapshot.project.id, submitted.placementId, {
          geometry: submittedGeometry,
          expectedRevision: submitted.expectedRevision,
          operationId: newProjectOperationId("placement"),
        });
        const latest = draftsRef.current[submitted.itemId];
        if (latest) {
          const next = {
            ...draftsRef.current,
            [submitted.itemId]: {
              ...latest,
              expectedRevision: result.value.revision,
              baseline: geometryCopy(result.value),
            },
          };
          draftsRef.current = next;
          setDrafts(next);
        }
      }
      const stillDirty = dirtyPlacementDrafts(draftsRef.current).length > 0;
      setSaveState(stillDirty ? "unsaved" : "saved");
    } catch (error) {
      if (error instanceof ProjectApiError && error.status === 409) {
        setSaveState("conflict");
        setSaveMessage(error.message);
      } else {
        setSaveState("error");
        setSaveMessage((error as Error).message || "Placement save failed");
      }
    } finally {
      savingRef.current = false;
    }
  }, [saveState, snapshot.project.id]);

  useEffect(() => {
    if (saveState !== "unsaved") return;
    const timeout = window.setTimeout(() => void flushPlacements(), AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [drafts, flushPlacements, saveState]);

  const handleNodesChange: OnNodesChange<ProjectFlowNode> = useCallback((changes) => {
    onNodesChange(changes);
  }, [onNodesChange]);

  const onNodeDragStart = useCallback((_event: MouseEvent | TouchEvent, node: ProjectFlowNode) => {
    const draft = draftsRef.current[node.id];
    if (draft) interactionStartRef.current[node.id] = geometryCopy(draft.geometry);
  }, []);

  const onNodeDragStop = useCallback((_event: MouseEvent | TouchEvent, node: ProjectFlowNode) => {
    const draft = draftsRef.current[node.id];
    if (!draft) return;
    completeGeometryChange(node.id, geometryFromNode(node, draft.geometry));
  }, [completeGeometryChange]);

  const applyCommand = useCallback((command: ProjectMapCommand, direction: "undo" | "redo") => {
    const geometry = direction === "undo" ? command.before : command.after;
    const current = draftsRef.current[command.itemId];
    if (!current) return;
    const next = {
      ...draftsRef.current,
      [command.itemId]: { ...current, geometry: geometryCopy(geometry) },
    };
    draftsRef.current = next;
    setDrafts(next);
    applyNodeGeometryRef.current(command.itemId, geometry);
    setSaveState(dirtyPlacementDrafts(next).length ? "unsaved" : "saved");
    setSaveMessage("");
  }, []);

  const undo = useCallback(() => {
    setPast((commands) => {
      const command = commands.at(-1);
      if (!command) return commands;
      applyCommand(command, "undo");
      setFuture((redo) => [...redo, command]);
      return commands.slice(0, -1);
    });
  }, [applyCommand]);

  const redo = useCallback(() => {
    setFuture((commands) => {
      const command = commands.at(-1);
      if (!command) return commands;
      applyCommand(command, "redo");
      setPast((undoCommands) => [...undoCommands, command]);
      return commands.slice(0, -1);
    });
  }, [applyCommand]);

  const selectedModel = selectedItemId ? modelsById.get(selectedItemId) ?? null : null;
  const selectedGeometry = selectedItemId ? drafts[selectedItemId]?.geometry ?? null : null;
  const dirtyCount = dirtyPlacementDrafts(drafts).length;

  return <div className="project-map-layout">
    <section className="project-map-stage" aria-label="Project Map">
      <div className="project-map-toolbar">
        <div className={`project-save-state project-save-state-${saveState}`} role="status">
          {saveState === "saved" && "Saved"}
          {saveState === "saving" && "Saving…"}
          {saveState === "unsaved" && `${dirtyCount} unsaved placement${dirtyCount === 1 ? "" : "s"}`}
          {saveState === "conflict" && "Conflict"}
          {saveState === "error" && "Save error"}
        </div>
        <div className="project-map-toolbar-actions">
          <button type="button" className="button" onClick={undo} disabled={!past.length || saveState === "saving"}>Undo</button>
          <button type="button" className="button" onClick={redo} disabled={!future.length || saveState === "saving"}>Redo</button>
          <button type="button" className="button primary" onClick={() => void flushPlacements()} disabled={!dirtyCount || saveState === "saving" || saveState === "conflict"}>Save</button>
        </div>
      </div>
      {(saveState === "conflict" || saveState === "error") && <div className={saveState === "conflict" ? "warning-banner project-map-save-banner" : "error-banner project-map-save-banner"}>
        <span>{saveMessage || (saveState === "conflict" ? "Project state changed on the server." : "Placement save failed.")}</span>
        {saveState === "conflict" && <button type="button" className="text-button" onClick={onReload}>Reload authoritative snapshot</button>}
      </div>}
      <div className="project-map-canvas">
        <ReactFlow<ProjectFlowNode>
          nodes={nodes}
          edges={[]}
          nodeTypes={NODE_TYPES}
          onNodesChange={handleNodesChange}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          onSelectionChange={({ nodes: selected }) => setSelectedItemId(selected.at(-1)?.id ?? null)}
          fitView
          fitViewOptions={{ padding: 0.18, maxZoom: 1.1 }}
          minZoom={0.15}
          maxZoom={2}
          nodesConnectable={false}
          deleteKeyCode={null}
          selectionOnDrag
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
          <Controls showInteractive={false} />
          {nodes.length > 5 && <MiniMap pannable zoomable />}
        </ReactFlow>
      </div>
    </section>
    <ProjectInspector node={selectedModel} geometry={selectedGeometry} />
  </div>;
}
