from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one anchor in {path}, found {count}: {old[:180]!r}")
    target.write_text(text.replace(old, new, 1))


surface = "src/components/project/ProjectMapSurface.tsx"
replace_once(surface, "  type NodeMouseHandler,\n", "")
replace_once(surface, "  type OnSelectionChangeFunc,\n", "")

replace_once(
    surface,
    '''  const [flowNodes, setFlowNodes] = useState<ProjectFlowNode[]>(projectedNodes);
  const flowNodesRef = useRef<ProjectFlowNode[]>(projectedNodes);
  const projectedEdges = useMemo(() => {
''',
    '''  const [flowNodes, setFlowNodes] = useState<ProjectFlowNode[]>(projectedNodes);
  const flowNodesRef = useRef<ProjectFlowNode[]>(projectedNodes);
  const selectedItemIdRef = useRef(selectedItemId);
  const selectedEdgeIdRef = useRef(selectedEdgeId);
  selectedItemIdRef.current = selectedItemId;
  selectedEdgeIdRef.current = selectedEdgeId;
  const projectedEdges = useMemo(() => {
''',
)

replace_once(
    surface,
    '''  useEffect(() => {
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
''',
    '''  // Parent selection is authoritative. Do not preserve React Flow's transient
  // selection here: doing so can re-select a node while an edge click is clearing it.
  useEffect(() => {
    setFlowNodes(() => {
      const next = projectedNodes.map((projected) => ({
        ...projected,
        selected: !projected.data.pendingReference
          && !projected.data.pendingAttachment
          && projected.id === selectedItemId,
      }));
      flowNodesRef.current = next;
      return next;
    });
  }, [projectedNodes, selectedItemId]);
''',
)

replace_once(
    surface,
    '''  const onNodesChange = useCallback((changes: NodeChange<ProjectFlowNode>[]) => {
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
    if (!node.data.pendingReference && !node.data.pendingAttachment) onSelect(node.id);
    setContextMenu(null);
  }, [onSelect]);
  const handleEdgeClick = useCallback((_event: React.MouseEvent, edge: ProjectFlowEdge) => {
    if (pendingEdge?.edgeId === edge.id) return;
    onEdgeSelect(edge.id);
    setContextMenu(null);
  }, [onEdgeSelect, pendingEdge]);
  const handlePaneClick = useCallback(() => {
    onSelect(null);
    onEdgeSelect(null);
    setContextMenu(null);
  }, [onEdgeSelect, onSelect]);
  const handleSelectionChange = useCallback<OnSelectionChangeFunc<ProjectFlowNode, ProjectFlowEdge>>(({ nodes, edges }) => {
    const selectedNode = [...nodes].reverse().find((node) => !node.data.pendingReference && !node.data.pendingAttachment);
    if (selectedNode) {
      onSelect(selectedNode.id);
      return;
    }
    const selectedEdge = [...edges].reverse().find((edge) => edge.id !== pendingEdge?.edgeId);
    if (selectedEdge) {
      onEdgeSelect(selectedEdge.id);
      return;
    }
    if (selectedItemId !== null) onSelect(null);
  }, [onEdgeSelect, onSelect, pendingEdge, selectedItemId]);
  const handleEdgesChange = useCallback((changes: EdgeChange<ProjectFlowEdge>[]) => {
    const selected = [...changes].reverse().find((change) => change.type === "select" && change.selected);
    if (selected?.type === "select") {
      onEdgeSelect(selected.id);
      return;
    }
    if (selectedEdgeId !== null && changes.some((change) =>
      change.type === "select" && !change.selected && change.id === selectedEdgeId
    )) onEdgeSelect(null);
  }, [onEdgeSelect, selectedEdgeId]);
''',
    '''  const onNodesChange = useCallback((changes: NodeChange<ProjectFlowNode>[]) => {
    const effectiveChanges = geometryInteractionDisabled
      ? changes.filter((change) => change.type !== "position")
      : changes;
    const current = flowNodesRef.current;
    const next = applyNodeChanges(effectiveChanges, current);
    flowNodesRef.current = next;
    setFlowNodes(next);

    // Selection has one user-event bridge: React Flow NodeChange/EdgeChange.
    // Click and aggregate selection callbacks must not write the same state again.
    const selectedChange = [...effectiveChanges].reverse().find(
      (change) => change.type === "select" && change.selected,
    );
    if (selectedChange?.type === "select") {
      const selectedNode = next.find((candidate) => candidate.id === selectedChange.id);
      if (selectedNode && !selectedNode.data.pendingReference && !selectedNode.data.pendingAttachment) {
        onSelect(selectedNode.id);
        setContextMenu(null);
      }
    } else {
      const selectedItemId = selectedItemIdRef.current;
      if (selectedItemId !== null && effectiveChanges.some((change) => (
        change.type === "select" && !change.selected && change.id === selectedItemId
      ))) onSelect(null);
    }

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
  }, [geometryInteractionDisabled, interactionStarts, onGeometryCommit, onSelect]);

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
''',
)

replace_once(surface, "      onNodeClick={handleNodeClick}\n", "")
replace_once(surface, "      onEdgeClick={handleEdgeClick}\n", "")
replace_once(surface, "      onSelectionChange={handleSelectionChange}\n", "")

path = Path("src/project-edge-surface.mount.test.tsx")
text = path.read_text()
anchor = '\n});\n'
position = text.rfind(anchor)
if position < 0:
    raise SystemExit("could not find describe terminator")

test = r'''

  it("switches node, edge, node, and pane selection without controlled-selection feedback", async () => {
    const snapshot = projectTestSnapshot();
    const stableNodes = projectMapNodes(snapshot);
    const stableEdges = [edgeRecord()];
    const transitions: string[] = [];

    function ControlledClickHarness() {
      const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
      const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
      const handleSelect = useCallback((itemId: string | null) => {
        transitions.push(`node:${itemId ?? "none"}`);
        if (transitions.length > 20) throw new Error("Project Map selection feedback loop");
        setSelectedItemId(itemId);
        if (itemId !== null) setSelectedEdgeId(null);
      }, []);
      const handleEdgeSelect = useCallback((edgeId: string | null) => {
        transitions.push(`edge:${edgeId ?? "none"}`);
        if (transitions.length > 20) throw new Error("Project Map selection feedback loop");
        setSelectedEdgeId(edgeId);
        if (edgeId !== null) setSelectedItemId(null);
      }, []);
      return <ProjectMapSurface
        nodes={stableNodes}
        edges={stableEdges}
        selectedItemId={selectedItemId}
        selectedEdgeId={selectedEdgeId}
        onSelect={handleSelect}
        onEdgeSelect={handleEdgeSelect}
        onGeometryCommit={() => undefined}
      />;
    }

    const { container } = render(<div style={{ width: 900, height: 700 }}><ControlledClickHarness /></div>);
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBe(2));
    const liveNode = (id: string) => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
    const liveEdge = () => container.querySelector<SVGGElement>('.react-flow__edge[data-id="edge-a"]')!;
    const pane = () => container.querySelector<HTMLElement>(".react-flow__pane")!;
    await waitFor(() => expect(liveEdge()).toBeTruthy());

    fireEvent.click(liveNode("item-note"));
    await waitFor(() => expect(liveNode("item-note").classList.contains("selected")).toBe(true));
    transitions.length = 0;

    fireEvent.click(liveEdge());
    await waitFor(() => {
      expect(liveEdge().classList.contains("selected")).toBe(true);
      expect(liveNode("item-note").classList.contains("selected")).toBe(false);
    });
    expect(transitions).toContain("edge:edge-a");
    expect(transitions.length).toBeLessThanOrEqual(6);

    transitions.length = 0;
    fireEvent.click(liveNode("item-reference"));
    await waitFor(() => {
      expect(liveNode("item-reference").classList.contains("selected")).toBe(true);
      expect(liveEdge().classList.contains("selected")).toBe(false);
    });
    expect(transitions).toContain("node:item-reference");
    expect(transitions.length).toBeLessThanOrEqual(6);

    transitions.length = 0;
    fireEvent.click(pane());
    await waitFor(() => expect(liveNode("item-reference").classList.contains("selected")).toBe(false));
    expect(transitions).toContain("node:none");
    expect(transitions.length).toBeLessThanOrEqual(4);
  });
'''

path.write_text(text[:position] + test + text[position:])
