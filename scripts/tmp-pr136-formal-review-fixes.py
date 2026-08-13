from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one anchor in {path}, found {count}: {old[:80]!r}")
    target.write_text(text.replace(old, new, 1))


def replace_count(path: str, old: str, new: str, expected: int) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"expected {expected} anchors in {path}, found {count}: {old[:80]!r}")
    target.write_text(text.replace(old, new))


# 1 + 4: separate edge interaction gating and accurate edge accessibility labels.
surface = "src/components/project/ProjectMapSurface.tsx"
replace_once(
    surface,
    'import type { ProjectPendingEdgePreview } from "../../lib/project-edges";',
    'import { projectEdgeDirection, type ProjectPendingEdgePreview } from "../../lib/project-edges";',
)
replace_once(
    surface,
    '''  geometryInteractionDisabled: boolean;\n  onResizeStart:''',
    '''  geometryInteractionDisabled: boolean;\n  edgeInteractionDisabled: boolean;\n  onResizeStart:''',
)
replace_once(
    surface,
    '''  geometryInteractionDisabled?: boolean;\n  onSelect:''',
    '''  geometryInteractionDisabled?: boolean;\n  edgeInteractionDisabled?: boolean;\n  onSelect:''',
)
replace_once(
    surface,
    '''    markdownEditor,\n    geometryInteractionDisabled,\n  } = data;''',
    '''    markdownEditor,\n    geometryInteractionDisabled,\n    edgeInteractionDisabled,\n  } = data;''',
)
replace_once(
    surface,
    '''    <Handle type="source" id="top" position={Position.Top} className="project-edge-handle nodrag nopan" isConnectable={!geometryInteractionDisabled && !editing} />\n    <Handle type="source" id="right" position={Position.Right} className="project-edge-handle nodrag nopan" isConnectable={!geometryInteractionDisabled && !editing} />\n    <Handle type="source" id="bottom" position={Position.Bottom} className="project-edge-handle nodrag nopan" isConnectable={!geometryInteractionDisabled && !editing} />\n    <Handle type="source" id="left" position={Position.Left} className="project-edge-handle nodrag nopan" isConnectable={!geometryInteractionDisabled && !editing} />''',
    '''    <Handle type="source" id="top" position={Position.Top} className="project-edge-handle nodrag nopan" isConnectable={!edgeInteractionDisabled && !editing} />\n    <Handle type="source" id="right" position={Position.Right} className="project-edge-handle nodrag nopan" isConnectable={!edgeInteractionDisabled && !editing} />\n    <Handle type="source" id="bottom" position={Position.Bottom} className="project-edge-handle nodrag nopan" isConnectable={!edgeInteractionDisabled && !editing} />\n    <Handle type="source" id="left" position={Position.Left} className="project-edge-handle nodrag nopan" isConnectable={!edgeInteractionDisabled && !editing} />''',
)
replace_once(
    surface,
    '''function buildFlowEdge(edge: ProjectEdgeRecord, selected: boolean): ProjectFlowEdge {\n  return {\n    id: edge.id,\n    source: edge.sourceItemId,\n    target: edge.targetItemId,\n    sourceHandle: edge.sourceHandle,\n    targetHandle: edge.targetHandle,\n    type: "default",\n    label: edge.label ?? undefined,\n    markerStart: projectFlowMarker(edge.markerStart),\n    markerEnd: projectFlowMarker(edge.markerEnd),\n    selected,\n    selectable: true,\n    deletable: false,\n  };\n}''',
    '''function projectFlowEdgeAriaLabel(edge: ProjectEdgeRecord, sourceLabel: string, targetLabel: string) {\n  const label = edge.label ? `; label: ${edge.label}` : "";\n  switch (projectEdgeDirection(edge.markerStart, edge.markerEnd)) {\n    case "undirected": return `Undirected edge between ${sourceLabel} and ${targetLabel}${label}`;\n    case "forward": return `Directed edge from ${sourceLabel} to ${targetLabel}${label}`;\n    case "reverse": return `Directed edge from ${targetLabel} to ${sourceLabel}${label}`;\n    case "bidirectional": return `Bidirectional edge between ${sourceLabel} and ${targetLabel}${label}`;\n  }\n}\n\nfunction buildFlowEdge(\n  edge: ProjectEdgeRecord,\n  selected: boolean,\n  sourceLabel: string,\n  targetLabel: string,\n): ProjectFlowEdge {\n  return {\n    id: edge.id,\n    source: edge.sourceItemId,\n    target: edge.targetItemId,\n    sourceHandle: edge.sourceHandle,\n    targetHandle: edge.targetHandle,\n    type: "default",\n    label: edge.label ?? undefined,\n    markerStart: projectFlowMarker(edge.markerStart),\n    markerEnd: projectFlowMarker(edge.markerEnd),\n    selected,\n    selectable: true,\n    deletable: false,\n    ariaLabel: projectFlowEdgeAriaLabel(edge, sourceLabel, targetLabel),\n  };\n}''',
)
replace_once(
    surface,
    '''function buildFlowNode(\n  descriptor: ProjectNodeDescriptor,\n  geometryInteractionDisabled: boolean,\n  markdownEditor: ProjectMapMarkdownEditorState | null,''',
    '''function buildFlowNode(\n  descriptor: ProjectNodeDescriptor,\n  geometryInteractionDisabled: boolean,\n  edgeInteractionDisabled: boolean,\n  markdownEditor: ProjectMapMarkdownEditorState | null,''',
)
replace_once(
    surface,
    '''      markdownEditor,\n      geometryInteractionDisabled,\n      ...callbacks,''',
    '''      markdownEditor,\n      geometryInteractionDisabled,\n      edgeInteractionDisabled,\n      ...callbacks,''',
)
replace_once(surface, '''    connectable: false,''', '''    connectable: !edgeInteractionDisabled && !editing,''')
replace_count(surface, 'buildFlowNode(descriptor, true, null, callbacks)', 'buildFlowNode(descriptor, true, true, null, callbacks)', 4)
replace_once(surface, 'buildFlowNode(descriptor, true, editor, callbacks)', 'buildFlowNode(descriptor, true, true, editor, callbacks)')
replace_once(
    surface,
    '''  selectedEdgeId = null,\n  geometryInteractionDisabled = false,\n  onSelect,''',
    '''  selectedEdgeId = null,\n  geometryInteractionDisabled = false,\n  edgeInteractionDisabled = false,\n  onSelect,''',
)
replace_once(
    surface,
    '''      descriptor,\n      geometryInteractionDisabled,\n      markdownEditor?.itemId === descriptor.itemId ? markdownEditor : null,''',
    '''      descriptor,\n      geometryInteractionDisabled,\n      edgeInteractionDisabled,\n      markdownEditor?.itemId === descriptor.itemId ? markdownEditor : null,''',
)
replace_once(
    surface,
    '''  }, [callbacks, descriptors, geometryInteractionDisabled, markdownEditor, pendingAttachment, pendingReference]);''',
    '''  }, [callbacks, descriptors, edgeInteractionDisabled, geometryInteractionDisabled, markdownEditor, pendingAttachment, pendingReference]);''',
)
replace_once(
    surface,
    '''  const projectedEdges = useMemo(() => {\n    const active = edges.map((edge) => buildFlowEdge(edge, edge.id === selectedEdgeId));\n    if (pendingEdge && !active.some((edge) => edge.id === pendingEdge.edgeId)) active.push(buildPendingFlowEdge(pendingEdge));\n    return active;\n  }, [edges, pendingEdge, selectedEdgeId]);''',
    '''  const projectedEdges = useMemo(() => {\n    const labels = new Map(descriptors.map((descriptor) => [descriptor.itemId, descriptor.title]));\n    const active = edges.map((edge) => buildFlowEdge(\n      edge,\n      edge.id === selectedEdgeId,\n      labels.get(edge.sourceItemId) ?? edge.sourceItemId,\n      labels.get(edge.targetItemId) ?? edge.targetItemId,\n    ));\n    if (pendingEdge && !active.some((edge) => edge.id === pendingEdge.edgeId)) active.push(buildPendingFlowEdge(pendingEdge));\n    return active;\n  }, [descriptors, edges, pendingEdge, selectedEdgeId]);''',
)
replace_once(
    surface,
    '''  const handleConnect = useCallback((connection: Connection) => {\n    if (geometryInteractionDisabled || !onEdgeConnect || !connection.source || !connection.target''',
    '''  const handleConnect = useCallback((connection: Connection) => {\n    if (edgeInteractionDisabled || !onEdgeConnect || !connection.source || !connection.target''',
)
replace_once(surface, '  }, [geometryInteractionDisabled, onEdgeConnect]);', '  }, [edgeInteractionDisabled, onEdgeConnect]);')
replace_once(surface, '      nodesConnectable={!geometryInteractionDisabled}', '      nodesConnectable={!edgeInteractionDisabled}')

# 1: wire the edge gate into the page and edge-history toolbar actions.
page = "src/pages/ProjectPage.tsx"
replace_once(
    page,
    '''    if (command.kind === "geometry") {\n      const next = applyProjectGeometryCommand(geometryRef.current, command.command, "undo");''',
    '''    if (command.kind === "geometry") {\n      const next = applyProjectGeometryCommand(geometryRef.current, command.command, "undo");''',
)
# Insert explicit edge-history guards after the geometry branches, before applyHistory.
replace_once(
    page,
    '''      return;\n    }\n    edgeController.applyHistory(command, "undo", () => {''',
    '''      return;\n    }\n    if (edgeController.interactionDisabled) return;\n    edgeController.applyHistory(command, "undo", () => {''',
)
replace_once(
    page,
    '''      return;\n    }\n    edgeController.applyHistory(command, "redo", () => {''',
    '''      return;\n    }\n    if (edgeController.interactionDisabled) return;\n    edgeController.applyHistory(command, "redo", () => {''',
)
replace_once(
    page,
    '''  const geometryInteractionDisabled = pendingReferenceRemoval !== null\n    || pendingReference?.status === "reconciling"\n    || workspaceOperationBusy;\n\n  const navigationBlockMessage''',
    '''  const geometryInteractionDisabled = pendingReferenceRemoval !== null\n    || pendingReference?.status === "reconciling"\n    || workspaceOperationBusy;\n  const undoCommand = undoStack.at(-1) ?? null;\n  const redoCommand = redoStack.at(-1) ?? null;\n  const undoDisabled = !undoCommand\n    || saveState === "saving"\n    || geometryInteractionDisabled\n    || (undoCommand.kind !== "geometry" && edgeController.interactionDisabled);\n  const redoDisabled = !redoCommand\n    || saveState === "saving"\n    || geometryInteractionDisabled\n    || (redoCommand.kind !== "geometry" && edgeController.interactionDisabled);\n\n  const navigationBlockMessage''',
)
replace_once(
    page,
    '''        <button type="button" className="button compact-button" disabled={!undoStack.length || saveState === "saving" || geometryInteractionDisabled} onClick={undo}>Undo</button>\n        <button type="button" className="button compact-button" disabled={!redoStack.length || saveState === "saving" || geometryInteractionDisabled} onClick={redo}>Redo</button>''',
    '''        <button type="button" className="button compact-button" disabled={undoDisabled} onClick={undo}>Undo</button>\n        <button type="button" className="button compact-button" disabled={redoDisabled} onClick={redo}>Redo</button>''',
)
replace_once(
    page,
    '''            selectedEdgeId={edgeController.selectedEdgeId}\n            geometryInteractionDisabled={geometryInteractionDisabled}\n            onSelect={selectProjectItem}''',
    '''            selectedEdgeId={edgeController.selectedEdgeId}\n            geometryInteractionDisabled={geometryInteractionDisabled}\n            edgeInteractionDisabled={edgeController.interactionDisabled}\n            onSelect={selectProjectItem}''',
)

# 2: editing after a deterministic PATCH failure starts a fresh authoritative request identity.
controller = "src/lib/use-project-edge-controller.ts"
replace_once(
    controller,
    '''  const changeEdit = useCallback((field: "direction" | "label", value: string) => {\n    const current = editorRef.current;\n    if (!current || current.status === "saving" || current.status === "uncertain" || current.status === "conflict") return;\n    updateEditor({\n      ...current,\n      [field]: value,\n      status: "editing",\n      message: null,\n    } as ProjectEdgeEditorState);\n  }, [updateEditor]);''',
    '''  const changeEdit = useCallback((field: "direction" | "label", value: string) => {\n    const current = editorRef.current;\n    if (!current || current.status === "saving" || current.status === "uncertain" || current.status === "conflict") return;\n    const failedPending = pendingRef.current;\n    if (current.status === "error"\n      && failedPending?.kind === "update"\n      && failedPending.edgeId === current.edgeId\n      && failedPending.status === "error") {\n      updatePending(null);\n    }\n    setActionError("");\n    updateEditor({\n      ...current,\n      [field]: value,\n      status: "editing",\n      message: null,\n    } as ProjectEdgeEditorState);\n  }, [updateEditor, updatePending]);''',
)

# Mounted page regressions for busy edge interaction + deterministic update restart.
mount = "src/project-edges.mount.test.tsx"
replace_once(
    mount,
    'import type { ProjectPendingEdgePreview } from "./lib/project-edges";',
    'import type { ProjectPendingEdgePreview } from "./lib/project-edges";\nimport type { ProjectGeometryCommand } from "./lib/project-map-model";',
)
replace_once(
    mount,
    '''    pendingEdge,\n    onEdgeConnect,\n    onEdgeSelect,''',
    '''    pendingEdge,\n    edgeInteractionDisabled = false,\n    onEdgeConnect,\n    onEdgeSelect,\n    onGeometryCommit,''',
)
replace_once(
    mount,
    '''    pendingEdge?: ProjectPendingEdgePreview | null;\n    onEdgeConnect?: (connection: {''',
    '''    pendingEdge?: ProjectPendingEdgePreview | null;\n    edgeInteractionDisabled?: boolean;\n    onEdgeConnect?: (connection: {''',
)
replace_once(
    mount,
    '''    }) => void;\n    onEdgeSelect?: (edgeId: string | null) => void;\n  }, ref) {''',
    '''    }) => void;\n    onEdgeSelect?: (edgeId: string | null) => void;\n    onGeometryCommit?: (command: ProjectGeometryCommand) => void;\n  }, ref) {''',
)
replace_once(
    mount,
    '''      <p>Edge count: {edges.length}</p>\n      {pendingEdge && <p>Pending edge: {pendingEdge.status}</p>}\n      <button type="button" onClick={() => onEdgeConnect?.({''',
    '''      <p>Edge count: {edges.length}</p>\n      <p>Edge interaction: {edgeInteractionDisabled ? "disabled" : "enabled"}</p>\n      {pendingEdge && <p>Pending edge: {pendingEdge.status}</p>}\n      <button type="button" disabled={edgeInteractionDisabled} onClick={() => onEdgeConnect?.({''',
)
replace_once(
    mount,
    '''      })}>Connect edge fixture</button>\n      {edges[0] && <button type="button" onClick={() => onEdgeSelect?.(edges[0].id)}>Select edge fixture</button>}''',
    '''      })}>Connect edge fixture</button>\n      <button type="button" onClick={() => onGeometryCommit?.({\n        placementId: "placement-note",\n        before: { x: 20, y: 40, width: 250, height: 180, zIndex: 0 },\n        after: { x: 42, y: 40, width: 250, height: 180, zIndex: 0 },\n      })}>Move node fixture</button>\n      {edges[0] && <button type="button" onClick={() => onEdgeSelect?.(edges[0].id)}>Select edge fixture</button>}''',
)
# Add deterministic PATCH restart regression after the ordinary edit test.
anchor = '''  it("undoes and redoes a committed edge deletion through authoritative restore and delete revisions", async () => {'''
path = Path(mount)
text = path.read_text()
if text.count(anchor) != 1:
    raise SystemExit("mounted edge test insertion anchor not unique")
new_tests = r'''  it("starts a fresh edge update after a deterministic PATCH failure when the user changes the draft", async () => {
    const patchInputs: UpdateProjectEdgeInput[] = [];
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshotWithEdge());
      if (String(path) === "/api/projects/project-a/edges/edge-a" && init?.method === "PATCH") {
        const input = JSON.parse(String(init.body)) as UpdateProjectEdgeInput;
        patchInputs.push(input);
        if (patchInputs.length === 1) return jsonResponse({ error: "Invalid edge metadata" }, 400);
        return jsonResponse({
          value: edgeRecord({
            markerStart: input.markerStart,
            markerEnd: input.markerEnd,
            label: input.label,
            revision: 2,
          }),
          replayed: false,
        });
      }
      return jsonResponse({ error: "Unexpected request" }, 500);
    });

    renderProjectPage();
    await waitForMap();
    fireEvent.click(screen.getByRole("button", { name: "Select edge fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit edge" }));
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "Save edge" }));

    expect((await screen.findAllByText("Invalid edge metadata")).length).toBeGreaterThan(0);
    expect(patchInputs).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "recovered" } });
    expect(screen.getByRole("button", { name: "Save edge" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save edge" }));

    await waitFor(() => expect(patchInputs).toHaveLength(2));
    expect(patchInputs[1].label).toBe("recovered");
    expect(patchInputs[1].expectedRevision).toBe(1);
    expect(patchInputs[1].operationId).not.toBe(patchInputs[0].operationId);
    await screen.findByText("recovered");
  });

  it("disables edge connection and edge-history undo while placement state is unsaved", async () => {
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshotWithEdge());
      if (String(path) === "/api/projects/project-a/edges/edge-a" && init?.method === "DELETE") {
        return jsonResponse({
          value: edgeRecord({ revision: 2, deletedAt: "2026-08-13T12:00:00.000Z", deletedBy: "user@example.com" }),
          replayed: false,
        });
      }
      return jsonResponse({ error: "Unexpected request" }, 500);
    });

    renderProjectPage();
    await waitForMap();
    expect(screen.getByText("Edge interaction: enabled")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Select edge fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete edge" }));
    await waitFor(() => expect(screen.getByText("Edge count: 0")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Move node fixture" }));
    await waitFor(() => expect(screen.getByText("Edge interaction: disabled")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Connect edge fixture" }).hasAttribute("disabled")).toBe(true);

    const undoGeometry = screen.getByRole("button", { name: "Undo" });
    expect(undoGeometry.hasAttribute("disabled")).toBe(false);
    fireEvent.click(undoGeometry);

    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(true));
  });

'''
path.write_text(text.replace(anchor, new_tests + anchor, 1))

# Real Surface regressions for independent handle gating and four direction aria labels.
surface_test = "src/project-edge-surface.mount.test.tsx"
path = Path(surface_test)
text = path.read_text()
anchor = '''  it("renders four loose connection handles per node and an authoritative selectable Bezier edge", async () => {'''
if text.count(anchor) != 1:
    raise SystemExit("surface regression insertion anchor not unique")
new_surface_tests = r'''  it("disables connection handles independently from node geometry interaction", async () => {
    const snapshot = projectTestSnapshot();
    const stableNodes = projectMapNodes(snapshot);
    const { container, rerender } = render(<div style={{ width: 900, height: 700 }}>
      <ProjectMapSurface
        nodes={stableNodes}
        edgeInteractionDisabled
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
      />
    </div>);

    await waitFor(() => expect(container.querySelectorAll(".project-edge-handle").length).toBe(8));
    expect(container.querySelectorAll(".project-edge-handle.connectable").length).toBe(0);
    expect(container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')?.classList.contains("draggable")).toBe(true);

    rerender(<div style={{ width: 900, height: 700 }}>
      <ProjectMapSurface
        nodes={stableNodes}
        edgeInteractionDisabled={false}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
      />
    </div>);
    await waitFor(() => expect(container.querySelectorAll(".project-edge-handle.connectable").length).toBe(8));
  });

  it("describes undirected, forward, reverse, and bidirectional edges accurately for keyboard users", async () => {
    const snapshot = projectTestSnapshot();
    const nodes = projectMapNodes(snapshot);
    const sourceTitle = nodes.find((node) => node.itemId === "item-note")!.title;
    const targetTitle = nodes.find((node) => node.itemId === "item-reference")!.title;
    const edges = [
      edgeRecord({ id: "edge-undirected", markerStart: "none", markerEnd: "none", label: null }),
      edgeRecord({ id: "edge-forward", markerStart: "none", markerEnd: "arrow", label: "feeds" }),
      edgeRecord({ id: "edge-reverse", markerStart: "arrow", markerEnd: "none", label: null }),
      edgeRecord({ id: "edge-bidirectional", markerStart: "arrow", markerEnd: "arrow", label: "coupled" }),
    ];
    const { container } = render(<div style={{ width: 900, height: 700 }}>
      <ProjectMapSurface
        nodes={nodes}
        edges={edges}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
      />
    </div>);

    const aria = (edgeId: string) => container.querySelector<SVGGElement>(`.react-flow__edge[data-id="${edgeId}"]`)?.getAttribute("aria-label");
    await waitFor(() => expect(aria("edge-undirected")).toBe(`Undirected edge between ${sourceTitle} and ${targetTitle}`));
    expect(aria("edge-forward")).toBe(`Directed edge from ${sourceTitle} to ${targetTitle}; label: feeds`);
    expect(aria("edge-reverse")).toBe(`Directed edge from ${targetTitle} to ${sourceTitle}`);
    expect(aria("edge-bidirectional")).toBe(`Bidirectional edge between ${sourceTitle} and ${targetTitle}; label: coupled`);
  });

'''
path.write_text(text.replace(anchor, new_surface_tests + anchor, 1))

# 3: canonical documentation and contract synchronization.
canvas = "docs/PROJECT_CANVAS_INTERACTION_CONTRACT.md"
replace_once(
    canvas,
    '''Status: product and architecture contract during Phase 3B4 implementation and Draft review in PR #136''',
    '''Status: canonical product and architecture contract; Phase 3B4 is implemented in PR #136 and awaits clean formal re-review before merge''',
)
replace_once(
    canvas,
    '''Last reviewed: 2026-08-13 after Phase 3A persistence in PRs #131/#132, the Map\nkernel in PR #133, reference placement in PR #134, and Project-owned content in\nPR #135 were completed; Phase 3B4 basic Project-local edges are implemented in\nDraft PR #136 and await final exact-head verification and independent review''',
    '''Last reviewed: 2026-08-13 after Phase 3A persistence in PRs #131/#132, the Map\nkernel in PR #133, reference placement in PR #134, and Project-owned content in\nPR #135 were completed; Phase 3B4 basic Project-local edges are implemented in\nPR #136, with formal-review fixes awaiting clean independent re-review before merge''',
)
replace_once(
    canvas,
    '''3B3 Project-owned Markdown and generic attachment creation; Draft PR #136\nimplements Phase 3B4 basic Project-local edges without widening the normalized\ngraph model.''',
    '''3B3 Project-owned Markdown and generic attachment creation; PR #136 implements\nPhase 3B4 basic Project-local edges without widening the normalized graph model.''',
)
replace_once(
    canvas,
    '''Undo/redo is client-session only. It operates on local commands/current state;\na subsequent save persists the restored current state as an ordinary new\nrevision. There is no requirement to permanently store every drag, resize,\nkeystroke, or undo command.''',
    '''Undo/redo is client-session history, but persistence depends on command type:\n\n- **Geometry undo/redo** applies the inverse placement geometry locally. The\n  restored current geometry then follows the ordinary bounded autosave / explicit\n  Save path and persists as a new placement revision.\n- **Edge undo/redo** immediately dispatches the authoritative inverse edge\n  mutation (`update`, `delete`, or `restore`) with the current authoritative edge\n  revision and a new operation ID. The history stack advances only after that\n  inverse mutation succeeds; an uncertain outcome must exact-retry the frozen\n  inverse request before history may move.\n\nThere is no requirement to permanently store every drag, resize, keystroke, or\nundo command.''',
)

plan = "docs/PROJECT_EDGES_IMPLEMENTATION_PLAN.md"
replace_once(
    plan,
    '''Status: Phase 3B4 implemented in Draft PR #136; final exact-head verification pending''',
    '''Status: Phase 3B4 implemented in PR #136; formal-review fixes addressed and awaiting clean re-review before merge''',
)
replace_once(
    plan,
    '''Last reviewed: 2026-08-13 after the authoritative edge controller, React Flow surface, Inspector editing, session undo/redo, mounted regressions, and permanent `pre-pr/project-edges` gate were implemented''',
    '''Last reviewed: 2026-08-13 after formal review of edge interaction gating, deterministic update restart, canonical history semantics, multi-edge keyboard selection, and accessibility labeling''',
)
replace_once(
    plan,
    '''- deterministic client/validation failure: keep an explicit local error that may be dismissed/restarted;''',
    '''- deterministic client/validation failure: keep an explicit local error; for an Inspector update, changing the draft discards the failed request and the next Save creates a fresh operation ID;''',
)
replace_once(
    plan,
    '''While an edge mutation outcome is unresolved:\n\n- another edge mutation cannot start;\n- edge handles are disabled;''',
    '''Edge connection handles are also disabled while placement save state is not `Saved` or another Project reference/content operation makes the edge controller externally busy. This gate is separate from node geometry interaction so a temporary edge-only lock does not unnecessarily disable node movement.\n\nWhile an edge mutation outcome is unresolved:\n\n- another edge mutation cannot start;\n- edge handles are disabled;''',
)
replace_once(
    plan,
    '''- four real React Flow handles and authoritative Bezier rendering;\n- authoritative connection creation with endpoint revisions;''',
    '''- four real React Flow handles, independent busy-state connection gating, and authoritative Bezier rendering;\n- direction-accurate accessible names for undirected, forward, reverse, and bidirectional edges;\n- authoritative connection creation with endpoint revisions;''',
)
replace_once(
    plan,
    '''- Inspector marker/label update and fixed endpoint/handle behavior;''',
    '''- Inspector marker/label update, deterministic-failure edit restart with a fresh operation ID, and fixed endpoint/handle behavior;''',
)

roadmap = "docs/PRODUCT_ROADMAP.md"
replace_once(
    roadmap,
    '''Last reviewed: 2026-08-13 after the reference/search foundation through PR #130,\nPhase 3A1/3A2 Project persistence in PRs #131/#132, the Map kernel in PR #133,\nreference placement in PR #134, and Project-owned content in PR #135 were\ncompleted; Phase 3B4 basic Project-local edges are implemented in Draft PR #136\nand await final exact-head verification and independent review''',
    '''Last reviewed: 2026-08-13 after the reference/search foundation through PR #130,\nPhase 3A1/3A2 Project persistence in PRs #131/#132, the Map kernel in PR #133,\nreference placement in PR #134, and Project-owned content in PR #135 were\ncompleted; Phase 3B4 basic Project-local edges are implemented in PR #136, with\nformal-review fixes awaiting clean re-review and squash merge before Phase 3C''',
)
replace_once(
    roadmap,
    '''Phase 3B3 Project-owned Markdown and generic attachment creation is complete in\nsquash-merged PR #135. The active implementation target is Draft PR #136,\nPhase 3B4 basic Project-local edges; Phase 3C starts only after this edge slice\nis independently reviewed, exact-head verified, and squash-merged.''',
    '''Phase 3B3 Project-owned Markdown and generic attachment creation is complete in\nsquash-merged PR #135. Phase 3B4 basic Project-local edges are implemented in\nPR #136 and are awaiting clean formal re-review and squash merge. Phase 3C is\nthe next implementation phase after that merge.''',
)
replace_once(
    roadmap,
    '''**Status:** implemented in Draft PR #136; final exact-head verification and independent review pending.''',
    '''**Status:** implemented in PR #136; formal-review fixes addressed and awaiting clean re-review and squash merge.''',
)
replace_once(
    roadmap,
    '''## Immediate next PR order\n\n1. Add **double-click Markdown and generic attachment insertion** as Phase 3B3.\n2. Add **basic Bezier directional edges**.\n3. Add the no-creation **Reading projection**.\n4. Harden **Markdown/TeX, mixed media, save/conflict UX, and export**.\n5. Add advanced **Inspector/Canvas/previews/performance**.\n6. Run the dedicated Docker portability implementation after Project content\n   and save semantics stabilize.''',
    '''## Immediate next PR order\n\n1. After PR #136 is squash-merged, add the no-creation **Reading projection** as Phase 3C.\n2. Harden **Markdown/TeX, mixed media, save/conflict UX, and export** as Phase 3D.\n3. Add advanced **Inspector/Canvas/previews/performance**.\n4. Run the dedicated Docker portability implementation after Project content\n   and save semantics stabilize.''',
)

contract = "src/project-edges-contract.test.ts"
replace_once(
    contract,
    '''    const canvas = fs.readFileSync("docs/PROJECT_CANVAS_INTERACTION_CONTRACT.md", "utf8");\n    expect(plan).toContain("Status: Phase 3B4 implemented in Draft PR #136");\n    expect(plan).toContain("Changing source/target occurrence or either handle is deliberately **not** an update");\n    expect(plan).toContain("ordinary Bezier edges only");\n    expect(plan).toContain("No first-version self-loop, obstacle avoidance, draggable control point, relation ontology");\n    expect(roadmap).toContain("**Status:** implemented in Draft PR #136");\n    expect(canvas).toContain("[PROJECT_EDGES_IMPLEMENTATION_PLAN.md](./PROJECT_EDGES_IMPLEMENTATION_PLAN.md)");''',
    '''    const canvas = fs.readFileSync("docs/PROJECT_CANVAS_INTERACTION_CONTRACT.md", "utf8");\n    const surface = fs.readFileSync("src/components/project/ProjectMapSurface.tsx", "utf8");\n    const page = fs.readFileSync("src/pages/ProjectPage.tsx", "utf8");\n    expect(plan).toContain("Changing source/target occurrence or either handle is deliberately **not** an update");\n    expect(plan).toContain("ordinary Bezier edges only");\n    expect(plan).toContain("No first-version self-loop, obstacle avoidance, draggable control point, relation ontology");\n    expect(roadmap).toContain("After PR #136 is squash-merged, add the no-creation **Reading projection** as Phase 3C");\n    expect(canvas).toContain("**Geometry undo/redo**");\n    expect(canvas).toContain("**Edge undo/redo**");\n    expect(canvas).toContain("[PROJECT_EDGES_IMPLEMENTATION_PLAN.md](./PROJECT_EDGES_IMPLEMENTATION_PLAN.md)");\n    expect(surface).toContain("edgeInteractionDisabled?: boolean");\n    expect(page).toContain("edgeInteractionDisabled={edgeController.interactionDisabled}");''',
)
