from pathlib import Path

surface_path = Path("src/components/project/ProjectMapSurface.tsx")
surface = surface_path.read_text()

pane_anchor = '''  const handlePaneClick = useCallback(() => {
    setContextMenu(null);
  }, []);
'''
if surface.count(pane_anchor) != 1:
    raise SystemExit(f"expected one pane click anchor, found {surface.count(pane_anchor)}")
surface = surface.replace(pane_anchor, '''  const handleElementClick = useCallback(() => {
    setContextMenu(null);
  }, []);
  const handlePaneClick = useCallback(() => {
    setContextMenu(null);
  }, []);
''', 1)

flow_anchor = '''      onNodesChange={onNodesChange}
      onEdgesChange={handleEdgesChange}
      onConnect={handleConnect}
      onPaneClick={handlePaneClick}
'''
if surface.count(flow_anchor) != 1:
    raise SystemExit(f"expected one React Flow callback anchor, found {surface.count(flow_anchor)}")
surface = surface.replace(flow_anchor, '''      onNodesChange={onNodesChange}
      onEdgesChange={handleEdgesChange}
      onNodeClick={handleElementClick}
      onEdgeClick={handleElementClick}
      onConnect={handleConnect}
      onPaneClick={handlePaneClick}
''', 1)
surface_path.write_text(surface)

test_path = Path("src/project-edge-surface.mount.test.tsx")
test = test_path.read_text()
insert_at = test.rfind("\n});\n")
if insert_at == -1:
    raise SystemExit("could not locate final describe terminator")

regression = r'''

  it("closes the attachment menu when an already-selected node or edge is clicked without rewriting selection", async () => {
    const snapshot = projectTestSnapshot();
    const stableNodes = projectMapNodes(snapshot);
    const stableEdges = [edgeRecord()];
    const nodeSelections: Array<string | null> = [];
    const edgeSelections: Array<string | null> = [];

    function ControlledMenuHarness() {
      const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
      const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
      const handleSelect = useCallback((itemId: string | null) => {
        nodeSelections.push(itemId);
        setSelectedItemId(itemId);
        if (itemId !== null) setSelectedEdgeId(null);
      }, []);
      const handleEdgeSelect = useCallback((edgeId: string | null) => {
        edgeSelections.push(edgeId);
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
        onAttachmentRequest={() => undefined}
      />;
    }

    const { container } = render(<div style={{ width: 900, height: 700 }}><ControlledMenuHarness /></div>);
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBe(2));
    const node = () => container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
    const edge = () => container.querySelector<SVGGElement>('.react-flow__edge[data-id="edge-a"]')!;
    const pane = () => container.querySelector<HTMLElement>(".react-flow__pane")!;
    const menu = () => container.querySelector<HTMLElement>('.project-map-context-menu[role="menu"]');
    await waitFor(() => expect(edge()).toBeTruthy());

    fireEvent.click(node());
    await waitFor(() => expect(node().classList.contains("selected")).toBe(true));
    const nodeSelectionCount = nodeSelections.length;

    fireEvent.contextMenu(pane(), { clientX: 120, clientY: 110 });
    await waitFor(() => expect(menu()).toBeTruthy());
    fireEvent.click(node());
    await waitFor(() => expect(menu()).toBeNull());
    expect(nodeSelections).toHaveLength(nodeSelectionCount);

    fireEvent.click(edge());
    await waitFor(() => expect(edge().classList.contains("selected")).toBe(true));
    const edgeSelectionCount = edgeSelections.length;

    fireEvent.contextMenu(pane(), { clientX: 160, clientY: 130 });
    await waitFor(() => expect(menu()).toBeTruthy());
    fireEvent.click(edge());
    await waitFor(() => expect(menu()).toBeNull());
    expect(edgeSelections).toHaveLength(edgeSelectionCount);
  });
'''

test_path.write_text(test[:insert_at] + regression + test[insert_at:])
