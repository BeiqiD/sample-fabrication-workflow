from pathlib import Path

path = Path("src/project-edge-surface.mount.test.tsx")
text = path.read_text()
anchor = '\n});\n'
if text.count(anchor) != 1:
    raise SystemExit(f"expected one describe terminator, found {text.count(anchor)}")

test = r'''

  it("switches from a selected node to a clicked edge without controlled-selection feedback", async () => {
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
    const noteNode = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
    const liveEdge = () => container.querySelector<SVGGElement>('.react-flow__edge[data-id="edge-a"]')!;
    await waitFor(() => expect(liveEdge()).toBeTruthy());

    fireEvent.click(noteNode);
    await waitFor(() => expect(noteNode.classList.contains("selected")).toBe(true));
    transitions.length = 0;

    fireEvent.click(liveEdge());
    await waitFor(() => {
      expect(liveEdge().classList.contains("selected")).toBe(true);
      expect(noteNode.classList.contains("selected")).toBe(false);
    });
    expect(transitions).toContain("edge:edge-a");
    expect(transitions.length).toBeLessThanOrEqual(6);
  });
'''

path.write_text(text.replace(anchor, test + anchor, 1))
